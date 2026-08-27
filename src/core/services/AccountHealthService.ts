import { Repository } from '../database/repositories';
import { ProviderHealthStatus, ProviderHealthObservationApplicationResult } from '../types/domain';
import { ProviderFailureCategory } from './ExecutionFailureClassifier';

export interface RateLimitedHealthUpdateOptions {
  cooldownDurationMs?: number;
  cooldownUntil?: string | Date;
}

export interface QuotaExhaustedHealthUpdateOptions {
  cooldownUntil?: string | Date | null;
}

export type CooldownFailureCategory =
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'RESOURCE_UNAVAILABLE';

export interface CooldownHealthUpdateOptions {
  cooldownDurationMs?: number;
  cooldownUntil?: string | Date;
  failureCode: CooldownFailureCategory;
}

export interface GeneralFailureHealthUpdateOptions {
  failureCode?: ProviderFailureCategory;
  cooldownUntil?: string | Date | null;
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
   * Always binds last_failure_code to RATE_LIMITED.
   */
  public recordRateLimited(accountId: string, options: RateLimitedHealthUpdateOptions): void {
    this.ensureAccountExists(accountId);
    const cooldownUntil = this.resolveExplicitCooldownUntil(options);

    this.repo.updateProviderAccountHealth(
      accountId,
      'RATE_LIMITED',
      cooldownUntil,
      'RATE_LIMITED'
    );
  }

  /**
   * Records quota exhaustion for the provider account. Does not invent a cooldown
   * unless explicitly supplied by caller policy.
   * Always binds last_failure_code to QUOTA_EXHAUSTED.
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

    this.repo.updateProviderAccountHealth(
      accountId,
      'QUOTA_EXHAUSTED',
      cooldownUntil,
      'QUOTA_EXHAUSTED'
    );
  }

  /**
   * Records authentication failure for the provider account. Sets status to AUTH_ERROR
   * and clears cooldown (authentication errors require owner intervention).
   * Always binds last_failure_code to AUTHENTICATION_FAILURE.
   */
  public recordAuthError(accountId: string): void {
    this.ensureAccountExists(accountId);

    this.repo.updateProviderAccountHealth(
      accountId,
      'AUTH_ERROR',
      null,
      'AUTHENTICATION_FAILURE'
    );
  }

  /**
   * Records an explicit COOLDOWN status with a required future cooldown duration or timestamp,
   * and an explicit temporary CooldownFailureCategory (no invented default reason).
   */
  public recordCooldown(accountId: string, options: CooldownHealthUpdateOptions): void {
    this.ensureAccountExists(accountId);
    if (!options || !options.failureCode) {
      throw new Error(
        'MISSING_COOLDOWN_FAILURE_CODE: Generic recordCooldown requires an explicit failureCode.'
      );
    }
    const cooldownUntil = this.resolveExplicitCooldownUntil(options);

    this.repo.updateProviderAccountHealth(
      accountId,
      'COOLDOWN',
      cooldownUntil,
      options.failureCode
    );
  }

  /**
   * Records a general health degradation (e.g. UNHEALTHY, OFFLINE) with optional failure code.
   * Rejects dedicated semantic health statuses (AVAILABLE, RATE_LIMITED, QUOTA_EXHAUSTED, AUTH_ERROR, COOLDOWN).
   */
  public recordGeneralFailure(
    accountId: string,
    healthStatus: ProviderHealthStatus,
    options?: GeneralFailureHealthUpdateOptions
  ): void {
    this.ensureAccountExists(accountId);
    if (
      healthStatus === 'AVAILABLE' ||
      healthStatus === 'RATE_LIMITED' ||
      healthStatus === 'QUOTA_EXHAUSTED' ||
      healthStatus === 'AUTH_ERROR' ||
      healthStatus === 'COOLDOWN'
    ) {
      throw new Error(
        `INVALID_GENERAL_HEALTH_STATUS: Dedicated health status "${healthStatus}" must be recorded using its dedicated mutation method.`
      );
    }

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

  /**
   * Applies a modern durable provider health observation to the associated ProviderAccount
   * using latest-effective actionable ordering and atomic watermark management.
   * Single semantic writer entrypoint for observation-driven health application.
   */
  public applyDurableObservation(
    authorizationId: string
  ): ProviderHealthObservationApplicationResult {
    if (!authorizationId || typeof authorizationId !== 'string' || authorizationId.trim().length === 0) {
      throw new Error(
        'INVALID_AUTHORIZATION_ID: applyDurableObservation requires a non-empty authorizationId string.'
      );
    }
    return this.repo.applyDurableProviderHealthObservation(authorizationId.trim());
  }
}
