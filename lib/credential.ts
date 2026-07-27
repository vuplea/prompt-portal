import { CliError } from './errors';

// Windows Credential Manager access (generic credentials in the user's
// store), shared by the workstation (`prompt-portal set-password`, one
// credential) and the hub (`prompt-portal hub set-password`, one per hub
// password). Keeps secrets out of environment variables and the registry;
// note a stored credential stays readable by any process running as this
// user, these ones included.

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;

// CREDENTIALW field offsets (x64): Flags 0, Type 4, TargetName 8, Comment 16,
// LastWritten 24, CredentialBlobSize 32, CredentialBlob 40, Persist 48,
// AttributeCount 52, Attributes 56, TargetAlias 64, UserName 72 — 80 bytes.
const CREDENTIAL_SIZE = 80;

function advapi32() {
  const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi');
  return dlopen('advapi32.dll', {
    CredReadW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
    CredWriteW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    CredDeleteW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.bool },
    CredFree: { args: [FFIType.ptr], returns: FFIType.void },
  }).symbols;
}

// A null-terminated UTF-16LE buffer — the string form every Win32 *W API
// (here and in cli/window.ts) takes.
export function utf16z(value: string): Buffer {
  return Buffer.from(value + '\0', 'utf16le');
}

export function readCredential(target: string): string | null {
  const { ptr, read, toArrayBuffer } = require('bun:ffi') as typeof import('bun:ffi');
  type Pointer = import('bun:ffi').Pointer;
  const api = advapi32();
  const targetName = utf16z(target);
  const out = Buffer.alloc(8);
  if (!api.CredReadW(ptr(targetName), CRED_TYPE_GENERIC, 0, ptr(out))) return null;
  // read.ptr returns the pointer as a plain number; the FFI calls below want
  // it back as a Pointer.
  const cred = read.ptr(ptr(out), 0) as unknown as Pointer;
  try {
    const blobSize = read.u32(cred, 32);
    const blob = read.ptr(cred, 40) as unknown as Pointer;
    if (!blob || blobSize === 0) return null;
    // UTF-16 bytes, the convention Credential Manager tooling expects.
    return Buffer.from(toArrayBuffer(blob, 0, blobSize)).toString('utf16le');
  } finally {
    api.CredFree(cred);
  }
}

export function writeCredential(target: string, secret: string): void {
  const { ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const api = advapi32();
  // These buffers must stay referenced until the call returns; the struct
  // holds raw pointers into them.
  const targetName = utf16z(target);
  const user = utf16z('promptportal');
  const blob = Buffer.from(secret, 'utf16le');
  const cred = Buffer.alloc(CREDENTIAL_SIZE);
  cred.writeUInt32LE(CRED_TYPE_GENERIC, 4);
  cred.writeBigUInt64LE(BigInt(ptr(targetName)), 8);
  cred.writeUInt32LE(blob.length, 32);
  cred.writeBigUInt64LE(BigInt(ptr(blob)), 40);
  cred.writeUInt32LE(CRED_PERSIST_LOCAL_MACHINE, 48);
  cred.writeBigUInt64LE(BigInt(ptr(user)), 72);
  if (!api.CredWriteW(ptr(cred), 0)) {
    throw new CliError(`could not store the credential "${target}" in Credential Manager`);
  }
}

// Remove a stored credential (`prompt-portal uninstall`). Absent counts as
// removed: the point is the end state, and uninstall must be idempotent.
export function deleteCredential(target: string): void {
  const { ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const targetName = utf16z(target);
  advapi32().CredDeleteW(ptr(targetName), CRED_TYPE_GENERIC, 0);
}
