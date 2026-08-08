import path from 'node:path';

import { SESSION_PROTOCOL } from '../lib/protocol';
import { isWindows, resolveExistingDir } from './config';
import { configureHostConsole } from './console';
import { maintainLink, type Post } from './link';
import { muteConsole, setLogTag } from './log';
import { InputScheduler } from './schedule';
import { KILL_GRACE_MS, Session } from './session';

// `prompt-portal` — one session, one process. Owns the pty, renders it natively in the
// terminal it was started in (the window *is* the session: closing it kills
// the shell, always), and dials the hub on its own outbound WebSocket so the
// same screen is watchable and drivable from the browser. Spawned headless
// (no terminal on stdio) it is the same thing without a local view — how the
// launcher hosts sessions in the workstation container.
//
// The session dies with this process, and only with it: the shell exiting,
// SIGHUP (the window closing), or a kill from the hub.

export interface HostSpec {
  id?: string;
  label?: string;
  cwd?: string;
  command?: string;
  // Launcher specs pin the session's hub context (see launcher.ts); a
  // locally started `prompt-portal` takes both from the environment instead.
  hubUrl?: string;
  node?: string;
}

export interface HostContext {
  hubUrl: string; // normalized ws(s) URL, '' to run unlinked
  password: string;
  node: string;
}

// The Esc key from a remote viewer, in win32-input-mode encoding (keydown +
// keyup). ConPTY asks its terminal for win32-input-mode, and once the local
// window has typed anything, conhost holds a bare 0x1b as an incomplete
// sequence — the phone's Esc dies silently while printable keys and complete
// sequences (arrows) keep working. The win32 encoding is parsed exactly in
// every parser state; longer ESC-prefixed frames are real sequences and must
// pass through untouched.
const WIN32_INPUT_ESC = '\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_';

// "Take control back" must mean a person at the workstation. The window's
// size changes with nobody at the desk — monitors detaching on sleep
// collapse the desktop to a stub display and Windows resizes every window —
// and the console can feed this process bytes nobody typed (focus reports,
// query replies). Following those yanks the shared pty away from a phone
// viewer while the machine sits locked; the browser client deduplicates its
// resize sends, so the theft sticks until the viewer reattaches. Physical
// keyboard/mouse input in this session within this window is what counts as
// presence.
const LOCAL_PRESENCE_MS = 30_000;

