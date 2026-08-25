import { Repository } from '../database/repositories';
import { ProviderHealthStatus } from '../types/domain';

export interface RateLimitedHealthUpdateOptions {
  cooldownDurationMs?: number;
  cooldownUntil?: string | Date;
  failureCode?: string;
}

export interface QuotaExhaustedHealthUpdateOptions {
  cooldownUntil?: string | Date | null;
  failureCode?: string;
}

export interface AuthErrorHealthUpdateOptions {
  failureCode?: string;
}

export interface CooldownHealthUpdateOptions {
  cooldownDurationMs?: number;
  cooldownUntil?: string | Date;
  failureCode?: string;
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
    this.repo.updateProviderAccountHealth(accountId, 'AVAILABLE');
  }

  /**
   * Records rate limiting for the provider account with an explicit future cooldown.
   * Fails closed if no explicit cooldown duration or timestamp is provided (no invented defaults).
   */
  public recordRateLimited(accountId: string, options: RateLimitedHealthUpdateOptions): void {
    const cooldownUntil = this.resolveExplicitCooldownUntil(options);
    const failureCode = options.failureCode ?? 'RATE_LIMITED';

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
    let cooldownUntil: string | null = null;
    if (options?.cooldownUntil) {
      const parsed = new Date(options.cooldownUntil);
      if (isNaN(parsed.getTime())) {
        throw new Error(
          `INVALID_COOLDOWN_TIMESTAMP: Provided cooldownUntil "${options.cooldownUntil}" is not a valid date.`
        );
      }
      cooldownUntil = parsed.toISOString();
    }

    const failureCode = options?.failureCode ?? 'QUOTA_EXHAUSTED';

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
    const failureCode = options?.failureCode ?? 'AUTH_ERROR';

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
    const cooldownUntil = this.resolveExplicitCooldownUntil(options);
    const failureCode = options.failureCode ?? 'COOLDOWN';

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
    options?: { failureCode?: string; cooldownUntil?: string | Date | null }
  ): void {
    let cooldownUntil: string | null = null;
    if (options?.cooldownUntil) {
      const parsed = new Date(options.cooldownUntil);
      if (isNaN(parsed.getTime())) {
        throw new Error(
          `INVALID_COOLDOWN_TIMESTAMP: Provided cooldownUntil "${options.cooldownUntil}" is not a valid date.`
        );
      }
      cooldownUntil = parsed.toISOString();
    }

    this.repo.updateProviderAccountHealth(
      accountId,
      healthStatus,
      cooldownUntil,
      options?.failureCode ?? null
    );
  }

  private resolveExplicitCooldownUntil(
    options: RateLimitedHealthUpdateOptions | CooldownHealthUpdateOptions
  ): string {
    if (options.cooldownUntil !== undefined && options.cooldownUntil !== null) {
      const parsed = new Date(options.cooldownUntil);
      if (isNaN(parsed.getTime())) {
        throw new Error(
          `INVALID_COOLDOWN_TIMESTAMP: Provided cooldownUntil "${options.cooldownUntil}" is not a valid date.`
        );
      }
      return parsed.toISOString();
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
