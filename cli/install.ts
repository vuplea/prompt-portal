import fs from 'node:fs';
import path from 'node:path';

import { deleteCredential, readCredential, writeCredential } from '../lib/credential';
import { NODE_NAME_RE } from '../lib/protocol';
import { promptHidden } from '../lib/secret';
import {
  HUB_CREDENTIAL_TARGETS, HUB_WEBACCESS_TARGET, HUB_WORKSTATION_TARGET, passwordProblem,
} from '../lib/settings';
import { CliError, CREDENTIAL_TARGET, isCompiled, isWindows, resolveNodeName } from './config';
import { normalizeHubUrl } from './link';
import { verifyWorkstationPassword } from './password';

// `prompt-portal install|update|uninstall` — manage the Windows install:
// build the native prompt-portal.exe, persist its configuration, register the
// launcher to run at logon, and wire up Windows Terminal. With --install-hub,
// also register the hub as a background logon task, so this machine serves
// the UI and brokers browsers to workstations. `update` rebuilds the
// executable from the running package and swaps it in, leaving every stored
// setting untouched; `uninstall` removes everything an install created.
//
// After `install`, `prompt-portal` in any terminal hosts a session that is
// also reachable from your hub, and sessions started from the hub open as
// terminal windows here. A session lives exactly as long as its window:
// closing it ends the session everywhere. Re-run any time to change settings
// or rebuild; it is idempotent (at the password prompts, Enter keeps what is
// stored).
//
// One self-contained executable serves every role (session host, launcher,
// hub): %LOCALAPPDATA%\PromptPortal\bin\prompt-portal.exe, compiled from this
// package by the Bun that runs this command — which is why install and update
// run from source (`bunx prompt-portal install`), never from the installed
// executable, which carries no source to rebuild from.
//
// Windows-management operations (scheduled tasks, process queries, user
// environment) shell out to Windows PowerShell — always present, and the
// proven unelevated path for user-scoped logon tasks.

const LAUNCHER_TASK = 'PromptPortalLauncher';
const HUB_TASK = 'PromptPortalHub';
const EXE_BASE = 'prompt-portal';
// User environment variables an install persists (and uninstall removes).
const USER_ENV_VARS = ['PROMPTPORTAL_HUB_URL', 'PROMPTPORTAL_NODE_NAME'];

const MIN_BUN = [1, 3, 14] as const;

const USAGE = 'prompt-portal install [--hub-url URL] [--node-name NAME] [--password PW]'
  + ' [--install-hub] [--hub-port N] [--webaccess-password PW]'
  + ' | prompt-portal update | prompt-portal uninstall';

interface InstallCli {
  hubUrl?: string;
  nodeName?: string;
  password?: string;
  installHub: boolean;
  hubPort: number;
  webaccessPassword?: string;
}

function localAppData(): string {
  const dir = process.env.LOCALAPPDATA;
  if (!dir) throw new CliError('LOCALAPPDATA is not set');
  return dir;
}

const binDir = () => path.join(localAppData(), 'PromptPortal', 'bin');
const hubDataDir = () => path.join(localAppData(), 'PromptPortal', 'hub-data');
const exePath = () => path.join(binDir(), `${EXE_BASE}.exe`);
const stagedExePath = () => path.join(binDir(), `${EXE_BASE}-new.exe`);
const fragmentDir = () => path.join(localAppData(), 'Microsoft', 'Windows Terminal', 'Fragments', 'PromptPortal');

// The package this running script belongs to — what gets compiled and where
// the icon and the Windows Terminal fragment template ship.
const packageRoot = () => path.dirname(import.meta.dir);

// ------------------------------------------------------------- powershell

