import crypto from 'node:crypto';

import { BASIC_USERNAME } from './protocol';

// Failures allowed before lockouts begin; after that each failure doubles the
// lockout, starting at BASE_LOCK_MS and capped at MAX_LOCK_MS.
const FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;
const RECORD_TTL_MS = 60 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 1000;
// Failure records live for up to RECORD_TTL_MS, so a botnet spraying bad
// credentials from many addresses could grow the map without bound inside
// that window; cap it by evicting the oldest record.
const MAX_ATTEMPT_RECORDS = 10000;
// Tokens live for TOKEN_TTL_MS, so an authenticated client hammering
// GET /api/token could grow the map within that window; cap it the same way.
const MAX_TOKENS = 10000;

// Accepts a string (hashed as UTF-8) or a Buffer.
function digest(value: string | Buffer): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

// One machine, one lockout bucket. Keying on the raw address would let an
// attacker with a single IPv6 /64 — the standard end-site allocation — rotate
// source addresses and never accumulate failures; fold IPv6 to its /64.
// IPv4 (and IPv4 mapped into IPv6) stays per-address.
function lockoutBucket(ip: string): string {
  const plain = ip.split('%')[0]!; // strip a zone id
  if (!plain.includes(':')) return plain;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(plain);
  if (mapped) return mapped[1]!;
  // Expand '::' and keep the first 4 hextets (the /64).
  const [head = '', tail = ''] = plain.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const mid = Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  return [...left, ...mid, ...right].slice(0, 4).join(':').toLowerCase();
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 429; retryAfter?: number };

interface AttemptRecord {
  fails: number;
  lockedUntil: number;
  lastFail: number;
}

export class Auth {
  private userDigest: Buffer;
  private webPassDigest: Buffer;
  private workstationPassDigest: Buffer;
  private attempts = new Map<string, AttemptRecord>(); // channel:bucket -> record
  private tokens = new Map<string, number>(); // token -> expiry (for WebSocket upgrades)

  constructor(webaccessPassword: string, workstationPassword: string) {
    this.userDigest = digest(BASIC_USERNAME);
    this.webPassDigest = digest(webaccessPassword);
    this.workstationPassDigest = digest(workstationPassword);
    setInterval(() => this.prune(), 60 * 1000).unref();
  }

  // Browser and workstation lockouts are throttled alike but tracked separately
  // (the channel prefix): the lockout gate runs before the credential check,
  // so a shared bucket would let one workstation left on a stale password —
  // redialing every 10s forever — serve correct-password browsers on the
  // same address nothing but 429s. The price is one extra set of free
  // attempts on the second channel, noise against a long random password.
  check(authorization: string | undefined, ip: string): AuthResult {
    const key = `browser:${lockoutBucket(ip)}`;
    const locked = this.lockout(key);
    if (locked) return locked;

    if (this.credentialsValid(authorization)) {
      this.attempts.delete(key);
      return { ok: true };
    }

    if (authorization) this.recordFailure(key, Date.now());
    return { ok: false, status: 401 };
  }

  // The same gate for the bare workstation password (session and launcher
  // sockets present it, base64url-decoded by the caller, from a
  // Sec-WebSocket-Protocol slot).
  checkPassword(value: Buffer, ip: string): AuthResult {
    const key = `workstation:${lockoutBucket(ip)}`;
    const locked = this.lockout(key);
    if (locked) return locked;

    if (value.length > 0 && crypto.timingSafeEqual(digest(value), this.workstationPassDigest)) {
      this.attempts.delete(key);
      return { ok: true };
    }

    if (value.length > 0) this.recordFailure(key, Date.now());
    return { ok: false, status: 401 };
  }

  private lockout(key: string): AuthResult | null {
    const now = Date.now();
    const record = this.attempts.get(key);
    if (record && record.lockedUntil > now) {
      return { ok: false, status: 429, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) };
    }
    return null;
  }

  private credentialsValid(header: string | undefined): boolean {
    if (!header || !header.startsWith('Basic ')) return false;
    let decoded;
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      return false;
    }
    const sep = decoded.indexOf(':');
    if (sep < 0) return false;
    // Always compare both parts so timing does not reveal which one failed.
    const userOk = crypto.timingSafeEqual(digest(decoded.slice(0, sep)), this.userDigest);
    const passOk = crypto.timingSafeEqual(digest(decoded.slice(sep + 1)), this.webPassDigest);
    return userOk && passOk;
  }

  private recordFailure(key: string, now: number): void {
    // Map iterates in insertion order, so the first key holds the oldest
    // record. Evicting one merely forgets that IP's failure count — an
    // attacker with this many addresses is beyond per-IP lockouts anyway.
    if (!this.attempts.has(key) && this.attempts.size >= MAX_ATTEMPT_RECORDS) {
      this.attempts.delete(this.attempts.keys().next().value!);
    }
    const record = this.attempts.get(key) || { fails: 0, lockedUntil: 0, lastFail: 0 };
    record.fails += 1;
    record.lastFail = now;
    if (record.fails >= FREE_ATTEMPTS) {
      const lockMs = Math.min(BASE_LOCK_MS * 2 ** (record.fails - FREE_ATTEMPTS), MAX_LOCK_MS);
      record.lockedUntil = now + lockMs;
      console.warn(`auth: locked out ${key} for ${Math.round(lockMs / 1000)}s after ${record.fails} failures`);
    }
    this.attempts.set(key, record);
  }

  // Tokens authenticate WebSocket upgrades; browsers do not reliably attach
  // Basic credentials to those, so the page fetches a token over the
  // authenticated HTTP channel and offers it in the Sec-WebSocket-Protocol
  // header. Single-use and short-lived, so a token that leaks into a log is
  // worthless.
  issueToken(): string {
    const token = crypto.randomBytes(32).toString('hex');
    // Map iterates in insertion order, so the first key is the oldest — and,
    // since every token shares one TTL, also the nearest to expiry.
    if (this.tokens.size >= MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value!);
    this.tokens.set(token, Date.now() + TOKEN_TTL_MS);
    return token;
  }

  consumeToken(token: string | undefined): boolean {
    if (typeof token !== 'string') return false;
    const expiry = this.tokens.get(token);
    if (expiry === undefined) return false;
    this.tokens.delete(token);
    return expiry > Date.now();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, record] of this.attempts) {
      if (record.lockedUntil < now && now - record.lastFail > RECORD_TTL_MS) this.attempts.delete(key);
    }
    for (const [token, expiry] of this.tokens) {
      if (expiry <= now) this.tokens.delete(token);
    }
  }
}
