import { describe, expect, it } from 'vitest';
import {
  clampQuotaPercent,
  clampProgressPercent,
  deriveConnectivityState,
  quotaSourceLabel,
  validateQuotaSnapshot,
} from '../src/ui/capacityTruth';

describe('capacity and capability truth', () => {
  it.each([
    [{ remaining: 25, total: 100 }, { valid: true, remaining: 25, total: 100 }],
    [{ remaining: 0, total: 0 }, { valid: true, remaining: 0, total: 0 }],
    [{ remaining: null, total: null }, { valid: true, remaining: null, total: null }],
  ])('accepts valid quota snapshots', (input, expected) => {
    expect(validateQuotaSnapshot(input)).toEqual(expected);
  });

  it.each([
    { remaining: -1, total: 100 },
    { remaining: 101, total: 100 },
    { remaining: Number.NaN, total: 100 },
    { remaining: Number.POSITIVE_INFINITY, total: 100 },
    { remaining: 1, total: Number.POSITIVE_INFINITY },
  ])('rejects invalid quota snapshot %#', (input) => {
    expect(validateQuotaSnapshot(input).valid).toBe(false);
  });

  it('clamps only finite percentages', () => {
    expect(clampQuotaPercent(50, 100)).toBe(50);
    expect(clampQuotaPercent(-1, 100)).toBeNull();
    expect(clampQuotaPercent(120, 100)).toBeNull();
    expect(clampQuotaPercent(1, 0)).toBeNull();
    expect(clampQuotaPercent(Number.NaN, 100)).toBeNull();
  });

  it('clamps invalid task progress deterministically', () => {
    expect(clampProgressPercent(42.4)).toBe(42);
    expect(clampProgressPercent(-10)).toBe(0);
    expect(clampProgressPercent(150)).toBe(100);
    expect(clampProgressPercent(Number.NaN)).toBe(0);
    expect(clampProgressPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('preserves every quota source label', () => {
    expect(quotaSourceLabel('MANUAL')).toBe('manual');
    expect(quotaSourceLabel('MEASURED')).toBe('measured');
    expect(quotaSourceLabel('PROVIDER_REPORTED')).toBe('providerReported');
    expect(quotaSourceLabel('ESTIMATED')).toBe('estimated');
    expect(quotaSourceLabel('UNKNOWN')).toBe('unknown');
  });

  it('derives offline/error states before online', () => {
    expect(deriveConnectivityState({ isElectron: false, refreshError: null })).toBe('BROWSER_PREVIEW');
    expect(deriveConnectivityState({ isElectron: true, refreshError: 'offline' })).toBe('ERROR');
    expect(deriveConnectivityState({ isElectron: true, refreshError: null })).toBe('ONLINE');
  });
});
