import { spawn } from 'child_process';
import { CredentialRef } from './CredentialRef';
import { SecretValue } from './SecretValue';

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

/**
 * In-memory CredentialStore fake for test environments and non-Windows CI.
 * @internal
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly store = new Map<string, SecretValue>();

  public async put(ref: CredentialRef, secret: SecretValue): Promise<void> {
    this.store.set(ref.toUriString(), secret);
  }

  public async get(ref: CredentialRef): Promise<SecretValue | null> {
    return this.store.get(ref.toUriString()) ?? null;
  }

  public async delete(ref: CredentialRef): Promise<boolean> {
    return this.store.delete(ref.toUriString());
  }

  public async exists(ref: CredentialRef): Promise<boolean> {
    return this.store.has(ref.toUriString());
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
 * Fails closed on non-Windows platforms.
 */
export class WindowsCredentialStore implements CredentialStore {
  private readonly platform: string;

  constructor(platformOverride?: string) {
    this.platform = platformOverride ?? process.platform;
  }

  private assertWindowsPlatform(): void {
    if (this.platform !== 'win32') {
      throw new Error(
        `UNSUPPORTED_PLATFORM: WindowsCredentialStore is only supported on Windows (win32). Current platform: "${this.platform}".`
      );
    }
  }

  public async put(ref: CredentialRef, secret: SecretValue): Promise<void> {
    this.assertWindowsPlatform();
    const targetName = ref.getWindowsTargetName();
    const secretContent = secret.exposeSecret();

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

    await this.executePowerShell(psScript, `${targetName}\n${secretContent}`);
  }

  public async get(ref: CredentialRef): Promise<SecretValue | null> {
    this.assertWindowsPlatform();
    const targetName = ref.getWindowsTargetName();

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

    const output = await this.executePowerShell(psScript, targetName);
    if (!output || output.length === 0) {
      return null;
    }
    return new SecretValue(output);
  }

  public async delete(ref: CredentialRef): Promise<boolean> {
    this.assertWindowsPlatform();
    const targetName = ref.getWindowsTargetName();

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

    const output = await this.executePowerShell(psScript, targetName);
    return output.trim() === 'DELETED';
  }

  public async exists(ref: CredentialRef): Promise<boolean> {
    const cred = await this.get(ref);
    return cred !== null;
  }

  private executePowerShell(script: string, stdinInput: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        reject(new Error(`[WindowsCredentialStore] PowerShell process error: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          const sanitizedError = stderr.replace(/[\r\n]+/g, ' ').trim();
          reject(new Error(`[WindowsCredentialStore] Operation failed (exit code ${code}): ${sanitizedError}`));
        } else {
          resolve(stdout);
        }
      });

      child.stdin.write(stdinInput);
      child.stdin.end();
    });
  }
}
