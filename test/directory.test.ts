import { describe, expect, test } from 'bun:test';

import { Directory } from '../lib/directory';
import { MAX_FIELD_CHARS, type Msg, type SessionInfo } from '../lib/protocol';

// The minimal socket surface the directory touches, recording sent frames.
function fakeSocket(kind: 'session' | 'launcher' | 'browser') {
  const frames: Msg[] = [];
  const socket = {
    readyState: 1,
    data: { kind, clientId: null as string | null },
    send: (data: string) => frames.push(JSON.parse(data)),
    getBufferedAmount: () => 0,
    close: () => { socket.readyState = 3; },
    terminate: () => { socket.readyState = 3; },
  };
  return { socket, frames };
}

function info(id: string): SessionInfo {
  return { id, label: id, cwd: '/tmp', command: '', node: 'ws1' };
}

function register(directory: Directory, id: string) {
  const { socket, frames } = fakeSocket('session');
  const conn = directory.registerSession(socket as any, info(id))!;
  expect(conn).not.toBeNull();
  return { conn, socket, frames };
}

describe('registerSession', () => {
  test('lists registered sessions and rejects malformed registrations', () => {
    const directory = new Directory();
    register(directory, 's1');
    expect(directory.registerSession(fakeSocket('session').socket as any, { label: 'no id' })).toBeNull();
    expect(directory.listSessions().map((s) => s.id)).toEqual(['s1']);
  });

  test('serves only the known fields, truncated to the shared cap', () => {
    const directory = new Directory();
    const oversized = 'x'.repeat(MAX_FIELD_CHARS + 100);
    const conn = directory.registerSession(fakeSocket('session').socket as any,
      { ...info('s1'), label: oversized, extra: 'smuggled' } as any);
    expect(conn).not.toBeNull();
    const listed = directory.listSessions()[0]!;
    expect(listed.label).toBe(oversized.slice(0, MAX_FIELD_CHARS));
    expect('extra' in listed).toBe(false);
    // An oversized id is malformed, not truncated: a truncated id could
    // collide with another session's.
    expect(directory.registerSession(fakeSocket('session').socket as any, info(oversized))).toBeNull();
  });

  test('a re-registration replaces the previous socket', () => {
    const directory = new Directory();
    const first = register(directory, 's1');
    const second = register(directory, 's1');
    expect(first.socket.readyState).toBe(3); // terminated
    expect(directory.get('s1')).toBe(second.conn);
    // The stale socket's close must not evict the replacement.
    directory.unregisterSession(first.conn);
    expect(directory.get('s1')).toBe(second.conn);
  });
});

describe('watchers', () => {
  test('fan out live output, target snapshots, and close when the session dies', () => {
    const directory = new Directory();
    const { conn, frames: host } = register(directory, 's1');
    const a = fakeSocket('browser');
    const b = fakeSocket('browser');
    conn.attachBrowser(a.socket as any);
    conn.attachBrowser(b.socket as any);
    expect(host.filter((f) => f.t === 'watch')).toHaveLength(2);

    // Live output reaches every watcher; a snapshot only its addressee.
    conn.handleMessage({ t: 'o', d: 'out' });
    conn.handleMessage({ t: 's', d: 'snap', client: b.socket.data.clientId! });
    expect(a.frames).toEqual([{ t: 'o', d: 'out' }]);
    expect(b.frames).toEqual([{ t: 'o', d: 'out' }, { t: 's', d: 'snap' }]);

    // A detached watcher stops receiving and the host is told.
    conn.detachBrowser(a.socket.data.clientId, a.socket as any);
    expect(host.at(-1)).toMatchObject({ t: 'unwatch' });
    conn.handleMessage({ t: 'o', d: 'more' });
    expect(a.frames).toHaveLength(1);

    // The session's socket closing takes the remaining watchers down.
    directory.unregisterSession(conn);
    expect(b.socket.readyState).toBe(3);
    expect(directory.listSessions()).toEqual([]);
  });

  test('an exit frame reaches watchers', () => {
    const directory = new Directory();
    const { conn } = register(directory, 's1');
    const a = fakeSocket('browser');
    conn.attachBrowser(a.socket as any);
    conn.handleMessage({ t: 'x', code: 3 });
    expect(a.frames).toEqual([{ t: 'x', code: 3 }]);
  });

  test('relays schedule frames: management to the host, the list to watchers', () => {
    const directory = new Directory();
    const { conn, frames: host } = register(directory, 's1');
    const a = fakeSocket('browser');
    const b = fakeSocket('browser');
    conn.attachBrowser(a.socket as any);
    conn.attachBrowser(b.socket as any);

    // Management flows to the host — the esc flag only as a literal true —
    // and malformed frames do not.
    conn.handleBrowserMessage({ t: 'sched', d: 'go', delay: 60_000 });
    conn.handleBrowserMessage({ t: 'sched', d: 'esc', delay: 60_000, esc: true });
    conn.handleBrowserMessage({ t: 'sched', d: 'junk esc', delay: 60_000, esc: 'yes' as any });
    conn.handleBrowserMessage({ t: 'sched', d: 'no delay' });
    conn.handleBrowserMessage({ t: 'unsched', id: 'sid' });
    conn.handleBrowserMessage({ t: 'unsched' });
    expect(host.filter((f) => f.t === 'sched')).toEqual([
      { t: 'sched', d: 'go', delay: 60_000 },
      { t: 'sched', d: 'esc', delay: 60_000, esc: true },
      { t: 'sched', d: 'junk esc', delay: 60_000 },
    ]);
    expect(host.filter((f) => f.t === 'unsched')).toEqual([{ t: 'unsched', id: 'sid' }]);

    // The pending list fans out to every watcher — or answers one on attach.
    const scheds = [{ id: 'sid', d: 'go', at: 123 }];
    conn.handleMessage({ t: 'scheds', scheds });
    conn.handleMessage({ t: 'scheds', scheds: [], client: b.socket.data.clientId! });
    conn.handleMessage({ t: 'scheds' }); // malformed: dropped
    expect(a.frames.filter((f) => f.t === 'scheds')).toEqual([{ t: 'scheds', scheds }]);
    expect(b.frames.filter((f) => f.t === 'scheds')).toEqual([{ t: 'scheds', scheds }, { t: 'scheds', scheds: [] }]);
  });

  test('kill is delivered even on a backlogged host link', () => {
    const directory = new Directory();
    const { conn, socket, frames } = register(directory, 's1');
    socket.getBufferedAmount = () => 100 * 1024 * 1024; // over the drop threshold
    conn.kill();
    expect(socket.readyState).toBe(1); // not terminated
    expect(frames.at(-1)).toEqual({ t: 'kill' });
  });
});

