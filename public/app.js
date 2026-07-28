'use strict';

/* ------------------------------------------------------------ state */

let profiles = [];
let commands = [];
let sessions = [];
let nodes = []; // connected workstation names

let sessionFilter = ''; // narrows the Running list to one workstation ('' = all)

let currentId = null; // session shown in the terminal view
let ws = null;
let lastFrameAt = 0; // last frame on the terminal socket (the hub pings every 30s)
let reconnectTimer = null;
let reconnectDelay = 1000;
let sessionMisses = 0; // consecutive state refreshes missing currentId
let sessionExited = false; // the viewed session reported {t:'x'}
let ctrlArmed = false;
let altArmed = false;
let shiftArmed = false;

const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

/* -------------------------------------------------------------- api */

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const res = await fetch('/api/' + path, options);
  if (res.status === 401) {
    location.reload(); // let the browser re-prompt for credentials
    throw Object.assign(new Error('unauthorized'), { silent: true });
  }
  if (res.status === 429) {
    // A lockout (plain-text body, no JSON). No reload: that would trade the
    // page — and any open terminal view — for a bare lockout message.
    // Background polls swallow this error; direct actions alert it.
    throw new Error(await res.text());
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Fire-and-forget a UI action; surface failures (e.g. acting on a session
// another client already closed) instead of dropping them as unhandled
// rejections.
function run(promise) {
  promise.catch((err) => { if (!err.silent) alert(err.message); });
}

async function refreshState() {
  ({ profiles, commands, sessions, nodes } = await api('state'));
  renderHome();
  renderSessionSelect();
}

/* ----------------------------------------------------------- views */

function showView(view) {
  document.body.dataset.view = view;
  if (view === 'home') refreshState().catch(console.error);
}

/* ------------------------------------------------------------- home */

function meta({ node, cwd, command }) {
  return `${node ? `${node} · ` : ''}${cwd}${command ? ' · ' + command : ''}`;
}

function renderHome() {
  // The filter offers only workstations that currently have sessions, and
  // hides itself when there is nothing to narrow. A selection whose
  // workstation lost its last session falls back to all — so the filtered
  // list is never empty while sessions exist, keeping the "no terminals"
  // message truthful.
  const filter = $('#session-filter');
  const machines = [...new Set(sessions.map((s) => s.node).filter(Boolean))];
  if (!machines.includes(sessionFilter)) sessionFilter = '';
  filter.hidden = machines.length < 2;
  filter.replaceChildren(
    el('option', { value: '', textContent: 'All workstations' }),
    ...machines.map((m) => el('option', { value: m, textContent: m })),
  );
  filter.value = sessionFilter;

  const shown = sessionFilter ? sessions.filter((s) => s.node === sessionFilter) : sessions;
  const sessionList = $('#session-list');
  sessionList.replaceChildren(...shown.map((s) =>
    el('li', {}, [
      el('div', { className: 'grow', onclick: () => openSession(s.id) }, [
        el('div', { className: 'title', textContent: s.label }),
        el('div', { className: 'meta', textContent: meta(s) }),
      ]),
      el('button', {
        className: 'danger-text', textContent: '✕', title: 'Close session',
        onclick: () => run(closeSession(s)),
      }),
    ])
  ));

  const profileList = $('#profile-list');
  profileList.replaceChildren(...profiles.map((p) =>
    el('li', {}, [
      el('div', { className: 'grow', onclick: () => run(launchProfile(p)), title: 'Launch' }, [
        el('div', { className: 'title', textContent: p.name }),
        el('div', { className: 'meta', textContent: meta(p) }),
      ]),
      el('button', { className: 'small', textContent: '✎', title: 'Edit', onclick: () => editProfile(p) }),
      el('button', {
        className: 'danger-text', textContent: '✕', title: 'Delete profile',
        onclick: () => {
          if (!confirm(`Delete profile "${p.name}"?`)) return;
          run(api('profiles/delete', { name: p.name }).then(refreshState));
        },
      }),
    ])
  ));

  $('#command-list').replaceChildren(...commands.map((c) =>
    el('li', {}, [
      el('div', { className: 'grow' }, [el('div', { className: 'meta', textContent: c })]),
      el('button', {
        className: 'danger-text', textContent: '✕', title: 'Remove',
        onclick: () => run(api('commands', { commands: commands.filter((x) => x !== c) }).then(refreshState)),
      }),
    ])
  ));
}

$('#session-filter').onchange = (e) => {
  sessionFilter = e.target.value;
  renderHome();
};

async function launchProfile(profile) {
  const { id } = await api('sessions', { profile: profile.name });
  await refreshState();
  openSession(id);
}

async function closeSession(s) {
  if (!confirm(`Kill "${s.label}"?`)) return;
  await api('sessions/delete', { id: s.id });
  if (currentId === s.id) detach();
  await refreshState();
}

/* ----------------------------------------------------- profile form */

function showProfileForm(profile) {
  $('#pf-replace').value = profile ? profile.name : '';
  $('#pf-name').value = profile ? profile.name : '';
  $('#pf-cwd').value = profile ? profile.cwd : '';
  $('#pf-command').value = profile ? profile.command || '' : '';
  // Offer connected workstations plus any name the profile already targets (it
  // may point at one that is currently offline). A profile always pins a
  // workstation: preselect the sole candidate, otherwise force a choice (the
  // select is required, so the browser blocks saving on the placeholder).
  const selected = profile ? profile.node || '' : '';
  const options = [...new Set(nodes.concat(selected ? [selected] : []))];
  const value = selected || (options.length === 1 ? options[0] : '');
  $('#pf-node').replaceChildren(
    ...(value ? [] : [el('option', { value: '', textContent: 'Choose…', disabled: true })]),
    ...options.map((n) => el('option', { value: n, textContent: n })),
  );
  $('#pf-node').value = value;
  $('#pf-chips').replaceChildren(...commands.map((c) =>
    el('button', {
      type: 'button', textContent: c,
      onclick: () => { $('#pf-command').value = c; },
    })
  ));
  $('#profile-form').hidden = false;
  $('#pf-name').focus();
}

function editProfile(profile) {
  showProfileForm(profile);
  $('#profile-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#btn-new-profile').onclick = () => showProfileForm(null);
$('#pf-cancel').onclick = () => { $('#profile-form').hidden = true; };

$('#profile-form').onsubmit = (e) => {
  e.preventDefault();
  run(api('profiles', {
    name: $('#pf-name').value.trim(),
    cwd: $('#pf-cwd').value.trim(),
    command: $('#pf-command').value.trim(),
    node: $('#pf-node').value || undefined,
    replace: $('#pf-replace').value || undefined,
  }).then(() => {
    $('#profile-form').hidden = true;
    refreshState();
  }));
};

$('#command-form').onsubmit = (e) => {
  e.preventDefault();
  const value = $('#cmd-new').value.trim();
  if (!value) return;
  run(api('commands', { commands: [...commands, value] }).then(() => {
    $('#cmd-new').value = '';
    refreshState();
  }));
};

/* --------------------------------------------------------- terminal */

let fontSize = Number(localStorage.getItem('fontSize')) || (matchMedia('(max-width: 600px)').matches ? 13 : 15);

const term = new Terminal({
  fontSize,
  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
  cursorBlink: true,
  scrollback: 5000,
  theme: {
    background: '#16161e',
    foreground: '#d8d8e4',
    cursor: '#7aa2f7',
    selectionBackground: '#3a3a5e',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
let termOpened = false;

// Applies and disarms the armed Shift/Ctrl/Alt modifiers on one keystroke.
function applyModifiers(data) {
  // Enter with the newline chord armed — the keybar's Enter or the phone
  // keyboard's own Enter key alike: ESC CR, what claude and codex read as
  // "insert newline" (their Alt+Enter). Plain terminals have no
  // Ctrl/Shift+Enter encoding of their own.
  if (data === '\r' && newlineArmed()) {
    (newline === 'ctrl' ? setCtrl : setShift)(false);
    return '\x1b\r';
  }
  if (shiftArmed) {
    data = data.toUpperCase(); // meaningful for letters; harmless elsewhere
    setShift(false);
  }
  if (ctrlArmed) {
    data = toCtrl(data) ?? data;
    setCtrl(false);
  }
  if (altArmed) {
    data = '\x1b' + data; // meta encoding: ESC prefix
    setAlt(false);
  }
  return data;
}

term.onData((data) => {
  // One code point is a keystroke (surrogate pairs included), anything longer
  // a paste. Either way an armed modifier is spent — left armed, it would
  // silently turn a later keystroke into a control char.
  if ([...data].length === 1) return sendInput(applyModifiers(data));
  setCtrl(false);
  setAlt(false);
  setShift(false);
  sendInput(data);
});

function toCtrl(ch) {
  if (ch === ' ') return '\x00';
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64); // @ A-Z [ \ ] ^ _
  return null;
}

// The hub caps browser frames at 1MB and terminates the socket past it, so a
// huge paste sent whole would tear down the view and vanish silently. Chunk
// well under the cap (JSON escaping can inflate a char to 6 bytes) without
// splitting a surrogate pair, whose halves would each decode to U+FFFD.
const MAX_INPUT_FRAME_CHARS = 128 * 1024;

function sendInput(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (data.length > MAX_INPUT_FRAME_CHARS) {
    let cut = MAX_INPUT_FRAME_CHARS;
    const last = data.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut--; // high surrogate: keep the pair together
    ws.send(JSON.stringify({ t: 'i', d: data.slice(0, cut) }));
    data = data.slice(cut);
  }
  ws.send(JSON.stringify({ t: 'i', d: data }));
}

let sentCols = 0; // size last sent on the current socket
let sentRows = 0;

// term.write is async: it queues into xterm's parser and drains on its own
// clock. The hub bounds the socket, but a flood (e.g. `yes`) can still outrun
// a phone's renderer and pile up inside xterm until its ~50M-char guard trips
// and silently drops output, stranding the view. Track the queue via
// write's callback; once it runs too deep, drop the socket — the reconnect
// replays a fresh snapshot, the same resync the server-side caps rely on.
const MAX_PENDING_WRITE = 4 * 1024 * 1024;
let pendingWrite = 0;
let writeEpoch = 0; // bumped on reset; a write's callback only counts within its epoch

// Reset the backpressure counter without corrupting it: writes queued before
// the reset carry the old epoch, so their late callbacks are ignored rather
// than subtracted from the new tally (which would understate the real backlog
// and defeat the guard below).
function resetPendingWrite() {
  pendingWrite = 0;
  writeEpoch++;
}

function writeTerm(data) {
  const epoch = writeEpoch;
  pendingWrite += data.length;
  term.write(data, () => {
    if (epoch === writeEpoch) pendingWrite = Math.max(0, pendingWrite - data.length);
  });
  if (pendingWrite > MAX_PENDING_WRITE && ws) {
    resetPendingWrite();
    ws.close(); // too far behind; reconnect and replay from a clean snapshot
  }
}

function fitTerm() {
  if (!termOpened || document.body.dataset.view !== 'term') return;
  try { fit.fit(); } catch { return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Resize events arrive in storms (window drags, the phone keyboard
  // animating); the pty only needs actual changes.
  if (term.cols === sentCols && term.rows === sentRows) return;
  sentCols = term.cols;
  sentRows = term.rows;
  ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
}

function setStatus(status) {
  $('#conn-dot').className = status;
  $('#conn-dot').title = status;
}

function openSession(id) {
  currentId = id;
  sessionMisses = 0;
  sessionExited = false;
  reconnectDelay = 1000; // a fresh view must not inherit another session's backoff
  showViewTerm();
  connect();
}

// Touch scrolling needs two things xterm's built-in handling doesn't give us.
// A stable event target: the DOM renderer rebuilds the row <span>s when it
// renders a scroll, touch events stick to the now-detached touchstart target,
// and so they stop bubbling — a transparent layer over the text fixes that.
// And scrolling that survives mouse-tracking apps: claude under ConPTY
// enables mouse reporting, and xterm then ignores touches entirely (its
// touch handlers are gated on the mouse protocol being off). So drags are
// translated into synthetic wheel events here: xterm's wheel pipeline
// scrolls the viewport for plain apps and reports the wheel to
// mouse-tracking apps — the same split a desktop mouse wheel gets. Taps
// still bubble for focus; only drags are swallowed.
function installTouchLayer() {
  if (!matchMedia('(pointer: coarse)').matches) return; // mouse selection needs the text hittable
  const layer = el('div', { className: 'touch-layer' });
  // Drags are translated per consumer. The scrollback viewport takes pixel
  // deltas: drag-the-paper feel, smooth below line granularity. Everything
  // an app consumes — mouse-tracking wheel reports, alternate-screen arrow
  // translation — counts events, not magnitude, so pixel deltas there would
  // scroll a tick per touchmove (wild acceleration); those get one unit
  // event per matching stretch of finger travel instead. The viewport runs
  // a touch ahead of the finger, 1.5x its travel — drag-the-paper with
  // enough lead that it never reads as sluggish. App ticks stay near the
  // finger's pace too: apps respond to the event rate, and a rate much
  // above the finger reads as acceleration, not speed.
  const DRAG_SPEED = 1.5; // viewport px scrolled per px of finger travel
  const DRAG_ROWS_PER_TICK = 1.8; // finger travel, in row-heights, per wheel tick sent to an app
  const wheel = (deltaY, deltaMode, touch) => layer.dispatchEvent(new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY,
    deltaMode,
    clientX: touch.clientX,
    clientY: touch.clientY,
  }));
  let touchY = null;
  let travel = 0; // px accumulated toward the next scrolled line
  layer.addEventListener('touchstart', (e) => {
    touchY = e.touches[0].clientY;
    travel = 0;
  }, { passive: true });
  layer.addEventListener('touchmove', (e) => {
    if (touchY === null) return;
    const touch = e.touches[0];
    const deltaY = touchY - touch.clientY; // finger up -> content down, standard touch semantics
    touchY = touch.clientY;
    e.preventDefault();
    e.stopPropagation();
    if (term.modes.mouseTrackingMode === 'none' && term.buffer.active.type === 'normal') {
      travel = 0;
      wheel(deltaY * DRAG_SPEED, WheelEvent.DOM_DELTA_PIXEL, touch);
      return;
    }
    travel += deltaY;
    const step = (layer.clientHeight / term.rows) * DRAG_ROWS_PER_TICK;
    const lines = Math.trunc(travel / step);
    travel -= lines * step;
    for (let i = 0; i < Math.abs(lines); i++) {
      wheel(Math.sign(lines), WheelEvent.DOM_DELTA_LINE, touch);
    }
  }, { passive: false });
  for (const ev of ['touchend', 'touchcancel']) {
    layer.addEventListener(ev, () => { touchY = null; });
  }
  term.element.querySelector('.xterm-screen').append(layer);
}

// Android keyboards revise words they have already committed — Gboard's
// autocorrect rewrites text behind the cursor. xterm gets no readable key
// events on Android (every keystroke is keyCode 229); it recovers input by
// diffing its hidden textarea, which it empties only on Enter or blur, so a
// long line accumulates there in full. A behind-the-cursor rewrite breaks
// the diff's append-only assumption, and xterm re-sends the entire
// accumulated line: typed text visibly repeats, again on every subsequent
// autocorrect. Trimming the textarea to its trailing word whenever
// composition is idle caps what a rewrite can touch — and what a broken
// diff can re-send — at a single word. The trailing word stays (rather
// than emptying the field outright) because a field that empties after
// every word makes the keyboard rebuild its state each time, a visible
// flicker. The trim is deferred one timer and abandoned if anything —
// composition, a keystroke, any value change — happened since it was
// scheduled: xterm reads the textarea on zero-delay timers of its own, and
// a trim landing between its before/after reads would send a spurious
// delete or drop a character.
function installImeWorkaround() {
  if (!matchMedia('(pointer: coarse)').matches) return; // desktop IMEs diff fine; leave them alone
  const textarea = term.textarea;
  let composing = false;
  let keySeq = 0;
  const scheduleTrim = () => {
    const value = textarea.value;
    const keep = value.match(/\S*\s*$/)[0]; // trailing word, its whitespace included
    if (keep === value) return;
    const seq = keySeq;
    setTimeout(() => {
      if (!composing && keySeq === seq && textarea.value === value) textarea.value = keep;
    }, 0);
  };
  textarea.addEventListener('keydown', () => { keySeq++; });
  textarea.addEventListener('compositionstart', () => { composing = true; });
  textarea.addEventListener('compositionend', () => {
    composing = false;
    scheduleTrim();
  });
  textarea.addEventListener('blur', () => { composing = false; }); // xterm empties the textarea on blur itself
  term.onData(scheduleTrim);
}

function showViewTerm() {
  document.body.dataset.view = 'term';
  if (!termOpened) {
    term.open($('#xterm'));
    termOpened = true;
    installTouchLayer();
    installImeWorkaround();
  }
  renderSessionSelect();
  requestAnimationFrame(fitTerm);
}

let connectSeq = 0; // bumping it invalidates connect() calls already in flight

// Drop the current socket without firing its handlers: a stale close must not
// schedule a reconnect, and a stale in-flight frame must not write into the
// next session's view.
function discardSocket() {
  if (!ws) return;
  ws.onclose = null;
  ws.onmessage = null;
  ws.close();
  ws = null;
}

function retryLater() {
  setStatus('reconnecting');
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 10000);
}

function scheduleReconnect() {
  if (document.body.dataset.view !== 'term' || !currentId) return;
  retryLater();
  // The session may have been closed from another client; the local list
  // wouldn't know. Refresh — but one refresh missing the session does not
  // mean it was closed: a blip on the session's own hub link unregisters it,
  // and it comes back when its host redials seconds later. Ride through a
  // few misses (retrying meanwhile) before going home.
  refreshState().then(() => {
    if (!currentId) return;
    if (sessions.some((s) => s.id === currentId)) { sessionMisses = 0; return; }
    if (++sessionMisses >= 5) detach();
  }).catch(() => {}); // hub unreachable; the retry above probes again
}

async function connect() {
  const seq = ++connectSeq;
  clearTimeout(reconnectTimer);
  discardSocket();
  setStatus('reconnecting');

  // Each connection uses a fresh single-use token, carried in a subprotocol
  // slot rather than the URL so it stays out of access logs.
  const id = currentId;
  let token;
  try {
    ({ token } = await api('token'));
  } catch {
    if (seq === connectSeq) scheduleReconnect();
    return;
  }
  if (seq !== connectSeq || currentId !== id || document.body.dataset.view !== 'term') return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 'promptportal' is BROWSER_PROTOCOL in lib/protocol.ts (kept in sync by
  // hand — no build step bundles the shared constant into this page).
  ws = new WebSocket(`${proto}//${location.host}/ws?session=${encodeURIComponent(id)}`, ['promptportal', token]);

  // A black-holed handshake (network dropped mid-connect) fires neither open
  // nor close until the browser's own timeout, minutes away — the workstation
  // link has a silence watchdog (cli/link.ts), so give this end one too.
  const dialTimer = setTimeout(() => {
    if (seq !== connectSeq) return;
    discardSocket();
    scheduleReconnect();
  }, 10000);

  ws.onopen = () => {
    clearTimeout(dialTimer);
    lastFrameAt = Date.now();
    reconnectDelay = 1000;
    sessionMisses = 0;
    // Re-assert this viewer's size on every connection: another viewer may
    // have resized the shared pty since the last one.
    sentCols = sentRows = 0;
    setStatus('connected');
    fitTerm();
    term.focus();
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    lastFrameAt = Date.now(); // any frame proves the link; {t:'ping'} exists for just this
    if (msg.t === 's') {
      // Reset in-band (RIS through the write queue), not term.reset(): a
      // reset applied immediately would run before output still sitting in
      // xterm's async write buffer, which would then corrupt the snapshot.
      resetPendingWrite();
      writeTerm('\x1bc' + msg.d);
    } else if (msg.t === 'o') {
      writeTerm(msg.d);
    } else if (msg.t === 'x') {
      // The session is about to vanish (its host exits with the shell);
      // show the exit banner over the final screen, then go home from the
      // close handler — a known exit needs no reconnect attempts.
      sessionExited = true;
      setStatus('exited');
      const code = typeof msg.code === 'number' ? ` with code ${msg.code}` : '';
      term.write(`\r\n\x1b[90m[process exited${code}]\x1b[0m\r\n`);
    }
  };

  ws.onclose = () => {
    clearTimeout(dialTimer);
    if (!sessionExited) return scheduleReconnect();
    // Leave the banner readable for a moment before leaving the view.
    setTimeout(() => {
      if (currentId === id && document.body.dataset.view === 'term') detach();
    }, 1500);
  };
}

function detach() {
  clearTimeout(reconnectTimer);
  discardSocket();
  currentId = null;
  showView('home');
}

function renderSessionSelect() {
  const select = $('#session-select');
  select.replaceChildren(...sessions.map((s) =>
    el('option', { value: s.id, textContent: s.label })
  ));
  if (currentId) select.value = currentId;
}

$('#btn-back').onclick = () => detach();
$('#session-select').onchange = (e) => openSession(e.target.value);
$('#btn-kill').onclick = () => {
  const session = sessions.find((s) => s.id === currentId);
  if (session) run(closeSession(session));
};

/* ----------------------------------------------------------- keybar */

// The armed-class toggles tolerate an absent button: each modifier key
// exists only while the layout includes it.
function setCtrl(armed) {
  ctrlArmed = armed;
  $('#key-ctrl')?.classList.toggle('armed', armed);
}

function setAlt(armed) {
  altArmed = armed;
  $('#key-alt')?.classList.toggle('armed', armed);
}

function setShift(armed) {
  shiftArmed = armed;
  $('#key-shift')?.classList.toggle('armed', armed);
}

function disarm() {
  setCtrl(false);
  setAlt(false);
  setShift(false);
}

const CURSOR = { '←': 'D', '↑': 'A', '↓': 'B', '→': 'C', Home: 'H', End: 'F' }; // CSI 1 ; <mod> <letter>
const TILDES = { PgUp: '5', PgDn: '6', Ins: '2' }; // the CSI <n> ~ keys

function sendKey(label, seq) {
  const modifier = 1 + (shiftArmed ? 1 : 0) + (altArmed ? 2 : 0) + (ctrlArmed ? 4 : 0);
  if (CURSOR[label] && modifier > 1) {
    seq = `\x1b[1;${modifier}${CURSOR[label]}`; // ctrl+arrow word jump, ctrl+home buffer top, etc.
    disarm();
  } else if (TILDES[label] && modifier > 1) {
    seq = `\x1b[${TILDES[label]};${modifier}~`;
    disarm();
  } else if (label === 'Tab' && shiftArmed) {
    seq = '\x1b[Z'; // backtab
    setShift(false);
  } else if (seq.length === 1) {
    // Esc/Tab/Enter honor an armed modifier like typed keys — and always
    // disarm it, so it cannot linger and turn the next keystroke into a
    // control char.
    seq = applyModifiers(seq);
  }
  sendInput(seq);
}

function setFontSize(delta) {
  fontSize = Math.min(24, Math.max(8, fontSize + delta));
  localStorage.setItem('fontSize', fontSize);
  term.options.fontSize = fontSize;
  $('#fs-value').textContent = fontSize;
  fitTerm();
}

const POINTER_END = ['pointerup', 'pointercancel', 'pointerleave'];

// pointerdown + preventDefault keeps focus (and the phone keyboard) on the terminal
function keyButton(key, { repeat = false } = {}) {
  const btn = el('button', { textContent: key.label, title: key.title || key.label, className: key.className || '' });
  if (key.id) btn.id = key.id;
  let delay = null;
  let interval = null;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(interval);
    delay = interval = null;
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    key.run();
    if (repeat) delay = setTimeout(() => { interval = setInterval(key.run, 80); }, 400);
  });
  for (const ev of POINTER_END) btn.addEventListener(ev, stop);
  return btn;
}

// Everything the key bar can hold, in the order the picker lists them.
// 'updown' stacks ↑ floating over ↓ in one slot — the single-row layout's
// one exception; plain '↑'/'↓' are the flat alternative. Keys that repeat
// on hold are the ones a finger holds down on a keyboard.
const KEY_CATALOG = [
  { key: 'ctrl', label: 'Ctrl', id: 'key-ctrl', run: () => setCtrl(!ctrlArmed) },
  { key: 'alt', label: 'Alt', id: 'key-alt', run: () => setAlt(!altArmed) },
  { key: 'shift', label: 'Shift', id: 'key-shift', run: () => setShift(!shiftArmed) },
  { key: 'esc', label: 'Esc', run: () => sendKey('Esc', '\x1b') },
  { key: 'tab', label: 'Tab', run: () => sendKey('Tab', '\t') },
  { key: 'enter', label: 'Enter', run: () => sendKey('Enter', '\r') },
  { key: 'pgup', label: 'PgUp', repeat: true, run: () => sendKey('PgUp', '\x1b[5~') },
  { key: 'pgdn', label: 'PgDn', repeat: true, run: () => sendKey('PgDn', '\x1b[6~') },
  { key: 'ins', label: 'Ins', run: () => sendKey('Ins', '\x1b[2~') },
  { key: 'home', label: 'Home', run: () => sendKey('Home', '\x1b[H') },
  { key: 'end', label: 'End', run: () => sendKey('End', '\x1b[F') },
  { key: 'left', label: '←', repeat: true, run: () => sendKey('←', '\x1b[D') },
  { key: 'updown', label: '↑↓' },
  { key: 'up', label: '↑', repeat: true, run: () => sendKey('↑', '\x1b[A') },
  { key: 'down', label: '↓', repeat: true, run: () => sendKey('↓', '\x1b[B') },
  { key: 'right', label: '→', repeat: true, run: () => sendKey('→', '\x1b[C') },
];
const KEY_BY_NAME = new Map(KEY_CATALOG.map((k) => [k.key, k]));

const DEFAULT_KEYBAR = ['ctrl', 'alt', 'esc', 'left', 'updown', 'right'];

// The chosen layout persists like the font size does.
let keybar = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('keybar'));
    if (Array.isArray(saved)) return saved.filter((name) => KEY_BY_NAME.has(name));
  } catch {}
  return [...DEFAULT_KEYBAR];
})();

