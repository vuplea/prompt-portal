import path from 'node:path';

import { Auth } from './lib/auth';
import { Store } from './lib/store';
import { Directory, type PtSocket, type WsData } from './lib/directory';
import { ClientError, CliError } from './lib/errors';
import { BROWSER_PROTOCOL, LAUNCHER_PROTOCOL, MAX_FIELD_CHARS, NODE_NAME_RE, SESSION_PROTOCOL, parse, send } from './lib/protocol';
import { HUB_USAGE, parseHubCli, resolveHubPasswords, setHubPasswords } from './lib/settings';

// Static assets, imported as files: under `bun server.ts` each import is a
// path on disk; under `bun build --compile` the file is embedded, so the hub
// binary is self-contained (the Windows background task and the container
// both run compiled builds).
// bun-types types '*.html' imports as HTMLBundle (Bun's HTML bundling), but
// with { type: 'file' } this import is a path string like the others.
import indexHtmlBundle from './public/index.html' with { type: 'file' };
const indexHtml = indexHtmlBundle as unknown as string;
import appJs from './public/app.js' with { type: 'file' };
import styleCss from './public/style.css' with { type: 'file' };
// PWA assets: the manifest makes the phone install prompt-portal to the home
// screen, and its icon + background_color (#16161e) drive the launch splash.
import manifestFile from './public/manifest.webmanifest' with { type: 'file' };
import icon192 from './public/icon-192.png' with { type: 'file' };
import icon512 from './public/icon-512.png' with { type: 'file' };
import splashPng from './public/splash.png' with { type: 'file' };
// Per-device iOS launch images: Safari shows a splash only when an image
// matches the device's exact resolution (index.html media-queries each).
import sp0 from './public/splash/splash-1290x2796.png' with { type: 'file' };
import sp1 from './public/splash/splash-1284x2778.png' with { type: 'file' };
import sp2 from './public/splash/splash-1179x2556.png' with { type: 'file' };
import sp3 from './public/splash/splash-1170x2532.png' with { type: 'file' };
import sp4 from './public/splash/splash-1125x2436.png' with { type: 'file' };
import sp5 from './public/splash/splash-1242x2688.png' with { type: 'file' };
import sp6 from './public/splash/splash-828x1792.png' with { type: 'file' };
import sp7 from './public/splash/splash-750x1334.png' with { type: 'file' };
import sp8 from './public/splash/splash-2048x2732.png' with { type: 'file' };
import sp9 from './public/splash/splash-1668x2388.png' with { type: 'file' };
import sp10 from './public/splash/splash-1640x2360.png' with { type: 'file' };
import xtermJs from '@xterm/xterm/lib/xterm.js' with { type: 'file' };
import xtermJsMap from '@xterm/xterm/lib/xterm.js.map' with { type: 'file' };
import xtermCss from '@xterm/xterm/css/xterm.css' with { type: 'file' };
import addonFitJs from '@xterm/addon-fit/lib/addon-fit.js' with { type: 'file' };
import addonFitJsMap from '@xterm/addon-fit/lib/addon-fit.js.map' with { type: 'file' };

// The hub. It serves the browser UI, authenticates clients, and brokers
// between browser sockets and the terminal workstations registered with it.
// It hosts no terminals itself: every session is a `prompt-portal` process on
// a workstation that dials in over its own outbound WebSocket, and each
// workstation runs a small `prompt-portal launcher` so sessions can be started
// from here — including the `server` workstation container deployed beside the
// hub (see docker-compose.yml).
//
// Two entry points, one path: `bun server.ts` (the compose hub, dev runs) and
// `prompt-portal hub` (cli/main.ts) both land in runHub.

// ---------------------------------------------------------------- static

