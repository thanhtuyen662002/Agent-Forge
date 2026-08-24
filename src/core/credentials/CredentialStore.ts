import { spawn } from 'child_process';
import { CredentialRef, parseCredentialRef } from './CredentialRef';
import { SecretValue } from './SecretValue';

/**
 * Microsoft documented maximum credential blob size for generic credentials (5 * 512 bytes).
 */
export const CRED_MAX_CREDENTIAL_BLOB_SIZE = 2560;

/**
 * Provider-neutral interface for secure local credential storage.
 * Implementations manage persistent or in-memory storage of secret payloads
 * indexed by opaque CredentialRef references.
 */
export interface CredentialStore {
  put(ref: CredentialRef, secret: SecretValue): Promise<void>;
  get(ref: CredentialRef): Promise<SecretValue | null>;
  delete(ref: CredentialRef): Promise<boolean>;
  exists(ref: CredentialRef): Promise<boolean>;
}

export type PowerShellExecutor = (script: string, stdinInput: string) => Promise<string>;

/**
 * In-memory CredentialStore fake for test environments and non-Windows CI.
 * Revalidates reference canonical identity before indexing.
 * @internal
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly store = new Map<string, SecretValue>();

  private getCanonicalUri(ref: CredentialRef): string {
    if (!ref) {
      throw new Error('[InMemoryCredentialStore] Credential reference cannot be null or undefined.');
    }
    const rawUri =
      typeof ref === 'string'
        ? ref
        : typeof (ref as any).toUriString === 'function'
          ? (ref as any).toUriString()
          : String(ref);
    const canonicalRef = parseCredentialRef(rawUri);
    return canonicalRef.toUriString();
  }

  public async put(ref: CredentialRef, secret: SecretValue): Promise<void> {
    const key = this.getCanonicalUri(ref);
    this.store.set(key, secret);
  }

  public async get(ref: CredentialRef): Promise<SecretValue | null> {
    const key = this.getCanonicalUri(ref);
    return this.store.get(key) ?? null;
  }

  public async delete(ref: CredentialRef): Promise<boolean> {
    const key = this.getCanonicalUri(ref);
    return this.store.delete(key);
  }

  public async exists(ref: CredentialRef): Promise<boolean> {
    const key = this.getCanonicalUri(ref);
    return this.store.has(key);
  }

  public clear(): void {
    this.store.clear();
  }
}

/**
 * Production Windows Credential Manager backend.
 * Stores secrets in the Windows Credential Store under the current-user scope
 * with an `AgentForge:` namespace prefix.
 *
 * Revalidates reference inputs fail-closed before invoking OS commands.
 * Fails closed on non-Windows platforms.
 */
export class WindowsCredentialStore implements CredentialStore {
  readonly #platform: string;
  readonly #executor: PowerShellExecutor;

  constructor(platformOverride?: string, customExecutor?: PowerShellExecutor) {
    this.#platform = platformOverride ?? process.platform;
    this.#executor = customExecutor ?? this.#defaultPowerShellExecutor.bind(this);
  }

  private assertWindowsPlatform(): void {
    if (this.#platform !== 'win32') {
      throw new Error(
        `UNSUPPORTED_PLATFORM: WindowsCredentialStore is only supported on Windows (win32). Current platform: "${this.#platform}".`
      );
    }
  }

  private getCanonicalTargetName(ref: CredentialRef): string {
    if (!ref) {
      throw new Error('[WindowsCredentialStore] Credential reference cannot be null or undefined.');
    }
    const rawUri =
      typeof ref === 'string'
        ? ref
        : typeof (ref as any).toUriString === 'function'
          ? (ref as any).toUriString()
          : String(ref);
    const canonicalRef = parseCredentialRef(rawUri);
    return canonicalRef.getWindowsTargetName();
  }

  public async put(ref: CredentialRef, secret: SecretValue): Promise<void> {
    this.assertWindowsPlatform();
    const targetName = this.getCanonicalTargetName(ref);
    const secretContent = secret.exposeSecret();

    // Validate byte length against Microsoft Windows Credential Manager generic blob limits
    const byteLength = Buffer.byteLength(secretContent, 'utf16le');
    if (byteLength > CRED_MAX_CREDENTIAL_BLOB_SIZE) {
      throw new Error(
        `[WindowsCredentialStore] Credential secret size (${byteLength} bytes) exceeds maximum Windows Credential Manager limit (${CRED_MAX_CREDENTIAL_BLOB_SIZE} bytes).`
      );
    }

    // PowerShell script to write generic credential via advapi32.dll with secret passed via stdin
    const psScript = `
$target = [Console]::In.ReadLine()
$secret = [Console]::In.ReadToEnd()
if ([string]::IsNullOrEmpty($secret)) {
    throw "Secret payload is empty."
}

$def = @"
using System;
using System.Runtime.InteropServices;
public class WinCredWriter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "CredWriteW", CharSet = CharSet.Unicode)]
    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);
}
"@
Add-Type -TypeDefinition $def

$bytes = [System.Text.Encoding]::Unicode.GetBytes($secret)
$blobPtr = [System.Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blobPtr, $bytes.Length)

$cred = New-Object WinCredWriter+CREDENTIAL
$cred.Flags = 0
$cred.Type = 1 # CRED_TYPE_GENERIC
$cred.TargetName = $target
$cred.Comment = "AgentForge Managed Credential"
$cred.CredentialBlobSize = $bytes.Length
$cred.CredentialBlob = $blobPtr
$cred.Persist = 2 # CRED_PERSIST_LOCAL_MACHINE (current user scope)
$cred.UserName = "AgentForge"

$success = [WinCredWriter]::CredWrite([ref]$cred, 0)
[System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($blobPtr)

if (-not $success) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "CredWrite failed with error code $err."
}
Write-Output "OK"
`;

    await this.#executor(psScript, `${targetName}\n${secretContent}`);
  }

