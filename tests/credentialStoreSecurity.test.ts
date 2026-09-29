import { describe, expect, it } from 'vitest';
import {
  CredentialStoreError,
  WindowsCredentialStore,
} from '../src/core/credentials/CredentialStore';
import { parseCredentialRef } from '../src/core/credentials/CredentialRef';
import { SecretValue } from '../src/core/credentials/SecretValue';
import {
  buildTrustedEnvironment,
  isProtectedExecutableName,
  resolveTrustedExecutable,
} from '../src/core/services/ExecutableResolver';

const REF = parseCredentialRef('wincred://agentforge/security/credential-store');

describe('CredentialStore PowerShell security boundary', () => {
  it('resolves PowerShell only from trusted Windows installation roots', () => {
    const trusted = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const attacker = 'C:\\Users\\owner\\AppData\\Local\\Temp\\powershell.exe';
    const files = new Set([trusted]);
    const options = {
      platform: 'win32' as const,
      env: {
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        Path: 'C:\\Users\\owner\\AppData\\Local\\Temp',
      },
      fileExists: (candidate: string) => files.has(candidate),
      fileIsRegularFile: (candidate: string) => files.has(candidate),
    };

    expect(resolveTrustedExecutable('powershell.exe', 'powershell', options)).toBe(trusted);
    expect(resolveTrustedExecutable(attacker, 'powershell', options)).toBeNull();
    expect(isProtectedExecutableName('powershell.exe')).toBe('powershell');
  });

  it('builds a minimal trusted environment without caller PATH or secret overrides', () => {
    const env = buildTrustedEnvironment({
      platform: 'win32',
      env: {
        SystemRoot: 'C:\\Windows',
        Path: 'C:\\Users\\owner\\AppData\\Local\\Temp',
        PATH: 'C:\\Users\\owner\\AppData\\Local\\Temp',
        API_TOKEN: 'must-not-cross-boundary',
      },
      allowedEnvKeys: ['PATH', 'API_TOKEN'],
      fileExists: (candidate: string) => candidate.toLowerCase().endsWith('\\cmd.exe'),
      fileIsRegularFile: (candidate: string) => candidate.toLowerCase().endsWith('\\cmd.exe'),
    });

    expect(env.PATH?.toLowerCase()).not.toContain('users\\owner\\appdata\\local\\temp');
    expect(env.COMSPEC?.toLowerCase()).not.toContain('users\\owner\\appdata');
    expect(env.API_TOKEN).toBe('must-not-cross-boundary');
    expect(env.SystemRoot).toBe('C:\\Windows');
  });

  it('keeps credential data on stdin and supports concurrent mocked round trips', async () => {
    const observed: Array<{ script: string; input: string }> = [];
    const executor = async (script: string, input: string): Promise<string> => {
      observed.push({ script, input });
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (script.includes('CredWrite')) return 'OK\n';
      if (script.includes('WinCredProber')) return 'EXISTS\n';
      if (script.includes('CredReadW')) return 'retrieved-secret';
      if (script.includes('CredDeleteW')) return 'DELETED\n';
      return '';
    };
    const store = new WindowsCredentialStore('win32', executor);
    const secret = new SecretValue('super-secret-value');

    await Promise.all([store.put(REF, secret), store.exists(REF), store.get(REF), store.delete(REF)]);

    const put = observed.find((entry) => entry.script.includes('CredWrite'))!;
    expect(put.input).toBe('AgentForge:security:credential-store\nsuper-secret-value');
    expect(put.script).not.toContain('super-secret-value');
    expect(observed.filter((entry) => entry.input.includes('super-secret-value'))).toHaveLength(1);
  });

  it('returns typed bounded timeout, cancellation, output, and option errors', async () => {
    const never = new WindowsCredentialStore('win32', () => new Promise<string>(() => undefined));
    await expect(never.get(REF, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    const controller = new AbortController();
    const pending = new WindowsCredentialStore('win32', () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 100)));
    const cancelled = pending.get(REF, { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });

    const noisy = new WindowsCredentialStore('win32', async () => 'x'.repeat(100));
    await expect(noisy.get(REF, { maxOutputBytes: 10 })).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT_EXCEEDED',
    });
    await expect(noisy.get(REF, { timeoutMs: 0 })).rejects.toMatchObject({
      code: 'INVALID_OPERATION_OPTIONS',
    });
  });

  it('redacts a secret from injected process diagnostics and fails with a typed error', async () => {
    const secret = 'do-not-leak-this-secret';
    const store = new WindowsCredentialStore('win32', async () => {
      throw new Error(`PowerShell stderr accidentally echoed ${secret}`);
    });

    try {
      await store.put(REF, new SecretValue(secret));
      throw new Error('expected put to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialStoreError);
      expect((error as Error).message).not.toContain(secret);
      expect((error as CredentialStoreError).code).toBe('PROCESS_FAILED');
    }
  });

  it('fails closed on unsupported platforms before invoking PowerShell', async () => {
    let invoked = false;
    const store = new WindowsCredentialStore('linux', async () => {
      invoked = true;
      return 'OK';
    });

    await expect(store.exists(REF)).rejects.toMatchObject({
      code: 'UNSUPPORTED_PLATFORM',
    });
    expect(invoked).toBe(false);
  });
});
