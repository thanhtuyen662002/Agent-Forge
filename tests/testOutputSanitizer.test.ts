import { describe, expect, it } from 'vitest';
import { redactCredentialLabels } from './testOutputSanitizer';

describe('Vitest credential output sanitizer', () => {
  it('redacts human, JSON, and equals-delimited credential labels', () => {
    const secret = `opaque-${'x'.repeat(32)}`;
    const output = [
      `Plaintext Token:  ${secret}`,
      `{"plaintext_token": "${secret}"}`,
      `plaintext_token=${secret}`,
    ].join('\n');

    const redacted = redactCredentialLabels(output);

    expect(redacted).not.toContain(secret);
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(3);
    expect(redacted).toContain('Plaintext Token:  [REDACTED]');
    expect(redacted).toContain('{"plaintext_token": "[REDACTED]"}');
    expect(redacted).toContain('plaintext_token=[REDACTED]');
  });

  it('leaves unrelated diagnostics unchanged', () => {
    const diagnostic = 'MCP_AUTHORITY_FENCED: request rejected';
    expect(redactCredentialLabels(diagnostic)).toBe(diagnostic);
  });
});
