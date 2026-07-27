import { CliError } from './errors';

// Reading secrets from the user, shared by `prompt-portal set-password` and
// `hub set-password`: a hidden prompt on a TTY, or piped stdin (the installer,
// the launcher's pipe to a headless host, the entrypoint's heredoc).

// Read a secret piped on stdin. Strips only the single trailing newline the
// pipe adds — nothing else, since every other byte of the password is
// significant.
export async function readSecretFromStdin(): Promise<string> {
  return (await Bun.stdin.text()).replace(/[\r\n]+$/, '');
}

// Bytes are scanned for the control keys (safe: UTF-8 continuation bytes are
// all >= 0x80, so they can never look like one) while the text between them
// goes through a streaming decoder — building the string byte-by-byte would
// turn a multi-byte password like "pässword" into mojibake that then fails
// hub auth despite being typed correctly.
export function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let buffer = '';
    const decoder = new TextDecoder();
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer) => {
      let start = 0;
      const takeText = (end: number) => {
        if (end > start) buffer += decoder.decode(chunk.subarray(start, end), { stream: true });
        start = end + 1;
      };
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i]!;
        if (byte === 0x0d || byte === 0x0a) { // Enter
          takeText(i);
          finish();
          resolve(buffer);
          return;
        }
        if (byte === 0x03) { // Ctrl-C: raw mode swallows the signal, so honor it here
          finish();
          reject(new CliError('cancelled'));
          return;
        }
        if (byte === 0x08 || byte === 0x7f) { // Backspace: drop one code point
          takeText(i);
          buffer = [...buffer].slice(0, -1).join('');
        } else if (byte < 0x20) { // other control keys: ignore
          takeText(i);
        }
      }
      takeText(chunk.length);
    };
    process.stdin.on('data', onData);
  });
}
