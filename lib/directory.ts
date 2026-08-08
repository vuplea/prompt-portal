import type { ServerWebSocket } from 'bun';

import { ClientError } from './errors';
import { MAX_BUFFERED_BYTES, MAX_FIELD_CHARS, send, type Msg, type SessionInfo } from './protocol';

// The hub's view of the workstation side. Every session is a `prompt-portal` process
// that dialed in on its own outbound WebSocket — the connection *is* the
// session, so a session disappears the moment its process (and on Windows,
// its terminal window) dies. Launchers are the one resident process per
// workstation, connected only so the phone can start new sessions there.

const CREATE_TIMEOUT_MS = 10 * 1000;
// How long a timed-out create's id stays flagged so a straggling
// registration is recognized and killed (see createSession).
const CREATE_TOMBSTONE_MS = 5 * 60 * 1000;

// Per-connection context attached at upgrade time; Bun delivers WebSocket
// events to one central handler (server.ts), which dispatches on `kind`.
export type WsData =
  | { kind: 'session'; conn: SessionConn | null; missedPongs: number }
  | { kind: 'launcher'; name: string; missedPongs: number }
  | { kind: 'browser'; conn: SessionConn; clientId: string | null; missedPongs: number };

export type PtSocket = ServerWebSocket<WsData>;

interface PendingCreate {
  resolve: (id: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Every send to any peer is bounded: a socket whose send buffer grew past the
// cap is too far behind (slow browser link) or stalled (workstation vanished
// without a close frame) — drop it rather than buffer without bound. Browsers
// reconnect and replay; hosts redial and re-register.
function sendBounded(ws: PtSocket, msg: Msg): void {
  if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) ws.terminate();
  else send(ws, msg);
}

// One registered session: its socket, its registration info, and the browser
// sockets currently watching it.
export class SessionConn {
  readonly info: SessionInfo;
  readonly ws: PtSocket;
  private watchers = new Map<string, PtSocket>(); // clientId -> browser ws

  constructor(info: SessionInfo, ws: PtSocket) {
    this.info = info;
    this.ws = ws;
  }

  handleMessage(msg: Msg): void {
    let payload: Msg;
    switch (msg.t) {
      case 's':
      case 'o':
        if (typeof msg.d !== 'string') return;
        payload = { t: msg.t, d: msg.d };
        break;
      case 'x':
        payload = { t: 'x', code: typeof msg.code === 'number' ? msg.code : null };
        break;
      case 'scheds':
        if (!Array.isArray(msg.scheds)) return;
        payload = { t: 'scheds', scheds: msg.scheds };
        break;
      default:
        return;
    }
    // A client-tagged frame (a replay snapshot and its companions) answers
    // one browser; anything else fans out to all watchers.
    const targets = msg.client ? [this.watchers.get(msg.client)] : this.watchers.values();
    for (const ws of targets) {
      if (ws && ws.readyState === 1) sendBounded(ws, payload);
    }
  }

  // Register a browser socket as a watcher; frames flow until detachBrowser
  // (its close handler) unhooks it. The host answers the watch with a replay
  // snapshot for exactly this client. Until that snapshot arrives the new
  // watcher also receives live 'o' frames the snapshot will re-contain; the
  // client must treat 's' as authoritative (reset, then write), which is what
  // makes the overlap harmless.
  attachBrowser(ws: PtSocket): void {
    const clientId = crypto.randomUUID();
    if (ws.data.kind === 'browser') ws.data.clientId = clientId;
    this.watchers.set(clientId, ws);
    sendBounded(this.ws, { t: 'watch', client: clientId });
  }

  detachBrowser(clientId: string | null, ws: PtSocket): void {
    if (!clientId || this.watchers.get(clientId) !== ws) return;
    this.watchers.delete(clientId);
    sendBounded(this.ws, { t: 'unwatch' });
  }

  // Input, resize, and schedule management from a watching browser, bound
  // for the host (which validates schedule fields itself). Input frames can
  // be up to 1MB each (pastes), so this direction needs the send bound as
  // much as the fan-out does.
  handleBrowserMessage(msg: Msg): void {
    if (msg.t === 'i' && typeof msg.d === 'string') sendBounded(this.ws, { t: 'i', d: msg.d });
    else if (msg.t === 'r') sendBounded(this.ws, { t: 'r', c: msg.c, r: msg.r });
    else if (msg.t === 'sched' && typeof msg.d === 'string' && typeof msg.delay === 'number') {
      const frame: Msg = { t: 'sched', d: msg.d, delay: msg.delay };
      if (msg.esc === true) frame.esc = true;
      sendBounded(this.ws, frame);
    } else if (msg.t === 'unsched' && typeof msg.id === 'string') {
      sendBounded(this.ws, { t: 'unsched', id: msg.id });
    }
  }

  kill(): void {
    // Deliberately not sendBounded: dropping a destructive control frame on a
    // backlogged link would not kill anything — the host just redials and
    // re-registers, and the "killed" session lives on. One tiny frame on an
    // already-oversized buffer changes nothing; the reaper handles dead links.
    send(this.ws, { t: 'kill' });
  }