// Whether the session's last physical input (GetLastInputInfo) is recent.
// Anywhere the question cannot be asked (non-Windows, FFI failure) counts as
// present, which keeps the plain follow-the-window behavior.
function makeLocalPresenceProbe(): () => boolean {
  if (!isWindows) return () => true;
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const user32 = dlopen('user32.dll', {
      GetLastInputInfo: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
    const kernel32 = dlopen('kernel32.dll', {
      GetTickCount: { args: [], returns: FFIType.u32 },
    }).symbols;
    const info = new Uint32Array([8, 0]); // LASTINPUTINFO { cbSize, dwTime }
    return () => {
      if (!user32.GetLastInputInfo(ptr(info))) return true;
      // >>> 0 keeps the subtraction correct across GetTickCount's 49-day wrap.
      return ((Number(kernel32.GetTickCount()) - info[1]!) >>> 0) < LOCAL_PRESENCE_MS;
    };
  } catch {
    return () => true;
  }
}

export async function runHost(spec: HostSpec, ctx: HostContext): Promise<never> {
  const cwd = resolveExistingDir(spec.cwd || process.cwd());
  const command = spec.command ?? '';
  const label = spec.label || command || path.basename(cwd) || 'shell';

  const windowed = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (windowed) {
    // From here on the terminal belongs to the pty; link chatter (reconnect
    // notices and the like) would scribble over the live screen, so console
    // output goes only to the log file. What must reach the user is written
    // straight to stdout as terminal output.
    muteConsole();
    configureHostConsole();
  }

  const id = spec.id || crypto.randomUUID();
  setLogTag(`session ${id.slice(0, 8)}`);
  // JSON.stringify: these may come from the phone via the hub — control
  // characters must not reach the log raw (same as launcher.ts).
  console.log(`starting: id ${id}, label ${JSON.stringify(label)}, cwd ${JSON.stringify(cwd)}`
    + (command ? `, command ${JSON.stringify(command)}` : '') + (windowed ? ', windowed' : ', headless'));

  const session = new Session({
    id,
    label,
    cwd,
    command,
    node: ctx.node,
    cols: windowed ? process.stdout.columns : undefined,
    rows: windowed ? process.stdout.rows : undefined,
    onRaw: windowed ? (chunk) => process.stdout.write(chunk) : undefined,
  });

  // Resolves once the pty has ended and its {t:'x'} frame has been emitted (and
  // so posted to the hub, below), letting shutdown wait for a watching viewer
  // to get the exit banner rather than an abrupt socket drop.
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
  session.subscribe((msg) => {
    if (msg.t !== 'x') return;
    console.log(`shell exited (code ${msg.code})`);
    resolveExited();
  });

  // Every exit path funnels here: kill the shell's whole tree first, so
  // closing the window never leaves invisible processes on a pty nobody can
  // reach again.
  let shuttingDown = false;
  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`shutting down (${reason})`);
    const sweeping = process.platform === 'linux' && session.alive;
    session.close();
    if (sweeping) {
      // Stay up for the SIGKILL sweep (KILL_GRACE_MS) — it, not the exit here,
      // is what clears SIGHUP-immune children — plus a moment for it to land.
      await Bun.sleep(KILL_GRACE_MS + 200);
    } else if (session.alive) {
      // The kill took the whole tree synchronously (taskkill /t on Windows);
      // wait for the pty's exit frame to reach the hub, then a beat to flush it.
      await Promise.race([exited, Bun.sleep(2000)]);
      await Bun.sleep(100);
    }
    process.exit(0);
  }

  // The window closing delivers SIGHUP (on Windows, the console's
  // CTRL_CLOSE_EVENT arrives as SIGHUP with a few seconds' grace) — the
  // moment the requirement "window close = session dead" is enforced.
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  if (!windowed) process.on('SIGINT', () => void shutdown('SIGINT'));

  // The shell exiting ends the session, exactly like any terminal: the host
  // exits with the shell's code (so the window closes, or Windows Terminal
  // shows its native exit banner for a failure, per closeOnExit). The delay
  // lets the exit frame reach the hub first, so an attached viewer sees the
  // banner before the vanishing session sends it home. During an explicit
  // shutdown the exit is shutdown()'s to make: exiting from here would beat
  // the SIGKILL sweep and leave SIGHUP-immune children running invisibly.
  session.subscribe((msg) => {
    if (msg.t !== 'x' || shuttingDown) return;
    setTimeout(() => process.exit(typeof msg.code === 'number' ? msg.code : 0), 500);
  });

  // A remote viewer resizing the shared pty is invisible to the window poll
  // below; the windowed host records it here so typing locally can take the
  // size back (see the stdin handler).
  let noteRemoteResize = (_cols: number, _rows: number) => {};

  if (windowed) {
    // Title the window after the session, so hub-started windows are
    // tellable apart in the taskbar. Best effort: the shell may retitle it.
    process.stdout.write(`\x1b]0;${label.replace(/[\x00-\x1f\x7f]/g, ' ')}\x07`);

    // The pty follows whichever end shaped it last (the tmux-style shared-
    // terminal cost). ptyCols/ptyRows remember the last size it was given
    // from either end, so a keystroke here can tell that a remote viewer
    // reshaped it and take the size back — "take control back" is typing,
    // not wiggling the window.
    let ptyCols = process.stdout.columns;
    let ptyRows = process.stdout.rows;
    noteRemoteResize = (c, r) => { ptyCols = c; ptyRows = r; };
    const resizeToWindow = (c: number, r: number) => {
      ptyCols = c;
      ptyRows = r;
      session.resize(c, r);
    };

    const locallyPresent = makeLocalPresenceProbe();

    // Keystrokes go to the pty as raw bytes, Ctrl-C included, the way ssh
    // does it. The bytes are decoded through a streaming decoder so a
    // multi-byte character split across reads survives. The size take-back is
    // gated on presence: stdin also carries bytes nobody typed (focus
    // reports, terminal query replies), which must not steal the pty from a
    // remote viewer.
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const decoder = new TextDecoder();
    process.stdin.on('data', (chunk: Buffer) => {
      const { columns: c, rows: r } = process.stdout;
      if (locallyPresent() && c && r && (c !== ptyCols || r !== ptyRows)) resizeToWindow(c, r);
      const text = decoder.decode(chunk, { stream: true });
      if (text.length > 0) session.write(text);
    });
    process.stdin.on('end', () => void shutdown('terminal closed')); // terminal gone without a signal

    // The console gives no reliable resize signal everywhere; poll and
    // follow the window. Compared against the window's own last size, not
    // the pty's: a remote viewer's resize must hold until the window
    // actually changes (or a key is typed here) — not be fought within
    // 250ms. Presence-gated like the stdin path: the system resizes windows
    // on its own (display sleep, DPI changes), and only a change the local
    // user could have made may take the pty. While away the remembered size
    // goes stale on purpose — the first poll tick after the user returns
    // sees the difference and takes the size back.
    let cols = process.stdout.columns;
    let rows = process.stdout.rows;
    setInterval(() => {
      const { columns: c, rows: r } = process.stdout;
      if (locallyPresent() && c && r && (c !== cols || r !== rows)) {
        cols = c;
        rows = r;
        resizeToWindow(c, r);
      }
    }, 250).unref();
  }

  if (!ctx.hubUrl) {
    if (windowed) {
      process.stdout.write('\x1b[90m[not linked to a hub — set PROMPTPORTAL_HUB_URL]\x1b[0m\r\n');
    }
    return new Promise(() => {}); // a local-only terminal until the window closes
  }

  // The hub link. Output streams only while some browser is watching (the
  // hub sends watch/unwatch as viewers come and go); the scrollback ring in
  // the Session serves the replay snapshot regardless, so gating only saves
  // bandwidth, never history.
  let watchCount = 0;
  let post: Post | null = null;
  session.subscribe((msg) => {
    if (!post) return;
    if (msg.t === 'o' && watchCount > 0) post(msg);
    else if (msg.t === 'x') post(msg);
  });

  // Remote input, typed or scheduled, in one place — so a scheduled Esc gets
  // the same win32-input-mode translation a typed one does.
  const writeInput = (data: string) => {
    session.write(isWindows && data === '\x1b' ? WIN32_INPUT_ESC : data);
  };

  // Scheduled inputs (cli/schedule.ts) are held here, not on the hub or the
  // page, so they fire straight into the pty whatever the link is doing.
  // Watchers mirror the pending list: they get it on attach and after every
  // change; while the link is down there is nobody to tell, and the next
  // attach resyncs.
  const scheduler = new InputScheduler(
    writeInput,
    () => post?.({ t: 'scheds', scheds: scheduler.list() }),
  );

  return maintainLink(`${ctx.hubUrl}/session`, SESSION_PROTOCOL, ctx.password, {
    onOpen(p) {
      p({ t: 'register', session: session.serialize() });
      post = p;
      watchCount = 0;
    },
    onMessage(msg, p) {
      switch (msg.t) {
        case 'watch':
          watchCount += 1;
          console.log(`viewer attached (${watchCount} watching)`);
          session.replay((data, alive, exitCode) => {
            p({ t: 's', client: msg.client, d: data });
            if (!alive) p({ t: 'x', client: msg.client, code: exitCode });
          });
          // Sent even when empty, so the attaching view starts from truth
          // rather than whatever it last saw.
          p({ t: 'scheds', client: msg.client, scheds: scheduler.list() });
          break;
        case 'unwatch':
          watchCount = Math.max(0, watchCount - 1);
          console.log(`viewer detached (${watchCount} watching)`);
          break;
        case 'i':
          if (typeof msg.d === 'string') writeInput(msg.d);
          break;
        case 'r':
          if (typeof msg.c === 'number' && typeof msg.r === 'number') {
            noteRemoteResize(msg.c, msg.r);
            session.resize(msg.c, msg.r);
          }
          break;
        case 'sched':
          // Accepted mutations broadcast from the scheduler itself. A
          // rejected add re-sends the unchanged list — no rejection signal,
          // just the standing truth: a row that never appears was never
          // scheduled.
          if (!scheduler.add(msg.d, msg.delay, msg.esc)) p({ t: 'scheds', scheds: scheduler.list() });
          break;
        case 'unsched':
          scheduler.remove(msg.id);
          break;
        case 'kill':
          void shutdown('hub kill');
          break;
      }
    },
    onClose() {
      post = null;
      watchCount = 0;
    },
  });
}
