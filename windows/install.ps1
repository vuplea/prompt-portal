#Requires -Version 5.1
<#
.SYNOPSIS
  Install PromptPortal on this Windows workstation: build the native
  promptportal.exe, persist its configuration, register the launcher to run at logon,
  and wire up Windows Terminal + the `promptportal` command. With -InstallHub, also
  build hub.exe and register the hub itself as a background logon task, so
  this machine serves the UI and brokers browsers to workstations. With
  -Uninstall, remove everything a previous run installed on this machine.
  With -Update, rebuild the executables from the current repo and swap them
  in, leaving every stored setting untouched.

.DESCRIPTION
  After this runs, `promptportal` in any terminal hosts a session that is also
  reachable from your hub, and sessions started from the hub open as terminal
  windows here. A session lives exactly as long as its window: closing it
  ends the session everywhere. Re-run any time to change settings or rebuild;
  it is idempotent (at the password prompts, Enter keeps what is stored).

  Each piece is a single self-contained executable built from this repo:
  windows\dist\promptportal.exe, plus windows\dist\hub.exe (static assets embedded)
  with -InstallHub. Bun (>= 1.3.14, bun.sh) is the only build prerequisite.

.EXAMPLE
  .\install.ps1 -HubUrl https://promptportal.example.com -NodeName laptop
  # prompts for the workstation password (hidden); -Password '...' skips the prompt
  # for scripted installs, at the cost of the password landing in shell
  # history and the process command line

.EXAMPLE
  .\install.ps1 -InstallHub
  # hosts the hub here too: builds windows\dist\hub.exe, stores both hub
  # passwords in Credential Manager, registers the 'PromptPortalHub' logon
  # task, and points this workstation at http://127.0.0.1:8080. The hub
  # listens on loopback; front it with TLS (e.g. tailscale serve) to reach
  # it from other machines.

.EXAMPLE
  .\install.ps1 -Uninstall
  # removes both scheduled tasks, the running processes, the stored
  # credentials, the user environment variables, the PATH entry, and the
  # Windows Terminal profile. The built exes and the hub-data directory (saved
  # profiles and quick commands) are left in place.

.EXAMPLE
  .\install.ps1 -Update
  # rebuilds promptportal.exe (and hub.exe when the hub is installed here) from the
  # current repo and restarts the tasks, touching no passwords, environment
  # variables, PATH entry, or Windows Terminal profile. Needs no -HubUrl: the
  # stored configuration already has it. Open sessions keep running on the
  # old build until their windows close; only the launcher (and hub) restart.
#>
param(
  [string]$HubUrl,
  [string]$Password,
  [string]$NodeName = ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9_.-]', '-'),
  [switch]$InstallHub,
  [ValidateRange(1, 65535)][int]$HubPort = 8080,
  [string]$WebAccessPassword,
  [switch]$Uninstall,
  [switch]$Update
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path "$PSScriptRoot\..").Path
$dist = "$PSScriptRoot\dist"
$launcherTask = 'PromptPortalLauncher'
$hubTask = 'PromptPortalHub'
$fragDir = "$env:LOCALAPPDATA\Microsoft\Windows Terminal\Fragments\PromptPortal"
# Credential Manager targets and user environment variables the install writes,
# mirrored from promptportal/config.ts (CREDENTIAL_TARGET) and lib/settings.ts since
# PowerShell cannot import them — kept beside the tasks and paths so -Uninstall
# removes exactly what was created, and nothing else.
$workstationCredential = 'PromptPortal'
$hubCredentials = @('PromptPortalHub/webaccess', 'PromptPortalHub/workstation')
$userEnvVars = @('PROMPTPORTAL_HUB_URL', 'PROMPTPORTAL_NODE_NAME')

# --- Helpers -------------------------------------------------------------------

