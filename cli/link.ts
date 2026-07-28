import { MAX_BUFFERED_BYTES, parse, type Msg } from '../lib/protocol';
import { CliError } from './config';

// One maintained outbound WebSocket to the hub, shared plumbing for the two
// workstation roles: a session host (host.ts, /session) and the launcher
// (launcher.ts, /launcher). Dials, redials with backoff, and watches for a
// hub that went silent.

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10 * 1000;
// A link must survive this long before its close resets the reconnect
// backoff. Resetting on open alone would let two peers that share an
// identity replace each other's registration in a tight 1s loop forever (the
// hub terminates the old link on each new registration); requiring a stable
// link turns that misconfiguration into ordinary exponential backoff.
const STABLE_LINK_MS = 30 * 1000;
// The hub sends a {t:'ping'} frame every 10s; a link this quiet has missed
// three of them and is dead (WS-level pings are answered below the JS layer,
// so they prove nothing to this end). Redial rather than trust it.
const SILENCE_TIMEOUT_MS = 30 * 1000;
// How long a dropped link gets to deliver its close event. terminate() on a
// live socket closes it immediately — but on a transport that died during a
// system sleep, Bun's close event can fail to arrive at all, and a redial
// loop waiting for it would park forever (a launcher that never comes back
// after the machine wakes). The grace timer settles the link regardless.
const TERMINATE_GRACE_MS = 2 * 1000;

// Accepts http(s)/ws(s); the link is a WebSocket, so normalize to ws(s). A
// bare host ("hub.example.com") means TLS — cleartext is never a default, so
// it must be asked for with an explicit ws:// or http://.
export function normalizeHubUrl(raw: string): string {
  const url = raw.replace(/\/+$/, '');
  let normalized;
  if (url.startsWith('https://')) normalized = 'wss://' + url.slice('https://'.length);
  else if (url.startsWith('http://')) normalized = 'ws://' + url.slice('http://'.length);
  else if (url.startsWith('wss://') || url.startsWith('ws://')) normalized = url;
  else if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) normalized = 'wss://' + url;
  else throw new CliError(`PROMPTPORTAL_HUB_URL must be an http(s)/ws(s) URL, got: ${raw}`);
  // A malformed value (bad host, stray space) must fail here, loudly, at
  // startup — not later inside the WebSocket constructor.
  try {
    if (new URL(normalized).hostname === '') throw new Error('no host');
  } catch {
    throw new CliError(`PROMPTPORTAL_HUB_URL is not a valid URL: ${raw}`);
  }
  // Endpoint paths are appended to this value (`${url}/session`), which a
  // query or fragment would silently corrupt.
  if (normalized.includes('?') || normalized.includes('#')) {
    throw new CliError(`PROMPTPORTAL_HUB_URL must not carry a query or fragment: ${raw}`);
  }
  return normalized;
}

// ws:// carries the workstation password (and every keystroke) in cleartext. That is
// fine on this machine or inside a compose network (single-label hosts like
// "hub"); anywhere else it hands the one secret to any eavesdropper. A
// warning rather than a refusal: a LAN deployment may accept the tradeoff
// knowingly, and the hub's loopback listen default already makes a remote
// cleartext hub a deliberate act.
export function warnIfCleartext(url: string): void {
  if (!url.startsWith('ws://')) return;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || !host.includes('.')) return;
  console.error(`WARNING: hub link to ${host} uses unencrypted ws:// — the workstation password`
    + ' and all terminal traffic are readable in transit; use wss:// (an https hub URL)');
}

export type Post = (msg: Msg) => void;

export interface LinkHandlers {
  onOpen(post: Post): void;
  onMessage(msg: Msg, post: Post): void;
  onClose?(): void;
}

