# <img src="docs/icon.png" height="80" align="absmiddle" alt="prompt-portal icon">&nbsp; prompt-portal

Spawn a terminal window from your phone running on your PC; work remotely.
Open any terminal window from your PC; pick it up from your phone.
Use it for Claude Code, Codex or general terminal needs.

<p align="center"><img src="docs/windows-terminal.png" width="600" alt="A Claude Code session in Windows Terminal on the workstation"></p>
<table align="center">
  <tr>
    <td><img src="docs/phone-home.png" width="270" alt="The hub in the phone browser: running sessions, profiles, quick commands"></td>
    <td><img src="docs/phone.png" width="270" alt="The same session, live in the phone browser"></td>
  </tr>
</table>
<p align="center"><em>One shared pty from both ends: the session in Windows Terminal on the
workstation (top); the hub's home screen and the same session live in the
phone browser (below). Type in either.</em></p>

## Architecture

Three tiers:

- **Client** — the browser (phone). One page lists every session on
  every connected workstation; open one to view and drive it.
- **Hub** — serves the UI, authenticates clients, and brokers browser
  sockets to workstations. The one piece you host; for access from the open
  Internet it needs a TLS reverse proxy in front (Dokploy on a cloud VM
  works well), or keep it private on a VPN.
- **Workstations** — the machines where terminals run: `prompt-portal`, one
  self-contained executable. Every session is its own `prompt-portal` process
  owning its pty and dialing the hub over WebSocket; a small resident
  `prompt-portal launcher` per workstation lets sessions be started from the
  hub.

```
  phone ─┐
         ├─(HTTPS/WSS)─▶  HUB  ◀─(outbound WSS per session + launcher)─┬─ Windows workstation "laptop"
 desktop ┘             hub.example.com                                  ├─ Windows workstation "desktop"
                                                                        └─ workstation "server" (its own container, beside the hub)
```

A session is one shared pty, controlled cooperatively: the terminal window on
the workstation renders it natively while the phone watches and types into
the same screen. "Take control back" is typing at the workstation — the
first keystroke snaps the pty back to the window's size. **Closing the
window ends the session**, everywhere, always: what you see in the taskbar
is exactly what exists.

