import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { vi } from 'vitest';
import type { CodexQuotaProcess, CodexQuotaSpawner, CodexQuotaSpawnOptions } from '../src/core/services/CodexQuotaClient';

export const QUOTA_RESULT = {
  rateLimits: {
    primary: { usedPercent: 37, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    secondary: { usedPercent: 12, resetsAt: 1_800_600_000, windowDurationMins: 10_080 },
    planType: 'plus', rateLimitReachedType: null,
    credits: { hasCredits: true, unlimited: false, balance: 'provider-only-metadata' },
  },
};

export interface FakeRpcMessage { id?: number; method: string; params?: unknown }

export class FakeCodexProcess extends EventEmitter implements CodexQuotaProcess {
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  readonly messages: FakeRpcMessage[] = [];
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);

  constructor(onMessage: (message: FakeRpcMessage, child: FakeCodexProcess) => void) {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      const message = JSON.parse(chunk.toString()) as FakeRpcMessage;
      this.messages.push(message);
      done();
      queueMicrotask(() => onMessage(message, this));
    } });
  }

  reply(value: unknown): void { this.stdout.write(`${JSON.stringify(value)}\n`); }
}

export class FakeCodexSpawner implements CodexQuotaSpawner {
  readonly children: FakeCodexProcess[] = [];
  result: unknown = QUOTA_RESULT;
  onRateRead: ((child: FakeCodexProcess) => void) | null = null;
  onInitialize: ((child: FakeCodexProcess) => void) | null = null;
  readonly spawn = vi.fn((_executable: string, _args: string[], options: CodexQuotaSpawnOptions) => {
    const child = new FakeCodexProcess((message, process) => {
      if (message.method === 'initialize') {
        if (this.onInitialize) this.onInitialize(process);
        else process.reply({ id: 1, result: {
          userAgent: 'fake-codex', codexHome: options.env.CODEX_HOME,
          platformFamily: 'windows', platformOs: 'windows',
        } });
      } else if (message.method === 'account/rateLimits/read') {
        if (this.onRateRead) this.onRateRead(process);
        else process.reply({ id: 2, result: this.result });
      }
    });
    this.children.push(child);
    return child;
  });
}
