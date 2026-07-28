import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

// File logging for the long-running prompt-portal processes. Every console.log/error
// line from the launcher and from each session host is also appended to a
// shared log file under ~/.prompt-portal/logs, headed with a timestamp and the
// writer's identity — the record that survives a headless conhost (the
// launcher's logon task) or a closed session window. Console output keeps
// flowing, tag-prefixed; a windowed host mutes the console (muteConsole)
// because the pty owns that screen, and its lines then live only in the file.
//
// Rotation: two fixed files, prompt-portal.0.log and prompt-portal.1.log.
// Writers append to the active one; when it reaches LINE_LIMIT lines they move
// to the other, truncating it first. No renames — the launcher and any number
// of session hosts write concurrently, and renaming under a concurrent writer
// strands its output; with fixed names the worst race (two writers rotating in
// the same instant, double-truncating) costs a few lines once per LINE_LIMIT.
//
// Concurrency: each line is one O_APPEND write (appendFileSync opens with
// 'a'), which the kernel serializes, so concurrent writers interleave whole
// lines. Line counting is incremental — each writer reads only the bytes
// appended since it last looked — and a file that shrank means a sibling
// rotated onto it, so the count restarts. These processes log rarely enough
// that a stat and append per line costs nothing.

const LINE_LIMIT = 200_000;

export class RotatingLog {
  private readonly files: [string, string];
  private active: 0 | 1;
  private lines = 0; // newlines in the active file
  private counted = 0; // bytes of the active file those newlines came from

  constructor(dir: string, private readonly limit: number = LINE_LIMIT) {
    fs.mkdirSync(dir, { recursive: true });
    this.files = [path.join(dir, 'prompt-portal.0.log'), path.join(dir, 'prompt-portal.1.log')];
    // The active file is the most recently written one: rotation leaves the
    // full file behind with an older mtime. A missing file counts as oldest.
    // An mtime tie can pick the full file, which self-corrects on the first
    // append (it rotates to the fresh file, whose lines are under the limit,
    // so nothing is truncated).
    const mtime = (file: string) => { try { return fs.statSync(file).mtimeMs; } catch { return -1; } };
    this.active = mtime(this.files[1]) > mtime(this.files[0]) ? 1 : 0;
    this.recount();
  }

  private get file(): string {
    return this.files[this.active];
  }

  append(text: string): void {
    this.syncCount();
    this.rotateIfFull();
    const buf = Buffer.from(text.endsWith('\n') ? text : text + '\n', 'utf8');
    fs.appendFileSync(this.file, buf);
    this.lines += countNewlines(buf);
    this.counted += buf.length;
  }

  private recount(): void {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.file);
    } catch {
      buf = Buffer.alloc(0);
    }
    this.lines = countNewlines(buf);
    this.counted = buf.length;
  }

  // Fold in what other writers appended since the last look: count the
  // newlines in just the new bytes. Appends interleave whole lines, so byte
  // ranges counted exactly once cover every line exactly once, even though
  // this writer's offsets sit mid-stream. A file smaller than what was
  // already counted was truncated by a rotating sibling — recount.
  private syncCount(): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      size = 0;
    }
    if (size < this.counted) return this.recount();
    if (size === this.counted) return;
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.counted);
      const read = fs.readSync(fd, buf, 0, buf.length, this.counted);
      this.lines += countNewlines(buf.subarray(0, read));
      this.counted += read;
    } finally {
      fs.closeSync(fd);
    }
  }

  private rotateIfFull(): void {
    if (this.lines < this.limit) return;
    this.active = this.active === 0 ? 1 : 0;
    this.recount();
    // Truncate only a file that is itself full: a writer lagging behind a
    // rotation that already happened must join the fresh file, not wipe it.
    if (this.lines >= this.limit) {
      fs.writeFileSync(this.file, '');
      this.lines = 0;
      this.counted = 0;
    }
  }
}

function countNewlines(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) n++;
  return n;
}

const original = { log: console.log, error: console.error };

let log: RotatingLog | null = null;
let tag = 'prompt-portal';
let forward = true;
let patched = false;

function writeLine(text: string): void {
  try {
    log?.append(`${new Date().toISOString()} [${tag} ${process.pid}] ${text}`);
  } catch {} // logging is best-effort; a full disk must not take the session down
}

// The console line carries the tag too (`launcher: hub link established`) —
// several processes can share one console (headless hosts inherit the
// launcher's stdio in the container) — so messages never name their own
// writer; the header/prefix does.
function patchConsole(): void {
  if (patched) return;
  patched = true;
  console.log = (...args: unknown[]) => {
    const text = util.format(...args);
    writeLine(text);
    if (forward) original.log(`${tag}: ${text}`);
  };
  console.error = (...args: unknown[]) => {
    const text = util.format(...args);
    writeLine(text);
    if (forward) original.error(`${tag}: ${text}`);
  };
}

// Start file logging for this process, headed `[<who> <pid>]`. Called once,
// as the first thing the launcher and session-host commands do, so even a
// failure to read the configuration leaves a trace.
export function initLog(who: string): void {
  tag = who;
  try {
    log = new RotatingLog(path.join(os.homedir(), '.prompt-portal', 'logs'));
  } catch (err) {
    original.error(`prompt-portal: file logging disabled: ${(err as Error).message}`);
  }
  patchConsole();
  // Process lifecycle, both ends: 'exit' fires on every orderly path
  // (process.exit included); the monitor records a crash without changing
  // how it is reported.
  writeLine('process started');
  process.on('exit', (code) => writeLine(`process exiting (code ${code})`));
  process.on('uncaughtExceptionMonitor', (err) => {
    writeLine(`crashing: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });
}

// Name the session in the header once its id is known, so interleaved lines
// from concurrent sessions stay tellable apart.
export function setLogTag(who: string): void {
  tag = who;
}

// A windowed host's terminal belongs to the pty: everything logged still
// reaches the file, nothing scribbles over the live screen.
export function muteConsole(): void {
  forward = false;
  patchConsole();
}
