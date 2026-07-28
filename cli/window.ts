import { utf16z } from '../lib/credential';

// Opens a session host in a new terminal window, for sessions created from
// the hub — via ShellExecuteW on argv[0] (the program), so Windows hands it
// to the user's default terminal application. The window closes the moment
// the host exits, banner-free in every case: Windows Terminal closes
// hand-off sessions unconditionally (closeOnExit "automatic" treats them as
// "always"), and a classic console window always dies with its process.

const SW_SHOWNORMAL = 1;

export function openHostWindow(argv: string[]): void {
  const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const shell32 = dlopen('shell32.dll', {
    ShellExecuteW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
      returns: FFIType.u64,
    },
  }).symbols;
  const [program, ...params] = argv;
  const quote = (arg: string) => (/\s/.test(arg) ? `"${arg}"` : arg);
  const result = Number(shell32.ShellExecuteW(null, ptr(utf16z('open')), ptr(utf16z(program!)),
    ptr(utf16z(params.map(quote).join(' '))), null, SW_SHOWNORMAL));
  // ShellExecuteW reports success as a value greater than 32.
  if (result <= 32) throw new Error(`could not open a terminal window (ShellExecuteW: ${result})`);
}
