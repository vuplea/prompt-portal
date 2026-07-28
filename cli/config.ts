import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliError } from '../lib/errors';
import { NODE_NAME_RE } from '../lib/protocol';

// Configuration shared by the prompt-portal commands, read from the environment (the
// Windows installer persists these as user variables; the compose file passes
// them to the `server` workstation container).

// Re-exported so cli code keeps one import site for its user-facing error.
export { CliError };

export const isWindows = process.platform === 'win32';

// Compiled (`bun build --compile`, the installed prompt-portal.exe) the executable is
// the program; under `bun cli/main.ts` the runtime is bun itself, so the
// script path has to be passed along to spawn another one, and the dotenv
// autoload the compiled builds disable is in play (see dropAutoloadedDotenv).
//
// Told apart by where the entry point lives: a compiled binary's is inside
// Bun's virtual filesystem, never on disk. Anything unrecognized counts as a
// source run, so a Bun binary under an unexpected name — a version manager's
// `bun-1.3.14` — errs toward sanitizing the environment and toward a launcher
// spawn that fails loudly, rather than one that silently leaks.
export const isCompiled = /^(?:[a-z]:[\\/]~bun[\\/]|[\\/]\$bunfs[\\/])/i.test(Bun.main);

// Argv that re-invokes this program with `args` appended — the compiled/source
// split above, in spawnable form. Anchored to this directory rather than
// process.argv[1], which is not main.ts in every context (`bun test`).
export function selfArgv(args: string[]): string[] {
  return isCompiled
    ? [process.execPath, ...args]
    : [process.execPath, path.join(import.meta.dir, 'main.ts'), ...args];
}

// The workstation password's home on Windows: a generic credential in the
// user's Credential Manager (lib/credential.ts), written by `prompt-portal set-password`
// and read back by every session host and the launcher.
export const CREDENTIAL_TARGET = 'prompt-portal';

export const env = {
  get hubUrl(): string { return process.env.PROMPTPORTAL_HUB_URL ?? ''; },
  get password(): string { return process.env.PROMPTPORTAL_WORKSTATION_PASSWORD ?? ''; },
  // The container (and the launcher, spawning headless hosts) hands the
  // workstation password over stdin instead of the environment.
  get passwordFromStdin(): boolean {
    return ['1', 'true'].includes(process.env.PROMPTPORTAL_PASSWORD_STDIN ?? '');
  },
  get nodeName(): string { return process.env.PROMPTPORTAL_NODE_NAME ?? ''; },
  // The shell each session hosts. Empty means the platform default
  // (powershell.exe on Windows, $SHELL/bash elsewhere) — see cli/session.ts.
  get shell(): string { return process.env.PROMPTPORTAL_SHELL ?? ''; },
};

// Bun autoloads .env files from a process's startup directory into process.env
// before any of our code runs. Nothing here should answer to the directory a
// terminal happens to be started in: not the shell or hub prompt-portal itself
// picks, and not what the shells it hosts inherit. The shipped binaries are
// compiled with --no-compile-autoload-dotenv and so never see those values; a
// run from a clone (`bun cli/main.ts`) has no flag we can pass on the
// user's behalf, so it drops them instead — leaving both paths behaving alike.
//
// Every file Bun can autoload from `dir` counts, not the subset it picked:
// which environment-specific files it reads depends on the NODE_ENV it started
// with, and a dotenv file may itself define NODE_ENV — after the fact the two
// are indistinguishable, so guessing risks reading the wrong ones. Parents are
// not searched, and files Bun never autoloads (e.g. `.env.example`) are left
// alone.
//
// Names are all we take, and the regex approximates Bun's parser loosely. Both
// over-strip: a name Bun never injected — or one whose inherited value won over
// the dotenv file's — is dropped anyway. Telling those apart would need a
// Bun-faithful value parser, and dropping a variable beats leaking a secret.
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([^\s#=]+)\s*=/;
const ENV_FILES = [
  '.env', '.env.local',
  '.env.development', '.env.development.local',
  '.env.production', '.env.production.local',
  '.env.test', '.env.test.local',
];

export function autoloadedEnvKeys(dir: string): Set<string> {
  const keys = new Set<string>();
  for (const file of ENV_FILES) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue; // file absent — nothing to strip
    }
    // A lone \r separates lines for Bun too, so splitting on \n alone would
    // miss — and leak — every assignment after the first on such a line.
    for (const line of text.split(/[\r\n]+/)) {
      const match = ENV_ASSIGNMENT.exec(line);
      if (match) keys.add(match[1]!);
    }
  }
  return keys;
}

// What the process itself runs on, which a project's .env has no business
// costing it: dropping PATH would leave both this process and its shells unable
// to resolve a binary, and the rest locate the home, system and temp
// directories they read. None is plausibly an app secret. Matched
// case-insensitively — Windows spells it `Path`.
const KEEP_REGARDLESS = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']);

// Called once, before anything reads configuration. A compiled build has
// nothing to drop — autoload was off, so these names can only hold values the
// user set themselves. (A binary compiled by hand without the flag falls
// outside this; both supported build paths pass it.) Nothing chdirs, so the
// default cwd here is still the directory Bun read the files from.
export function dropAutoloadedDotenv(dir = process.cwd()): void {
  if (isCompiled) return;
  for (const key of autoloadedEnvKeys(dir)) {
    if (!KEEP_REGARDLESS.has(key.toUpperCase())) delete process.env[key];
  }
}

// This workstation's name: PROMPTPORTAL_NODE_NAME, or the hostname lowercased
// with non-conforming chars turned into '-'.
export function resolveNodeName(): string {
  const configured = env.nodeName;
  if (configured) {
    if (!NODE_NAME_RE.test(configured)) {
      throw new CliError(`Invalid PROMPTPORTAL_NODE_NAME "${configured}" (allowed: letters, digits, _ . -)`);
    }
    return configured;
  }
  const name = (os.hostname() || 'workstation')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return name.length > 0 ? name : 'workstation';
}

function expandHome(dir: string): string {
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

// A session's working directory, as given by the user or the phone: ~ and
// relative paths resolved, and required to exist.
export function resolveExistingDir(dir: string): string {
  const resolved = path.resolve(expandHome(dir));
  let isDir;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new CliError(`directory does not exist: ${resolved}`);
  return resolved;
}