function renderKeybar() {
  disarm(); // a re-render drops the armed styling; drop the state with it
  $('#keybar').replaceChildren(...keybar.map((name) => {
    if (name === 'updown') {
      const up = keyButton(KEY_BY_NAME.get('up'), { repeat: true });
      up.className = 'float';
      return el('div', { className: 'key-updown' }, [
        keyButton(KEY_BY_NAME.get('down'), { repeat: true }),
        up,
      ]);
    }
    const key = KEY_BY_NAME.get(name);
    return keyButton(key, { repeat: key.repeat });
  }));
}

renderKeybar();

/* ---------------------------------------------------- keybar settings */

// The picker under the header's ⚙: the bar's keys in order, then the rest
// of the catalog. Tap one side to remove, the other to append — order is
// the order keys were added.
function renderKeybarSettings() {
  $('#kb-selected').replaceChildren(...keybar.map((name, i) =>
    el('button', { type: 'button', textContent: KEY_BY_NAME.get(name).label, onclick: () => {
      keybar.splice(i, 1);
      saveKeybar();
    } })
  ));
  $('#kb-available').replaceChildren(...KEY_CATALOG.filter((k) => !keybar.includes(k.key)).map((k) =>
    el('button', { type: 'button', textContent: k.label, onclick: () => {
      keybar.push(k.key);
      saveKeybar();
    } })
  ));
}

