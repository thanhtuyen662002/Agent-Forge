import { Repository } from '../database/repositories';
import { ProviderHealthStatus } from '../types/domain';
import { ProviderFailureCategory } from './ExecutionFailureClassifier';

export interface RateLimitedHealthUpdateOptions {
  cooldownDurationMs?: number;
  cooldownUntil?: string | Date;
  failureCode?: ProviderFailureCategory;
}

export interface QuotaExhaustedHealthUpdateOptions {
  cooldownUntil?: string | Date | null;
  failureCode?: ProviderFailureCategory;
}

export interface AuthErrorHealthUpdateOptions {
  failureCode?: ProviderFailureCategory;
}

export interface CooldownHealthUpdateOptions {
  cooldownDurationMs?: number;
  cooldownUntil?: string | Date;
  failureCode?: ProviderFailureCategory;
}

export class AccountHealthService {
  private readonly now: () => Date;

  constructor(
    private readonly repo: Repository,
    clock?: () => Date
  ) {
    this.now = clock ?? (() => new Date());
  }

  /**
   * Records a successful execution for the provider account, restoring
   * its health status to AVAILABLE and clearing any active cooldown.
   */
  public recordSuccess(accountId: string): void {
    this.ensureAccountExists(accountId);
    this.repo.updateProviderAccountHealth(accountId, 'AVAILABLE');
  }

  /**
   * Records rate limiting for the provider account with an explicit future cooldown.
   * Fails closed if no explicit cooldown duration or timestamp is provided (no invented defaults).
   */
  public recordRateLimited(accountId: string, options: RateLimitedHealthUpdateOptions): void {
    this.ensureAccountExists(accountId);
    const cooldownUntil = this.resolveExplicitCooldownUntil(options);
    const failureCode: ProviderFailureCategory = options.failureCode ?? 'RATE_LIMITED';

    this.repo.updateProviderAccountHealth(
      accountId,
      'RATE_LIMITED',
      cooldownUntil,
      failureCode
    );
  }

  /**
   * Records quota exhaustion for the provider account. Does not invent a cooldown
   * unless explicitly supplied by caller policy.
   */
  public recordQuotaExhausted(
    accountId: string,
    options?: QuotaExhaustedHealthUpdateOptions
  ): void {
    this.ensureAccountExists(accountId);
    let cooldownUntil: string | null = null;
    if (options?.cooldownUntil) {
      cooldownUntil = this.parseAndValidateFutureCooldown(options.cooldownUntil);
    }

    const failureCode: ProviderFailureCategory = options?.failureCode ?? 'QUOTA_EXHAUSTED';

    this.repo.updateProviderAccountHealth(
      accountId,
      'QUOTA_EXHAUSTED',
      cooldownUntil,
      failureCode
    );
  }

  /**
   * Records authentication failure for the provider account. Sets status to AUTH_ERROR
   * and clears cooldown (authentication errors require owner intervention).
   */
  public recordAuthError(accountId: string, options?: AuthErrorHealthUpdateOptions): void {
    this.ensureAccountExists(accountId);
    const failureCode: ProviderFailureCategory = options?.failureCode ?? 'AUTHENTICATION_FAILURE';

    this.repo.updateProviderAccountHealth(
      accountId,
      'AUTH_ERROR',
      null,
      failureCode
    );
  }

  /**
   * Records an explicit COOLDOWN status with a required future cooldown duration or timestamp.
   */
  public recordCooldown(accountId: string, options: CooldownHealthUpdateOptions): void {
    this.ensureAccountExists(accountId);
    const cooldownUntil = this.resolveExplicitCooldownUntil(options);
    const failureCode: ProviderFailureCategory = options.failureCode ?? 'RATE_LIMITED';

    this.repo.updateProviderAccountHealth(
      accountId,
      'COOLDOWN',
      cooldownUntil,
      failureCode
    );
  }

  /**
   * Records a general health degradation (e.g. UNHEALTHY, OFFLINE) with optional failure code.
   */
  public recordGeneralFailure(
    accountId: string,
    healthStatus: ProviderHealthStatus,
    options?: { failureCode?: ProviderFailureCategory; cooldownUntil?: string | Date | null }
  ): void {
    this.ensureAccountExists(accountId);
    let cooldownUntil: string | null = null;
    if (options?.cooldownUntil) {
      cooldownUntil = this.parseAndValidateFutureCooldown(options.cooldownUntil);
    }

    this.repo.updateProviderAccountHealth(
      accountId,
      healthStatus,
      cooldownUntil,
      options?.failureCode ?? null
    );
  }

  private ensureAccountExists(accountId: string): void {
    const account = this.repo.getProviderAccount(accountId);
    if (!account) {
      throw new Error(`PROVIDER_ACCOUNT_NOT_FOUND: ProviderAccount "${accountId}" not found.`);
    }
  }

  private parseAndValidateFutureCooldown(cooldownUntil: string | Date): string {
    const parsed = new Date(cooldownUntil);
    if (isNaN(parsed.getTime())) {
      throw new Error(
        `INVALID_COOLDOWN_TIMESTAMP: Provided cooldownUntil "${cooldownUntil}" is not a valid date.`
      );
    }
    const targetMs = parsed.getTime();
    const currentMs = this.now().getTime();
    if (targetMs <= currentMs) {
      throw new Error(
        `INVALID_COOLDOWN_TIMESTAMP: Cooldown timestamp must be strictly in the future relative to current time (${this.now().toISOString()}).`
      );
    }
    return parsed.toISOString();
  }

  private resolveExplicitCooldownUntil(
    options: RateLimitedHealthUpdateOptions | CooldownHealthUpdateOptions
  ): string {
    if (options.cooldownUntil !== undefined && options.cooldownUntil !== null) {
      return this.parseAndValidateFutureCooldown(options.cooldownUntil);
    }

    if (
      options.cooldownDurationMs !== undefined &&
      typeof options.cooldownDurationMs === 'number' &&
      Number.isFinite(options.cooldownDurationMs) &&
      options.cooldownDurationMs > 0
    ) {
      const nowMs = this.now().getTime();
      return new Date(nowMs + options.cooldownDurationMs).toISOString();
    }

    throw new Error(
      'MISSING_EXPLICIT_COOLDOWN: Cooldown mutation requires an explicit positive cooldownDurationMs or valid cooldownUntil timestamp. No default cooldown is assumed.'
    );
  }
}
