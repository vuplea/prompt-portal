import { readCredential, writeCredential } from '../lib/credential';
import { SESSION_PROTOCOL } from '../lib/protocol';
import { promptHidden, readSecretFromStdin } from '../lib/secret';
import { CliError, CREDENTIAL_TARGET, env, isWindows } from './config';
import { normalizeHubUrl, warnIfCleartext } from './link';

// `prompt-portal set-password` — store the workstation password in Windows
// Credential Manager, where hosts and the launcher read it from, instead of an
// environment variable. Piped input or a hidden prompt; an empty entry keeps
// the already-stored credential. The password is proved against the
// configured hub before it is stored: a wrong one written here would leave
// the launcher silently redialing forever.

export async function setPassword(): Promise<void> {
  if (!isWindows) {
    throw new CliError('set-password uses Windows Credential Manager; on this platform set PROMPTPORTAL_WORKSTATION_PASSWORD instead');
  }
  const stored = readCredential(CREDENTIAL_TARGET);
  const entered = process.stdin.isTTY
    ? await promptHidden(`Workstation password${stored !== null ? ' (Enter keeps the stored one)' : ''}: `)
    : await readSecretFromStdin();
  if (entered.length === 0 && stored === null) throw new CliError('no password given');
  // Keeping the stored password still verifies it, so a re-run proves the
  // hub link either way.
  const password = entered.length > 0 ? entered : stored!;
  if (env.hubUrl.length === 0) {
    console.log('PROMPTPORTAL_HUB_URL is not set; storing the password unverified.');
  } else {
    await verifyWorkstationPassword(password, env.hubUrl);
  }
  if (entered.length === 0) {
    console.log('Kept the stored workstation password.');
    return;
  }
  writeCredential(CREDENTIAL_TARGET, password);
  console.log(`Stored the workstation password in Credential Manager (generic credential "${CREDENTIAL_TARGET}").`);
}

// The hub gates /session upgrades on the workstation password (lib/auth.ts),
// so one dial proves it end-to-end — the same gate every session and launcher
// link passes. No register frame is sent, so the probe creates nothing on the
// hub; it upgrades, proves the password, and closes. Shared with the
// installer (cli/install.ts), which proves the password before persisting
// anything.
export function verifyWorkstationPassword(password: string, hubUrl: string): Promise<void> {
  const normalized = normalizeHubUrl(hubUrl);
  // A cleartext hub URL puts the password readable on the wire right here —
  // say so before sending it, the same warning the link prints.
  warnIfCleartext(normalized);
  const url = `${normalized}/session`;
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, [SESSION_PROTOCOL, Buffer.from(password, 'utf8').toString('base64url')]);
    } catch (err) {
      return reject(new CliError(`could not reach the hub to verify the password (${url}): ${(err as Error).message}`));
    }
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new CliError(`could not reach the hub to verify the password (${url}): timed out`));
    }, 10 * 1000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
      ws.close();
    };
    // A rejected upgrade surfaces as a close without an open; the HTTP status
    // (wrong password? lockout?) is not visible at this layer, so the message
    // names both. If onopen already resolved, this reject is a no-op.
    ws.onclose = (event) => {
      clearTimeout(timer);
      reject(new CliError('the hub rejected this password or is unreachable'
        + ` (${url}, close code ${event.code}${event.reason ? ` ${JSON.stringify(event.reason)}` : ''}) — not stored`));
    };
  });
}
