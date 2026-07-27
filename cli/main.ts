#!/usr/bin/env bun
import fs from 'node:fs';

import { readCredential } from '../lib/credential';
import { readSecretFromStdin } from '../lib/secret';
import {
  CliError, CREDENTIAL_TARGET, dropAutoloadedDotenv, env, isWindows, resolveNodeName,
} from './config';
import { runConsoleGuard } from './console';
import { runHost, type HostContext, type HostSpec } from './host';
import { runLauncher } from './launcher';
import { normalizeHubUrl, warnIfCleartext } from './link';
import { initLog } from './log';
import { setPassword } from './password';

//   prompt-portal [label] [--cwd DIR] [-- CMD ARGS...]    host a session in this terminal
//                          (everything after -- is the command, verbatim —
//                           no quoting)
//   prompt-portal launcher           run the workstation launcher (a logon task on
//                          Windows, the container entrypoint) so sessions can
//                          be started from the hub
//   prompt-portal hub [...]          run the hub (see server.ts; --help for flags)
//   prompt-portal set-password       store the workstation password in Credential Manager (Windows)
//   prompt-portal install|update|uninstall   manage the Windows install (see cli/install.ts)
//
// (internal)  prompt-portal run --spec <b64url-json>      host a session from a launcher spec
// (internal)  prompt-portal console-guard <shell-pid>     hold a session console's codepages
//                          at UTF-8 (Windows; see cli/console.ts)
//
// A session lives exactly as long as its `prompt-portal` process: close the
// window (or kill it from the hub) and the shell dies with it.

const USAGE = 'prompt-portal [label] [--cwd DIR] [-- CMD ARGS...] | prompt-portal launcher | prompt-portal hub'
  + ' | prompt-portal set-password | prompt-portal install|update|uninstall';

const args = process.argv.slice(2);

// First thing, so every read below — and every shell a session hosts — sees an
// environment the startup directory's .env had no say in. Safe here because no
// module reads configuration while being imported. The hub subcommand is the
// one exception: it spawns no shells and `bun server.ts` autoloads .env, so
// `prompt-portal hub` keeps that behavior rather than differing from it.
if (args[0] !== 'hub') dropAutoloadedDotenv();

// The workstation password is kept out of this process's environment:
// same-user processes can read /proc/<pid>/environ, which deleting the
// variable does not clear. The launcher hands it to headless hosts over stdin
// (see workstation-entrypoint.sh); on Windows it lives in Credential Manager
// (`prompt-portal set-password`, written by the installer). The delete below
// still clears a PROMPTPORTAL_WORKSTATION_PASSWORD set directly in the
// environment, so a session's shell doesn't inherit it.
async function resolvePassword(): Promise<string> {
  let password = env.password;
  delete process.env.PROMPTPORTAL_WORKSTATION_PASSWORD;
  if (password.length === 0 && env.passwordFromStdin) {
    password = await readSecretFromStdin();
    // stdin here carries the secret (a shell heredoc's temp file, or the
    // launcher's pipe) and stays readable via /proc/<pid>/fd/0. Repoint fd 0 at
    // /dev/null to release it once read.
    if (!isWindows) {
      try {
        fs.closeSync(0);
        fs.openSync('/dev/null', 'r'); // POSIX: open reclaims the lowest fd — 0
      } catch {}
    }
  }
  if (password.length === 0 && isWindows) {
    password = readCredential(CREDENTIAL_TARGET) ?? '';
  }
  return password;
}

// A launcher spec pins hubUrl and node, so a spawned session registers with
// exactly the hub that asked for it; everything else comes from the
// environment.
async function workstationContext(spec: HostSpec = {}): Promise<HostContext> {
  const node = spec.node || resolveNodeName();
  const hubUrl = spec.hubUrl ?? (env.hubUrl.length > 0 ? normalizeHubUrl(env.hubUrl) : '');
  if (hubUrl) warnIfCleartext(hubUrl);
  return { hubUrl, password: hubUrl ? await resolvePassword() : '', node };
}