const STATIC_FILES: Record<string, [string, string]> = {
  '/': [indexHtml, 'text/html; charset=utf-8'],
  '/app.js': [appJs, 'text/javascript; charset=utf-8'],
  '/style.css': [styleCss, 'text/css; charset=utf-8'],
  '/manifest.webmanifest': [manifestFile, 'application/manifest+json; charset=utf-8'],
  '/icon-192.png': [icon192, 'image/png'],
  '/icon-512.png': [icon512, 'image/png'],
  '/splash.png': [splashPng, 'image/png'],
  '/splash/splash-1290x2796.png': [sp0, 'image/png'],
  '/splash/splash-1284x2778.png': [sp1, 'image/png'],
  '/splash/splash-1179x2556.png': [sp2, 'image/png'],
  '/splash/splash-1170x2532.png': [sp3, 'image/png'],
  '/splash/splash-1125x2436.png': [sp4, 'image/png'],
  '/splash/splash-1242x2688.png': [sp5, 'image/png'],
  '/splash/splash-828x1792.png': [sp6, 'image/png'],
  '/splash/splash-750x1334.png': [sp7, 'image/png'],
  '/splash/splash-2048x2732.png': [sp8, 'image/png'],
  '/splash/splash-1668x2388.png': [sp9, 'image/png'],
  '/splash/splash-1640x2360.png': [sp10, 'image/png'],
  '/vendor/xterm.js': [xtermJs, 'text/javascript'],
  '/vendor/xterm.js.map': [xtermJsMap, 'application/json'],
  '/vendor/xterm.css': [xtermCss, 'text/css'],
  '/vendor/addon-fit.js': [addonFitJs, 'text/javascript'],
  '/vendor/addon-fit.js.map': [addonFitJsMap, 'application/json'],
};

// Applied to every HTTP response. style-src 'unsafe-inline' for xterm.js (its
// DOM renderer injects a style element); img-src data: for the inline SVG
// favicon.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

