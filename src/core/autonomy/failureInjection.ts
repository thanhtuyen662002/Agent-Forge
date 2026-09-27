import crypto from 'crypto';

export const FAILURE_INJECTION_IDS = [
  'FI-01', 'FI-02', 'FI-03', 'FI-04', 'FI-05',
  'FI-06', 'FI-07', 'FI-08', 'FI-09', 'FI-10',
  'FI-11', 'FI-12', 'FI-13', 'FI-14', 'FI-15',
] as const;
export type FailureInjectionId = (typeof FAILURE_INJECTION_IDS)[number];

export const FAILURE_INJECTION_DESCRIPTIONS: Readonly<Record<FailureInjectionId, string>> = Object.freeze({
  'FI-01': 'account exhaustion',
  'FI-02': 'provider outage after dispatch',
  'FI-03': 'coder/reviewer separation violation',
  'FI-04': 'malformed claim',
  'FI-05': 'worker process termination',
  'FI-06': 'cancellation with unresolved termination',
  'FI-07': 'worktree precondition conflict',
  'FI-08': 'ownership epoch drift',
  'FI-09': 'handoff interruption',
  'FI-10': 'verification failure',
  'FI-11': 'reviewer projection hash drift',
  'FI-12': 'token expiry or revocation',
  'FI-13': 'restart recovery',
  'FI-14': 'duplicate submission',
  'FI-15': 'evidence store inconsistency',
});

export interface FailureInjectionRule {
  triggerOnInvocation: number;
  code?: string;
  message?: string;
}

export interface FailureInjectionEvent {
  id: FailureInjectionId;
  invocation: number;
  injected: boolean;
  code: string | null;
  eventHash: string;
}

export class DeterministicFailureInjectionError extends Error {
  constructor(
    public readonly id: FailureInjectionId,
    public readonly code: string,
    message: string
  ) {
    super(`FAILURE_INJECTED:${id}:${code}: ${message}`);
    this.name = 'DeterministicFailureInjectionError';
  }
}

function isFailureInjectionId(value: string): value is FailureInjectionId {
  return (FAILURE_INJECTION_IDS as readonly string[]).includes(value);
}

function validateRule(id: FailureInjectionId, rule: FailureInjectionRule): FailureInjectionRule {
  if (!Number.isSafeInteger(rule.triggerOnInvocation) || rule.triggerOnInvocation < 1) {
    throw new Error(`FAILURE_INJECTION_INVALID_RULE:${id}: triggerOnInvocation must be a positive safe integer`);
  }
  const code = rule.code ?? `INJECTED_${id.replace('-', '_')}`;
  if (!/^[A-Z][A-Z0-9_:-]{0,63}$/.test(code)) {
    throw new Error(`FAILURE_INJECTION_INVALID_RULE:${id}: code must be an uppercase bounded identifier`);
  }
  const message = rule.message ?? FAILURE_INJECTION_DESCRIPTIONS[id];
  if (typeof message !== 'string' || message.length === 0 || message.length > 512 || /[\u0000\r\n]/.test(message)) {
    throw new Error(`FAILURE_INJECTION_INVALID_RULE:${id}: message is invalid`);
  }
  return { triggerOnInvocation: rule.triggerOnInvocation, code, message };
}

/**
 * A deterministic, side-effect-free fault controller. Production callers can
 * inject it through an explicit test/rehearsal seam; it never reads credentials,
 * invokes a process, or mutates SQLite by itself.
 */
export class DeterministicFailureInjectionHarness {
  private readonly rules = new Map<FailureInjectionId, FailureInjectionRule>();
  private readonly invocationCounts = new Map<FailureInjectionId, number>();
  private readonly events: FailureInjectionEvent[] = [];

  constructor(rules: Partial<Record<FailureInjectionId, FailureInjectionRule>> = {}) {
    for (const [rawId, rawRule] of Object.entries(rules)) {
      if (!isFailureInjectionId(rawId)) throw new Error(`FAILURE_INJECTION_UNKNOWN_ID:${rawId}`);
      this.rules.set(rawId, validateRule(rawId, rawRule!));
    }
  }

  public checkpoint(id: FailureInjectionId): void {
    if (!isFailureInjectionId(id)) throw new Error(`FAILURE_INJECTION_UNKNOWN_ID:${String(id)}`);
    const invocation = (this.invocationCounts.get(id) ?? 0) + 1;
    this.invocationCounts.set(id, invocation);
    const rule = this.rules.get(id);
    const injected = Boolean(rule && rule.triggerOnInvocation === invocation);
    const code = injected ? rule!.code! : null;
    const eventHash = crypto.createHash('sha256')
      .update(`${id}|${invocation}|${injected ? code : 'NOOP'}`, 'utf8')
      .digest('hex');
    this.events.push({ id, invocation, injected, code, eventHash });
    if (injected) throw new DeterministicFailureInjectionError(id, rule!.code!, rule!.message!);
  }

  public execute<T>(id: FailureInjectionId, operation: () => T): T {
    this.checkpoint(id);
    return operation();
  }

  public snapshot(): readonly FailureInjectionEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  public snapshotHash(): string {
    return crypto.createHash('sha256').update(JSON.stringify(this.events), 'utf8').digest('hex');
  }

  public invocationCount(id: FailureInjectionId): number {
    return this.invocationCounts.get(id) ?? 0;
  }
}
