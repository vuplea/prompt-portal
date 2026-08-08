// End-to-end over the real wire: a real hub, real session hosts (real
// shells on real ptys), a real launcher — driven purely through the HTTP API
// and the browser WebSocket protocol, the way the phone drives production.
// No terminal windows and no Credential Manager, so it runs the same on a
// Windows desktop and in the Linux container.
//
// Not part of `bun test` (it spawns processes and owns a port); run it with:
//   bun run test:e2e

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BROWSER_PROTOCOL } from '../lib/protocol';

const REPO = path.resolve(import.meta.dir, '..');
const PORT = 18000 + (process.pid % 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'prompt-portal-e2e-not-a-real-secret'; // web access
const NODE_PASS = 'prompt-portal-e2e-workstation-secret'; // workstation registration
const NODE = 'e2e';
const CWD = os.tmpdir();
const AUTH = 'Basic ' + Buffer.from(`promptportal:${PASS}`).toString('base64');

const children: Bun.Subprocess[] = [];
let dataDir = '';

function cleanup(): void {
  for (const child of children) try { child.kill(); } catch {}
  if (dataDir) try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}

function fail(message: string): never {
  console.error(`E2E FAIL: ${message}`);
  cleanup();
  process.exit(1);
}

function spawn(label: string, args: string[], env: Record<string, string> = {}): Bun.Subprocess {
  const proc = Bun.spawn({
    cmd: [process.execPath, ...args],
    cwd: REPO,
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  for (const stream of [proc.stdout, proc.stderr]) {
    (async () => {
      const reader = (stream as ReadableStream).getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.trim()) console.log(`  [${label}] ${line.trim()}`);
        }
      }
    })();
  }
  children.push(proc);
  return proc;
}

function spawnHost(label: string): Bun.Subprocess {
  const spec = Buffer.from(JSON.stringify({ label, cwd: CWD })).toString('base64url');
  return spawn(label, ['cli/main.ts', 'run', '--spec', spec], {
    PROMPTPORTAL_HUB_URL: BASE, PROMPTPORTAL_WORKSTATION_PASSWORD: NODE_PASS, PROMPTPORTAL_NODE_NAME: NODE,
  });
}

async function api(pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await Bun.sleep(200);
  }
  return fail(`timeout waiting for ${what}`);
}

async function raceOk(p: Promise<unknown>, ms: number, what: string): Promise<void> {
  let ok = false;
  await Promise.race([p.then(() => { ok = true; }), Bun.sleep(ms)]);
  if (!ok) fail(`timeout waiting for ${what}`);
}

const listedSession = (label: string) => async () => {
  const { body } = await api('/api/state');
  return body?.sessions?.find((s: { label: string }) => s.label === label);
};

const goneFromList = (id: string) => async () => {
  const { body } = await api('/api/state');
  return Array.isArray(body?.sessions) && !body.sessions.some((s: { id: string }) => s.id === id);
};