# Compile one self-contained executable to its staging name ($Name-new.exe).
# Staging first: a failed build must tear nothing down. Both builds disable
# bunfig autoload, so a bunfig.toml in the directory the binary starts in cannot
# `preload` code into it. -NoDotenv additionally turns off dotenv autoload; the
# workstation needs it off so a session host cannot pick up that directory's
# .env and pass it to the shells it hosts, while the hub — which spawns no
# shells — keeps Bun's default.
function New-StagedExecutable([string]$EntryPoint, [string]$Name, [switch]$NoDotenv) {
  Write-Host "`nBuilding $Name.exe..."
  # [string[]] holds: an if-expression's output is unrolled, so an untyped
  # $dotenv would become a bare string and splat one character per argument.
  [string[]]$dotenv = if ($NoDotenv) { '--no-compile-autoload-dotenv' } else { @() }
  # --windows-icon brands the executable with the PromptPortal app icon.
  bun build --compile $EntryPoint --outfile "$dist\$Name-new.exe" --no-compile-autoload-bunfig `
    --windows-icon "$PSScriptRoot\promptportal.ico" --windows-title 'PromptPortal' @dotenv
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$dist\$Name-new.exe")) {
    throw "Build failed; see output above."
  }
}

# Compile the executables to their staging names, verifying the one build
# prerequisite first: promptportal (the workstation launcher and its session hosts), and
# the hub with -Hub. Shared by the install and the update, so both build under
# the same Bun floor and neither drifts. Staging first means a failed build
# tears nothing down.
function Build-StagedExecutables([bool]$Hub, [bool]$Launcher = $true) {
  $null = (Get-Command bun -ErrorAction Stop).Source
  # Bun.spawn's `terminal` option (the pty every session runs in) needs 1.3.14,
  # and `bun build --compile` embeds the running Bun as the exe's runtime — an
  # old Bun would yield a promptportal.exe whose sessions die at spawn. Prerelease
  # suffixes (1.3.16-canary.…) are not [version]-castable; strip them.
  $bunVersion = [version]((bun --version) -replace '[-+].*$', '')
  if ($bunVersion -lt [version]'1.3.14') {
    throw "Bun $bunVersion is too old; promptportal needs >= 1.3.14 (bun upgrade)"
  }
  if ($Hub) {
    # server.ts embeds the @xterm assets out of node_modules, which a fresh
    # clone lacks (bun build does not install; promptportal.exe needs no packages).
    bun install --frozen-lockfile --cwd $repo
    if ($LASTEXITCODE -ne 0) { throw 'bun install failed; see output above.' }
    New-StagedExecutable "$repo\server.ts" 'hub'
  }
  if ($Launcher) { New-StagedExecutable "$repo\promptportal\main.ts" 'promptportal' -NoDotenv }
}

# Stop every running build of $Name — the launcher, its session hosts, or the
# hub. Match our own build by Bun's PE company field ("Oven"), not the install
# path, so a copy left running from another clone is caught too. Best effort —
# this would also stop an unrelated Bun exe that happened to be named
# $Name.exe, a trade accepted to reliably retire our own stragglers.
# -Uninstall only: install and update spare session hosts (Stop-ResidentProcess).
function Stop-PromptPortalProcess([string]$Name, [string]$StopNote) {
  $running = @(Get-Process $Name -ErrorAction SilentlyContinue | Where-Object { $_.Company -eq 'Oven' })
  if ($running) {
    Write-Host "Stopping running $Name processes$StopNote..."
    $running | Stop-Process -Force
    $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
  }
}

# Stop the resident copies of $Name — `promptportal launcher`, or every hub.exe —
# so their task can restart them on the fresh binary. Session hosts are
# deliberately spared: the swap renames the old image aside and a running
# process follows its file through a rename, so open sessions live on
# untouched. Sparing them also means running the update from inside a
# PromptPortal session is safe — stopping every host would kill the session
# the script itself runs in, mid-swap. A session host never carries a first
# argument of `launcher`, which is what marks the resident.
function Stop-ResidentProcess([string]$Name) {
  $running = @(Get-Process $Name -ErrorAction SilentlyContinue | Where-Object { $_.Company -eq 'Oven' })
  if ($Name -eq 'promptportal') {
    $running = @($running | Where-Object {
      $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
      $cmd -and (($cmd -replace '^\s*(?:"[^"]+"|\S+)\s*', '') -match '^launcher(\s|$)')
    })
  }
  if ($running) {
    Write-Host "Stopping the running $(if ($Name -eq 'promptportal') { 'launcher' } else { $Name })..."
    $running | Stop-Process -Force
    $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
  }
}

# Swap a staged build in. Only the resident process stops — the swap renames
# the old image aside rather than overwriting it (Windows locks a running
# image against overwrite, but always allows renaming one), so session hosts
# keep running on the old build until their windows close, and only then does
# the old copy become deletable (cleaned up best-effort; the next run
# retries). Stopping the scheduled task is not enough to retire the resident:
# it terminates the conhost it started, which can orphan the child — and a
# process started by hand has no task at all.
function Install-StagedExecutable([string]$Name, [string]$TaskName) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Stop-ResidentProcess $Name
  # Swap the new binary in via rename-aside: Move-Item -Force does not reliably
  # replace an existing file, and a straggler process would hold the exe locked
  # against deletion anyway — but Windows always allows renaming a running
  # image. Old copies are cleaned up best-effort (next run retries).
  Get-ChildItem "$dist\$Name-old-*.exe" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  if (Test-Path "$dist\$Name.exe") { Move-Item "$dist\$Name.exe" "$dist\$Name-old-$PID.exe" }
  Move-Item "$dist\$Name-new.exe" "$dist\$Name.exe"
  Remove-Item "$dist\$Name-old-$PID.exe" -Force -ErrorAction SilentlyContinue
  Write-Host "Built $dist\$Name.exe"
}

# Register a resident process to run at logon, windowless. conhost --headless
# hosts it in an invisible console: no window exists at any point. (A
# `powershell -WindowStyle Hidden` wrapper would still flash a console at
# logon before hiding it.) It inherits the user env vars this script sets.
# Scoped to this user: it starts at (and runs as) your logon, and a
# user-scoped trigger registers without elevation. ExecutionTimeLimit PT0S
# disables Task Scheduler's default 72-hour limit, which would otherwise kill
# the process after three days.
function Register-HeadlessLogonTask([string]$TaskName, [string]$CommandLine, [string]$Description) {
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
    -Argument "--headless $CommandLine" `
    -WorkingDirectory $dist
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 `
    -ExecutionTimeLimit (New-TimeSpan)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Force -Description $Description | Out-Null
  Write-Host "Registered scheduled task '$TaskName' (runs at logon)."
}

# A hidden prompt that keeps the secret out of shell history and this
# process's command line.
function Read-Secret([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# Pipe lines into a set-password command. The pipe must carry UTF-8: Windows
# PowerShell's default pipeline encoding for native commands is ASCII, which
# would corrupt non-ASCII passwords.
function Invoke-Utf8Pipe([string[]]$Lines, [string]$Exe, [string[]]$ExeArgs) {
  $prevEncoding = $OutputEncoding
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  try { $Lines | & $Exe @ExeArgs } finally { $OutputEncoding = $prevEncoding }
}

# Add or remove $dist on the user PATH. Split on ';' and compare whole entries:
# -like would treat $dist as a wildcard, and concatenating onto an empty PATH
# would prepend a stray separator. Read and write through the registry
# directly: [Environment]::GetEnvironmentVariable expands %VAR% entries on read
# and SetEnvironmentVariable writes plain REG_SZ, so a round-trip would freeze
# every REG_EXPAND_SZ entry at its current expansion. A raw registry write also
# skips the WM_SETTINGCHANGE broadcast SetEnvironmentVariable would send, so
# send it by hand — without it, shells opened before the next logon never see
# the change.
function Edit-UserPath([ValidateSet('Add', 'Remove')][string]$Action) {
  $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entries = @($userPath -split ';' | Where-Object { $_ -ne '' })
    $present = $entries -contains $dist
    if ($Action -eq 'Add' -and -not $present) { $updated = @($entries) + $dist }
    elseif ($Action -eq 'Remove' -and $present) { $updated = @($entries | Where-Object { $_ -ne $dist }) }
    else { return }
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($envKey.GetValueNames() -contains 'Path') { $kind = $envKey.GetValueKind('Path') }
    $envKey.SetValue('Path', (@($updated) -join ';'), $kind)
    if (-not ([System.Management.Automation.PSTypeName]'Win32.Env').Type) {
      Add-Type -Namespace Win32 -Name Env -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    }
    [UIntPtr]$broadcastResult = [UIntPtr]::Zero
    [void][Win32.Env]::SendMessageTimeoutW([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$broadcastResult)
    if ($Action -eq 'Add') { Write-Host "Added $dist to user PATH (restart shells to pick up `promptportal`)." }
    else { Write-Host "Removed $dist from user PATH." }
  } finally {
    $envKey.Close()
  }
}

# Reverse the install: stop the scheduled tasks and running processes, then
# remove the credentials, user environment variables, PATH entry, and Windows
# Terminal profile it created. Idempotent — anything already gone is skipped.
# The built exes under dist\ and the hub-data directory (saved profiles and
# quick commands) are deliberately left in place.
function Invoke-Uninstall {
  Write-Host "Uninstalling PromptPortal..."
  # Tasks before processes, so neither the launcher nor the hub is restarted at
  # logon or by a task's restart-on-failure while we are tearing it down.
  foreach ($task in $hubTask, $launcherTask) {
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $task -Confirm:$false
      Write-Host "Removed scheduled task '$task'."
    }
  }
  Stop-PromptPortalProcess 'hub' ''
  Stop-PromptPortalProcess 'promptportal' ' (open sessions end with them)'
  # cmdkey deletes the Credential Manager entries set-password wrote:
  # lib/credential.ts only reads and writes generic credentials, so there is no
  # exe path to reuse, and this must work without any build output. cmdkey
  # exits non-zero when the target is absent — treat that as already-gone.
  foreach ($target in @($workstationCredential) + $hubCredentials) {
    try { cmdkey "/delete:$target" 2>&1 | Out-Null } catch { }
    if ($LASTEXITCODE -eq 0) { Write-Host "Removed credential '$target'." }
  }
  foreach ($name in $userEnvVars) {
    if ($null -ne [Environment]::GetEnvironmentVariable($name, 'User')) {
      [Environment]::SetEnvironmentVariable($name, $null, 'User')
      Write-Host "Removed user environment variable $name."
    }
  }
  Edit-UserPath 'Remove'
  if (Test-Path $fragDir) {
    Remove-Item $fragDir -Recurse -Force
    Write-Host "Removed the Windows Terminal 'PromptPortal' profile."
  }
  Write-Host "`nDone. Left in place: the built executables in $dist\ and any hub"
  Write-Host "data in $env:LOCALAPPDATA\PromptPortal\hub-data."
}