// Maintain the link forever: dial, hand frames to the handlers, redial on
// loss with exponential backoff. Never resolves.
export async function maintainLink(url: string, subprotocol: string, password: string,
                                   handlers: LinkHandlers): Promise<never> {
  console.log(`maintaining hub link to ${url}`);
  let delay = RECONNECT_MIN_MS;
  while (true) {
    const uptime = await runLink(url, subprotocol, password, handlers);
    if (uptime >= STABLE_LINK_MS) delay = RECONNECT_MIN_MS;
    console.log(`hub link down; reconnecting in ${Math.round(delay / 1000)}s`);
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  }
}

// One connected link, from open to close. Resolves once the socket closes,
// with how long it was open in ms — 0 if it never opened (for the backoff
// reset).
function runLink(url: string, subprotocol: string, password: string,
                 handlers: LinkHandlers): Promise<number> {
  return new Promise((resolve) => {
    // The workstation password rides in a subprotocol slot, out of the URL (and
    // access logs). Base64url-encoded: subprotocol values must be HTTP
    // tokens, and the encoding lifts that charset restriction off the
    // password itself.
    //
    // A constructor throw (malformed URL) must count as a failed dial, not
    // escape: an exception here would reject through the caller's void'd
    // promise and silently end reconnection for the process's lifetime.
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, [subprotocol, Buffer.from(password, 'utf8').toString('base64url')]);
    } catch (err) {
      console.log(`cannot dial hub: ${(err as Error).message}`);
      return resolve(0);
    }

    let openedAt = 0;
    let lastTraffic = Date.now();
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    // Every path out of this link funnels here, exactly once: the close
    // event when it arrives, drop()'s grace timer when it does not.
    const settle = () => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      if (graceTimer) clearTimeout(graceTimer);
      handlers.onClose?.();
      resolve(openedAt === 0 ? 0 : Date.now() - openedAt);
    };

    // Abandon the link. terminate(), not close(): a graceful close waits for
    // queued data to drain, which on a dead or backlogged link never happens
    // — the socket would sit in CLOSING instead of redialing. The close
    // event normally follows and settles; the grace timer covers a
    // terminate() whose close event never arrives.
    const drop = () => {
      ws.terminate();
      graceTimer ??= setTimeout(() => {
        console.log('hub link close event never arrived; abandoning the socket');
        settle();
      }, TERMINATE_GRACE_MS);
    };

    // Terminal output can outrun a slow link; one whose send buffer
    // grows past the cap is dropped rather than buffered without bound, so
    // every viewer recovers from the replay snapshot on redial.
    const post: Post = (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        console.log('hub link send queue overflowed; dropping it to resync');
        drop();
        return;
      }
      ws.send(JSON.stringify(msg));
    };

    // Armed from the dial itself, not from the first ping: a link blackholed
    // before any frame arrives would otherwise sit "open" until TCP gives up
    // on it — many minutes, or never on an idle socket.
    const watchdog = setInterval(() => {
      if (Date.now() - lastTraffic > SILENCE_TIMEOUT_MS) {
        console.log('hub link silent too long; dropping it to redial');
        drop();
      }
    }, 10 * 1000);
    watchdog.unref?.();

    ws.onopen = () => {
      openedAt = Date.now();
      lastTraffic = openedAt;
      console.log('hub link established');
      handlers.onOpen(post);
    };

    ws.onmessage = (event) => {
      lastTraffic = Date.now();
      const msg = parse(event.data);
      if (msg) handlers.onMessage(msg, post);
    };

    // Logged even without a message: an error event with no detail is still
    // the only trace some failures leave (a close event is not guaranteed to
    // follow — see drop()).
    ws.onerror = (event: Event & { message?: string }) => {
      console.log(`hub link error${event.message ? `: ${event.message}` : ''}`);
    };

    ws.onclose = (event) => {
      const detail = `code ${event.code}` + (event.reason ? ` ${JSON.stringify(event.reason)}` : '');
      if (openedAt === 0) console.log(`hub link dial failed (${detail})`);
      else console.log(`hub link closed (${detail}, up ${Math.round((Date.now() - openedAt) / 1000)}s)`);
      settle();
    };
  });
}