// A scripted stand-in for the phone: token auth, then the s/o/x | i/r frames.
async function attachViewer(id: string) {
  const { body } = await api('/api/token');
  const frames: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${id}`, [BROWSER_PROTOCOL, body.token]);
  let onClose = () => {};
  const closed = new Promise<void>((resolve) => { onClose = resolve; });
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  ws.onclose = () => onClose();
  await until('viewer socket open', 5000, async () => ws.readyState === WebSocket.OPEN);
  return { ws, frames, closed };
}

// ------------------------------------------------------------------- hub
dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-portal-e2e-'));
// Through the `hub` subcommand rather than server.ts directly, so the e2e
// also proves the path `bunx prompt-portal hub` takes.
spawn('hub', ['cli/main.ts', 'hub'], {
  PROMPTPORTAL_PORT: String(PORT), PROMPTPORTAL_HOST: '127.0.0.1', PROMPTPORTAL_WEBACCESS_PASSWORD: PASS,
  PROMPTPORTAL_WORKSTATION_PASSWORD: NODE_PASS, PROMPTPORTAL_DATA: dataDir,
});
await until('hub up', 10000, async () => (await fetch(BASE, { headers: { Authorization: AUTH } })).ok);
console.log('OK hub up');

// -------------------------------------------- session lifecycle, hub kill
const host = spawnHost('e2e-io');
const session = await until('session registered', 15000, listedSession('e2e-io'));
if (session.node !== NODE) fail(`bad session info: ${JSON.stringify(session)}`);
console.log('OK host registered');

const a = await attachViewer(session.id);
await until('replay snapshot', 5000, async () => a.frames.some((f) => f.t === 's'));
a.ws.send(JSON.stringify({ t: 'i', d: 'echo pt_e2e_marker\r' }));
a.ws.send(JSON.stringify({ t: 'r', c: 100, r: 30 }));
await until('command output on the live stream', 30000, async () =>
  a.frames.some((f) => f.t === 'o' && String(f.d).includes('pt_e2e_marker')));
console.log('OK input/output through the browser protocol');

const b = await attachViewer(session.id);
await until('second viewer replay includes scrollback', 10000, async () =>
  b.frames.some((f) => f.t === 's' && String(f.d).includes('pt_e2e_marker')));
console.log('OK second viewer replay');

// ------------------------------------------------------- scheduled input
// The marker appears contiguously only in the command's output — the typed
// line carries a $() in the middle (empty expansion in PowerShell and bash
// alike) — so seeing it proves the schedule fired AND the Enter submitted.
a.ws.send(JSON.stringify({ t: 'sched', d: 'echo pt_e2e_sch$()ed', delay: 1500 }));
await until('pending schedule fanned out to every viewer', 5000, async () =>
  b.frames.some((f) => f.t === 'scheds' && f.scheds?.length === 1));
await until('scheduled command ran', 30000, async () =>
  a.frames.some((f) => f.t === 'o' && String(f.d).includes('pt_e2e_sched')));

const cancelMarker = 'pt_e2e_never';
a.ws.send(JSON.stringify({ t: 'sched', d: cancelMarker, delay: 3600 * 1000, esc: true }));
const sched = await until('far-future schedule fanned out with its esc flag', 5000, async () =>
  b.frames.filter((f) => f.t === 'scheds').at(-1)?.scheds?.find((s: any) => s.d === cancelMarker && s.esc === true));
a.ws.send(JSON.stringify({ t: 'unsched', id: sched.id }));
await until('canceled schedule gone from the fan-out', 5000, async () => {
  const last = b.frames.filter((f) => f.t === 'scheds').at(-1);
  return last && !last.scheds.some((s: any) => s.d === cancelMarker);
});
console.log('OK scheduled input: fires text then Enter, fans out, cancels');

const del = await api('/api/sessions/delete', { id: session.id });
if (del.status !== 200) fail(`delete returned ${del.status}`);
await raceOk(Promise.all([a.closed, b.closed]), 5000, 'viewers closed after kill');
await raceOk(host.exited, 5000, 'host exit after kill');
await until('killed session gone from the list', 5000, goneFromList(session.id));
console.log('OK kill from the hub: viewers closed, host exited, list empty');

// -------------------------------------------------------------- shell exit
const exitHost = spawnHost('e2e-exit');
const exitSession = await until('exit-test session registered', 15000, listedSession('e2e-exit'));
const c = await attachViewer(exitSession.id);
await until('exit-test replay', 5000, async () => c.frames.some((f) => f.t === 's'));
c.ws.send(JSON.stringify({ t: 'i', d: 'exit\r' }));
await until('exit frame reached the viewer', 30000, async () =>
  c.frames.some((f) => f.t === 'x' && typeof f.code === 'number'));
await raceOk(exitHost.exited, 5000, 'host exit after the shell exited');
await until('shell-exited session gone from the list', 5000, goneFromList(exitSession.id));
console.log('OK shell exit ends the session everywhere');

// --------------------------------------------------------------- launcher
spawn('launcher', ['cli/main.ts', 'launcher'], {
  PROMPTPORTAL_HUB_URL: BASE, PROMPTPORTAL_WORKSTATION_PASSWORD: NODE_PASS, PROMPTPORTAL_NODE_NAME: NODE,
});
await until('launcher registered', 10000, async () => {
  const { body } = await api('/api/state');
  return body?.nodes?.includes(NODE);
});
console.log('OK launcher registered');

const badCreate = await api('/api/sessions', { cwd: path.join(CWD, 'prompt-portal-e2e-definitely-missing') });
if (badCreate.status !== 400 || !String(badCreate.body?.error).includes('does not exist')) {
  fail(`bad-cwd create: ${badCreate.status} ${JSON.stringify(badCreate.body)}`);
}
console.log('OK create error path through the launcher');

console.log('\nE2E PASS');
cleanup();
process.exit(0);
