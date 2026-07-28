import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { autoloadedEnvKeys, dropAutoloadedDotenv } from '../cli/config';

// autoloadedEnvKeys covers the keys Bun can autoload from a directory, so
// dropAutoloadedDotenv can clear them at startup. These cover the files it
// reads and the assignment shapes it accepts.

const dirs: string[] = [];

function fixture(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-portal-env-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('collects keys from .env and .env.local, ignoring .env.example', () => {
  const dir = fixture({
    '.env': 'FROM_ENV=1\nBOTH=env\n',
    '.env.local': 'SERVICE_TOKEN=secret\nBOTH=local\n',
    '.env.example': 'SHOULD_NOT_STRIP=placeholder\n',
  });
  const keys = autoloadedEnvKeys(dir);
  expect(keys.has('FROM_ENV')).toBe(true);
  expect(keys.has('SERVICE_TOKEN')).toBe(true);
  expect(keys.has('BOTH')).toBe(true);
  expect(keys.has('SHOULD_NOT_STRIP')).toBe(false);
});

test('collects every environment-specific file, whatever NODE_ENV says', () => {
  // Bun picks these by the NODE_ENV it started with — which `.env` here claims
  // to set, and cannot be recovered afterwards. All of them get stripped.
  const dir = fixture({
    '.env': 'NODE_ENV=production\n',
    '.env.development': 'DEV=1\n',
    '.env.development.local': 'DEV_LOCAL=1\n',
    '.env.production': 'PROD=1\n',
    '.env.production.local': 'PROD_LOCAL=1\n',
    '.env.test': 'TEST=1\n',
    '.env.test.local': 'TEST_LOCAL=1\n',
  });
  const keys = autoloadedEnvKeys(dir);
  for (const key of ['DEV', 'DEV_LOCAL', 'PROD', 'PROD_LOCAL', 'TEST', 'TEST_LOCAL']) {
    expect(keys.has(key)).toBe(true);
  }
});

test('collects the assignment shapes Bun accepts; ignores comments', () => {
  const dir = fixture({
    '.env.local': [
      '# a comment',
      '',
      'export EXPORTED=1',
      'SPACED = 2',
      'QUOTED="value with = inside"',
      // Bun injects names that are not shell identifiers, so these must be
      // stripped too.
      'DOTTED.KEY=3',
      'DASHED-KEY=4',
      '1NUMBER=5',
      'not_an_assignment',
    ].join('\n'),
  });
  const keys = autoloadedEnvKeys(dir);
  for (const key of ['EXPORTED', 'SPACED', 'QUOTED', 'DOTTED.KEY', 'DASHED-KEY', '1NUMBER']) {
    expect(keys.has(key)).toBe(true);
  }
  expect(keys.has('not_an_assignment')).toBe(false);
});

test('splits on every line ending Bun accepts, including a lone CR', () => {
  const dir = fixture({ '.env': 'LF=1\nCRLF=2\r\nCR_FIRST=3\rCR_SECOND=4\r' });
  const keys = autoloadedEnvKeys(dir);
  for (const key of ['LF', 'CRLF', 'CR_FIRST', 'CR_SECOND']) expect(keys.has(key)).toBe(true);
});

test('returns an empty set when the directory has no env files', () => {
  expect(autoloadedEnvKeys(fixture()).size).toBe(0);
});

test('dropping clears autoloaded names but spares what the process runs on', () => {
  // PATH here stands for the whole KEEP_REGARDLESS set: losing it would leave
  // this process unable to spawn a shell at all.
  const dir = fixture({ '.env': 'PROJECT_SECRET=x\nPATH=/nowhere\n' });
  const path = process.env.PATH;
  process.env.PROJECT_SECRET = 'x';
  try {
    dropAutoloadedDotenv(dir);
    expect(process.env.PROJECT_SECRET).toBeUndefined();
    expect(process.env.PATH).toBe(path);
  } finally {
    delete process.env.PROJECT_SECRET;
    process.env.PATH = path;
  }
});
