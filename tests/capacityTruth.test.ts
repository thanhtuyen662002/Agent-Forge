import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  clampQuotaPercent,
  clampProgressPercent,
  deriveConnectivityState,
  quotaSourceLabel,
  validateQuotaSnapshot,
} from '../src/ui/capacityTruth';

const fixture = vi.hoisted(() => ({ context: {} as Record<string, unknown> }));
vi.mock('../src/ui/context/OrchestratorContext', () => ({ useOrchestrator: () => fixture.context }));
vi.mock('../src/ui/context/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { Sidebar } from '../src/ui/components/Sidebar';
import { QuotaBadge } from '../src/ui/components/QuotaBadge';

function sidebar(overrides: Record<string, unknown>) {
  fixture.context = { activeView: 'dashboard', setActiveView: () => {}, tasks: [], densityMode: 'OWNER', isElectron: true, loading: false, refreshError: null, hasRefreshed: false, ...overrides };
  return renderToStaticMarkup(React.createElement(Sidebar));
}

describe('capacity and capability truth', () => {
  it('renders connectivity from confirmed IPC refresh and exposes preview/error without echoing errors', () => {
    expect(sidebar({})).toContain('sidebar.connecting');
    expect(sidebar({})).not.toContain('sidebar.online');
    expect(sidebar({ hasRefreshed: true })).toContain('sidebar.online');
    expect(sidebar({ isElectron: false, hasRefreshed: true })).toContain('sidebar.browserPreview');
    const failed = sidebar({ hasRefreshed: true, refreshError: 'private-provider-error' });
    expect(failed).toContain('sidebar.error');
    expect(failed).not.toContain('sidebar.online');
    expect(failed).not.toContain('private-provider-error');
  });

  it.each(['MANUAL', 'MEASURED', 'PROVIDER_REPORTED', 'ESTIMATED', 'UNKNOWN'] as const)('renders the explicit %s quota provenance', (source) => {
    const markup = renderToStaticMarkup(React.createElement(QuotaBadge, { remaining: 50, total: 100, unit: 'REQUESTS', source }));
    expect(markup).toContain(`quota.${quotaSourceLabel(source)}`);
    if (source === 'PROVIDER_REPORTED') expect(markup).not.toContain('quota.estimated');
  });

  it('preserves zero totals and refuses a percentage for malformed or unknown quota', () => {
    const render = (remaining: number, total: number, source: any = 'MANUAL') => renderToStaticMarkup(React.createElement(QuotaBadge, { remaining, total, unit: 'REQUESTS', source }));
    expect(render(0, 0)).toContain('0/0');
    for (const markup of [render(-1, 100), render(101, 100), render(Number.NaN, 100), render(50, 100, 'UNRECOGNIZED')]) {
      expect(markup).toContain('quota.unknown');
      expect(markup).not.toContain('%');
    }
  });
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
    expect(deriveConnectivityState({ isElectron: true, refreshError: null })).toBe('CONNECTING');
    expect(deriveConnectivityState({ isElectron: true, refreshError: null, hasRefreshed: true })).toBe('ONLINE');
    expect(deriveConnectivityState({ isElectron: true, loading: true, hasRefreshed: true })).toBe('CONNECTING');
  });
});
