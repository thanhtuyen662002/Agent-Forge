import type * as Koffi from 'koffi';

/**
 * A generic Windows Credential Manager entry, copied opaquely (#304). The blob
 * is never parsed, logged or written anywhere but the Credential Manager.
 */
export interface CredentialRecord {
  userName: string | null;
  comment: string | null;
  persist: number;
  blob: Buffer;
}

export interface CredentialVault {
  read(target: string): CredentialRecord | null;
  write(target: string, record: CredentialRecord): void;
  remove(target: string): void;
}

export class CredentialVaultError extends Error {
  constructor(public readonly code: 'VAULT_UNAVAILABLE' | 'VAULT_READ_FAILED' | 'VAULT_WRITE_FAILED' | 'VAULT_DELETE_FAILED') {
    super(code);
    this.name = 'CredentialVaultError';
  }
}

const CRED_TYPE_GENERIC = 1;
const ERROR_NOT_FOUND = 1168;
/** CRED_MAX_CREDENTIAL_BLOB_SIZE: 5 * 512 bytes. */
const MAX_BLOB_BYTES = 2560;

function loadNative() {
  const koffi: typeof Koffi = require('koffi');
  const advapi = koffi.load('advapi32.dll');
  const kernel = koffi.load('kernel32.dll');
  const filetime = koffi.struct('AF_CRED_FILETIME', { low: 'uint32', high: 'uint32' });
  const credential = koffi.struct('AF_CREDENTIALW', {
    Flags: 'uint32', Type: 'uint32', TargetName: 'str16', Comment: 'str16', LastWritten: filetime,
    CredentialBlobSize: 'uint32', CredentialBlob: 'void *', Persist: 'uint32', AttributeCount: 'uint32',
    Attributes: 'void *', TargetAlias: 'str16', UserName: 'str16',
  });
  return {
    koffi,
    credential,
    read: advapi.func('__stdcall', 'CredReadW', 'int', ['str16', 'uint32', 'uint32', koffi.out(koffi.pointer('void *'))]),
    write: advapi.func('__stdcall', 'CredWriteW', 'int', [koffi.pointer(credential), 'uint32']),
    remove: advapi.func('__stdcall', 'CredDeleteW', 'int', ['str16', 'uint32', 'uint32']),
    free: advapi.func('__stdcall', 'CredFree', 'void', ['void *']),
    lastError: kernel.func('__stdcall', 'GetLastError', 'uint32', []),
  };
}

let native: ReturnType<typeof loadNative> | undefined;
function api(): ReturnType<typeof loadNative> {
  if (process.platform !== 'win32') throw new CredentialVaultError('VAULT_UNAVAILABLE');
  try { return native ??= loadNative(); } catch { throw new CredentialVaultError('VAULT_UNAVAILABLE'); }
}

/** Generic credentials of the current Windows user (DPAPI-protected by Windows). */
export class WindowsCredentialVault implements CredentialVault {
  public read(target: string): CredentialRecord | null {
    const n = api();
    const out: unknown[] = [null];
    if (!n.read(target, CRED_TYPE_GENERIC, 0, out)) {
      if (n.lastError() === ERROR_NOT_FOUND) return null;
      throw new CredentialVaultError('VAULT_READ_FAILED');
    }
    const pointer = out[0];
    try {
      const value = n.koffi.decode(pointer, n.credential) as {
        CredentialBlobSize: number; CredentialBlob: unknown; Persist: number; UserName: string | null; Comment: string | null;
      };
      if (value.CredentialBlobSize > MAX_BLOB_BYTES) throw new CredentialVaultError('VAULT_READ_FAILED');
      const bytes = value.CredentialBlobSize > 0
        ? Buffer.from(n.koffi.decode(value.CredentialBlob, 'uint8', value.CredentialBlobSize) as number[])
        : Buffer.alloc(0);
      return { userName: value.UserName ?? null, comment: value.Comment ?? null, persist: value.Persist, blob: bytes };
    } finally {
      n.free(pointer);
    }
  }

  public write(target: string, record: CredentialRecord): void {
    if (record.blob.length > MAX_BLOB_BYTES) throw new CredentialVaultError('VAULT_WRITE_FAILED');
    const n = api();
    const ok = n.write({
      Flags: 0, Type: CRED_TYPE_GENERIC, TargetName: target, Comment: record.comment, LastWritten: { low: 0, high: 0 },
      CredentialBlobSize: record.blob.length, CredentialBlob: record.blob, Persist: record.persist, AttributeCount: 0,
      Attributes: null, TargetAlias: null, UserName: record.userName,
    }, 0);
    if (!ok) throw new CredentialVaultError('VAULT_WRITE_FAILED');
  }

  public remove(target: string): void {
    const n = api();
    if (!n.remove(target, CRED_TYPE_GENERIC, 0) && n.lastError() !== ERROR_NOT_FOUND) throw new CredentialVaultError('VAULT_DELETE_FAILED');
  }
}
