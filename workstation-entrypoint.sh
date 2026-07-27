#!/bin/sh
set -e

# The workstation password arrives as PROMPTPORTAL_WORKSTATION_PASSWORD in PID
# 1's environment, which /proc/1/environ keeps readable to same-uid processes
# even after `unset`. So the entrypoint runs in two stages: stage 1 (shell
# builtins only) moves the password onto stdin and re-execs itself, rebuilding
# PID 1's environment without it; stage 2 holds it in an unexported shell
# variable and hands it to the launcher over stdin. Everything exec'd while
# the password is in reach uses an absolute path: $HOME/.local/bin leads PATH
# and is writable, so a bare name could resolve to a binary planted on a
# previous run.
if [ -z "${PROMPTPORTAL_ENTRYPOINT_STAGE2:-}" ]; then
    PASSWORD="${PROMPTPORTAL_WORKSTATION_PASSWORD:-}"
    unset PROMPTPORTAL_WORKSTATION_PASSWORD
    export PROMPTPORTAL_ENTRYPOINT_STAGE2=1
    exec /usr/local/bin/workstation-entrypoint.sh <<STAGE2_PASSWORD
$PASSWORD
STAGE2_PASSWORD
fi
unset PROMPTPORTAL_ENTRYPOINT_STAGE2
# `read` is a shell builtin, so no planted $HOME/.local/bin binary can shadow
# it. It takes the single heredoc line and drops the newline; the launcher
# strips any stray CR anyway.
IFS= read -r PASSWORD || :

# Detach fd 0 from the heredoc's temp file before the tool installers below run:
# they inherit stdin, and it would otherwise stay readable via /proc/<pid>/fd/0.
# The final exec re-provides the secret on a fresh heredoc.
exec 0</dev/null

# Install/update the CLIs onto the home volume at startup via each tool's
# official installer. They target $HOME/.local/bin, which the volume mount
# shadows — so a build-time install can't be seen and this is the only place
# they can land. Kept non-fatal: a transient failure (offline, or a just-
# published release whose GitHub asset digests haven't backfilled yet) must not
# hold the workstation down — a prior version is likely already on the volume,
# and the next start retries.
#
# Download then run as separate steps: piping curl into a shell masks a failed
# download (the shell sees empty input and exits 0), which would silently skip
# the install without the warning ever firing.
install_tool() {
    label=$1 url=$2 runner=$3
    tmp=$(mktemp)
    # Bounded timeouts: with the network down (e.g. host rebooting after an
    # outage), curl must not stall the launcher start for minutes per tool.
    if curl -fsSL --connect-timeout 10 --max-time 120 "$url" -o "$tmp"; then
        "$runner" "$tmp" </dev/null || echo "WARNING: $label install failed; continuing"
    else
        echo "WARNING: $label download failed; continuing"
    fi
    rm -f "$tmp"
}

echo "Installing/updating Claude Code..."
install_tool "Claude Code" https://claude.ai/install.sh bash

echo "Installing/updating Codex..."
install_tool "Codex" https://chatgpt.com/codex/install.sh sh

# Hand the password to the launcher over stdin and become it, under tini (which
# reaps zombies from exited terminal sessions). tini is exec'd here rather than
# added via compose `init: true`, whose docker-init would keep the container's
# original environment — password included — in /proc/1/environ for the
# container's lifetime. (PROMPTPORTAL_PASSWORD_STDIN tells the launcher to read
# the secret from stdin, and it hands it to each session host the same way.)
export PROMPTPORTAL_PASSWORD_STDIN=1
exec /usr/bin/tini -- /usr/local/bin/prompt-portal launcher <<PROMPTPORTAL_PASSWORD
$PASSWORD
PROMPTPORTAL_PASSWORD