function saveKeybar() {
  localStorage.setItem('keybar', JSON.stringify(keybar));
  renderKeybar();
  renderKeybarSettings();
}

$('#fs-minus').onclick = () => setFontSize(-1);
$('#fs-plus').onclick = () => setFontSize(+1);
$('#fs-value').textContent = fontSize;

// Which chord inserts a newline instead of submitting (see applyModifiers).
let newline = localStorage.getItem('newline') === 'shift' ? 'shift' : 'ctrl';

function newlineArmed() {
  return newline === 'ctrl' ? ctrlArmed : shiftArmed;
}

function setNewline(mode) {
  newline = mode;
  localStorage.setItem('newline', mode);
  $('#nl-ctrl').classList.toggle('armed', mode === 'ctrl');
  $('#nl-shift').classList.toggle('armed', mode === 'shift');
}
$('#nl-ctrl').onclick = () => setNewline('ctrl');
$('#nl-shift').onclick = () => setNewline('shift');
setNewline(newline);

$('#btn-keys').onclick = () => {
  const panel = $('#keybar-settings');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderKeybarSettings();
  requestAnimationFrame(fitTerm); // the panel takes real height from the terminal
};

/* ----------------------------------------------------------- layout */

function layout() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--vh', height + 'px');
  window.scrollTo(0, 0);
  fitTerm();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', layout);
}
window.addEventListener('resize', layout);

