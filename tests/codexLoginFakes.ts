import { vi } from 'vitest';
import type { CodexQuotaSpawner, CodexQuotaSpawnOptions } from '../src/core/services/CodexQuotaClient';
import { FakeCodexProcess } from './quotaFakes';

export const DEVICE_LOGIN = {
  type: 'chatgptDeviceCode', loginId: 'fake-login-id', userCode: 'ABCD-1234',
  verificationUrl: 'https://auth.openai.com/codex/device',
};

export class FakeCodexLoginSpawner implements CodexQuotaSpawner {
  readonly children: FakeCodexProcess[] = [];
  result: unknown = DEVICE_LOGIN;
  onInitialize: ((child: FakeCodexProcess, options: CodexQuotaSpawnOptions) => void) | null = null;
  onStart: ((child: FakeCodexProcess) => void) | null = null;
  readonly spawn = vi.fn((_executable: string, _args: string[], options: CodexQuotaSpawnOptions) => {
    const child = new FakeCodexProcess((message, process) => {
      if (message.method === 'initialize') {
        if (this.onInitialize) this.onInitialize(process, options);
        else process.reply({ id: 1, result: {
          userAgent: 'fake-codex', codexHome: options.env.CODEX_HOME,
          platformFamily: 'windows', platformOs: 'windows',
        } });
      } else if (message.method === 'account/login/start') {
        if (this.onStart) this.onStart(process);
        else process.reply({ id: 2, result: this.result });
      }
    });
    this.children.push(child);
    return child;
  });
}

export function completeLogin(child: FakeCodexProcess, success = true, loginId = DEVICE_LOGIN.loginId): void {
  child.reply({ method: 'account/login/completed', params: {
    loginId, success, error: success ? null : 'synthetic-private-provider-detail', extension: 'discard-me',
  } });
}
