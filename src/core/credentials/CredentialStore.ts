import { spawn, ChildProcess } from 'child_process';
import { CredentialRef, parseCredentialRef } from './CredentialRef';
import { SecretValue, safeFormatDiagnostic } from './SecretValue';
import { buildTrustedEnvironment, resolveTrustedExecutable } from '../services/ExecutableResolver';

/**
 * Microsoft documented maximum credential blob size for generic credentials (5 * 512 bytes).
 */
export const CRED_MAX_CREDENTIAL_BLOB_SIZE = 2560;

/** Maximum time and output a credential operation may consume. */
export const CREDENTIAL_OPERATION_DEFAULT_TIMEOUT_MS = 15_000;
export const CREDENTIAL_OPERATION_MAX_TIMEOUT_MS = 60_000;
export const CREDENTIAL_OPERATION_DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const CREDENTIAL_OPERATION_MAX_OUTPUT_BYTES = 1024 * 1024;

export type CredentialStoreErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_OPERATION_OPTIONS'
  | 'EXECUTABLE_NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'PROCESS_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'STDIN_WRITE_FAILED';

/** Stable, recoverable error returned by the Windows credential process boundary. */
export class CredentialStoreError extends Error {
  public readonly code: CredentialStoreErrorCode;

  public constructor(code: CredentialStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(`[WindowsCredentialStore] ${code}: ${message}`, options);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

export interface CredentialOperationOptions {
  /** Abort a pending operation and terminate its child process. */
  signal?: AbortSignal;
  /** Positive bounded deadline for the child process. */
  timeoutMs?: number;
  /** Maximum combined stdout/stderr bytes retained from the child. */
  maxOutputBytes?: number;
}

/**
 * Provider-neutral interface for secure local credential storage.
 * Implementations manage persistent or in-memory storage of secret payloads
 * indexed by opaque CredentialRef references.
 */
export interface CredentialStore {
  put(ref: CredentialRef, secret: SecretValue, options?: CredentialOperationOptions): Promise<void>;
  get(ref: CredentialRef, options?: CredentialOperationOptions): Promise<SecretValue | null>;
  delete(ref: CredentialRef, options?: CredentialOperationOptions): Promise<boolean>;
  exists(ref: CredentialRef, options?: CredentialOperationOptions): Promise<boolean>;
}

export interface PowerShellExecutorOptions extends CredentialOperationOptions {
  /** Secret values are used only to redact diagnostics; never logged. */
  knownSecrets?: readonly string[];
}

export type PowerShellExecutor = (
  script: string,
  stdinInput: string,
  options?: PowerShellExecutorOptions
) => Promise<string>;

function validateOperationOptions(options: CredentialOperationOptions | undefined): Required<Pick<CredentialOperationOptions, 'timeoutMs' | 'maxOutputBytes'>> & Pick<CredentialOperationOptions, 'signal'> {
  const timeoutMs = options?.timeoutMs ?? CREDENTIAL_OPERATION_DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options?.maxOutputBytes ?? CREDENTIAL_OPERATION_DEFAULT_MAX_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > CREDENTIAL_OPERATION_MAX_TIMEOUT_MS ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > CREDENTIAL_OPERATION_MAX_OUTPUT_BYTES
  ) {
    throw new CredentialStoreError(
      'INVALID_OPERATION_OPTIONS',
      `timeoutMs must be 1-${CREDENTIAL_OPERATION_MAX_TIMEOUT_MS} and maxOutputBytes must be 1-${CREDENTIAL_OPERATION_MAX_OUTPUT_BYTES}.`
    );
  }
  return { timeoutMs, maxOutputBytes, signal: options?.signal };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

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
 * Strict channel separation:
 * - PowerShell script logic is passed as command argument.
 * - Credential target and secret payloads are passed strictly via standard input.
 * - Fails closed on non-Windows platforms.
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
      throw new CredentialStoreError(
        'UNSUPPORTED_PLATFORM',
        `WindowsCredentialStore is only supported on Windows (win32). Current platform: "${this.#platform}".`
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

  public async put(ref: CredentialRef, secret: SecretValue, options?: CredentialOperationOptions): Promise<void> {
    this.assertWindowsPlatform();
    const operation = validateOperationOptions(options);
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

    await this.#executePowerShell(psScript, `${targetName}\n${secretContent}`, {
      ...operation,
      knownSecrets: [secretContent],
    });
  }

  public async get(ref: CredentialRef, options?: CredentialOperationOptions): Promise<SecretValue | null> {
    this.assertWindowsPlatform();
    const operation = validateOperationOptions(options);
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

    const output = await this.#executePowerShell(psScript, `${targetName}\n`, operation);
    if (!output || output.length === 0) {
      return null;
    }
    return new SecretValue(output);
  }

  public async delete(ref: CredentialRef, options?: CredentialOperationOptions): Promise<boolean> {
    this.assertWindowsPlatform();
    const operation = validateOperationOptions(options);
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

    const output = await this.#executePowerShell(psScript, `${targetName}\n`, operation);
    return output.trim() === 'DELETED';
  }

