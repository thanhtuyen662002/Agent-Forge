import { NativeProfileResolver } from '../credentials/NativeProfileResolver';
import { Repository } from '../database/repositories';
import type { ProviderAccount, ProviderResource } from '../types/domain';
import type { QuotaObservation, QuotaObservationStatus, QuotaWindowObservation } from '../types/quota';
import { AccountHealthService } from './AccountHealthService';
import { CodexQuotaClient, type CodexQuotaReader, type CodexRateLimitResult, type CodexRateLimitWindow } from './CodexQuotaClient';

export interface QuotaPollHandle { unref?(): void }

export interface QuotaPollTimer {
  setInterval(callback: () => void, intervalMs: number): QuotaPollHandle;
  clearInterval(handle: QuotaPollHandle): void;
}

export interface AccountQuotaServiceOptions {
  codexReader?: CodexQuotaReader;
  profileResolver?: Pick<NativeProfileResolver, 'resolve'>;
  timer?: QuotaPollTimer;
  now?: () => string;
  /**
   * When true, an authenticated OK read may initialize a never-used UNKNOWN
   * account to AVAILABLE through AccountHealthService (the single health
   * writer). Off by default: quota polling itself stays observation-only.
   */
  initializeVerifiedAccounts?: boolean;
}

const nodeTimer: QuotaPollTimer = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export const MIN_QUOTA_POLL_INTERVAL_MS = 30_000;
export const MAX_QUOTA_POLL_INTERVAL_MS = 60 * 60_000;

function observeWindow(window: CodexRateLimitWindow): QuotaWindowObservation {
  return {
    usedPercent: window.usedPercent,
    remainingPercent: 100 - window.usedPercent,
    resetsAt: window.resetsAt === null ? null : new Date(window.resetsAt * 1000).toISOString(),
    windowMinutes: window.windowDurationMins,
  };
}

function copyObservation(observation: QuotaObservation): QuotaObservation {
  return { ...observation, resourceIds: [...observation.resourceIds], secondary: observation.secondary ? { ...observation.secondary } : null };
}

/**
 * Usage polling: never authenticates or executes work. Quota observations are
 * kept separate from health; the only health effect is the optional, single-writer
 * initialization of a never-used UNKNOWN account after an authenticated read.
 */
export class AccountQuotaService {
  private readonly reader: CodexQuotaReader;
  private readonly profileResolver: Pick<NativeProfileResolver, 'resolve'> | undefined;
  private readonly timer: QuotaPollTimer;
  private readonly now: () => string;
  private readonly initializeVerifiedAccounts: boolean;
  private readonly latest = new Map<string, QuotaObservation>();
  private readonly accountReads = new Map<string, Promise<QuotaObservation>>();
  // Invalidate only snapshots this instance wrote, while values/bindings match.
  private readonly ownedSnapshots = new Map<string, ProviderResource>();
  private allInFlight: Promise<QuotaObservation[]> | null = null;
  private pollHandle: QuotaPollHandle | null = null;

  constructor(private readonly repo: Repository, options: AccountQuotaServiceOptions = {}) {
    this.reader = options.codexReader ?? new CodexQuotaClient();
    this.profileResolver = options.profileResolver;
    this.timer = options.timer ?? nodeTimer;
    this.now = options.now ?? (() => new Date().toISOString());
    this.initializeVerifiedAccounts = options.initializeVerifiedAccounts === true;
  }

  /** Detached snapshots; callers cannot modify the service's cache. */
  public getLatestObservations(): QuotaObservation[] {
    return [...this.latest.values()].map(copyObservation);
  }

  public refreshAll(): Promise<QuotaObservation[]> {
    if (this.allInFlight) return this.allInFlight.then((observations) => observations.map(copyObservation));
    const operation = this.readAll();
    this.allInFlight = operation;
    void operation.then(() => { this.allInFlight = null; }, () => { this.allInFlight = null; });
    return operation;
  }

  /** Explicit/timer refreshes share an account's pending read. */
  public refreshAccount(accountId: string): Promise<QuotaObservation> {
    const existing = this.accountReads.get(accountId);
    if (existing) return existing.then(copyObservation);
    const operation = this.readAccount(accountId);
    this.accountReads.set(accountId, operation);
    void operation.then(() => { this.accountReads.delete(accountId); }, () => { this.accountReads.delete(accountId); });
    return operation;
  }

  /** Poll immediately, then every 30 seconds to 1 hour (default: 5 minutes). */
  public start(intervalMs = 5 * 60_000): void {
    if (!Number.isInteger(intervalMs) || intervalMs < MIN_QUOTA_POLL_INTERVAL_MS || intervalMs > MAX_QUOTA_POLL_INTERVAL_MS) {
      throw new RangeError('Quota polling interval must be between 30000 and 3600000 milliseconds.');
    }
    if (this.pollHandle) return;
    const poll = () => {
      if (!this.pollHandle || this.allInFlight || this.accountReads.size > 0) return;
      // Explicit calls surface persistence failures. Ticks cannot leave an
      // unhandled rejection or turn a failure into a successful observation.
      void this.refreshAll().catch(() => undefined);
    };
    this.pollHandle = this.timer.setInterval(poll, intervalMs);
    this.pollHandle.unref?.();
    poll();
  }

  /** Stops future ticks; an already-running bounded read may finish. */
  public stop(): void {
    if (!this.pollHandle) return;
    this.timer.clearInterval(this.pollHandle);
    this.pollHandle = null;
  }