// A missing password is fatal for the launcher (it exists only to serve the
// hub) but not for a session: the window should still be a working terminal,
// just unlinked.
function requirePassword(ctx: HostContext): HostContext {
  if (ctx.password.length > 0) return ctx;
  throw new CliError('PROMPTPORTAL_HUB_URL is set but no workstation password was found'
    + (isWindows
      ? ' (run `prompt-portal set-password`, or set PROMPTPORTAL_WORKSTATION_PASSWORD)'
      : ' (set PROMPTPORTAL_WORKSTATION_PASSWORD)'));
}

async function hostSession(spec: HostSpec): Promise<never> {
  let ctx = await workstationContext(spec);
  if (ctx.hubUrl && ctx.password.length === 0) {
    try {
      requirePassword(ctx);
    } catch (err) {
      console.error(`${(err as CliError).message} — running unlinked`);
      ctx = { ...ctx, hubUrl: '' };
    }
  }
  return runHost(spec, ctx);
}

function parseHostArgs(rest: string[]): HostSpec {
  const spec: HostSpec = {};
  const labelParts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--') {
      // Everything right of -- is the command, verbatim: no escaping a
      // nested command line from the outer shell.
      const command = rest.slice(i + 1).join(' ');
      if (command) spec.command = command;
      break;
    }
    if (rest[i] === '--cwd' && i + 1 < rest.length) spec.cwd = rest[++i]!;
    else labelParts.push(rest[i]!);
  }
  if (labelParts.length > 0) spec.label = labelParts.join(' ');
  return spec;
}

function parseSpec(rest: string[]): HostSpec {
  const encoded = rest[0] === '--spec' ? rest[1] : undefined;
  if (!encoded) throw new CliError('run needs --spec');
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as HostSpec;
  } catch {
    throw new CliError('malformed --spec');
  }
}

// The launcher and session hosts log to a file as well as the console (see
// cli/log.ts) — initialized before anything can fail, so a launcher dying at
// logon inside its invisible conhost still leaves a trace.
try {
  switch (args[0]) {
    case 'launcher': {
      initLog('launcher');
      const ctx = await workstationContext();
      if (!ctx.hubUrl) throw new CliError('PROMPTPORTAL_HUB_URL is not set — the launcher exists only to serve a hub');
      await runLauncher(requirePassword(ctx));
      break;
    }
    case 'run':
      initLog('session');
      await hostSession(parseSpec(args.slice(1)));
      break;
    case 'console-guard':
      initLog('console-guard');
      await runConsoleGuard(Number(args[1]));
      break;
    case 'set-password':
      await setPassword();
      break;
    case 'hub': {
      const { runHub } = await import('../server');
      // 'serving' means the listener is up: park forever — the server owns
      // the process from here, exactly like `bun server.ts`.
      if (await runHub(args.slice(1)) === 'serving') await new Promise<never>(() => {});
      break;
    }
    case 'install':
    case 'update':
    case 'uninstall': {
      const { runInstaller } = await import('./install');
      await runInstaller(args[0], args.slice(1));
      break;
    }
    case '-h':
    case '--help':
      console.log(USAGE);
      break;
    default:
      // Headless hosting is reserved for launcher specs (`prompt-portal run`):
      // a bare `prompt-portal` in a script or healthcheck must not silently
      // spawn an invisible shell.
      if (process.stdin.isTTY !== true) {
        throw new CliError('prompt-portal hosts a session in the terminal it runs in, and no terminal is attached'
          + ` — usage: ${USAGE}`);
      }
      initLog('session');
      await hostSession(parseHostArgs(args));
      break;
  }
  process.exit(0);
} catch (err) {
  if (!(err instanceof CliError)) throw err;
  console.error(err.message);
  process.exit(1);
}
