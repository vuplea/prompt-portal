import { expect, test } from 'bun:test';
import os from 'node:os';

import type { Msg } from '../lib/protocol';
import { Session } from '../cli/session';

// One real shell on one real pty — slow (a shell start) but this is the
// heart of the workstation, so it earns its seconds.

async function until(what: string, probe: () => boolean, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (probe()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
}

test('streams output live, replays it, and emits the exit frame on close', async () => {
  const session = new Session({ id: 't1', label: 't1', cwd: os.tmpdir(), command: '' });
  const frames: Msg[] = [];
  session.subscribe((msg) => frames.push(msg));

  session.write('echo pt_marker_1\r');
  await until('command output', () =>
    frames.some((f) => f.t === 'o' && String(f.d).includes('pt_marker_1')));

  // The scrollback ring must serve the same bytes to a late viewer.
  let replayed = '';
  let wasAlive = false;
  session.replay((data, alive) => {
    replayed = data;
    wasAlive = alive;
  });
  expect(replayed).toContain('pt_marker_1');
  expect(wasAlive).toBe(true);

  // Out-of-range resizes reach the pty clamped to sane bounds; spy on the
  // terminal handle to capture what is actually applied.
  const applied: Array<[number, number]> = [];
  const terminal = (session as any).terminal;
  (session as any).terminal = {
    resize(c: number, r: number) { applied.push([c, r]); terminal.resize(c, r); },
    write(data: Uint8Array) { return terminal.write(data); },
  };
  session.resize(0, 0);
  session.resize(10000, 10000);
  session.resize(120, 30);
  await until('clamped resizes applied', () => applied.length === 3);
  expect(applied).toEqual([[2, 2], [1000, 1000], [120, 30]]);
  (session as any).terminal = terminal;

  session.close();
  await until('exit frame', () => frames.some((f) => f.t === 'x'));
  expect(session.alive).toBe(false);
  session.replay((_data, alive, exitCode) => {
    expect(alive).toBe(false);
    expect(typeof exitCode).toBe('number');
  });
}, 40000);

// The console guard must undo codepage changes made by processes inside the
// session (see runConsoleGuard in cli/console.ts). chcp both sets and
// reports the codepages, so the whole exchange can run through the pty itself.
// chcp's message text is localized; ": <n>" is its language-independent core,
// and the bare `chcp` query echoes no digits, so a numeric match can only be
// a response.
const windowsTest = process.platform === 'win32' ? test : test.skip;
windowsTest('holds the pty console codepages at UTF-8, through console ctrl events', async () => {
  const session = new Session({ id: 't2', label: 't2', cwd: os.tmpdir(), command: '' });
  const frames: Msg[] = [];
  session.subscribe((msg) => frames.push(msg));
  const output = () => frames.filter((f) => f.t === 'o').map((f) => String(f.d)).join('');

  const guardCorrects = async (phase: string) => {
    const from = output().length;
    session.write('chcp 850\r');
    await until(`chcp 850 ack (${phase})`, () => /:\s*850\b/.test(output().slice(from)));
    // Re-ask until the guard has flipped it back.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !/\b65001\b/.test(output().slice(from))) {
      session.write('chcp\r');
      await Bun.sleep(600);
    }
    expect(output().slice(from)).toMatch(/\b65001\b/);
  };

  await guardCorrects('fresh session');

  // Codepage protection must outlive console-wide ctrl events, which reach
  // every process attached to the pty console: Ctrl+C does not end the guard,
  // and Ctrl+Break does — the guard cannot ignore it — which the host heals
  // by restarting it (see spawnConsoleGuard). Raw \x03 through the pty does
  // not raise the events in this harness, so raise both from inside the
  // session.
  const from = output().length;
  session.write('Add-Type -Namespace T -Name K -MemberDefinition '
    + '\'[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint t, uint p);\''
    + '; [T.K]::GenerateConsoleCtrlEvent(0, 0); [T.K]::GenerateConsoleCtrlEvent(1, 0)\r');
  await until('ctrl events raised', () => output().slice(from).includes('True'));
  await Bun.sleep(500); // the events land async, and flush pending console input
  await guardCorrects('after Ctrl+C');

  session.close();
  await until('exit frame', () => frames.some((f) => f.t === 'x'));
}, 60000);
