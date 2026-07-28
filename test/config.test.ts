import { afterEach, describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';

import { NODE_NAME_RE } from '../lib/protocol';
import { CliError, resolveExistingDir, resolveNodeName } from '../cli/config';

describe('resolveNodeName', () => {
  afterEach(() => {
    delete process.env.PROMPTPORTAL_NODE_NAME;
  });

  test('takes a valid configured name verbatim', () => {
    process.env.PROMPTPORTAL_NODE_NAME = 'my-box.2';
    expect(resolveNodeName()).toBe('my-box.2');
  });

  test('rejects a configured name with forbidden characters', () => {
    process.env.PROMPTPORTAL_NODE_NAME = 'not a name';
    expect(() => resolveNodeName()).toThrow(CliError);
  });

  test('derives a conforming default from the hostname', () => {
    expect(resolveNodeName()).toMatch(NODE_NAME_RE);
  });
});

describe('resolveExistingDir', () => {
  test('expands ~ and resolves to an absolute path', () => {
    expect(resolveExistingDir('~')).toBe(os.homedir());
    expect(path.isAbsolute(resolveExistingDir('.'))).toBe(true);
  });

  test('rejects a directory that does not exist', () => {
    expect(() => resolveExistingDir(path.join(os.tmpdir(), 'prompt-portal-definitely-missing-xyz'))).toThrow(CliError);
  });
});