Everything below runs on [Bun](https://bun.sh) >= 1.3.14; `bunx` comes with it.

## Windows workstation

```powershell
bunx prompt-portal install --hub-url https://prompt-portal.example.com
```

It prompts for the workstation password (`--password` skips the prompt,
at the cost of it landing in shell history), verifies it against the hub,
builds a native self-contained `prompt-portal.exe` into
`%LOCALAPPDATA%\prompt-portal\bin`, persists the settings (user environment
variables + Windows Credential Manager), registers a logon task that runs
`prompt-portal launcher`, adds the exe to your PATH, and installs a Windows
Terminal **prompt-portal profile** that opens a connected session in a tab.
Re-run any time to change settings; it is idempotent.

- **Update** (rebuild from the latest release, settings untouched, open
  sessions keep running): `bunx prompt-portal@latest update`
- **Uninstall** (removes tasks, credentials, settings; sessions end):
  `bunx prompt-portal uninstall`
- **All-local, no server**: `bunx prompt-portal install --install-hub` also
  registers the hub itself as a logon task on loopback port 8080
  (`--hub-port`), and points the workstation at it. Publish it with e.g.
  `tailscale serve --bg 8080` and use the resulting URL from your phone.

To make every terminal you open reachable remotely, set the **prompt-portal
profile** as the Windows Terminal default. For terminals launched from a
command line, use `prompt-portal -- <command>`. A session created from the
phone opens as a window in the workstation's default terminal. macOS is not
implemented yet.

### The `prompt-portal` command

```
prompt-portal [label] [--cwd DIR] [-- COMMAND ...]   host a session in this terminal
prompt-portal launcher                               the logon-task resident (sessions from the hub)
prompt-portal hub [--port N] [--host ADDR] [--data DIR]   run the hub
prompt-portal set-password                           store the workstation password (Credential Manager)
prompt-portal install | update | uninstall           manage the Windows install
```

Everything after `--` is the command to run, taken verbatim — so
`prompt-portal work -- claude --dangerously-skip-permissions` needs no
quoting.

Configuration (the installer persists these; set them by hand to run
unmanaged):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROMPTPORTAL_HUB_URL` | unset | Hub URL (a bare host means `https`); unset = local-only terminal |
| `PROMPTPORTAL_WORKSTATION_PASSWORD` | — | The hub's workstation password; on Windows prefer `prompt-portal set-password` |
| `PROMPTPORTAL_NODE_NAME` | sanitized hostname | This workstation's name in the UI |
| `PROMPTPORTAL_SHELL` | platform default | Shell each session hosts |

The launcher and every session host append to a rotating log under
`~/.prompt-portal/logs`.

## Hosting the hub

Docker (recommended for a server — includes a `server` workstation):

```sh
cp .env.example .env   # set the two passwords
docker compose up -d --build
```

The compose deployment runs the **hub** (UI + broker, port 27180 on
loopback, data on the `hub-data` volume) and a **workstation** container
registered as `server`, so out of the box you get terminals on the server
itself. The workstation image bundles Node, .NET 10, Python 3 + uv, `gh`,
`tmux`, `ripgrep`, `jq`; Claude Code and Codex install onto the `home`
volume at each start, so auth, repos, and git config survive redeploys.

Anywhere else:

```sh
PROMPTPORTAL_WEBACCESS_PASSWORD='a-long-random-string' \
PROMPTPORTAL_WORKSTATION_PASSWORD='another-long-random-string' bunx prompt-portal hub
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROMPTPORTAL_WEBACCESS_PASSWORD` | required | Browsers sign in with it (username is always `promptportal`) |
| `PROMPTPORTAL_WORKSTATION_PASSWORD` | required | Workstations register with it |
| `PROMPTPORTAL_PORT` / `PROMPTPORTAL_HOST` | `8080` / `127.0.0.1` | Listen port / address; loopback by default — open with `PROMPTPORTAL_HOST=0.0.0.0` only behind TLS |
| `PROMPTPORTAL_DATA` | `./data` | Where profiles and quick commands persist |
| `PROMPTPORTAL_NODE_NAME` | `server` | The compose workstation's name in the UI |
| `PROMPTPORTAL_TRUST_PROXY` | unset | Set to `1` when a reverse proxy you control is the only way in (see Security notes) |

The flags `--port N`, `--host ADDR`, and `--data DIR` override these. The hub
exposes three WebSocket paths on one port: `/ws` (browser, token auth),
`/session` and `/launcher` (workstation, password auth).

If using Tailscale, keep the hub private and publish it to your tailnet with
TLS: `tailscale serve --bg 27180` (compose; bare hub: 8080), then use
`https://<machine>.<tailnet>.ts.net` as the hub URL with
`PROMPTPORTAL_TRUST_PROXY=1`.

## Security notes

There are two secrets: `PROMPTPORTAL_WEBACCESS_PASSWORD` signs browsers in
(Basic auth, username fixed to `promptportal`) and grants a shell on every
workstation; `PROMPTPORTAL_WORKSTATION_PASSWORD` registers workstation
sessions and launchers, and holding it lets an attacker impersonate a
workstation — make both long, random, and different. The hub itself speaks
plain HTTP, and Basic auth resends the web-access password with every
request, which is why TLS termination in front is mandatory; the hub listens
on loopback by default for the same reason.

Failed attempts trip a brute-force lockout keyed on client IP. Set
`PROMPTPORTAL_TRUST_PROXY=1` so it keys on the client IP the proxy — reverse
proxy or `tailscale serve` — appends to `X-Forwarded-For` (only when that
proxy is the sole way in — otherwise attackers forge the header and dodge
the lockout).

Isolation of the workstation password from the spawned sessions is
best-effort and not hardened, but there is room for improvement.

**Planned:** browsers and workstations authenticating with a GitHub identity
instead of the shared secret.