  // The session is gone (its socket closed): drop the watchers; their pages
  // refresh state and leave the terminal view.
  shutdown(): void {
    for (const ws of this.watchers.values()) ws.close();
    this.watchers.clear();
  }
}

export class Directory {
  private sessions = new Map<string, SessionConn>(); // sessionId -> conn
  private launchers = new Map<string, PtSocket>(); // node name -> launcher ws
  private pendingCreates = new Map<string, PendingCreate>(); // sessionId -> pending
  private timedOutCreates = new Set<string>(); // create ids that already failed at the API

  // A session host's first frame. Everything that reads the info dereferences
  // it, so malformed registrations are rejected wholesale (the socket is
  // closed by the caller).
  registerSession(ws: PtSocket, info: unknown): SessionConn | null {
    if (!info || typeof info !== 'object') return null;
    const s = info as SessionInfo;
    if (typeof s.id !== 'string' || s.id === '' || typeof s.label !== 'string'
      || typeof s.cwd !== 'string' || typeof s.command !== 'string'
      || typeof s.node !== 'string') return null;
    // Ids are machine-generated and short; an oversized one is malformed
    // (truncating it could collide with another session's).
    if (s.id.length > MAX_FIELD_CHARS) return null;
    // A host this slow already failed its create at the API (the timeout in
    // createSession): the user was told the session did not start, and has
    // likely retried. Registering it now would put a phantom session beside
    // the retry — tell it to die instead (the caller closes the socket).
    if (this.timedOutCreates.delete(s.id)) {
      // JSON.stringify: remote strings must not put control characters in the log.
      console.warn(`hub: killed session ${JSON.stringify(s.label)} on ${JSON.stringify(s.node)} — it registered after its create timed out`);
      send(ws, { t: 'kill' });
      return null;
    }
    // A host redialing after a link drop replaces its previous registration:
    // the old socket may not have noticed yet that it is dead.
    this.sessions.get(s.id)?.ws.terminate();
    // Everything here is served to every browser in each state response, so
    // hold the frame to the same hygiene the HTTP API enforces: the named
    // fields only, display strings truncated (the session is already running
    // — degrading its label beats refusing to link it).
    const cut = (value: string) => value.slice(0, MAX_FIELD_CHARS);
    const conn = new SessionConn({
      id: s.id,
      label: cut(s.label),
      cwd: cut(s.cwd),
      command: cut(s.command),
      node: cut(s.node),
    }, ws);
    this.sessions.set(s.id, conn);
    const pending = this.pendingCreates.get(s.id);
    if (pending) {
      this.pendingCreates.delete(s.id);
      clearTimeout(pending.timer);
      pending.resolve(s.id);
    }
    return conn;
  }

  unregisterSession(conn: SessionConn): void {
    if (this.sessions.get(conn.info.id) === conn) this.sessions.delete(conn.info.id);
    conn.shutdown();
  }

  // A reconnecting launcher replaces its previous link, same as sessions.
  registerLauncher(name: string, ws: PtSocket): void {
    this.launchers.get(name)?.terminate();
    this.launchers.set(name, ws);
  }

  unregisterLauncher(name: string, ws: PtSocket): void {
    if (this.launchers.get(name) === ws) this.launchers.delete(name);
  }

  // A launcher only ever reports that a spawn failed; success is the session
  // itself registering.
  handleLauncherMessage(msg: Msg): void {
    if (msg.t !== 'created' || !msg.error) return;
    const pending = this.pendingCreates.get(msg.id ?? '');
    if (!pending) return;
    this.pendingCreates.delete(msg.id!);
    clearTimeout(pending.timer);
    pending.reject(new ClientError(msg.error));
  }

  get(id: string): SessionConn | undefined {
    return this.sessions.get(id);
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((c) => c.info);
  }

  launcherNames(): string[] {
    return [...this.launchers.keys()];
  }

  // Resolves which workstation a launch targets: an explicit name if given,
  // else the sole connected one. Throws a message the client can show.
  private resolveLauncher(name: string | undefined): { name: string; ws: PtSocket } {
    if (name) {
      const ws = this.launchers.get(name);
      if (!ws) throw new ClientError(`workstation "${name}" is not connected`);
      return { name, ws };
    }
    if (this.launchers.size === 1) {
      const [sole] = this.launchers.entries();
      return { name: sole![0], ws: sole![1] };
    }
    if (this.launchers.size === 0) throw new ClientError('no workstation is connected');
    throw new ClientError('multiple workstations connected — choose one');
  }

  // Ask a workstation's launcher to start a session. Resolves when the new
  // session registers (the launcher itself answers only on failure).
  createSession(node: string | undefined,
                { label, cwd, command }: { label: string; cwd: string; command: string },
                timeoutMs = CREATE_TIMEOUT_MS,
  ): Promise<{ id: string; node: string }> {
    const target = this.resolveLauncher(node);
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingCreates.delete(id);
        // The launcher may still be spawning the host; flag the id so a late
        // registration is killed rather than kept as a phantom session.
        this.timedOutCreates.add(id);
        setTimeout(() => this.timedOutCreates.delete(id), CREATE_TOMBSTONE_MS).unref();
        reject(new ClientError(`workstation "${target.name}" did not start the session`));
      }, timeoutMs);
      this.pendingCreates.set(id, {
        resolve: (sessionId) => resolve({ id: sessionId, node: target.name }),
        reject,
        timer,
      });
      sendBounded(target.ws, { t: 'create', id, label, cwd, command });
    });
  }
}