function respond(status: number, body: string | null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

function respondJson(status: number, body: unknown): Response {
  return respond(status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readJsonBody(req: Request): Promise<any> {
  // Require a JSON content type. This is also the CSRF defense: a JSON body
  // is not a CORS "simple request", so a cross-origin caller triggers a
  // preflight this server never answers, and the browser blocks the request
  // before it reaches here — even though it would otherwise attach the
  // user's cached Basic-auth credentials. (Body size is capped by the
  // server's maxRequestBodySize.)
  const type = (req.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new ClientError('Content-Type must be application/json');
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientError('invalid JSON');
  }
}

// ------------------------------------------------------------------- api

// The request body cap alone (64KB) would still admit absurd labels into the
// store and the UI; MAX_FIELD_CHARS (lib/protocol.ts) is the per-field bound.
const MAX_COMMANDS = 100;

function requireString(value: unknown, name: string, { optional = false } = {}): string {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || value.trim() === '') throw new ClientError(`"${name}" is required`);
  if (value.length > MAX_FIELD_CHARS) throw new ClientError(`"${name}" is too long (max ${MAX_FIELD_CHARS} characters)`);
  return value.trim();
}

function authFailure(result: { status: 401 | 429; retryAfter?: number }): Response {
  if (result.status === 429) {
    return respond(429, `Too many failed attempts. Retry in ${result.retryAfter}s.`, {
      'Retry-After': String(result.retryAfter),
      'Content-Type': 'text/plain',
    });
  }
  return respond(401, 'Authentication required. Sign in as "promptportal" with the web-access password.', {
    'WWW-Authenticate': 'Basic realm="prompt-portal (username: promptportal)", charset="UTF-8"',
    'Content-Type': 'text/plain',
  });
}

function offeredProtocols(req: Request): string[] {
  return (req.headers.get('sec-websocket-protocol') || '').split(',').map((p) => p.trim());
}

// Input is keystrokes and pastes; a browser frame has no business being huge.
const MAX_BROWSER_FRAME_BYTES = 1024 * 1024;

// Run the hub CLI: 'done' for the one-shot paths (help, set-password), and
// 'serving' once the listener is up — the caller decides whether to exit
// (never while serving). CLI misuse throws CliError.
export async function runHub(cliArgs: string[]): Promise<'done' | 'serving'> {
  if (cliArgs[0] === '-h' || cliArgs[0] === '--help') {
    console.log(HUB_USAGE);
    return 'done';
  }
  if (cliArgs[0] === 'set-password') {
    await setHubPasswords();
    return 'done';
  }
  const cli = parseHubCli(cliArgs);

  const PORT = cli.port ?? (Number(process.env.PROMPTPORTAL_PORT) || 8080);
  // Loopback by default: the hub speaks plain HTTP and Basic auth resends the
  // password with every request, so a reachable-from-the-network listener is an
  // explicit decision (--host / PROMPTPORTAL_HOST=0.0.0.0) to pair with TLS in
  // front. The hub container sets it (Dockerfile.hub) and publishes the port
  // loopback-bound instead (docker-compose.yml).
  const HOST = cli.host || process.env.PROMPTPORTAL_HOST || '127.0.0.1';
  const DATA_DIR = cli.data || process.env.PROMPTPORTAL_DATA || path.join(process.cwd(), 'data');
  const TRUST_PROXY = ['1', 'true'].includes(process.env.PROMPTPORTAL_TRUST_PROXY ?? '');

  // The two secrets: browsers present the web-access password via Basic auth
  // (username "promptportal"); workstation session and launcher sockets present
  // the workstation password. See lib/auth.ts.
  const passwords = resolveHubPasswords();
  if (passwords.problems.length > 0) {
    throw new CliError(passwords.problems.join('\n'));
  }

  const auth = new Auth(passwords.webaccess, passwords.workstation);
  const store = new Store(DATA_DIR);
  const directory = new Directory();

  async function handleApi(req: Request, url: URL): Promise<Response> {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/state':
        return respondJson(200, {
          profiles: store.profiles,
          commands: store.commands,
          nodes: directory.launcherNames(),
          sessions: directory.listSessions(),
        });

      case 'GET /api/token':
        return respondJson(200, { token: auth.issueToken() });

      case 'POST /api/profiles': {
        const body = await readJsonBody(req);
        const profile = {
          name: requireString(body.name, 'name'),
          cwd: requireString(body.cwd, 'cwd'),
          command: requireString(body.command, 'command', { optional: true }),
          node: requireString(body.node, 'node', { optional: true }) || undefined,
        };
        store.upsertProfile(profile, typeof body.replace === 'string' ? body.replace : undefined);
        return respondJson(200, { ok: true });
      }

      case 'POST /api/profiles/delete': {
        const body = await readJsonBody(req);
        store.deleteProfile(requireString(body.name, 'name'));
        return respondJson(200, { ok: true });
      }

      case 'POST /api/commands': {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.commands) || body.commands.some((c: unknown) => typeof c !== 'string')) {
          throw new ClientError('"commands" must be an array of strings');
        }
        if (body.commands.length > MAX_COMMANDS) throw new ClientError(`at most ${MAX_COMMANDS} commands`);
        if (body.commands.some((c: string) => c.length > MAX_FIELD_CHARS)) {
          throw new ClientError(`each command must be at most ${MAX_FIELD_CHARS} characters`);
        }
        store.setCommands(body.commands.map((c: string) => c.trim()).filter(Boolean));
        return respondJson(200, { ok: true });
      }

      case 'POST /api/sessions': {
        const body = await readJsonBody(req);
        let { label, cwd, command, node } = body;
        if (body.profile) {
          const profile = store.getProfile(body.profile);
          if (!profile) return respondJson(404, { error: `profile "${body.profile}" not found` });
          ({ name: label, cwd, command, node } = profile);
        }
        // The cwd is validated on the target workstation (its own filesystem), so
        // a bad directory surfaces as a 400 here. label/command must be validated
        // as strings here, though: a non-string serializes into a frame the
        // launcher's parser rejects wholesale, which would surface as a 10s
        // timeout instead of a 400.
        // An explicit node in the body wins over a profile's pinned workstation.
        const created = await directory.createSession(requireString(body.node, 'node', { optional: true }) || node, {
          label: requireString(label, 'label', { optional: true }),
          cwd: requireString(cwd, 'cwd'),
          command: requireString(command, 'command', { optional: true }),
        });
        return respondJson(200, created);
      }

      case 'POST /api/sessions/delete': {
        const body = await readJsonBody(req);
        const conn = directory.get(requireString(body.id, 'id'));
        if (!conn) return respondJson(404, { error: 'session not found' });
        conn.kill();
        return respondJson(200, { ok: true });
      }

      default:
        return respondJson(404, { error: 'not found' });
    }
  }

  // The brute-force lockout keys on client IP. Behind a reverse proxy every
  // request arrives from the proxy's address, so one attacker would lock out
  // everyone; PROMPTPORTAL_TRUST_PROXY says the proxy is trusted to append the
  // real client IP to X-Forwarded-For.
  let warnedForwarded = false;
  function clientIp(req: Request): string {
    const forwarded = req.headers.get('x-forwarded-for');
    if (TRUST_PROXY) {
      if (forwarded) return forwarded.split(',').pop()!.trim();
    } else if (!warnedForwarded && forwarded) {
      warnedForwarded = true;
      console.warn('auth: requests carry X-Forwarded-For but PROMPTPORTAL_TRUST_PROXY is unset;'
        + ' lockouts key on the proxy address, so one attacker locks out everyone');
    }
    return server.requestIP(req)?.address ?? 'unknown';
  }

  // Three upgrade endpoints share the port, told apart by path:
  //   /ws?session=<id>   a browser attaching to a session (token auth)
  //   /session           a session host registering (node-secret auth)
  //   /launcher?name=<n> a workstation launcher registering (node-secret auth)
  // Each carries its secret in a Sec-WebSocket-Protocol slot, out of the URL.
  function handleUpgrade(req: Request, url: URL): Response | undefined {
    const offered = offeredProtocols(req);

    if (url.pathname === '/session' || url.pathname === '/launcher') {
      const marker = url.pathname === '/session' ? SESSION_PROTOCOL : LAUNCHER_PROTOCOL;
      // The workstation presents the password base64url-encoded (subprotocol
      // values must be HTTP tokens; the encoding frees the password's charset).
      const presented = offered.find((p) => p && p !== marker) || '';
      const gate = auth.checkPassword(Buffer.from(presented, 'base64url'), clientIp(req));
      if (!gate.ok) {
        return respond(gate.status, gate.status === 429 ? 'Too Many Requests' : 'Unauthorized');
      }
      const name = url.searchParams.get('name') || '';
      if (url.pathname === '/launcher' && !NODE_NAME_RE.test(name)) {
        return respond(400, 'Bad Request');
      }
      const ok = server.upgrade(req, {
        headers: { 'Sec-WebSocket-Protocol': marker },
        data: url.pathname === '/session'
          ? { kind: 'session', conn: null, missedPongs: 0 }
          : { kind: 'launcher', name, missedPongs: 0 },
      });
      return ok ? undefined : respond(400, 'Bad Request');
    }

    if (url.pathname === '/ws') {
      const session = url.searchParams.get('session');
      const token = offered.find((p) => p && p !== BROWSER_PROTOCOL);
      // Check the session first: a vanished session must not burn the
      // single-use token, so the client's retry can still succeed.
      const conn = session ? directory.get(session) : undefined;
      if (!conn || !auth.consumeToken(token)) {
        return respond(401, 'Unauthorized');
      }
      const ok = server.upgrade(req, {
        headers: { 'Sec-WebSocket-Protocol': BROWSER_PROTOCOL },
        data: { kind: 'browser', conn, clientId: null, missedPongs: 0 },
      });
      return ok ? undefined : respond(400, 'Bad Request');
    }

    return respond(404, 'Not Found');
  }

  // Every open socket, for the liveness reaper below.
  const liveSockets = new Set<PtSocket>();

  const server = Bun.serve<WsData>({
    port: PORT,
    hostname: HOST,
    // API bodies are small JSON; nothing else takes a body.
    maxRequestBodySize: 64 * 1024,

    async fetch(req) {
      // new URL(req.url) can throw on request targets the HTTP parser accepts
      // but the WHATWG parser rejects — and this runs before auth.
      let url;
      try {
        url = new URL(req.url);
      } catch {
        return respond(400, 'Bad request.', { 'Content-Type': 'text/plain' });
      }

      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return handleUpgrade(req, url);
      }

      const gate = auth.check(req.headers.get('authorization') ?? undefined, clientIp(req));
      if (!gate.ok) return authFailure(gate);

      if (url.pathname.startsWith('/api/')) {
        try {
          return await handleApi(req, url);
        } catch (err) {
          if (err instanceof ClientError) return respondJson(400, { error: err.message });
          // An unexpected fault (e.g. the store failing to write): log it, but
          // don't hand the client a misleading 400 or the raw message.
          console.error(`hub: api ${req.method} ${url.pathname}: ${(err as Error).message}`);
          return respondJson(500, { error: 'internal error' });
        }
      }

      const entry = STATIC_FILES[url.pathname];
      if (entry && (req.method === 'GET' || req.method === 'HEAD')) {
        const [file, type] = entry;
        const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
        if (req.method === 'HEAD') return respond(200, null, headers);
        const blob = Bun.file(file);
        if (!(await blob.exists())) {
          console.error(`static: ${file}: not found`);
          return respond(500, 'Failed to read file.', { 'Content-Type': 'text/plain' });
        }
        return new Response(blob, { headers: { ...BASE_HEADERS, ...headers } });
      }

      return respond(404, 'Not found.', { 'Content-Type': 'text/plain' });
    },

    // A thrown handler must not take the hub down — every browser view and
    // workstation link hangs off this process (the sessions themselves live on
    // their workstations and would survive, unreachable).
    error(err) {
      console.error(`hub: ${err.message}`);
      return respond(500, 'Internal error.', { 'Content-Type': 'text/plain' });
    },

    websocket: {
      maxPayloadLength: 16 * 1024 * 1024, // a build-log firehose from a session, not a browser frame
      // The reaper below is what detects dead peers; this is only a backstop,
      // and it must not outpace the 10s ping interval.
      idleTimeout: 480,

      open(ws: PtSocket) {
        liveSockets.add(ws);
        const data = ws.data;
        if (data.kind === 'launcher') {
          directory.registerLauncher(data.name, ws);
          console.log(`hub: workstation "${data.name}" connected`);
        } else if (data.kind === 'browser') {
          // The session can drop between upgrade and open; a watcher of a dead
          // connection would never be cleaned up.
          if (data.conn.ws.readyState !== 1) return ws.close();
          data.conn.attachBrowser(ws);
        }
        // A session socket registers with its first frame.
      },

      message(ws: PtSocket, raw: string | Buffer) {
        const data = ws.data;
        // A text frame's .length counts UTF-16 code units, not bytes; cap bytes.
        if (data.kind === 'browser'
          && (typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length) > MAX_BROWSER_FRAME_BYTES) {
          return ws.terminate();
        }
        const msg = parse(raw);
        if (!msg) return;
        switch (data.kind) {
          case 'session':
            if (data.conn) {
              data.conn.handleMessage(msg);
            } else if (msg.t === 'register') {
              data.conn = directory.registerSession(ws, msg.session);
              if (!data.conn) return ws.close();
              // JSON.stringify keeps control characters in these remote strings
              // from forging log lines or escaping into the operator's terminal.
              console.log(`hub: session ${JSON.stringify(data.conn.info.label)} on ${JSON.stringify(data.conn.info.node)} connected`);
            }
            break;
          case 'launcher':
            directory.handleLauncherMessage(msg);
            break;
          case 'browser':
            data.conn.handleBrowserMessage(msg);
            break;
        }
      },

      close(ws: PtSocket) {
        liveSockets.delete(ws);
        const data = ws.data;
        if (data.kind === 'session') {
          if (data.conn) directory.unregisterSession(data.conn);
        } else if (data.kind === 'launcher') {
          directory.unregisterLauncher(data.name, ws);
        } else {
          data.conn.detachBrowser(data.clientId, ws);
        }
      },

      pong(ws: PtSocket) {
        ws.data.missedPongs = 0;
      },
    },
  });

  // Drop peers that vanished without a close frame (phone lost signal, the
  // workstation slept) so nothing accumulates dead sockets. Dead means three
  // missed pong cycles — the same 30s the application-frame watchdogs allow;
  // a single cycle would reap a live peer over one bad RTT spike, and a
  // falsely reaped session socket drops its watchers and costs a full replay
  // on redial. Every peer also gets a {t:'ping'} frame: WS-level pings are
  // answered below the JS layer on both ends, so only an application frame
  // lets a workstation (cli/link.ts) or a page (public/app.js) tell a silent
  // hub from a dead link.
  setInterval(() => {
    for (const ws of liveSockets) {
      if (++ws.data.missedPongs >= 3) { ws.terminate(); continue; }
      ws.ping();
      send(ws, { t: 'ping' });
    }
  }, 10 * 1000).unref();

  // ------------------------------------------------------------- lifecycle

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal}: shutting down`);
      server.stop();
      process.exit(0);
    });
  }

  console.log(`prompt-portal hub listening on http://${HOST}:${PORT} (data: ${path.resolve(DATA_DIR)})`);

  // The hub itself speaks plain HTTP, and Basic auth resends the password with
  // every request — so a non-loopback listener is only safe with TLS
  // terminating in front (reverse proxy, tailscale serve, or a private compose
  // network). Say so at startup; the bare quickstart is one missed README
  // paragraph away from broadcasting the password on the LAN.
  if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    console.warn('hub: listening on a non-loopback address over plain HTTP — every request'
      + ' carries the password, so TLS must terminate in front (reverse proxy or VPN);'
      + ' set PROMPTPORTAL_HOST=127.0.0.1 if a local proxy is the only way in');
  }

  return 'serving';
}

if (import.meta.main) {
  try {
    if (await runHub(process.argv.slice(2)) === 'done') process.exit(0);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}
