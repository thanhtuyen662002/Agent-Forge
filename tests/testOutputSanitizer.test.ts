import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  captureMcpCliOutput,
  MCP_CLI_REDACTED_TOKEN,
  redactMcpCliOutput,
} from './helpers/mcpCliOutputGuard';
import { redactCredentialLabels } from './testOutputSanitizer';

const require = createRequire(import.meta.url);
const testRunnerSanitizer = require('../scripts/test-output-sanitizer.cjs') as {
  sanitizeCapturedOutput: (result: { stdout?: string; stderr?: string }) => { stdout: string; stderr: string };
};

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

  it('redacts session, submission, and reviewer credentials split across writes', () => {
    const sessionToken = 'S'.repeat(43);
    const submissionToken = `af-sub-${'U'.repeat(43)}`;
    const reviewerToken = `af-rev-12345678-1234-4234-8234-123456789abc`;

    const captured = captureMcpCliOutput(() => {
      process.stdout.write('{"plaintext_token":"');
      process.stdout.write(sessionToken.slice(0, 19));
      process.stdout.write(`${sessionToken.slice(19)}"}\n`);
      process.stdout.write('Plaintext Token: af-sub-');
      process.stdout.write(`${submissionToken.slice('af-sub-'.length, -7)}`);
      process.stdout.write(`${submissionToken.slice(-7)}\n`);
      process.stderr.write('reviewer credential: ');
      process.stderr.write(reviewerToken.slice(0, 17));
      process.stderr.write(`${reviewerToken.slice(17)}\n`);
    });

    expect(captured.stdout).not.toContain(sessionToken);
    expect(captured.stdout).not.toContain(submissionToken);
    expect(captured.stderr).not.toContain(reviewerToken);
    expect(captured.stdout).toContain(MCP_CLI_REDACTED_TOKEN);
    expect(captured.stderr).toContain(MCP_CLI_REDACTED_TOKEN);
  });

  it('sanitizes a failing child process before parent reporter output is forwarded', () => {
    const sessionToken = 'Q'.repeat(43);
    const submissionToken = `af-sub-${'V'.repeat(43)}`;
    const child = spawnSync(process.execPath, [
      '-e',
      `process.stdout.write('AssertionError: Received ${sessionToken}\\nPARENT_FAILURE_CONTEXT\\n'); process.stderr.write('Received: af-sub-${'V'.repeat(43)}\\n'); process.exitCode = 1;`,
    ], { encoding: 'utf8' });
    const safe = testRunnerSanitizer.sanitizeCapturedOutput({
      stdout: String(child.stdout),
      stderr: String(child.stderr),
    });
    const combined = `${safe.stdout}\n${safe.stderr}`;

    expect(child.status).toBe(1);
    expect(combined).not.toContain(sessionToken);
    expect(combined).not.toContain(submissionToken);
    expect(combined).toContain(MCP_CLI_REDACTED_TOKEN);
    expect(combined).toContain('PARENT_FAILURE_CONTEXT');
  });

  it('keeps ordinary diagnostic text unchanged in both streaming boundaries', () => {
    const diagnostic = 'MCP_AUTHORITY_FENCED: request rejected';
    expect(redactMcpCliOutput(diagnostic)).toBe(diagnostic);
    const captured = captureMcpCliOutput(() => process.stdout.write(`${diagnostic}\n`));
    expect(captured.stdout).toBe(`${diagnostic}\n`);
  });
});