  private async readAll(): Promise<QuotaObservation[]> {
    const accounts = this.repo.getAllProviderAccounts().filter((account) => account.enabled);
    const enabledIds = new Set(accounts.map((account) => account.id));
    for (const accountId of this.latest.keys()) {
      if (!enabledIds.has(accountId)) this.latest.delete(accountId);
    }
    const observations: QuotaObservation[] = [];
    // Bound automatic sweeps to one CLI process at a time.
    for (const account of accounts) observations.push(await this.refreshAccount(account.id));
    return observations;
  }

  private unknown(accountId: string, providerId: string, status: QuotaObservationStatus, message: string): QuotaObservation {
    return {
      accountId, providerId, resourceIds: [], status, source: 'UNKNOWN',
      usedPercent: null, remainingPercent: null, resetsAt: null, windowMinutes: null,
      secondary: null, planType: null, observedAt: this.now(), message,
    };
  }

  private async readAccount(accountId: string): Promise<QuotaObservation> {
    const account = this.repo.getProviderAccount(accountId);
    if (!account || !account.enabled) {
      const observation = this.unknown(accountId, account?.provider_id ?? '', 'UNAVAILABLE', 'Account is missing or disabled.');
      this.latest.delete(accountId);
      return observation;
    }
    let observation: QuotaObservation;
    if (account.provider_id !== 'prov-codex-cli') {
      observation = this.unknown(accountId, account.provider_id, 'UNSUPPORTED', 'This provider has no supported quota telemetry reader.');
    } else {
      let result: CodexRateLimitResult;
      try {
        if (account.auth_mode !== 'NATIVE_PROFILE' || !account.profile_ref) {
          result = { status: 'UNAVAILABLE', message: 'An isolated native Codex profile is required.' };
        } else {
          // A missing native profile root is unavailable telemetry, not a
          // service-startup failure (including for unsupported providers).
          const resolution = (this.profileResolver ?? new NativeProfileResolver()).resolve(account.profile_ref);
          result = resolution.provider === 'codex'
            ? await this.reader.readRateLimits(resolution.profileDirectory)
            : { status: 'UNAVAILABLE', message: 'Account profile does not identify Codex.' };
        }
      } catch {
        result = { status: 'UNAVAILABLE', message: 'Codex quota telemetry is unavailable.' };
      }
      observation = result.status === 'OK' ? {
        accountId, providerId: account.provider_id, resourceIds: [], status: 'OK', source: 'PROVIDER_REPORTED',
        ...observeWindow(result.primary),
        secondary: result.secondary ? observeWindow(result.secondary) : null,
        planType: result.planType, observedAt: this.now(), message: null,
      } : this.unknown(
        accountId, account.provider_id,
        result.status === 'MALFORMED' ? 'ERROR' : result.status === 'TIMEOUT' ? 'UNAVAILABLE' : result.status,
        result.message,
      );
    }

    const current = this.repo.getProviderAccount(accountId);
    if (!this.sameAccountBinding(account, current)) {
      observation = this.unknown(accountId, account.provider_id, 'UNAVAILABLE', 'Account binding changed during quota refresh.');
      this.latest.delete(accountId);
      return observation;
    }
    if (this.initializeVerifiedAccounts && observation.status === 'OK' && account.profile_ref) {
      AccountHealthService.create(this.repo).initializeVerifiedAccount(accountId, {
        providerId: account.provider_id,
        profileRef: account.profile_ref,
      });
    }
    const resources = this.repo.getProviderResourcesByAccount(accountId);
    observation.resourceIds = resources.map((resource) => resource.id);
    for (const resource of resources) this.persist(resource, observation);
    this.latest.set(accountId, copyObservation(observation));
    return observation;
  }

  private sameAccountBinding(before: ProviderAccount, after: ProviderAccount | null): boolean {
    return !!after && after.enabled && before.provider_id === after.provider_id &&
      before.auth_mode === after.auth_mode && before.profile_ref === after.profile_ref;
  }

  private persist(resource: ProviderResource, observation: QuotaObservation): void {
    if (resource.quota_source === 'MANUAL') {
      this.ownedSnapshots.delete(resource.id);
      return;
    }
    if (observation.status === 'OK') {
      this.repo.updateProviderResourceQuotaObservation(resource.id, {
        remaining: observation.remainingPercent, total: 100, unit: 'PERCENT', resetAt: observation.resetsAt,
        source: 'PROVIDER_REPORTED', confidence: 1,
      });
      this.ownedSnapshots.set(resource.id, {
        ...resource, remaining_quota: observation.remainingPercent, total_quota: 100, quota_unit: 'PERCENT',
        quota_reset_at: observation.resetsAt, quota_source: 'PROVIDER_REPORTED', quota_confidence: 1,
      });
      return;
    }
    const previous = this.ownedSnapshots.get(resource.id);
    this.ownedSnapshots.delete(resource.id);
    if (previous && resource.quota_source === 'PROVIDER_REPORTED' &&
        resource.provider_account_id === previous.provider_account_id &&
        resource.remaining_quota === previous.remaining_quota && resource.total_quota === previous.total_quota &&
        resource.quota_unit === previous.quota_unit && resource.quota_reset_at === previous.quota_reset_at &&
        resource.quota_confidence === previous.quota_confidence) {
      this.repo.updateProviderResourceQuotaObservation(resource.id, {
        remaining: null, total: null, unit: 'PERCENT', resetAt: null, source: 'UNKNOWN', confidence: 0,
      });
    }
  }
}
