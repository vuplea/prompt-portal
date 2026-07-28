import { describe, expect, test } from 'bun:test';

import { CliError } from '../cli/config';
import { normalizeHubUrl } from '../cli/link';

describe('normalizeHubUrl', () => {
  test('maps http(s) to ws(s) and passes ws(s) through', () => {
    expect(normalizeHubUrl('https://hub.example.com')).toBe('wss://hub.example.com');
    expect(normalizeHubUrl('http://hub:8080')).toBe('ws://hub:8080');
    expect(normalizeHubUrl('wss://hub.example.com')).toBe('wss://hub.example.com');
    expect(normalizeHubUrl('ws://localhost:9')).toBe('ws://localhost:9');
  });

  test('a bare host means TLS; host:port is ambiguous with a scheme and rejected', () => {
    expect(normalizeHubUrl('hub.example.com')).toBe('wss://hub.example.com');
    expect(() => normalizeHubUrl('hub.example.com:8443')).toThrow(CliError);
  });

  test('strips trailing slashes', () => {
    expect(normalizeHubUrl('https://hub.example.com//')).toBe('wss://hub.example.com');
  });

  test('rejects a query or fragment (endpoint paths are appended to the URL)', () => {
    expect(() => normalizeHubUrl('https://hub.example.com?tenant=a')).toThrow(CliError);
    expect(() => normalizeHubUrl('https://hub.example.com/#frag')).toThrow(CliError);
  });

  test('rejects other schemes and unparseable values', () => {
    expect(() => normalizeHubUrl('ftp://hub')).toThrow(CliError);
    expect(() => normalizeHubUrl('https://')).toThrow(CliError);
    expect(() => normalizeHubUrl('not a url')).toThrow(CliError);
  });
});