// Rotating re-wraps the local buffer, but an app that repaints only its own
// lines (claude's normal renderer) cannot clean up content laid out for the
// old width, leaving the screen garbled. Re-attach once the rotation
// settles: the replay re-renders the session at the new size, ending with
// the app's own post-resize repaint. Phones only — a desktop window dragged
// across the aspect threshold doesn't need it.
if (matchMedia('(pointer: coarse)').matches) {
  matchMedia('(orientation: landscape)').addEventListener('change', () => {
    setTimeout(() => {
      if (document.body.dataset.view === 'term' && currentId) connect();
    }, 350);
  });
}

// The hub pings every 30s, so an OPEN socket with no frame for 90s is dead:
// the hub reaped it while the phone slept and the close never arrived, or the
// network path changed under it. readyState cannot tell — WS-level pings are
// answered below the JS layer — so this is the same application-frame
// watchdog the workstation link runs (cli/link.ts).
const SILENCE_TIMEOUT_MS = 90 * 1000;

function reconnectIfDead() {
  if (document.body.dataset.view !== 'term' || !currentId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // dialing; its own timers cover it
  if (Date.now() - lastFrameAt > SILENCE_TIMEOUT_MS) connect();
}
setInterval(reconnectIfDead, 30 * 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (document.body.dataset.view === 'term' && currentId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect(); // the socket died silently in the background
    } else {
      reconnectIfDead(); // or survived as a zombie: still OPEN, long silent
    }
  } else if (document.body.dataset.view === 'home') {
    refreshState().catch(console.error);
  }
});

