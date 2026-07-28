import { expect, test } from 'bun:test';

import { OutputSanitizer } from '../cli/session';

// The four ConPTY terminal-mode requests the sanitizer must strip:
// win32-input-mode and focus-event reporting, set and reset.
const REQUESTS = ['\x1b[?9001h', '\x1b[?9001l', '\x1b[?1004h', '\x1b[?1004l'];

test('strips every terminal-mode request', () => {
  for (const seq of REQUESTS) {
    expect(new OutputSanitizer().push(`a${seq}b`)).toBe('ab');
  }
});

test('passes ordinary output and escape sequences through', () => {
  const s = new OutputSanitizer();
  expect(s.push('\x1b[31mred\x1b[0m plain')).toBe('\x1b[31mred\x1b[0m plain');
  expect(s.flush()).toBe('');
});

test('strips a request split across chunks', () => {
  const s = new OutputSanitizer();
  expect(s.push('foo\x1b[?90')).toBe('foo');
  expect(s.push('01hbar')).toBe('bar');
});

test('releases a held-back prefix once it turns out to be output', () => {
  const s = new OutputSanitizer();
  expect(s.push('foo\x1b[?9')).toBe('foo');
  expect(s.push('X')).toBe('\x1b[?9X');
});

test('flush releases a held-back prefix at end of stream', () => {
  const s = new OutputSanitizer();
  expect(s.push('bye\x1b')).toBe('bye');
  expect(s.flush()).toBe('\x1b');
  expect(s.flush()).toBe('');
});