  /**
   * Least-privilege existence check. Verifies credential presence without
   * reading, copying, or outputting the secret payload.
   */
  public async exists(ref: CredentialRef, options?: CredentialOperationOptions): Promise<boolean> {
    this.assertWindowsPlatform();
    const operation = validateOperationOptions(options);
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

    const output = await this.#executePowerShell(psScript, `${targetName}\n`, operation);
    return output.trim() === 'EXISTS';
  }

  /**
   * Apply the same deadline, cancellation, and output contract to the injected
   * test seam and to the production child-process implementation. The injected
   * seam cannot be force-killed, but its result is still bounded and callers get
   * the same deterministic timeout/cancellation errors.
   */
  #executePowerShell(script: string, stdinInput: string, options: PowerShellExecutorOptions): Promise<string> {
    const execution = this.#executor(script, stdinInput, options);
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => {
        finish(() => reject(new CredentialStoreError('CANCELLED', 'Credential operation was cancelled.')));
      };
      const timer = setTimeout(() => {
        finish(() => reject(new CredentialStoreError('TIMEOUT', `PowerShell exceeded ${options.timeoutMs}ms.`)));
      }, options.timeoutMs);
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      execution.then(
        (output) => {
          if (byteLength(output) > options.maxOutputBytes!) {
            finish(() => reject(new CredentialStoreError('OUTPUT_LIMIT_EXCEEDED', 'PowerShell output exceeded the bounded limit.')));
            return;
          }
          finish(() => resolve(output));
        },
        (error: unknown) => finish(() => reject(error))
      );
    });
  }

  /**
   * Spawns PowerShell asynchronously with piped stdin and bounded output.
   * PowerShell command source is supplied as a command argument (-Command <script>).
   * Credential targets and secret payloads are supplied strictly via stdin.
   */
  #defaultPowerShellExecutor(script: string, stdinInput: string, options: PowerShellExecutorOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const operation = validateOperationOptions(options);
      const executable = resolveTrustedExecutable('powershell', 'powershell', {
        platform: 'win32',
        env: process.env,
      });
      if (!executable) {
        reject(new CredentialStoreError('EXECUTABLE_NOT_FOUND', 'No trusted PowerShell installation was found.'));
        return;
      }

      let child: ChildProcess;
      try {
        child = spawn(
          executable,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false,
            env: buildTrustedEnvironment({ platform: 'win32', env: process.env }),
          }
        );
      } catch (error: unknown) {
        reject(new CredentialStoreError('SPAWN_FAILED', 'PowerShell could not be started.', { cause: error }));
        return;
      }

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        operation.signal?.removeEventListener('abort', onAbort);
      };
      const terminate = (): void => {
        try {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          if (child.exitCode === null && child.signalCode === null) {
            if (!child.kill()) child.kill('SIGKILL');
          }
        } catch {
          // The typed timeout/cancellation result is the authoritative outcome.
        }
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const failAndTerminate = (error: CredentialStoreError): void => {
        terminate();
        finish(() => reject(error));
      };
      const onAbort = (): void => {
        failAndTerminate(new CredentialStoreError('CANCELLED', 'Credential operation was cancelled.'));
      };

      child.stdout?.on('data', (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        outputBytes += chunk.byteLength;
        if (outputBytes > operation.maxOutputBytes) {
          failAndTerminate(new CredentialStoreError('OUTPUT_LIMIT_EXCEEDED', 'PowerShell output exceeded the bounded limit.'));
          return;
        }
        stdout += chunk.toString('utf8');
      });

      child.stderr?.on('data', (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        outputBytes += chunk.byteLength;
        if (outputBytes > operation.maxOutputBytes) {
          failAndTerminate(new CredentialStoreError('OUTPUT_LIMIT_EXCEEDED', 'PowerShell output exceeded the bounded limit.'));
          return;
        }
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        finish(() => reject(new CredentialStoreError('SPAWN_FAILED', 'PowerShell could not be started.', { cause: err })));
      });

      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          const sanitizedStderr = safeFormatDiagnostic(stderr.trim(), options.knownSecrets?.map((secret) => secret) ?? []);
          finish(() =>
            reject(
              new CredentialStoreError(
                'PROCESS_FAILED',
                `PowerShell execution failed (exit code ${code}): ${sanitizedStderr || 'Unknown error'}`
              )
            )
          );
        } else {
          finish(() => resolve(stdout));
        }
      });

      timer = setTimeout(() => {
        failAndTerminate(new CredentialStoreError('TIMEOUT', `PowerShell exceeded ${operation.timeoutMs}ms.`));
      }, operation.timeoutMs);
      if (operation.signal?.aborted) {
        onAbort();
        return;
      }
      operation.signal?.addEventListener('abort', onAbort, { once: true });

      // Write ONLY credential data to stdin
      try {
        if (stdinInput) child.stdin?.write(stdinInput);
        child.stdin?.end();
      } catch (error: unknown) {
        failAndTerminate(new CredentialStoreError('STDIN_WRITE_FAILED', 'PowerShell stdin could not be written.', { cause: error }));
      }
    });
  }
}
