import type { QuotaSource } from '../core/types/domain';

export type QuotaSnapshotInput = {
  remaining: number | null;
  total: number | null;
};

export type ValidQuotaSnapshot = QuotaSnapshotInput & { valid: true };
export type InvalidQuotaSnapshot = {
  valid: false;
  error: 'NON_FINITE' | 'NEGATIVE' | 'REMAINING_EXCEEDS_TOTAL';
};

export type QuotaSnapshotValidation = ValidQuotaSnapshot | InvalidQuotaSnapshot;

/**
 * Validate the numeric invariants shared by the quota editor and dashboard.
 * A missing value means that the provider did not report that side of the
 * quota. When both values are present, remaining capacity cannot exceed the
 * total allocation.
 */
export function validateQuotaSnapshot(input: QuotaSnapshotInput): QuotaSnapshotValidation {
  const values = [input.remaining, input.total];
  if (values.some((value) => value !== null && !Number.isFinite(value))) {
    return { valid: false, error: 'NON_FINITE' };
  }
  if (values.some((value) => value !== null && value < 0)) {
    return { valid: false, error: 'NEGATIVE' };
  }
  if (input.remaining !== null && input.total !== null && input.remaining > input.total) {
    return { valid: false, error: 'REMAINING_EXCEEDS_TOTAL' };
  }
  return { valid: true, remaining: input.remaining, total: input.total };
}

/** Empty input is a deliberate unknown value; malformed input is rejected. */
export function isQuotaInputValid(value: number | string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  const trimmed = value.trim();
  return trimmed === '' || Number.isFinite(Number(trimmed));
}

/** Return a safe display percentage, or null when a percentage is undefined. */
export function clampQuotaPercent(remaining: number | null, total: number | null): number | null {
  const validation = validateQuotaSnapshot({ remaining, total });
  if (!validation.valid || remaining === null || total === null || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((remaining / total) * 100)));
}

/** Keep task progress safe for progress bars and aggregate dashboard KPIs. */
export function clampProgressPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export type ConnectivityState = 'ONLINE' | 'CONNECTING' | 'BROWSER_PREVIEW' | 'ERROR';

export function deriveConnectivityState(input: {
  isElectron: boolean;
  loading?: boolean;
  refreshError?: string | null;
  hasRefreshed?: boolean;
}): ConnectivityState {
  if (!input.isElectron) return 'BROWSER_PREVIEW';
  if (input.refreshError) return 'ERROR';
  if (input.loading || input.hasRefreshed !== true) return 'CONNECTING';
  return 'ONLINE';
}

export type QuotaSourceLabelKey =
  | 'manual'
  | 'measured'
  | 'providerReported'
  | 'estimated'
  | 'unknown';

export function quotaSourceLabel(source: QuotaSource): QuotaSourceLabelKey {
  switch (source) {
    case 'MANUAL':
      return 'manual';
    case 'MEASURED':
      return 'measured';
    case 'PROVIDER_REPORTED':
      return 'providerReported';
    case 'ESTIMATED':
      return 'estimated';
    case 'UNKNOWN':
    default:
      return 'unknown';
  }
}
