import fs from 'node:fs';

import type { Msg, SessionInfo } from '../lib/protocol';
import { env, isWindows } from './config';
import { spawnConsoleGuard } from './console';

// One running pty (Bun.spawn with a terminal — ConPTY on Windows, a POSIX pty
// elsewhere) with a replay buffer and subscribers, owned by the host process
// (host.ts). It knows nothing about sockets or windows; the host taps raw
// output for its own terminal and subscribes the sanitized stream for the
// hub.

// Output kept for replay when a remote viewer (re)attaches.
const SCROLLBACK_BYTES = 400 * 1024;

// Input (and resize, which must stay ordered with it) waits in a queue while
// the pty is not accepting (foreground process not reading stdin). Bounded;
// input past the cap is dropped (that terminal is wedged anyway).
const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;

// How long a killed session's processes get to honor SIGHUP before the sweep
// SIGKILLs whatever ignored it (Linux; see Session.kill).
export const KILL_GRACE_MS = 2000;

// Pty dimensions are clamped, not rejected: a viewer past the bounds (an
// ultrawide monitor at a small font) keeps resizing at the cap instead of
// silently freezing the pty at whatever size it opened with. The cap also
// bounds what a remote frame can make ConPTY allocate.
const MIN_PTY_DIM = 2;
const MAX_PTY_DIM = 1000;

function clampDim(n: number): number {
  return Math.min(Math.max(n, MIN_PTY_DIM), MAX_PTY_DIM);
}

type PtyInput = Uint8Array | { cols: number; rows: number };

const ENCODER = new TextEncoder();

// ConPTY opens (and closes) each session by asking its terminal for
// win32-input-mode and focus events. The host's own window is the pty's real
// terminal, so it gets these untouched (the raw tap) — but replayed into a
// remote viewer they reprogram how *that* terminal encodes input, which can
// never work with many heterogeneous viewers of one shared pty. The buffered
// copy every remote viewer sees is stripped.
const TERMINAL_MODE_REQUESTS = ['\x1b[?9001h', '\x1b[?9001l', '\x1b[?1004h', '\x1b[?1004l'];
const TERMINAL_MODE_REQUEST_RE = /\x1b\[\?(?:9001|1004)[hl]/g;

export class OutputSanitizer {
  private tail = '';

  push(data: string): string {
    data = (this.tail + data).replace(TERMINAL_MODE_REQUEST_RE, '');
    this.tail = '';
    // Hold back a trailing prefix of a request split across chunks; it is
    // emitted (or stripped) once the rest arrives.
    const esc = data.lastIndexOf('\x1b');
    if (esc >= 0 && data.length - esc < TERMINAL_MODE_REQUESTS[0]!.length) {
      const suffix = data.slice(esc);
      if (TERMINAL_MODE_REQUESTS.some((seq) => seq.startsWith(suffix))) {
        this.tail = suffix;
        data = data.slice(0, esc);
      }
    }
    return data;
  }

  // Release a held-back prefix at end of stream: with no more chunks coming,
  // it was output, not the start of a filtered request.
  flush(): string {
    const tail = this.tail;
    this.tail = '';
    return tail;
  }
}

function defaultShell(): string {
  if (env.shell) return env.shell;
  if (isWindows) return 'powershell.exe';
  return process.env.SHELL || 'bash';
}

function childEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  // Keep the workstation password out of the shell's environment: a host
  // started with PROMPTPORTAL_WORKSTATION_PASSWORD set must not pass it on to
  // the shell. Values a project's .env contributed are already gone — main.ts
  // drops them from this process at startup (dropAutoloadedDotenv).
  delete env.PROMPTPORTAL_WORKSTATION_PASSWORD;
  delete env.PROMPTPORTAL_PASSWORD_STDIN;
  if (!isWindows) {
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
  }
  return env;
}

export interface SessionOptions {
  id: string;
  label: string;
  cwd: string;
  command: string;
  node?: string;
  cols?: number;
  rows?: number;
  // Raw pty bytes, before decoding and sanitizing — the host's own window.
  onRaw?: (chunk: Uint8Array) => void;
}