  public async get(ref: CredentialRef): Promise<SecretValue | null> {
    this.assertWindowsPlatform();
    const targetName = this.getCanonicalTargetName(ref);

    const psScript = `
$target = [Console]::In.ReadLine()

$def = @"
using System;
using System.Runtime.InteropServices;
public class WinCredReader {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "CredReadW", CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "CredFree")]
    public static extern void CredFree([In] IntPtr pBuffer);
}
"@
Add-Type -TypeDefinition $def

$ptr = [IntPtr]::Zero
$success = [WinCredReader]::CredRead($target, 1, 0, [ref]$ptr)

if (-not $success) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq 1168) { # ERROR_NOT_FOUND
        exit 0
    }
    throw "CredRead failed with error code $err."
}

try {
    $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][WinCredReader+CREDENTIAL])
    if ($cred.CredentialBlobSize -gt 0 -and $cred.CredentialBlob -ne [IntPtr]::Zero) {
        $bytes = New-Object byte[] $cred.CredentialBlobSize
        [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
        $secret = [System.Text.Encoding]::Unicode.GetString($bytes)
        [Console]::Out.Write($secret)
    }
} finally {
    [WinCredReader]::CredFree($ptr)
}
`;

    const output = await this.#executor(psScript, targetName);
    if (!output || output.length === 0) {
      return null;
    }
    return new SecretValue(output);
  }

  public async delete(ref: CredentialRef): Promise<boolean> {
    this.assertWindowsPlatform();
    const targetName = this.getCanonicalTargetName(ref);

    const psScript = `
$target = [Console]::In.ReadLine()

$def = @"
using System;
using System.Runtime.InteropServices;
public class WinCredDeleter {
    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string target, int type, int flags);
}
"@
Add-Type -TypeDefinition $def

$success = [WinCredDeleter]::CredDelete($target, 1, 0)
if ($success) {
    Write-Output "DELETED"
} else {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq 1168) { # ERROR_NOT_FOUND
        Write-Output "NOT_FOUND"
    } else {
        throw "CredDelete failed with error code $err."
    }
}
`;

    const output = await this.#executor(psScript, targetName);
    return output.trim() === 'DELETED';
  }

  /**
   * Least-privilege existence check. Verifies credential presence without
   * reading, copying, or outputting the secret payload.
   */
  public async exists(ref: CredentialRef): Promise<boolean> {
    this.assertWindowsPlatform();
    const targetName = this.getCanonicalTargetName(ref);

    const psScript = `
$target = [Console]::In.ReadLine()

$def = @"
using System;
using System.Runtime.InteropServices;
public class WinCredProber {
    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "CredReadW", CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "CredFree")]
    public static extern void CredFree([In] IntPtr pBuffer);
}
"@
Add-Type -TypeDefinition $def

$ptr = [IntPtr]::Zero
$success = [WinCredProber]::CredRead($target, 1, 0, [ref]$ptr)

if ($success) {
    if ($ptr -ne [IntPtr]::Zero) {
        [WinCredProber]::CredFree($ptr)
    }
    Write-Output "EXISTS"
} else {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq 1168) { # ERROR_NOT_FOUND
        Write-Output "NOT_FOUND"
    } else {
        throw "CredRead failed with error code $err."
    }
}
`;

    const output = await this.#executor(psScript, targetName);
    return output.trim() === 'EXISTS';
  }

  /**
   * Spawns PowerShell asynchronously with piped stdin and buffered stdout.
   */
  #defaultPowerShellExecutor(script: string, stdinInput: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString('utf8');
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString('utf8');
      });

      child.on('error', (err) => {
        reject(new Error(`[WindowsCredentialStore] Failed to spawn PowerShell: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `[WindowsCredentialStore] PowerShell execution failed (exit code ${code}): ${stderr.trim() || stdout.trim()}`
            )
          );
        } else {
          resolve(stdout);
        }
      });

      // Write script and stdin input to powershell stdin
      child.stdin.write(script + '\n');
      if (stdinInput) {
        child.stdin.write(stdinInput);
      }
      child.stdin.end();
    });
  }
}