# Prove a headless task's process came up and stayed up. The task runs it with
# no window, so a startup error (bad config) dies invisibly — the only signal
# is the process holding past the first couple of seconds. $Hint is the command
# to run by hand to see the error.
function Wait-ProcessHolds([string]$Name, [string]$ImagePath, [string]$What, [string]$Hint) {
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $proc = Get-Process $Name -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ImagePath } | Select-Object -First 1
    if ($proc) {
      Start-Sleep -Seconds 2   # a config error exits within moments of starting
      if (-not $proc.HasExited) { return }
    }
    Start-Sleep -Milliseconds 500
  }
  throw "The $What did not come up. Run $Hint in a terminal to see the error."
}

# Prove the headless hub came up: it must both answer HTTP and still be
# running. Any HTTP status counts — an unauthenticated request earns a 401 from
# a healthy hub. The answer alone is not proof, though: with the port already
# taken, the hub dies at bind time while the other service answers the probe —
# so require the hub process to hold too. $Hint is the command to run by hand.
function Wait-HubHolds([int]$Port, [string]$Hint) {
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $answered = $false
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $answered = $true
    } catch {
      if ($_.Exception.Response) { $answered = $true }
    }
    if ($answered) {
      Start-Sleep -Seconds 2   # a bind failure kills the hub within moments
      if (@(Get-Process hub -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$dist\hub.exe" }).Count -gt 0) {
        return
      }
      throw ("Port $Port answers but $dist\hub.exe is not running — another service likely holds the port " +
        "(pick a different -HubPort), or the hub crashed at startup. Run $Hint in a terminal to see the error.")
    }
    Start-Sleep -Milliseconds 500
  }
  throw "The hub did not come up. Run $Hint in a terminal to see the error."
}

