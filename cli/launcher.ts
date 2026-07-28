import { LAUNCHER_PROTOCOL, type Msg } from '../lib/protocol';
import { isWindows, resolveExistingDir, selfArgv } from './config';
import { maintainLink } from './link';
import type { HostContext } from './host';
import { openHostWindow } from './window';

// `prompt-portal launcher` — the one resident process per workstation, and the only
// reason one exists: starting sessions from the phone. It keeps a single
// outbound WebSocket to the hub and answers create requests by spawning a
// `prompt-portal` host — in a terminal window on a Windows desktop (the window is the
// session), headless in the workstation container. It relays no terminal
// traffic and owns nothing: stopping it strands no sessions.

export async function runLauncher(ctx: HostContext): Promise<never> {
  console.log(`workstation "${ctx.node}" ready`);
  const url = `${ctx.hubUrl}/launcher?name=${encodeURIComponent(ctx.node)}`;
  return maintainLink(url, LAUNCHER_PROTOCOL, ctx.password, {
    onOpen() {
      console.log(`linked to hub as "${ctx.node}"`);
    },
    onMessage(msg, post) {
      if (msg.t !== 'create' || typeof msg.id !== 'string') return;
      console.log(`create ${msg.id}: label ${JSON.stringify(msg.label ?? '')}, cwd ${JSON.stringify(msg.cwd ?? '')}`
        + (msg.command ? `, command ${JSON.stringify(msg.command)}` : ''));
      try {
        create(msg, ctx);
      } catch (err) {
        // The message can embed the requested cwd; stringified like the fields above.
        console.log(`create ${msg.id} failed: ${JSON.stringify((err as Error).message)}`);
        post({ t: 'created', id: msg.id, error: (err as Error).message });
      }
    },
  });
}

// Spawn the host for one create request. Success is never reported from
// here — the session registers itself with the hub; only a spawn that
// definitely failed answers (so the phone sees the error instead of a
// timeout). The cwd is checked here for the same reason.
function create(msg: Msg, ctx: HostContext): void {
  const cwd = resolveExistingDir(msg.cwd || '');

  // The spec carries the session's full context, so a spawned host registers
  // with exactly the hub that asked for it — never with whatever PROMPTPORTAL_*
  // values happen to sit in an inherited environment.
  const spec = Buffer.from(JSON.stringify({
    id: msg.id,
    label: msg.label || undefined,
    cwd,
    command: msg.command || undefined,
    hubUrl: ctx.hubUrl,
    node: ctx.node,
  })).toString('base64url');

  const argv = selfArgv(['run', '--spec', spec]);

  if (isWindows) {
    // A visible window: the session must be closable (and killable) by
    // closing it. The host reads the workstation password from Credential
    // Manager itself.
    openHostWindow(argv);
    console.log(`session ${msg.id} opened in a terminal window`);
    return;
  }

  // No windows here (the workstation container): a headless host. The
  // password goes over stdin rather than the environment.
  const child = Bun.spawn({
    cmd: argv,
    env: { ...process.env, PROMPTPORTAL_PASSWORD_STDIN: '1' },
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  console.log(`session ${msg.id} host spawned (pid ${child.pid})`);
  // The pipe settles asynchronously: a host that dies before reading its
  // stdin rejects these after create() has returned, where an unguarded
  // rejection would take down the launcher itself.
  (async () => {
    await child.stdin.write(ctx.password + '\n');
    await child.stdin.end();
  })().catch(() => {
    // The host is dead; the create surfaces to the phone as a timeout.
    console.log(`session ${msg.id} host (pid ${child.pid}) died before reading its password`);
  });
  child.unref();
}