export class Session {
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly command: string;
  readonly node?: string;
  exitCode: number | null = null;
  private exited = false;

  private chunks: string[] = [];
  private bufferedLength = 0;
  private subscribers = new Set<(msg: Msg) => void>();
  private decoder = new TextDecoder();
  private sanitizer = new OutputSanitizer();
  private onRaw?: (chunk: Uint8Array) => void;

  private proc: Bun.Subprocess;
  private terminal!: Bun.Terminal;
  private stopConsoleGuard: () => void = () => {};
  private torndown = false;

  private inputQueue: PtyInput[] = [];
  private queuedInputBytes = 0;

  get alive(): boolean {
    return !this.exited;
  }

  constructor(opts: SessionOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.cwd = opts.cwd;
    this.command = opts.command;
    this.node = opts.node;
    this.onRaw = opts.onRaw;

    this.proc = Bun.spawn({
      cmd: [defaultShell()],
      cwd: this.cwd,
      env: childEnv(),
      terminal: {
        cols: clampDim(opts.cols || 80),
        rows: clampDim(opts.rows || 24),
        name: 'xterm-256color',
        data: (_terminal, chunk) => {
          this.onRaw?.(chunk);
          this.emitOutput(this.sanitizer.push(this.decoder.decode(chunk, { stream: true })));
        },
        // The pty stream closing (after the child exited and the tail was
        // flushed) is what ends a session, so the exit frame lands after the
        // last output.
        exit: () => void this.onPtyEnd(),
        drain: () => this.flushInput(),
      },
    });
    this.terminal = this.proc.terminal!;

    // The pty console's codepages are held at UTF-8 for the session's life —
    // see runConsoleGuard in cli/console.ts.
    this.stopConsoleGuard = spawnConsoleGuard(this.proc.pid);

    // Typed into the interactive shell rather than run via `shell -c`, so
    // the command stays visible in the terminal and a shell survives if it
    // exits.
    if (this.command.length > 0) this.write(this.command + '\r');
  }

  private async onPtyEnd(): Promise<void> {
    const code = await this.proc.exited;
    if (this.exited) return;
    // Flush what the streaming decoder and the sanitizer still hold (an
    // incomplete UTF-8 sequence, a held-back escape prefix), so the final
    // bytes reach replay and live viewers ahead of the exit frame.
    this.emitOutput(this.sanitizer.push(this.decoder.decode()) + this.sanitizer.flush());
    this.exitCode = code;
    this.exited = true;
    this.emit({ t: 'x', code });
    this.teardown();
  }