# Rebuild the executables from the current repo and swap them in, leaving every
# stored setting untouched: no passwords, environment variables, PATH entry, or
# Windows Terminal profile are read or written. Updates whichever halves are
# installed here — the workstation launcher, and the hub too when its task is
# registered — using the same staged-build discipline and come-up checks a full
# install uses. Needs no -HubUrl: the config the tasks already carry has it.
function Invoke-Update {
  $launcherInstalled = [bool](Get-ScheduledTask -TaskName $launcherTask -ErrorAction SilentlyContinue)
  $hubInstalled = [bool](Get-ScheduledTask -TaskName $hubTask -ErrorAction SilentlyContinue)
  if (-not $launcherInstalled -and -not $hubInstalled) {
    throw 'Nothing to update: no PromptPortal launcher or hub is installed on this machine. Run install.ps1 with -HubUrl (or -InstallHub) first.'
  }
  Write-Host "Updating PromptPortal in place (rebuilding executables)..."
  Write-Host "Repo: $repo"

  # Build only the halves installed here, to staging names so a failed build
  # tears nothing down.
  Build-StagedExecutables $hubInstalled $launcherInstalled

  # Swap and verify in the same order a full install uses: the hub first (the
  # workstation half's set-password normally verifies against it), then the
  # launcher. The port and a runnable hint come from the task the swap keeps.
  if ($hubInstalled) {
    $hubArgs = (Get-ScheduledTask -TaskName $hubTask).Actions[0].Arguments
    $hubPort = if ($hubArgs -match '--port\s+(\d+)') { [int]$Matches[1] } else { $HubPort }
    Install-StagedExecutable 'hub' $hubTask
    Start-ScheduledTask -TaskName $hubTask
    Wait-HubHolds $hubPort ($hubArgs -replace '^\s*--headless\s+', '')
    Write-Host "The hub is up on http://127.0.0.1:$hubPort."
  }
  if ($launcherInstalled) {
    Install-StagedExecutable 'promptportal' $launcherTask
    Start-ScheduledTask -TaskName $launcherTask
    Wait-ProcessHolds 'promptportal' "$dist\promptportal.exe" 'launcher' "`"$dist\promptportal.exe`" launcher"
  }
  Write-Host "`nDone. Rebuilt and restarted. Host a session from any terminal with:  promptportal"
}

if ($Uninstall) {
  Invoke-Uninstall
  return
}

if ($Update) {
  if ($HubUrl -or $InstallHub) {
    throw '-Update rebuilds the installed executables in place and reads no new settings; run it on its own, or drop -Update to change configuration with -HubUrl/-InstallHub.'
  }
  Invoke-Update
  return
}

# --- Validate inputs and prerequisites -----------------------------------------
# Mirrors the node-name rule promptportal itself enforces (promptportal/config.ts) — a conscious
# one-line duplication, since PowerShell cannot import it: failing here beats
# a launcher that dies at logon with the error visible only by hand-running it.
if ($NodeName -notmatch '^[A-Za-z0-9_.-]{1,64}$') {
  throw "Invalid -NodeName '$NodeName' (allowed: letters, digits, _ . - ; max 64 chars)"
}
if (-not $HubUrl) {
  if (-not $InstallHub) { throw '-HubUrl is required (or -InstallHub to host the hub on this machine, or -Update to rebuild an existing install without changing its configuration)' }
  $HubUrl = "http://127.0.0.1:$HubPort"
}
if ($WebAccessPassword -and -not $InstallHub) {
  throw '-WebAccessPassword configures the hub; it needs -InstallHub'
}

Write-Host "Repo:      $repo"
Write-Host "Node name: $NodeName"
Write-Host "Hub:       $HubUrl$(if ($InstallHub) { ' (installed here)' })"

# The environment outranks Credential Manager by design (containers, dev
# runs), so a password variable persisted user- or machine-wide would make
# the hub and promptportal silently ignore what this install stores.
$passwordVars = @('PROMPTPORTAL_WORKSTATION_PASSWORD') + $(if ($InstallHub) { @('PROMPTPORTAL_WEBACCESS_PASSWORD') } else { @() })
foreach ($name in $passwordVars) {
  foreach ($scope in 'User', 'Machine') {
    if ([Environment]::GetEnvironmentVariable($name, $scope)) {
      Write-Warning "$name is persisted ($scope scope) and overrides the password this install stores in Credential Manager — remove the variable."
    }
  }
}

# --- Build the executables (to staging names) ----------------------------------
# Builds and password entry both come before anything stops or swaps, so a
# failed build or a cancelled prompt leaves the machine exactly as it was.
Build-StagedExecutables $InstallHub

# --- Install the hub -----------------------------------------------------------
# The hub must be serving before the workstation half below, whose
# set-password verifies the workstation password against it.
if ($InstallHub) {
  # Both hub secrets go to Credential Manager. Prompted here rather than by
  # hub.exe so the workstation password is asked for once and reused for the
  # workstation registration below — and stored through the staged binary, so
  # bad input aborts while the old hub still runs untouched.
  if (-not $WebAccessPassword) {
    $WebAccessPassword = Read-Secret 'Web-access password (browsers sign in with it; Enter keeps one stored before)'
  }
  if (-not $Password) {
    $Password = Read-Secret 'Workstation password (workstations register with it; Enter keeps one stored before)'
  }
  Write-Host 'Storing the hub passwords in Credential Manager...'
  Invoke-Utf8Pipe @($WebAccessPassword, $Password) "$dist\hub-new.exe" @('set-password')
  if ($LASTEXITCODE -ne 0) { throw 'Failed to store the hub passwords; see output above.' }

  Install-StagedExecutable 'hub' $hubTask

  # Profiles and quick commands persist here (the compose deployment's
  # hub-data volume, as a directory). A scheduled task has no per-process
  # environment channel, so the settings ride the command line — including
  # --host, so a stray user-level PROMPTPORTAL_HOST variable can never flip
  # this headless plain-HTTP hub onto the network.
  $hubData = "$env:LOCALAPPDATA\PromptPortal\hub-data"
  New-Item -ItemType Directory -Force -Path $hubData | Out-Null
  $hubCommand = "`"$dist\hub.exe`" --host 127.0.0.1 --port $HubPort --data `"$hubData`""
  Register-HeadlessLogonTask $hubTask $hubCommand 'PromptPortal hub'

  Start-ScheduledTask -TaskName $hubTask
  # The task runs the hub headless, so a startup error would die invisibly;
  # prove it answers HTTP and holds before the workstation half depends on it.
  Wait-HubHolds $HubPort $hubCommand
  Write-Host "The hub is up on http://127.0.0.1:$HubPort."
} elseif (Get-ScheduledTask -TaskName $hubTask -ErrorAction SilentlyContinue) {
  Write-Warning ("a '$hubTask' task from an earlier -InstallHub run is still registered and keeps serving at logon; " +
    "remove it with: Unregister-ScheduledTask '$hubTask' -Confirm:`$false")
}

# --- Store the workstation password ---------------------------------------------
# It goes to Windows Credential Manager instead of a user environment
# variable, which would sit in the registry and be inherited by every process
# in the session. set-password verifies it against the hub before storing,
# and runs through the staged binary — a mistyped password fails right here,
# before the launcher or any session has been touched. The user env var
# persisted below is not part of this process's environment yet, so hand the
# URL over explicitly.
Write-Host "`nStoring the workstation password in Credential Manager..."
$env:PROMPTPORTAL_HUB_URL = $HubUrl
if ($Password -or $InstallHub) {
  # With -InstallHub the password was already prompted for above (an empty
  # entry pipes through as "keep the stored one") — never ask twice.
  Invoke-Utf8Pipe @($Password) "$dist\promptportal-new.exe" @('set-password')
} else {
  # No -Password given: let promptportal prompt for it hidden.
  & "$dist\promptportal-new.exe" set-password
}
if ($LASTEXITCODE -ne 0) { throw "Failed to store the password; see output above." }

Install-StagedExecutable 'promptportal' $launcherTask

# --- Persist configuration ------------------------------------------------------
# Non-secret settings go to user environment variables; the scheduled tasks and
# any shell you open inherit them.
Write-Host "Setting user environment variables..."
[Environment]::SetEnvironmentVariable('PROMPTPORTAL_HUB_URL',   $HubUrl,   'User')
[Environment]::SetEnvironmentVariable('PROMPTPORTAL_NODE_NAME', $NodeName, 'User')

# Put dist\ on the user PATH so `promptportal` resolves everywhere.
Edit-UserPath 'Add'

# --- Register the launcher to run at logon (windowless) -----------------------
# The launcher is the workstation's one resident process: it exists so
# sessions can be started from the hub (each opens as a terminal window
# here).
Register-HeadlessLogonTask $launcherTask "`"$dist\promptportal.exe`" launcher" 'PromptPortal workstation launcher'

# --- Install the Windows Terminal fragment ------------------------------------
# Adds a "PromptPortal" profile that opens a new hub-connected session
# (it just runs `promptportal`).
New-Item -ItemType Directory -Force -Path $fragDir | Out-Null
# Ship the app icon beside the exe so the profile points at a stable path, then
# resolve both placeholders (exe path + icon path) in the fragment.
Copy-Item "$PSScriptRoot\promptportal.ico" "$dist\promptportal.ico" -Force
# -Encoding UTF8 explicitly: the note holds non-ASCII, and Windows PowerShell
# 5.1 reads ANSI by default, which would mangle it.
$fragment = (Get-Content "$PSScriptRoot\windows-terminal-fragment.template.json" -Raw -Encoding UTF8).
  Replace('__PROMPTPORTAL__', ("$dist\promptportal.exe" -replace '\\', '\\')).
  Replace('__ICON__', ("$dist\promptportal.ico" -replace '\\', '\\'))
Set-Content -Path "$fragDir\promptportal.json" -Value $fragment -Encoding UTF8
Write-Host "Installed Windows Terminal fragment (new 'PromptPortal' profile)."

# --- (Re)start it --------------------------------------------------------------
# Stop first so a re-run picks up the freshly built executable.
Stop-ScheduledTask -TaskName $launcherTask -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $launcherTask

# The task runs the launcher headless, so a startup error (bad config) would
# die invisibly; prove it came up and stayed up before declaring success. The
# password and hub URL were already proven against the hub by set-password
# above, so a launcher that holds is a launcher that registers.
Wait-ProcessHolds 'promptportal' "$dist\promptportal.exe" 'launcher' "`"$dist\promptportal.exe`" launcher"
Write-Host "`nDone. The launcher is running. Host a session from any terminal with:  promptportal"
Write-Host "In Windows Terminal, the 'PromptPortal' profile opens a connected session."
Write-Host "Closing a session's window ends that session everywhere."
if ($InstallHub) {
  Write-Host "The hub is serving on http://127.0.0.1:$HubPort (task '$hubTask', data in $env:LOCALAPPDATA\PromptPortal\hub-data)."
  Write-Host "It speaks plain HTTP on loopback; to reach it from other machines put TLS in"
  Write-Host "front (e.g. tailscale serve --bg $HubPort) and use that URL from browsers and workstations."
}
