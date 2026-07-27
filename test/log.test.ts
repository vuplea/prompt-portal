import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RotatingLog } from '../cli/log';

const dirs: string[] = [];

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptportal-log-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function lines(dir: string, file: 0 | 1): string[] {
  try {
    return fs.readFileSync(path.join(dir, `promptportal.${file}.log`), 'utf8').split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

describe('RotatingLog', () => {
  test('rotates between the two files at the line limit, truncating the stale one', () => {
    const dir = scratchDir();
    const log = new RotatingLog(dir, 5);
    for (let i = 1; i <= 12; i++) log.append(`line ${i}`);
    // 1-5 filled file 0; 6-10 rotated onto (empty) file 1; 11 rotated back,
    // truncating the full file 0.
    expect(lines(dir, 0)).toEqual(['line 11', 'line 12']);
    expect(lines(dir, 1)).toEqual(['line 6', 'line 7', 'line 8', 'line 9', 'line 10']);
  });

  test('concurrent writers interleave into one file and follow each other across rotations', () => {
    const dir = scratchDir();
    const a = new RotatingLog(dir, 4);
    const b = new RotatingLog(dir, 4);
    a.append('a1');
    b.append('b1');
    a.append('a2');
    b.append('b2'); // file 0 is now full
    a.append('a3'); // a rotates to file 1
    b.append('b3'); // b must join file 1 without truncating a3 away
    expect(lines(dir, 0)).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(lines(dir, 1)).toEqual(['a3', 'b3']);
  });

  test('an externally truncated file is recounted, not miscounted', () => {
    const dir = scratchDir();
    const log = new RotatingLog(dir, 5);
    for (let i = 1; i <= 3; i++) log.append(`line ${i}`);
    fs.writeFileSync(path.join(dir, 'promptportal.0.log'), '');
    log.append('after');
    expect(lines(dir, 0)).toEqual(['after']);
    // The recount means these 4 writes did not reach the limit: no rotation.
    expect(lines(dir, 1)).toEqual([]);
  });

  test('a new writer resumes on the most recently written file', () => {
    const dir = scratchDir();
    const first = new RotatingLog(dir, 3);
    for (let i = 1; i <= 4; i++) first.append(`line ${i}`); // rotated: file 1 holds "line 4"
    const second = new RotatingLog(dir, 3);
    second.append('line 5');
    expect(lines(dir, 1)).toEqual(['line 4', 'line 5']);
    expect(lines(dir, 0)).toEqual(['line 1', 'line 2', 'line 3']);
  });

  test('embedded newlines count toward the limit', () => {
    const dir = scratchDir();
    const log = new RotatingLog(dir, 4);
    log.append('one\ntwo\nthree');
    log.append('four');
    log.append('five'); // 4 lines reached; this rotates
    expect(lines(dir, 1)).toEqual(['five']);
  });
});