  // Buffering and delivery are one synchronous step, so a viewer attaching
  // concurrently sees every chunk exactly once: either in the replay snapshot
  // or live — never neither, never both.
  private emitOutput(data: string): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.bufferedLength += data.length;
    while (this.bufferedLength > SCROLLBACK_BYTES && this.chunks.length > 1) {
      this.bufferedLength -= this.chunks[0]!.length;
      this.chunks.shift();
    }
    this.emit({ t: 'o', d: data });
  }

  // Subscriber callbacks run synchronously, so they must not block (the
  // existing ones queue onto sockets and return). A callback that throws
  // (e.g. a log write to a broken stdout) must not unwind the pty data
  // callback — that would skip teardown.
  private emit(message: Msg): void {
    for (const fn of [...this.subscribers]) {
      try {
        fn(message);
      } catch {}
    }
  }

  // onMessage receives o/x frames, for the process's lifetime.
  subscribe(onMessage: (msg: Msg) => void): void {
    this.subscribers.add(onMessage);
  }

  // The ordered state snapshot for a (re)attaching remote viewer.
  replay(fn: (data: string, alive: boolean, exitCode: number | null) => void): void {
    fn(this.chunks.join(''), this.alive, this.exitCode);
  }

  write(data: string): void {
    this.enqueue(ENCODER.encode(data));
  }

  // Shared control is cooperative: any viewer may resize, and the pty follows
  // the most recent request. Sequential hand-off (phone, then workstation) is
  // the expected case, so this does not thrash; two viewers of different
  // sizes watching at once will tug, which is the tmux-style shared-terminal
  // cost.
  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    this.enqueue({ cols: clampDim(cols), rows: clampDim(rows) });
  }

  private enqueue(item: PtyInput): void {
    const cost = item instanceof Uint8Array ? item.byteLength : 16; // resizes are small but must not be free
    if (this.torndown || this.queuedInputBytes + cost > MAX_QUEUED_INPUT_BYTES) return;
    this.queuedInputBytes += cost;
    this.inputQueue.push(item);
    this.flushInput();
  }

  private flushInput(): void {
    while (this.inputQueue.length > 0) {
      if (this.torndown) {
        this.inputQueue = [];
        this.queuedInputBytes = 0;
        return;
      }
      const item = this.inputQueue[0]!;
      if (!(item instanceof Uint8Array)) {
        try { this.terminal.resize(item.cols, item.rows); } catch {}
        this.inputQueue.shift();
        this.queuedInputBytes -= 16;
        continue;
      }
      let written;
      try {
        written = this.terminal.write(item);
      } catch {
        return;
      }
      this.queuedInputBytes -= written;
      if (written < item.byteLength) {
        // The pty is full; keep the rest queued and let drain resume.
        this.inputQueue[0] = item.subarray(written);
        return;
      }
      this.inputQueue.shift();
    }
  }

  // Explicit teardown: kill the pty if still running. The kill flows through
  // the pty-exit path, the same as a natural exit. On Linux the SIGKILL sweep
  // runs KILL_GRACE_MS later on an unref'd timer — a caller about to exit
  // must stay up that long (see KILL_GRACE_MS).
  close(): void {
    if (this.alive) this.kill();
  }

  // SIGHUP first, like a closing terminal emulator: the polite "your terminal
  // is gone". But a process that shrugs it off — a nohup'd job, or a
  // grandchild that kept the pty open after the shell died — would keep the
  // session alive forever (alive flips only once the pty stream ends), so a
  // short grace later everything still in the child's terminal session is
  // SIGKILLed. Killing a session must not leave invisible processes running
  // on a pty nobody can reach again. Processes that daemonized into their own
  // session are, correctly, left alone.
  private kill(): void {
    if (isWindows) {
      // Killing only the shell leaves its children (a running claude/codex)
      // alive and attached to the ConPTY — the session would sit "alive" and
      // unreachable forever. taskkill /t is the sweep's Windows twin; it must
      // run while the shell still exists, since it walks parent links.
      // Processes that re-parented away are, likewise, left alone.
      try {
        Bun.spawnSync({ cmd: ['taskkill', '/t', '/f', '/pid', String(this.proc.pid)] });
      } catch {}
      this.proc.kill(); // backstop if taskkill was unavailable; no-op otherwise
      return;
    }
    try { this.proc.kill('SIGHUP'); } catch {}
    if (process.platform !== 'linux') return; // the sweep reads /proc
    const sid = this.proc.pid; // pty children lead a session whose id is their pid
    setTimeout(() => killTerminalSession(sid), KILL_GRACE_MS).unref();
  }

  private teardown(): void {
    if (this.torndown) return;
    this.torndown = true;
    this.stopConsoleGuard();
    this.inputQueue = [];
    this.queuedInputBytes = 0;
    try {
      if (!this.terminal.closed) this.terminal.close();
    } catch {}
  }

  serialize(): SessionInfo {
    return {
      id: this.id,
      label: this.label,
      cwd: this.cwd,
      command: this.command,
      node: this.node,
    };
  }
}

function killTerminalSession(sid: number): void {
  let dirs;
  try {
    dirs = fs.readdirSync('/proc');
  } catch {
    return;
  }
  for (const name of dirs) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      // "pid (comm) state ppid pgrp session ..." — comm may itself contain
      // spaces or parens, so parse from after the last ')'.
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      if (Number(fields[3]) === sid) process.kill(pid, 'SIGKILL');
    } catch {} // exited mid-scan, or not ours to signal
  }
}