describe('launchers', () => {
  test('a reconnecting launcher replaces its previous socket', () => {
    const directory = new Directory();
    const first = fakeSocket('launcher');
    const second = fakeSocket('launcher');
    directory.registerLauncher('ws1', first.socket as any);
    directory.registerLauncher('ws1', second.socket as any);
    expect(first.socket.readyState).toBe(3); // terminated
    // The stale socket's close must not evict the replacement.
    directory.unregisterLauncher('ws1', first.socket as any);
    expect(directory.launcherNames()).toEqual(['ws1']);
    directory.unregisterLauncher('ws1', second.socket as any);
    expect(directory.launcherNames()).toEqual([]);
  });
});

describe('createSession', () => {
  function directoryWithLauncher() {
    const directory = new Directory();
    const { socket, frames } = fakeSocket('launcher');
    directory.registerLauncher('ws1', socket as any);
    return { directory, frames };
  }

  test('resolves when the new session registers', async () => {
    const { directory, frames } = directoryWithLauncher();
    const creating = directory.createSession(undefined, { label: 'l', cwd: '/tmp', command: '' });
    const create = frames[0]!;
    expect(create).toMatchObject({ t: 'create', label: 'l', cwd: '/tmp' });
    const id = create.id!;
    register(directory, id);
    expect(await creating).toEqual({ id, node: 'ws1' });
  });

  test('kills a registration that arrives after the create timed out', async () => {
    const { directory, frames } = directoryWithLauncher();
    const creating = directory.createSession(undefined, { label: '', cwd: '/tmp', command: '' }, 5);
    await expect(creating).rejects.toThrow('did not start');
    const late = fakeSocket('session');
    expect(directory.registerSession(late.socket as any, info(frames[0]!.id!))).toBeNull();
    expect(late.frames.at(-1)).toEqual({ t: 'kill' });
    expect(directory.listSessions()).toEqual([]);
  });

  test('rejects on a launcher-reported spawn failure', async () => {
    const { directory, frames } = directoryWithLauncher();
    const creating = directory.createSession('ws1', { label: '', cwd: '/nope', command: '' });
    directory.handleLauncherMessage({ t: 'created', id: frames[0]!.id, error: 'directory does not exist' });
    await expect(creating).rejects.toThrow('directory does not exist');
  });

  test('rejects when no or several workstations could serve the request', async () => {
    const directory = new Directory();
    expect(() => directory.createSession(undefined, { label: '', cwd: '/', command: '' }))
      .toThrow('no workstation');
    directory.registerLauncher('a', fakeSocket('launcher').socket as any);
    directory.registerLauncher('b', fakeSocket('launcher').socket as any);
    expect(() => directory.createSession(undefined, { label: '', cwd: '/', command: '' }))
      .toThrow('choose one');
    expect(() => directory.createSession('c', { label: '', cwd: '/', command: '' }))
      .toThrow('"c" is not connected');
  });
});