// Run a PowerShell script, values passed via environment variables (PP_*) —
// no quoting or encoding pitfalls — and the script itself via -EncodedCommand
// for the same reason. Returns stdout. Exit 0 always means success; a script
// whose negative outcome is expected (task absent, nothing to change) signals
// it with the distinct `exit 3`, allowed per call — so a PowerShell failure
// (any other exit) always throws instead of masquerading as the negative.
const PS_NEGATIVE = 3;
function ps(script: string, env: Record<string, string> = {}, { allow = [] as number[] } = {}): { code: number; out: string } {
  // 'Stop' turns cmdlet failures into terminating errors, so they surface as
  // a non-zero exit instead of scrolling past while the script "succeeds";
  // steps that expect absence opt out per call with -ErrorAction.
  const body = `$ErrorActionPreference = 'Stop'\n${script}`;
  const result = Bun.spawnSync({
    cmd: [
      'powershell.exe', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64'),
    ],
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = result.stdout.toString().trim();
  const code = result.exitCode ?? -1;
  if (code !== 0 && !allow.includes(code)) {
    const detail = (result.stderr.toString().trim() || out).split('\n').slice(0, 8).join('\n');
    throw new CliError(`PowerShell step failed (exit ${code}):\n${script.trim().split('\n')[0]}...\n${detail}`);
  }
  return { code, out };
}

function taskExists(name: string): boolean {
  return ps(`if (Get-ScheduledTask -TaskName $env:PP_TASK -ErrorAction SilentlyContinue) { exit 0 } else { exit ${PS_NEGATIVE} }`,
    { PP_TASK: name }, { allow: [PS_NEGATIVE] }).code === 0;
}

function stopTask(name: string): void {
  ps(`Stop-ScheduledTask -TaskName $env:PP_TASK -ErrorAction SilentlyContinue; exit 0`, { PP_TASK: name });
}

function startTask(name: string): void {
  ps(`Start-ScheduledTask -TaskName $env:PP_TASK`, { PP_TASK: name });
}

function unregisterTask(name: string): boolean {
  return ps(`
    if (Get-ScheduledTask -TaskName $env:PP_TASK -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $env:PP_TASK -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $env:PP_TASK -Confirm:$false
      exit 0
    }
    exit ${PS_NEGATIVE}`, { PP_TASK: name }, { allow: [PS_NEGATIVE] }).code === 0;
}

// Register a resident process to run at logon, windowless. conhost --headless
// hosts it in an invisible console: no window exists at any point. (A
// `powershell -WindowStyle Hidden` wrapper would still flash a console at
// logon before hiding it.) It inherits the user env vars this install sets.
// Scoped to this user: it starts at (and runs as) your logon, and a
// user-scoped trigger registers without elevation. ExecutionTimeLimit zero
// disables Task Scheduler's default 72-hour limit, which would otherwise kill
// the process after three days.
function registerHeadlessLogonTask(name: string, commandLine: string, description: string): void {
  ps(`
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\conhost.exe" \`
      -Argument "--headless $env:PP_CMDLINE" -WorkingDirectory $env:PP_BIN
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \`
      -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 \`
      -ExecutionTimeLimit (New-TimeSpan)
    Register-ScheduledTask -TaskName $env:PP_TASK -Action $action -Trigger $trigger \`
      -Settings $settings -Force -Description $env:PP_DESC | Out-Null`,
  { PP_TASK: name, PP_CMDLINE: commandLine, PP_BIN: binDir(), PP_DESC: description });
  console.log(`Registered scheduled task '${name}' (runs at logon).`);
}

// The task's stored command line, to recover settings (the hub's --port).
// Callers gate on taskExists, so the task is expected to be there.
function taskArguments(name: string): string {
  return ps(`(Get-ScheduledTask -TaskName $env:PP_TASK).Actions[0].Arguments`, { PP_TASK: name }).out;
}

// Stop the resident copies of the executable — the launcher and the hub, told
// by their first argument — so their tasks can restart them on a fresh
// binary. Session hosts are deliberately spared: the swap renames the old
// image aside and a running process follows its file through a rename, so
// open sessions live on untouched. Sparing them also means running an update
// from inside a PromptPortal session is safe — stopping every host would kill
// the session this very command runs in, mid-swap. Matched by Bun's PE
// company field ("Oven"), not the install path, so a resident left running
// from an old build is caught too.
function stopResidents(): void {
  const { out } = ps(`
    $procs = @(Get-Process $env:PP_NAME -ErrorAction SilentlyContinue | Where-Object { $_.Company -eq 'Oven' })
    foreach ($p in $procs) {
      $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue).CommandLine
      if ($cmd -and (($cmd -replace '^\\s*(?:"[^"]+"|\\S+)\\s*', '') -match '^(launcher|hub)(\\s|$)')) {
        Write-Output "Stopping the running $($cmd -replace '^\\s*(?:"[^"]+"|\\S+)\\s*', '' -replace '\\s.*$', '') (pid $($p.Id))..."
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $p.Id -Timeout 10 -ErrorAction SilentlyContinue
      }
    }
    exit 0`, { PP_NAME: EXE_BASE });
  if (out) console.log(out);
}

// Uninstall only: stop every running copy — launcher, hub, and session hosts
// (open sessions end with them). Runs last, after all bookkeeping: the
// terminal the uninstall itself runs in may be one of those sessions, and
// killing its host ends this very command's console. The pid exclusion
// spares only the uninstall process itself (when run from the installed
// executable), not the session hosting it — nothing can.
function stopAll(): void {
  ps(`
    Get-Process $env:PP_NAME -ErrorAction SilentlyContinue |
      Where-Object { $_.Company -eq 'Oven' -and $_.Id -ne [int]$env:PP_SELF } |
      ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    exit 0`, { PP_NAME: EXE_BASE, PP_SELF: String(process.pid) });
}

// Add or remove the bin directory on the user PATH. Read and write through
// the registry directly: [Environment]::GetEnvironmentVariable expands %VAR%
// entries on read and SetEnvironmentVariable writes plain REG_SZ, so a
// round-trip would freeze every REG_EXPAND_SZ entry at its current expansion.
// A raw registry write also skips the WM_SETTINGCHANGE broadcast
// SetEnvironmentVariable would send, so send it by hand — without it, shells
// opened before the next logon never see the change.
function editUserPath(action: 'Add' | 'Remove'): void {
  const changed = ps(`
    $dir = $env:PP_DIR
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $entries = @($userPath -split ';' | Where-Object { $_ -ne '' })
      $present = $entries -contains $dir
      if ($env:PP_ACTION -eq 'Add' -and -not $present) { $updated = @($entries) + $dir }
      elseif ($env:PP_ACTION -eq 'Remove' -and $present) { $updated = @($entries | Where-Object { $_ -ne $dir }) }
      else { exit ${PS_NEGATIVE} }
      $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      if ($envKey.GetValueNames() -contains 'Path') { $kind = $envKey.GetValueKind('Path') }
      $envKey.SetValue('Path', (@($updated) -join ';'), $kind)
      Add-Type -Namespace Win32 -Name Env -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
      [UIntPtr]$result = [UIntPtr]::Zero
      [void][Win32.Env]::SendMessageTimeoutW([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
      exit 0
    } finally {
      $envKey.Close()
    }`, { PP_DIR: binDir(), PP_ACTION: action }, { allow: [PS_NEGATIVE] }).code === 0;
  if (!changed) return;
  if (action === 'Add') console.log(`Added ${binDir()} to user PATH (restart shells to pick up \`prompt-portal\`).`);
  else console.log(`Removed ${binDir()} from user PATH.`);
}

function setUserEnvVar(name: string, value: string | null): void {
  // SetEnvironmentVariable('User') broadcasts WM_SETTINGCHANGE itself.
  ps(`[Environment]::SetEnvironmentVariable($env:PP_NAME, $env:PP_VALUE, 'User')`,
    { PP_NAME: name, PP_VALUE: value ?? '' });
}

// An unset variable prints nothing and still exits 0, so a failure here is a
// real failure.
function getEnvVar(name: string, scope: 'User' | 'Machine'): string {
  return ps(`[Environment]::GetEnvironmentVariable($env:PP_NAME, '${scope}')`, { PP_NAME: name }).out;
}

// ------------------------------------------------------------------ build

// The Bun that compiles the executable. Only source runs reach here
// (runInstaller gates out the compiled executable): the running Bun is the
// one embedded into the output (`bun build --compile`), so its version is
// exactly Bun.version — checked against the floor Bun.spawn's `terminal`
// option (the pty every session runs in) needs. An old Bun would yield an
// executable whose sessions die at spawn.
function buildBun(): string {
  const version = Bun.version.replace(/[-+].*$/, '').split('.').map(Number);
  const older = version[0]! !== MIN_BUN[0] ? version[0]! < MIN_BUN[0]
    : version[1]! !== MIN_BUN[1] ? version[1]! < MIN_BUN[1] : version[2]! < MIN_BUN[2];
  if (older) {
    throw new CliError(`Bun ${Bun.version} is too old; prompt-portal needs >= ${MIN_BUN.join('.')} (bun upgrade)`);
  }
  return process.execPath;
}

// Compile the one self-contained executable to its staging name. Staging
// first: a failed build must tear nothing down. Autoload flags: a bunfig.toml
// in the directory the binary starts in must not `preload` code into it, and
// a session host must not pick up that directory's .env and pass it to the
// shells it hosts.
function buildStagedExecutable(): void {
  const root = packageRoot();
  // server.ts embeds the @xterm assets out of node_modules, which the bunx
  // cache always has but a bare clone may not. bun.lock ships in the package,
  // so the versions are pinned either way.
  if (!fs.existsSync(path.join(root, 'node_modules', '@xterm', 'xterm'))) {
    console.log('Installing package dependencies...');
    const install = Bun.spawnSync({
      cmd: [buildBun(), 'install', '--frozen-lockfile'], cwd: root, stdout: 'inherit', stderr: 'inherit',
    });
    if (install.exitCode !== 0) throw new CliError('bun install failed; see output above.');
  }
  console.log(`\nBuilding ${EXE_BASE}.exe...`);
  fs.mkdirSync(binDir(), { recursive: true });
  const build = Bun.spawnSync({
    cmd: [
      buildBun(), 'build', '--compile', path.join(root, 'cli', 'main.ts'),
      '--outfile', stagedExePath(),
      '--no-compile-autoload-bunfig', '--no-compile-autoload-dotenv',
      '--windows-icon', path.join(root, 'windows', 'promptportal.ico'),
      '--windows-title', 'PromptPortal',
    ],
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (build.exitCode !== 0 || !fs.existsSync(stagedExePath())) {
    throw new CliError('Build failed; see output above.');
  }
}

// Swap the staged build in. Only the residents stop — the swap renames the
// old image aside rather than overwriting it (Windows locks a running image
// against overwrite, but always allows renaming one), so session hosts keep
// running on the old build until their windows close, and only then does the
// old copy become deletable (cleaned up best-effort; the next run retries).
// Stopping the scheduled tasks is not enough to retire the residents: it
// terminates the conhost it started, which can orphan the child — and a
// process started by hand has no task at all.
function installStagedExecutable(): void {
  stopTask(LAUNCHER_TASK);
  stopTask(HUB_TASK);
  stopResidents();
  for (const name of fs.readdirSync(binDir())) {
    if (new RegExp(`^${EXE_BASE}-old-.*\\.exe$`).test(name)) {
      try { fs.rmSync(path.join(binDir(), name)); } catch {}
    }
  }
  const aside = path.join(binDir(), `${EXE_BASE}-old-${process.pid}.exe`);
  if (fs.existsSync(exePath())) fs.renameSync(exePath(), aside);
  fs.renameSync(stagedExePath(), exePath());
  try { fs.rmSync(aside); } catch {}
  console.log(`Built ${exePath()}`);
}

// ------------------------------------------------------------ verification

// The one executable serves several roles, so "is it running" is only
// meaningful per role: this PS pipeline fragment selects the live processes
// of the installed executable whose first argument is $env:PP_ROLE. Without
// the role filter, a running hub would satisfy the launcher's come-up check
// (and vice versa), and the checks would prove nothing.
const ROLE_PROCS = `@(Get-CimInstance Win32_Process -Filter "Name='$env:PP_EXENAME'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -eq $env:PP_EXE -and $_.CommandLine -and
        (($_.CommandLine -replace '^\\s*(?:"[^"]+"|\\S+)\\s*', '') -match ('^{0}(\\s|$)' -f $env:PP_ROLE)) })`;

function roleEnv(role: 'launcher' | 'hub'): Record<string, string> {
  return { PP_EXENAME: `${EXE_BASE}.exe`, PP_EXE: exePath(), PP_ROLE: role };
}

// Prove a headless task's process came up and stayed up. The task runs it
// with no window, so a startup error (bad config) dies invisibly — the only
// signal is the process holding past the first couple of seconds.
function waitProcessHolds(role: 'launcher' | 'hub', hint: string): void {
  const holds = ps(`
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
      $proc = ${ROLE_PROCS} | Select-Object -First 1
      if ($proc) {
        Start-Sleep -Seconds 2   # a config error exits within moments of starting
        if (Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue) { exit 0 }
      }
      Start-Sleep -Milliseconds 500
    }
    exit ${PS_NEGATIVE}`, roleEnv(role), { allow: [PS_NEGATIVE] }).code === 0;
  if (!holds) throw new CliError(`The ${role} did not come up. Run ${hint} in a terminal to see the error.`);
}

// Prove the headless hub came up: it must both answer HTTP and still be
// running. Any HTTP status counts — an unauthenticated request earns a 401
// from a healthy hub. The answer alone is not proof, though: with the port
// already taken, the hub dies at bind time while the other service answers
// the probe — so require a hub process to hold too.
async function waitHubHolds(port: number, hint: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const answered = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
      .then(() => true, () => false);
    if (answered) {
      await Bun.sleep(2000); // a bind failure kills the hub within moments
      const holds = ps(`if (${ROLE_PROCS}.Count -gt 0) { exit 0 } else { exit ${PS_NEGATIVE} }`,
        roleEnv('hub'), { allow: [PS_NEGATIVE] }).code === 0;
      if (holds) return;
      throw new CliError(`Port ${port} answers but no ${exePath()} hub is running — another service likely holds`
        + ` the port (pick a different --hub-port), or the hub crashed at startup.`
        + ` Run ${hint} in a terminal to see the error.`);
    }
    await Bun.sleep(500);
  }
  throw new CliError(`The hub did not come up. Run ${hint} in a terminal to see the error.`);
}

// -------------------------------------------------------------- secrets

// One secret's value for this install: an explicit flag, a hidden prompt
// (Enter keeps what is stored), or — with no terminal — the stored credential
// itself, so a scripted re-install need not re-present a password it already
// stored. Returns null for "keep the stored one".
async function collectSecret(flag: string | undefined, promptLabel: string, storedExists: boolean,
                             label: string): Promise<string | null> {
  if (flag !== undefined && flag.length > 0) return flag;
  if (process.stdin.isTTY === true) {
    const entered = await promptHidden(`${promptLabel}${storedExists ? ' (Enter keeps the stored one)' : ''}: `);
    if (entered.length > 0) return entered;
  }
  if (!storedExists) throw new CliError(`no ${label} password given and none stored`);
  return null;
}

// ------------------------------------------------------------ install

function parseInstallCli(argv: string[]): InstallCli {
  const cli: InstallCli = { installHub: false, hubPort: 8080 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${flag} needs a value — usage: ${USAGE}`);
      return v;
    };
    switch (flag) {
      case '--hub-url': cli.hubUrl = value(); break;
      case '--node-name': cli.nodeName = value(); break;
      case '--password': cli.password = value(); break;
      case '--install-hub': cli.installHub = true; break;
      case '--hub-port': {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new CliError('--hub-port must be an integer between 1 and 65535');
        }
        cli.hubPort = port;
        break;
      }
      case '--webaccess-password': cli.webaccessPassword = value(); break;
      default: throw new CliError(`unknown argument "${flag}" — usage: ${USAGE}`);
    }
  }
  return cli;
}

async function install(cli: InstallCli): Promise<void> {
  if (cli.nodeName !== undefined && !NODE_NAME_RE.test(cli.nodeName)) {
    throw new CliError(`Invalid --node-name "${cli.nodeName}" (allowed: letters, digits, _ . - ; max 64 chars)`);
  }
  if (!cli.hubUrl) {
    if (!cli.installHub) {
      throw new CliError('--hub-url is required (or --install-hub to host the hub on this machine,'
        + ' or `update` to rebuild an existing install without changing its configuration)');
    }
    cli.hubUrl = `http://127.0.0.1:${cli.hubPort}`;
  }
  // Validation only — the URL is persisted as given, and every consumer
  // normalizes at use. A malformed --hub-url must fail here, before anything
  // is stored, stopped, or swapped.
  normalizeHubUrl(cli.hubUrl);
  if (cli.webaccessPassword && !cli.installHub) {
    throw new CliError('--webaccess-password configures the hub; it needs --install-hub');
  }
  // No --node-name: keep a configured PROMPTPORTAL_NODE_NAME (a re-run must
  // be idempotent), else derive from the hostname.
  const nodeName = cli.nodeName ?? resolveNodeName();

  console.log(`Package:   ${packageRoot()}`);
  console.log(`Node name: ${nodeName}`);
  console.log(`Hub:       ${cli.hubUrl}${cli.installHub ? ' (installed here)' : ''}`);

  // The environment outranks Credential Manager by design (containers, dev
  // runs), so a password variable persisted user- or machine-wide would make
  // the installed processes silently ignore what this install stores.
  const passwordVars = ['PROMPTPORTAL_WORKSTATION_PASSWORD',
    ...(cli.installHub ? ['PROMPTPORTAL_WEBACCESS_PASSWORD'] : [])];
  for (const name of passwordVars) {
    for (const scope of ['User', 'Machine'] as const) {
      if (getEnvVar(name, scope)) {
        console.warn(`WARNING: ${name} is persisted (${scope} scope) and overrides the password this install`
          + ' stores in Credential Manager — remove the variable.');
      }
    }
  }

  // Secrets are collected before anything stops or swaps, so a cancelled
  // prompt leaves the machine exactly as it was. With --install-hub the
  // workstation password is asked for once and reused for the workstation
  // registration — never twice.
  let webaccess: string | null = null;
  if (cli.installHub) {
    webaccess = await collectSecret(cli.webaccessPassword,
      'Web-access password (browsers sign in with it)',
      readCredential(HUB_WEBACCESS_TARGET) !== null, 'web-access');
    if (webaccess !== null) {
      const problem = passwordProblem(webaccess);
      if (problem) throw new CliError(`the web-access password ${problem}`);
    }
  }
  const hubHasWorkstation = readCredential(HUB_WORKSTATION_TARGET) !== null;
  const workstationStored = readCredential(CREDENTIAL_TARGET);
  const entered = await collectSecret(cli.password,
    'Workstation password (workstations register with it)',
    workstationStored !== null || (cli.installHub && hubHasWorkstation), 'workstation');
  if (cli.installHub && entered !== null) {
    const problem = passwordProblem(entered);
    if (problem) throw new CliError(`the workstation password ${problem}`);
  }
  // What the workstation half stores and verifies below. "Keep the stored
  // one" normally means the workstation credential; with --install-hub the
  // hub's stored copy of the same secret serves too (and is re-stored under
  // the workstation target below).
  const workstationPassword = entered ?? workstationStored
    ?? (cli.installHub ? readCredential(HUB_WORKSTATION_TARGET) : null);
  if (workstationPassword === null) throw new CliError('no workstation password given and none stored');

  // Build before anything stops or swaps, so a failed build tears nothing down.
  buildStagedExecutable();

  // Without --install-hub the password is proved against the remote hub
  // before the machine changes at all. (With it, the hub this proves against
  // starts below, so the check runs after the swap.)
  if (!cli.installHub) {
    console.log('\nVerifying the workstation password against the hub...');
    await verifyWorkstationPassword(workstationPassword, cli.hubUrl);
  }

  const strayHubTask = !cli.installHub && taskExists(HUB_TASK);
  if (cli.installHub) {
    // Both hub secrets go to Credential Manager, before the swap: bad input
    // must abort while the old install still runs untouched. The hub's
    // workstation copy is written whenever it is missing — even on "keep the
    // stored one", which can name a credential only the workstation half has
    // (an earlier install without --install-hub); a hub starting without it
    // would die at resolveHubPasswords.
    if (webaccess !== null) writeCredential(HUB_WEBACCESS_TARGET, webaccess);
    if (entered !== null || !hubHasWorkstation) writeCredential(HUB_WORKSTATION_TARGET, workstationPassword);
    console.log('Stored the hub passwords in Credential Manager.');
  } else if (strayHubTask) {
    console.warn(`WARNING: a '${HUB_TASK}' task from an earlier --install-hub run is still registered and keeps`
      + ` serving at logon; remove it with: Unregister-ScheduledTask '${HUB_TASK}' -Confirm:$false`);
  }

  installStagedExecutable();

  // The swap stopped every resident, the locally installed hub included; a
  // workstation-only install must put that hub back, not leave it down until
  // the next logon.
  if (strayHubTask) await restartInstalledHub();

  if (cli.installHub) {
    // Profiles and quick commands persist here (the compose deployment's
    // hub-data volume, as a directory). A scheduled task has no per-process
    // environment channel, so the settings ride the command line — including
    // --host, so a stray user-level PROMPTPORTAL_HOST variable can never flip
    // this headless plain-HTTP hub onto the network.
    fs.mkdirSync(hubDataDir(), { recursive: true });
    const hubCommand = `"${exePath()}" hub --host 127.0.0.1 --port ${cli.hubPort} --data "${hubDataDir()}"`;
    registerHeadlessLogonTask(HUB_TASK, hubCommand, 'PromptPortal hub');
    startTask(HUB_TASK);
    // The task runs the hub headless, so a startup error would die invisibly;
    // prove it answers HTTP and holds before the workstation half depends on it.
    await waitHubHolds(cli.hubPort, hubCommand);
    console.log(`The hub is up on http://127.0.0.1:${cli.hubPort}.`);

    console.log('\nVerifying the workstation password against the hub...');
    await verifyWorkstationPassword(workstationPassword, cli.hubUrl);
  }

  // The workstation password goes to Windows Credential Manager instead of a
  // user environment variable, which would sit in the registry and be
  // inherited by every process in the session. It was verified against the
  // hub above, so a mistyped password never lands here.
  if (entered !== null || workstationStored === null) {
    writeCredential(CREDENTIAL_TARGET, workstationPassword);
    console.log(`Stored the workstation password in Credential Manager (generic credential "${CREDENTIAL_TARGET}").`);
  } else {
    console.log('Kept the stored workstation password.');
  }

  // Non-secret settings go to user environment variables; the scheduled
  // tasks and any shell you open inherit them.
  console.log('Setting user environment variables...');
  setUserEnvVar('PROMPTPORTAL_HUB_URL', cli.hubUrl);
  setUserEnvVar('PROMPTPORTAL_NODE_NAME', nodeName);

  // Put the bin directory on the user PATH so `prompt-portal` resolves everywhere.
  editUserPath('Add');

  // The launcher is the workstation's one resident process: it exists so
  // sessions can be started from the hub (each opens as a terminal window
  // here).
  registerHeadlessLogonTask(LAUNCHER_TASK, `"${exePath()}" launcher`, 'PromptPortal workstation launcher');

  installWindowsTerminalFragment();

  // (Re)start the launcher so a re-run picks up the freshly built executable.
  stopTask(LAUNCHER_TASK);
  startTask(LAUNCHER_TASK);
  // The task runs the launcher headless, so a startup error (bad config)
  // would die invisibly; prove it came up and stayed up before declaring
  // success. The password and hub URL were already proven against the hub
  // above, so a launcher that holds is a launcher that registers.
  waitProcessHolds('launcher', `"${exePath()}" launcher`);

  console.log('\nDone. The launcher is running. Host a session from any terminal with:  prompt-portal');
  console.log("In Windows Terminal, the 'prompt-portal' profile opens a connected session.");
  console.log("Closing a session's window ends that session everywhere.");
  if (cli.installHub) {
    console.log(`The hub is serving on http://127.0.0.1:${cli.hubPort} (task '${HUB_TASK}', data in ${hubDataDir()}).`);
    console.log('It speaks plain HTTP on loopback; to reach it from other machines put TLS in');
    console.log(`front (e.g. tailscale serve --bg ${cli.hubPort}) and use that URL from browsers and workstations.`);
  }
}

// Start the installed hub task back up and prove it holds, its port read
// from its own command line — used by update and by a workstation-only
// install, both of which stop it as part of the executable swap.
async function restartInstalledHub(): Promise<void> {
  const args = taskArguments(HUB_TASK);
  const port = Number(/--port\s+(\d+)/.exec(args)?.[1] ?? 8080);
  startTask(HUB_TASK);
  await waitHubHolds(port, args.replace(/^\s*--headless\s+/, ''));
  console.log(`The hub is up on http://127.0.0.1:${port}.`);
}

// Adds a "prompt-portal" profile that opens a new hub-connected session (it
// just runs `prompt-portal`). The whole fragment directory is rewritten, so a
// stale profile from an older layout never lingers beside the new one. The
// icon ships beside the exe so the profile points at a stable path.
function installWindowsTerminalFragment(): void {
  const iconPath = path.join(binDir(), `${EXE_BASE}.ico`);
  fs.copyFileSync(path.join(packageRoot(), 'windows', 'promptportal.ico'), iconPath);
  const template = fs.readFileSync(
    path.join(packageRoot(), 'windows', 'windows-terminal-fragment.template.json'), 'utf8');
  const fragment = template
    .replaceAll('__PROMPTPORTAL__', exePath().replaceAll('\\', '\\\\'))
    .replaceAll('__ICON__', iconPath.replaceAll('\\', '\\\\'));
  fs.rmSync(fragmentDir(), { recursive: true, force: true });
  fs.mkdirSync(fragmentDir(), { recursive: true });
  fs.writeFileSync(path.join(fragmentDir(), `${EXE_BASE}.json`), fragment);
  console.log("Installed Windows Terminal fragment (new 'prompt-portal' profile).");
}

// ------------------------------------------------------------- update

// Rebuild the executable from the running package and swap it in, leaving
// every stored setting untouched: no passwords, environment variables, PATH
// entry, or Windows Terminal profile are read or written. Restarts whichever
// residents are installed here, with the same staged-build discipline and
// come-up checks a full install uses. Open sessions keep running on the old
// build until their windows close.
async function update(): Promise<void> {
  const launcherInstalled = taskExists(LAUNCHER_TASK);
  const hubInstalled = taskExists(HUB_TASK);
  if (!launcherInstalled && !hubInstalled) {
    throw new CliError('Nothing to update: no PromptPortal launcher or hub is installed on this machine.'
      + ' Run `prompt-portal install` first.');
  }
  console.log('Updating PromptPortal in place (rebuilding the executable)...');
  buildStagedExecutable();
  installStagedExecutable();

  // Restart and verify in the same order a full install uses: the hub first,
  // then the launcher.
  if (hubInstalled) await restartInstalledHub();
  if (launcherInstalled) {
    startTask(LAUNCHER_TASK);
    waitProcessHolds('launcher', `"${exePath()}" launcher`);
  }
  console.log('\nDone. Rebuilt and restarted. Host a session from any terminal with:  prompt-portal');
}

// ---------------------------------------------------------- uninstall

// Reverse the install: unregister the scheduled tasks, remove the
// credentials, user environment variables, PATH entry, and Windows Terminal
// profile, and only then stop the running processes — the uninstall may be
// typed into a PromptPortal session, and killing its host mid-way would cut
// the bookkeeping (and this output) off. Idempotent — anything already gone
// is skipped. The built executable and the hub-data directory (saved
// profiles and quick commands) are deliberately left in place.
function uninstall(): void {
  console.log('Uninstalling PromptPortal...');
  // Tasks first, so neither the launcher nor the hub is restarted at logon
  // or by a task's restart-on-failure while we are tearing it down.
  for (const task of [HUB_TASK, LAUNCHER_TASK]) {
    if (unregisterTask(task)) console.log(`Removed scheduled task '${task}'.`);
  }
  for (const target of [CREDENTIAL_TARGET, ...HUB_CREDENTIAL_TARGETS]) {
    if (readCredential(target) === null) continue;
    if (deleteCredential(target)) console.log(`Removed credential '${target}'.`);
    else console.warn(`WARNING: could not remove credential '${target}' — it is still stored.`);
  }
  for (const name of USER_ENV_VARS) {
    if (getEnvVar(name, 'User')) {
      setUserEnvVar(name, null);
      console.log(`Removed user environment variable ${name}.`);
    }
  }
  editUserPath('Remove');
  if (fs.existsSync(fragmentDir())) {
    fs.rmSync(fragmentDir(), { recursive: true, force: true });
    console.log("Removed the Windows Terminal 'prompt-portal' profile.");
  }
  console.log(`Done. Left in place: the executable in ${binDir()} and any hub data in ${hubDataDir()}.`);
  console.log('Stopping running prompt-portal processes (open sessions end with them)...');
  stopAll();
}

// -------------------------------------------------------------- entry

export async function runInstaller(command: 'install' | 'update' | 'uninstall', argv: string[]): Promise<void> {
  if (!isWindows) {
    throw new CliError(`${command} manages a Windows workstation install; on this platform run the pieces`
      + ' directly (see the README: docker compose, or `prompt-portal hub` / `prompt-portal launcher`)');
  }
  // install and update compile the executable from this package's source,
  // which the compiled executable does not carry — refuse up front, before
  // any prompt or output. (uninstall needs no source and works from the
  // executable.) The hint deliberately names only the subcommand: argv can
  // hold --password values that must not be echoed.
  if (isCompiled && command !== 'uninstall') {
    throw new CliError(`${command} rebuilds the executable from source — run \`bunx prompt-portal@latest ${command}\` instead`);
  }
  if (command === 'install') return install(parseInstallCli(argv));
  if (argv.length > 0) throw new CliError(`${command} takes no arguments — usage: ${USAGE}`);
  if (command === 'update') return update();
  uninstall();
}
