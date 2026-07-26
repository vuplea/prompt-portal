// Windows console plumbing (bun:ffi against kernel32; the host-facing entry
// points no-op elsewhere): the windowed host's own console is configured for
// raw VT relay, and each session's pty console gets a guard process that
// holds its codepages at UTF-8.

import { selfArgv } from './config';

const STD_OUTPUT_HANDLE = -11;
const DISABLE_NEWLINE_AUTO_RETURN = 0x0008;
const CP_UTF8 = 65001;

// How often the guard re-asserts UTF-8. Output written while a stale
// codepage holds is garbled for good — it enters scrollback already
// translated — so the window is kept small; the steady state is two reads.
const GUARD_POLL_MS = 250;

function kernel32() {
  const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi');
  return dlopen('kernel32.dll', {
    GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
    GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    FreeConsole: { args: [], returns: FFIType.i32 },
    AttachConsole: { args: [FFIType.u32], returns: FFIType.i32 },
    GetConsoleCP: { args: [], returns: FFIType.u32 },
    GetConsoleOutputCP: { args: [], returns: FFIType.u32 },
    SetConsoleCP: { args: [FFIType.u32], returns: FFIType.i32 },
    SetConsoleOutputCP: { args: [FFIType.u32], returns: FFIType.i32 },
  }).symbols;
}

// The windowed host relays raw VT between the session's pty and this
// console, so the console must speak the stream's language:
//
// - A Windows console's default output mode turns a bare LF into CR+LF
//   ("auto return"), but ConPTY's re-serialized stream positions text with
//   bare LFs and expects the column to hold — auto return shifts such text
//   to column 1, into cells the source screen never repaints, which lingers
//   as ghost characters (e.g. in the two-column gutter of Claude Code's
//   fullscreen renderer). DISABLE_NEWLINE_AUTO_RETURN restores standard VT
//   line-feed semantics; ssh.exe sets it for the same reason.
//
// - The relayed stream is UTF-8 both ways (the pty stream is decoded as
//   UTF-8, local keystrokes are decoded as UTF-8), while a console starts on
//   the OEM codepage, which garbles byte-oriented reads and writes of
//   non-ASCII. Only this process writes through the console while the host
//   runs, so setting the codepages once is enough — no guard needed here.
export function configureHostConsole(): void {
  if (process.platform !== 'win32') return;
  const k32 = kernel32();
  const { ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const prevOut = Number(k32.GetConsoleOutputCP());
  const prevIn = Number(k32.GetConsoleCP());
  k32.SetConsoleOutputCP(CP_UTF8);
  k32.SetConsoleCP(CP_UTF8);
  // In a pre-existing terminal (a direct `promptportal` run) the console — and its
  // codepages — outlive this process, so what was found is put back on exit;
  // a hub-opened window dies with the host, where the restore is moot.
  // Console modes need no such care: shells re-assert theirs every prompt.
  if (prevOut !== 0) {
    process.on('exit', () => {
      k32.SetConsoleOutputCP(prevOut);
      k32.SetConsoleCP(prevIn);
    });
  }
  const handle = k32.GetStdHandle(STD_OUTPUT_HANDLE);
  if (!handle) return;
  const mode = new Uint32Array(1);
  if (!k32.GetConsoleMode(handle, ptr(mode))) return; // stdout is not a console
  k32.SetConsoleMode(handle, mode[0]! | DISABLE_NEWLINE_AUTO_RETURN);
}

// `promptportal console-guard <shell-pid>` (internal) — hold a session pty
// console's codepages at UTF-8, from a process of its own: SetConsoleCP acts
// on the caller's attached console, and a host must stay attached to the
// window it renders into.
//
// Why hold them: ConPTY re-encodes what a client writes through the
// byte-oriented console APIs using the console's output codepage. The
// console starts on the OEM codepage, and every process attached to it can
// change it at any time — tool children spawned inside the session share the
// console and routinely do (MSYS runtimes set UTF-8, scripts run chcp, and
// concurrent children restore stale values over each other). A client that
// writes raw UTF-8 bytes (Claude Code's native build) turns into per-byte
// OEM mojibake ("ΓÇª" for "…") whenever a stale codepage holds. Pinning
// UTF-8 makes the pty console match what the rest of the pipeline already
// assumes: the session decodes the ConPTY stream as UTF-8, and viewers
// render it as UTF-8.
export async function runConsoleGuard(shellPid: number): Promise<never> {
  const k32 = kernel32();
  k32.FreeConsole();
  if (!k32.AttachConsole(shellPid >>> 0)) process.exit(0); // shell already gone
  // The console closing (the session ending) delivers CTRL_CLOSE_EVENT,
  // which ends this process. A console-wide Ctrl+C does not (it reaches a
  // Bun child disabled or ignored; the ignore below is insurance should that
  // change). A console-wide Ctrl+Break DOES end it — Bun gives a handler no
  // way to veto the default termination — so surviving that is the host's
  // job: spawnConsoleGuard restarts a guard that dies while the session
  // lives.
  process.on('SIGINT', () => {});
  // Corrections are logged — the record that names the culprit's codepage
  // and moment when a mojibake report comes in — but only on a change of
  // reading, so a program re-asserting its codepage every tick cannot flood
  // the log.
  let lastOut = CP_UTF8;
  let lastIn = CP_UTF8;
  while (true) {
    const out = Number(k32.GetConsoleOutputCP());
    if (out === 0) process.exit(0); // console gone
    if (out !== CP_UTF8) {
      k32.SetConsoleOutputCP(CP_UTF8);
      if (out !== lastOut) console.log(`corrected output codepage ${out} -> ${CP_UTF8}`);
    }
    lastOut = out;
    const inp = Number(k32.GetConsoleCP());
    if (inp !== CP_UTF8) {
      k32.SetConsoleCP(CP_UTF8);
      if (inp !== lastIn) console.log(`corrected input codepage ${inp} -> ${CP_UTF8}`);
    }
    lastIn = inp;
    await Bun.sleep(GUARD_POLL_MS);
  }
}

// Start (and keep) a guard for the pty whose shell is `shellPid`. Best
// effort: a session works without one (modulo mojibake), so a failure is
// logged, not raised. A guard can be killed from inside the session — a
// console-wide Ctrl+Break reaches every process attached to the pty console,
// and the guard cannot ignore it — so one that dies while the session lives
// is restarted; exit 0 means the console itself is gone, where a restart
// would just churn. Returns the stopper the session calls at teardown.
export function spawnConsoleGuard(shellPid: number): () => void {
  if (process.platform !== 'win32') return () => {};
  let stopped = false;
  let proc: Bun.Subprocess | null = null;
  const start = () => {
    if (stopped) return;
    try {
      proc = Bun.spawn({
        cmd: selfArgv(['console-guard', String(shellPid)]),
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      });
      proc.unref();
      // Ties the session's log lines to the guard's own (tagged with its pid).
      console.log(`console guard started (pid ${proc.pid})`);
      proc.exited.then((code) => {
        if (stopped || code === 0) return;
        console.log(`console guard died (code ${code}); restarting`);
        setTimeout(start, 1000).unref();
      });
    } catch (err) {
      console.log(`console guard failed to start: ${(err as Error).message}`);
    }
  };
  start();
  return () => {
    stopped = true;
    try { proc?.kill(); } catch {}
  };
}
