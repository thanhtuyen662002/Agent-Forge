import { describe, it, expect } from 'vitest';
import {
  formatQuotaInput,
  parseQuotaInput,
  parseQuotaValue,
  resolveQuotaSnapshot,
  resolveQuotaUpdate,
} from '../src/ui/views/CapacityView';
import { ProviderResource } from '../src/core/types/domain';

describe('CapacityView Quota Truth & Semantics (TSK-CAPACITY-UNKNOWN-QUOTA)', () => {
  describe('1. Opening the quota editor: formatting input values truthfully', () => {
    it('preserves a real zero as "0" rather than inventing empty or default', () => {
      expect(formatQuotaInput(0)).toBe('0');
      expect(formatQuotaInput('0')).toBe('0');
    });

    it('represents null or undefined quota as empty string rather than inventing 0 or 100', () => {
      expect(formatQuotaInput(null)).toBe('');
      expect(formatQuotaInput(undefined)).toBe('');
    });

    it('preserves positive numeric quota values as exact string representation', () => {
      expect(formatQuotaInput(100)).toBe('100');
      expect(formatQuotaInput(50000)).toBe('50000');
      expect(formatQuotaInput(42.5)).toBe('42.5');
    });

    it('handles string input values and trims whitespace', () => {
      expect(formatQuotaInput('')).toBe('');
      expect(formatQuotaInput('   ')).toBe('');
      expect(formatQuotaInput(' 250 ')).toBe('250');
    });

    it('correctly maps a ProviderResource with UNKNOWN/null quota to empty editor inputs', () => {
      const unknownResource: ProviderResource = {
        id: 'res-gpt4-unknown',
        provider_id: 'openai',
        model_name: 'gpt-4o',
        health_status: 'AVAILABLE',
        capabilities: ['CODING'],
        enabled: true,
        remaining_quota: null,
        total_quota: null,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 0,
        last_health_check: null,
      };

      const remainingInput = formatQuotaInput(unknownResource.remaining_quota);
      const totalInput = formatQuotaInput(unknownResource.total_quota);

      expect(remainingInput).toBe('');
      expect(totalInput).toBe('');
      expect(remainingInput).not.toBe('0');
      expect(totalInput).not.toBe('100');
    });

    it('correctly maps a ProviderResource with real zero quota to "0" editor inputs', () => {
      const exhaustedResource: ProviderResource = {
        id: 'res-claude-zero',
        provider_id: 'anthropic',
        model_name: 'claude-3-5-sonnet',
        health_status: 'LOW_QUOTA',
        capabilities: ['CODING'],
        enabled: true,
        remaining_quota: 0,
        total_quota: 1000,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'MANUAL',
        quota_confidence: 1,
        last_health_check: null,
      };

      const remainingInput = formatQuotaInput(exhaustedResource.remaining_quota);
      const totalInput = formatQuotaInput(exhaustedResource.total_quota);

      expect(remainingInput).toBe('0');
      expect(totalInput).toBe('1000');
    });

    it('correctly maps a ProviderResource with zero total quota preserving 0 rather than 100', () => {
      const zeroTotalResource: ProviderResource = {
        id: 'res-zero-total',
        provider_id: 'custom',
        model_name: 'custom-model',
        health_status: 'AVAILABLE',
        capabilities: ['CODING'],
        enabled: true,
        remaining_quota: 0,
        total_quota: 0,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'MANUAL',
        quota_confidence: 1,
        last_health_check: null,
      };

      const remainingInput = formatQuotaInput(zeroTotalResource.remaining_quota);
      const totalInput = formatQuotaInput(zeroTotalResource.total_quota);

      expect(remainingInput).toBe('0');
      expect(totalInput).toBe('0');
      expect(totalInput).not.toBe('100');
    });
  });

  describe('2. Input parsing: parseQuotaInput / parseQuotaValue', () => {
    it('parses null, undefined, and empty string as null', () => {
      expect(parseQuotaInput(null)).toBeNull();
      expect(parseQuotaInput(undefined)).toBeNull();
      expect(parseQuotaInput('')).toBeNull();
      expect(parseQuotaInput('   ')).toBeNull();
      expect(parseQuotaValue('')).toBeNull();
    });

    it('parses real zero as number 0', () => {
      expect(parseQuotaInput(0)).toBe(0);
      expect(parseQuotaInput('0')).toBe(0);
      expect(parseQuotaInput('  0  ')).toBe(0);
      expect(parseQuotaValue('0')).toBe(0);
    });

    it('parses positive numbers correctly', () => {
      expect(parseQuotaInput(100)).toBe(100);
      expect(parseQuotaInput('100')).toBe(100);
      expect(parseQuotaInput('  4500  ')).toBe(4500);
      expect(parseQuotaValue('100')).toBe(100);
    });

    it('rejects non-numeric strings and non-finite values as null', () => {
      expect(parseQuotaInput('abc')).toBeNull();
      expect(parseQuotaInput('NaN')).toBeNull();
      expect(parseQuotaInput(NaN)).toBeNull();
      expect(parseQuotaInput(Infinity)).toBeNull();
      expect(parseQuotaInput(-Infinity)).toBeNull();
    });
  });

  describe('3. Saving quota snapshots: resolveQuotaSnapshot / resolveQuotaUpdate', () => {
    it('persists remaining=null, total=null, source=UNKNOWN, confidence=0 when saving two empty inputs', () => {
      const result = resolveQuotaSnapshot('', '');
      expect(result).toEqual({
        remaining: null,
        total: null,
        source: 'UNKNOWN',
        confidence: 0,
      });
    });

    it('persists remaining=null, total=null, source=UNKNOWN, confidence=0 when inputs are null/undefined/whitespace', () => {
      expect(resolveQuotaSnapshot(null, null)).toEqual({
        remaining: null,
        total: null,
        source: 'UNKNOWN',
        confidence: 0,
      });

      expect(resolveQuotaSnapshot(undefined, undefined)).toEqual({
        remaining: null,
        total: null,
        source: 'UNKNOWN',
        confidence: 0,
      });

      expect(resolveQuotaSnapshot('   ', '   ')).toEqual({
        remaining: null,
        total: null,
        source: 'UNKNOWN',
        confidence: 0,
      });

      expect(resolveQuotaUpdate('', '')).toEqual({
        remaining: null,
        total: null,
        source: 'UNKNOWN',
        confidence: 0,
      });
    });

    it('persists numeric remaining/total with source=MANUAL and confidence=1 when saving entered numeric values', () => {
      const result = resolveQuotaSnapshot('500', '1000');
      expect(result).toEqual({
        remaining: 500,
        total: 1000,
        source: 'MANUAL',
        confidence: 1,
      });

      const numericResult = resolveQuotaSnapshot(500, 1000);
      expect(numericResult).toEqual({
        remaining: 500,
        total: 1000,
        source: 'MANUAL',
        confidence: 1,
      });
    });

    it('preserves a real zero for remaining as 0 with source=MANUAL and confidence=1', () => {
      const result = resolveQuotaSnapshot('0', '100');
      expect(result).toEqual({
        remaining: 0,
        total: 100,
        source: 'MANUAL',
        confidence: 1,
      });
    });

    it('preserves a real zero for total as 0 with source=MANUAL and confidence=1', () => {
      const result = resolveQuotaSnapshot('0', '0');
      expect(result).toEqual({
        remaining: 0,
        total: 0,
        source: 'MANUAL',
        confidence: 1,
      });
    });

    it('persists source=MANUAL and confidence=1 when only remaining is specified', () => {
      const result = resolveQuotaSnapshot('250', '');
      expect(result).toEqual({
        remaining: 250,
        total: null,
        source: 'MANUAL',
        confidence: 1,
      });
    });

    it('persists source=MANUAL and confidence=1 when only total is specified', () => {
      const result = resolveQuotaSnapshot('', '1000');
      expect(result).toEqual({
        remaining: null,
        total: 1000,
        source: 'MANUAL',
        confidence: 1,
      });
    });

    it('persists source=MANUAL and confidence=1 when remaining is real zero and total is empty', () => {
      const result = resolveQuotaSnapshot('0', '');
      expect(result).toEqual({
        remaining: 0,
        total: null,
        source: 'MANUAL',
        confidence: 1,
      });
    });
  });

  describe('4. End-to-end quota editing truth workflow simulation', () => {
    it('untouched unknown snapshot is saved as UNKNOWN/null rather than MANUAL 0/100', () => {
      // Given an untouched resource with unknown quota:
      const untouchedResource: ProviderResource = {
        id: 'res-untouched-unknown',
        provider_id: 'mock',
        model_name: 'mock-model',
        health_status: 'AVAILABLE',
        capabilities: ['PLANNING'],
        enabled: true,
        remaining_quota: null,
        total_quota: null,
        quota_unit: 'TOKENS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 0,
        last_health_check: null,
      };

      // Editor opens: inputs populated from resource quota
      const editRemaining = formatQuotaInput(untouchedResource.remaining_quota);
      const editTotal = formatQuotaInput(untouchedResource.total_quota);

      expect(editRemaining).toBe('');
      expect(editTotal).toBe('');

      // User saves without entering any values:
      const savedPayload = resolveQuotaSnapshot(editRemaining, editTotal);

      // Must persist as UNKNOWN with null values and confidence 0, NOT MANUAL 0/100
      expect(savedPayload).toEqual({
        remaining: null,
        total: null,
        source: 'UNKNOWN',
        confidence: 0,
      });
      expect(savedPayload.remaining).toBeNull();
      expect(savedPayload.total).toBeNull();
      expect(savedPayload.source).toBe('UNKNOWN');
      expect(savedPayload.confidence).toBe(0);
    });

    it('clearing previous numeric values saves truthful UNKNOWN/null quota', () => {
      // Previously manual resource
      const initialRemaining = '50';
      const initialTotal = '100';

      // User clears both inputs
      const clearedRemaining = '';
      const clearedTotal = '';

      const savedPayload = resolveQuotaSnapshot(clearedRemaining, clearedTotal);
      expect(savedPayload).toEqual({
        remaining: null,
        total: null,
        source: 'UNKNOWN',
        confidence: 0,
      });
    });

    it('entering manual numeric values transitions unknown resource to MANUAL with confidence 1', () => {
      const enteredRemaining = '750';
      const enteredTotal = '1000';

      const savedPayload = resolveQuotaSnapshot(enteredRemaining, enteredTotal);
      expect(savedPayload).toEqual({
        remaining: 750,
        total: 1000,
        source: 'MANUAL',
        confidence: 1,
      });
    });

    it('entering a real zero preserves 0 and assigns MANUAL with confidence 1', () => {
      const enteredRemaining = '0';
      const enteredTotal = '500';

      const savedPayload = resolveQuotaSnapshot(enteredRemaining, enteredTotal);
      expect(savedPayload).toEqual({
        remaining: 0,
        total: 500,
        source: 'MANUAL',
        confidence: 1,
      });
      expect(savedPayload.remaining).toBe(0);
      expect(savedPayload.remaining).not.toBeNull();
    });
  });
});
