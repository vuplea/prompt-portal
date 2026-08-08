// Wire protocols and shared framing, used by both ends: the hub (server.ts,
// lib/directory.ts) and the workstation binary (cli/). One frame shape covers
// every protocol; each frame is a single JSON object.
//
// Three WebSocket protocols meet at the hub, told apart by URL path, each
// carrying its secret in a Sec-WebSocket-Protocol slot (never the URL, which
// lands in access logs):
//
//   BROWSER_PROTOCOL   browser <-> hub, one socket per open session view.
//     Terminal frames, identical regardless of which workstation hosts the
//     session:
//       server -> client : {t:'s', d}         replay snapshot on (re)attach
//                          {t:'o', d}         live output
//                          {t:'x', code}      process exited
//                          {t:'scheds', scheds} pending scheduled inputs, on
//                                             attach and after every change
//       client -> server : {t:'i', d}         input (keystrokes/paste)
//                          {t:'r', c, r}      resize to c cols x r rows
//                          {t:'sched', d, delay} type d (then Enter) in delay ms
//                          {t:'unsched', id}  cancel a pending scheduled input
//
//   SESSION_PROTOCOL   session host (`prompt-portal`) -> hub, one outbound socket per
//     session — the connection *is* the session, so no frame names one. The
//     host registers, then streams; the hub relays its watching browsers.
//       host -> hub : {t:'register', session}  once, on connect
//                     {t:'o', d}               live output (while watched)
//                     {t:'s', client, d}       replay snapshot for one client
//                     {t:'x', code[, client]}  process exited
//                     {t:'scheds', scheds[, client]} pending scheduled inputs
//       hub -> host : {t:'watch', client}      a browser attached: replay to it
//                     {t:'unwatch'}            a browser left
//                     {t:'i', d} {t:'r', c, r} input and resize
//                     {t:'sched', d, delay} {t:'unsched', id} scheduled input
//                     {t:'kill'}               close the session and exit
//
//   LAUNCHER_PROTOCOL  workstation launcher (`prompt-portal launcher`) -> hub, one
//     outbound socket per workstation. Exists only so the phone can start
//     sessions; it relays no terminal traffic.
//       hub -> launcher : {t:'create', id, label, cwd, command}
//       launcher -> hub : {t:'created', id, error}   only on spawn failure —
//                         success is the new session registering itself
//
//   The hub also sends {t:'ping'} periodically on every socket so the far
//   end — workstation or browser — can tell a silent link from a dead one
//   (the WS-level pong each auto-sends is invisible to its own code).

// These values are the wire protocol: a hub and a workstation must present
// them byte-identically, and browsers hold Basic-auth logins under the
// username. They deliberately keep the old single-token spelling — renaming
// them to match the prompt-portal command would break every deployed peer
// and saved login for zero functional gain. (public/app.js carries its own
// literal BROWSER_PROTOCOL; it cannot import this.)
export const BROWSER_PROTOCOL = 'promptportal';
export const SESSION_PROTOCOL = 'promptportal-session';
export const LAUNCHER_PROTOCOL = 'promptportal-launcher';

// The fixed Basic-auth username; the web-access password is the real secret.
export const BASIC_USERNAME = 'promptportal';

// A workstation's name: what `prompt-portal` validates PROMPTPORTAL_NODE_NAME against, sends
// as the /launcher?name= param, and the hub re-validates on upgrade. Both ends
// must apply the identical rule or a name one side accepts silently fails to
// register on the other.
export const NODE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// A peer whose send buffer grows past this is too far behind (slow link,
// backgrounded phone): drop it rather than buffer terminal output without
// bound. It reconnects and catches up from the replay snapshot.
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

// Every string field crossing the trust boundaries is human-typed — a label,
// a path, a command line — so cap it well above any real value. The HTTP API
// rejects longer fields (server.ts); session registration truncates instead
// (lib/directory.ts) — the session is already running, so degrading its
// display beats refusing to link it.
export const MAX_FIELD_CHARS = 2048;

// What a session host registers, and what the hub's session list serves the
// UI (GET /api/state). Only live sessions exist: a session whose shell
// exited is gone moments later (its host exits), so there is no
// alive/exited state to carry.
export interface SessionInfo {
  id: string;
  label: string;
  cwd: string;
  command: string;
  node?: string; // the hosting workstation's name
}

// One pending scheduled input on a session: at `at` the host types `d` into
// the pty, then Enter. Schedules live in the session host — the one process
// whose lifetime is exactly the session's — so they survive hub restarts and
// link drops, and die with the session (see cli/schedule.ts).
export interface ScheduledInput {
  id: string;
  d: string; // the text to type
  at: number; // fire time, epoch ms on the host's clock
}

export interface Msg {
  t?: string;
  id?: string;
  d?: string;
  c?: number;
  r?: number;
  code?: number | null;
  client?: string;
  label?: string;
  cwd?: string;
  command?: string;
  error?: string;
  session?: SessionInfo;
  delay?: number;
  scheds?: ScheduledInput[];
}

export function parse(raw: unknown): Msg | null {
  try {
    const value = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    // Arrays are objects to typeof, but no frame is one; letting them through
    // would hand handlers a "Msg" whose every field is undefined.
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Msg) : null;
  } catch {
    return null;
  }
}

// The minimal socket surface framing needs, satisfied by Bun's ServerWebSocket
// and the standard WebSocket alike (readyState 1 is OPEN in both).
export interface WireSocket {
  readyState: number;
  send(data: string): unknown;
}

export function send(ws: WireSocket, message: Msg): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}