/* ------------------------------------------------------------- init */

async function init() {
  layout();
  // The hub may still be coming up (or the network blinking) when the page
  // loads; retry rather than leaving a dead page. 401/429 reload the page
  // from api() itself.
  for (;;) {
    try {
      await refreshState();
      break;
    } catch (err) {
      console.error(err);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  setInterval(() => {
    if (document.body.dataset.view === 'home' && document.visibilityState === 'visible') {
      refreshState().catch(console.error);
    }
  }, 5000);
}

/* --------------------------------------------------- install (PWA) */

// Offer a home-screen install until the user dismisses it. Chromium fires
// beforeinstallprompt, which we stash and replay from a real button; iOS Safari
// has no such event, so we show the manual Share -> Add to Home Screen hint
// instead. Skipped while the app runs standalone, and the dismissal is
// remembered for good, since iOS Safari cannot tell an app that is already on
// the home screen from a plain browser tab.
function setupInstall() {
  const bar = $('#install'), btn = $('#btn-install'), hint = $('#install-hint'), dismiss = $('#install-dismiss');
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!bar || installed || localStorage.getItem('install-dismissed')) return;
  const close = () => { bar.hidden = true; localStorage.setItem('install-dismissed', '1'); };
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; btn.hidden = bar.hidden = false; });
  addEventListener('appinstalled', () => { deferred = null; close(); });
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    bar.hidden = true;
  });
  dismiss.addEventListener('click', close);

  // Browsers without beforeinstallprompt can only be installed by hand, so
  // spell out the gesture. On iOS only Safari can add to the home screen —
  // Chrome, Firefox and Edge there are WebKit shells that cannot, so they get
  // nothing. Chromium elsewhere fires the event and uses the button instead.
  const ua = navigator.userAgent;
  const iOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const bold = (text) => el('b', { textContent: text });
  const gesture =
    iOS && /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
      ? ['tap ', bold('Share'), ' → ', bold('Add to Home Screen')]
      : /Android/.test(ua) && /Firefox/.test(ua)
        ? ['open the ', bold('⋮'), ' menu → ', bold('Add to Home screen')]
        : null;
  if (gesture) {
    hint.append('Install: ', ...gesture);
    hint.hidden = bar.hidden = false;
  }
}
setupInstall();

init();
