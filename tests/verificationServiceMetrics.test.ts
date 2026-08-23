import { describe, it, expect } from 'vitest';
import { parseTestMetrics } from '../src/core/services/VerificationService';

describe('VerificationService - parseTestMetrics', () => {
  it('CASE A: handles successful Node TAP output', () => {
    const stdout = [
      '# tests 9',
      '# suites 2',
      '# pass 9',
      '# fail 0',
      '# cancelled 0',
      '# skipped 0',
      '# todo 0',
    ].join('\n');

    const result = parseTestMetrics(stdout, 0);
    expect(result).toEqual({
      passedCount: 9,
      failedCount: 0,
      skippedCount: 0,
    });
  });

  it('CASE B: handles failing Node TAP with partial successes and non-zero exit code', () => {
    const stdout = [
      '# tests 10',
      '# pass 7',
      '# fail 1',
      '# skipped 2',
    ].join('\n');

    const result = parseTestMetrics(stdout, 1);
    expect(result).toEqual({
      passedCount: 7,
      failedCount: 1,
      skippedCount: 2,
    });
  });

  it('CASE C: handles CRLF formatted Node TAP output', () => {
    const stdout = '# tests 9\r\n# suites 2\r\n# pass 9\r\n# fail 0\r\n# cancelled 0\r\n# skipped 0\r\n# todo 0\r\n';

    const result = parseTestMetrics(stdout, 0);
    expect(result).toEqual({
      passedCount: 9,
      failedCount: 0,
      skippedCount: 0,
    });
  });

  it('CASE D: prioritizes Node TAP summary over unrelated count-first text in logs', () => {
    const stdout = [
      'some diagnostic text: 1 passed previously',
      '# pass 9',
      '# fail 0',
      '# skipped 0',
    ].join('\n');

    const result = parseTestMetrics(stdout, 0);
    expect(result).toEqual({
      passedCount: 9,
      failedCount: 0,
      skippedCount: 0,
    });
  });

  it('CASE E: preserves Vitest count-first format compatibility', () => {
    const stdout = 'Tests  440 passed (440)';

    const result = parseTestMetrics(stdout, 0);
    expect(result).toEqual({
      passedCount: 440,
      failedCount: 0,
      skippedCount: 0,
    });
  });

  it('CASE F: preserves generic count-first failure compatibility', () => {
    const stdout = [
      '8 passed',
      '2 failed',
      '1 skipped',
    ].join('\n');

    const result = parseTestMetrics(stdout, 1);
    expect(result).toEqual({
      passedCount: 8,
      failedCount: 2,
      skippedCount: 1,
    });
  });

  it('CASE G: applies safe fallback for unparseable successful runner (exitCode 0)', () => {
    const stdout = 'All test suites completed successfully with custom format.';

    const result = parseTestMetrics(stdout, 0);
    expect(result).toEqual({
      passedCount: 1,
      failedCount: 0,
      skippedCount: 0,
    });
  });

  it('CASE H: applies safe fallback for unparseable failed runner (exitCode 1)', () => {
    const stdout = 'Fatal error: syntax error in test runner config.';

    const result = parseTestMetrics(stdout, 1);
    expect(result).toEqual({
      passedCount: 0,
      failedCount: 1,
      skippedCount: 0,
    });
  });

  it('CASE I: does not confuse "# tests N" with pass count', () => {
    const stdout = '# tests 9\n';

    const result = parseTestMetrics(stdout, 0);
    expect(result).toEqual({
      passedCount: 1,
      failedCount: 0,
      skippedCount: 0,
    });
  });

  it('handles Node.js spec reporter output with ℹ symbols', () => {
    const stdout = [
      'ℹ tests 9',
      'ℹ suites 2',
      'ℹ pass 9',
      'ℹ fail 0',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
    ].join('\n');

    const result = parseTestMetrics(stdout, 0);
    expect(result).toEqual({
      passedCount: 9,
      failedCount: 0,
      skippedCount: 0,
    });
  });

  it('handles empty or blank output gracefully', () => {
    expect(parseTestMetrics('', 0)).toEqual({
      passedCount: 1,
      failedCount: 0,
      skippedCount: 0,
    });

    expect(parseTestMetrics('', 1)).toEqual({
      passedCount: 0,
      failedCount: 1,
      skippedCount: 0,
    });
  });
});
