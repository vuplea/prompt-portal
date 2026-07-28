import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../lib/store';

let dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-portal-store-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

test('seeds defaults on first run', () => {
  const store = new Store(tempDir());
  expect(store.profiles.length).toBeGreaterThan(0);
  expect(store.commands).toContain('claude');
});

test('persists changes across instances', () => {
  const dir = tempDir();
  const store = new Store(dir);
  store.upsertProfile({ name: 'work', cwd: '/repos/work', command: 'claude', node: 'laptop' });
  store.setCommands(['claude', 'codex']);

  const reloaded = new Store(dir);
  expect(reloaded.getProfile('work')).toEqual({ name: 'work', cwd: '/repos/work', command: 'claude', node: 'laptop' });
  expect(reloaded.commands).toEqual(['claude', 'codex']);
});

describe('upsertProfile', () => {
  test('updates an existing profile in place', () => {
    const store = new Store(tempDir());
    store.upsertProfile({ name: 'work', cwd: '/a' });
    const count = store.profiles.length;
    store.upsertProfile({ name: 'work', cwd: '/b', command: 'codex' });
    expect(store.profiles.length).toBe(count);
    expect(store.getProfile('work')).toMatchObject({ cwd: '/b', command: 'codex' });
  });

  test('renames via replace', () => {
    const store = new Store(tempDir());
    store.upsertProfile({ name: 'old', cwd: '/a' });
    store.upsertProfile({ name: 'new', cwd: '/a' }, 'old');
    expect(store.getProfile('old')).toBeUndefined();
    expect(store.getProfile('new')).toBeDefined();
  });

  test('refuses a rename onto a name another profile holds', () => {
    const store = new Store(tempDir());
    store.upsertProfile({ name: 'a', cwd: '/a' });
    store.upsertProfile({ name: 'b', cwd: '/b' });
    expect(() => store.upsertProfile({ name: 'b', cwd: '/a' }, 'a')).toThrow('already exists');
    expect(store.getProfile('a')).toBeDefined();
  });

  test('caps the count; updates and renames still work at the cap', () => {
    const store = new Store(tempDir());
    for (let i = store.profiles.length; i < 100; i++) store.upsertProfile({ name: `p${i}`, cwd: '/tmp' });
    expect(() => store.upsertProfile({ name: 'over', cwd: '/tmp' })).toThrow('at most');
    store.upsertProfile({ name: 'p50', cwd: '/elsewhere' });
    store.upsertProfile({ name: 'p50-renamed', cwd: '/elsewhere' }, 'p50');
    expect(store.profiles.length).toBe(100);
  });
});

test('deleteProfile removes and persists', () => {
  const dir = tempDir();
  const store = new Store(dir);
  store.upsertProfile({ name: 'gone', cwd: '/tmp' });
  store.deleteProfile('gone');
  expect(store.getProfile('gone')).toBeUndefined();
  expect(new Store(dir).getProfile('gone')).toBeUndefined();
});

describe('corrupt store files', () => {
  test('invalid JSON is backed up and defaults restored', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'store.json'), 'not json at all {');
    const store = new Store(dir);
    expect(store.commands).toContain('claude');
    expect(fs.readFileSync(path.join(dir, 'store.json.corrupt'), 'utf8')).toBe('not json at all {');
    // The defaults land on disk too, so a restart loads cleanly instead of
    // re-warning over the same broken file.
    expect(new Store(dir).commands).toContain('claude');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')).profiles.length).toBeGreaterThan(0);
  });

  test('valid JSON of the wrong shape is treated the same', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ profiles: null, commands: 'nope' }));
    const store = new Store(dir);
    expect(store.profiles.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, 'store.json.corrupt'))).toBe(true);
  });

  test('a valid file with unexpected profile fields is rejected', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'store.json'),
      JSON.stringify({ profiles: [{ name: 'x', cwd: 42 }], commands: [] }));
    expect(new Store(dir).getProfile('x')).toBeUndefined();
  });
});
