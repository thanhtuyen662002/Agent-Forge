import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  captureMcpCliOutput,
  installMcpCliOutputGuard,
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

  it('protects real Vitest failure summaries while direct Vitest is a negative control', () => {
    const sessionToken = 'Q'.repeat(43);
    const submissionToken = `af-sub-${'V'.repeat(43)}`;
    const fixtureRelative = `tests/.tmp-output-sanitizer-${process.pid}-${Date.now()}.test.ts`;
    const fixturePath = resolve(process.cwd(), fixtureRelative);
    const vitestEntry = resolve(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
    const protectedRunner = resolve(process.cwd(), 'scripts', 'run-test-suite.cjs');
    const fixtureSource = [
      "import { expect, test } from 'vitest';",
      "test('PARENT_FAILURE_CONTEXT', () => {",
      `  const actual = { session: '--${sessionToken}', submission: '--${submissionToken}' };`,
      "  process.stderr.write('PARENT_STDERR_CONTEXT\\n');",
      "  expect(actual).toEqual({ session: 'safe-session', submission: 'safe-submission' });",
      "});",
      "",
    ].join('\n');

    writeFileSync(fixturePath, fixtureSource, 'utf8');
    try {
      const direct = spawnSync(process.execPath, [
        vitestEntry,
        'run',
        fixtureRelative,
        '--maxWorkers=1',
        '--reporter=dot',
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env },
      });
      const protectedRun = spawnSync(process.execPath, [
        protectedRunner,
        '--reporter=dot',
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, AGENTFORGE_TEST_FILES: fixtureRelative },
      });

      const directCombined = `${String(direct.stdout)}\n${String(direct.stderr)}`;
      const protectedCombined = `${String(protectedRun.stdout)}\n${String(protectedRun.stderr)}`;
      const evidence = {
        directFailed: direct.status !== 0,
        protectedFailed: protectedRun.status !== 0,
        directLeaksSession: directCombined.includes(sessionToken),
        directLeaksSubmission: directCombined.includes(submissionToken),
        protectedLeaksSession: protectedCombined.includes(sessionToken),
        protectedLeaksSubmission: protectedCombined.includes(submissionToken),
        protectedHasRedaction: protectedCombined.includes(MCP_CLI_REDACTED_TOKEN),
        protectedHasFailureContext: protectedCombined.includes('PARENT_FAILURE_CONTEXT'),
        protectedHasStderrContext: protectedCombined.includes('PARENT_STDERR_CONTEXT'),
      };

      // Keep failure output boolean-only so a regression cannot echo a synthetic
      // credential into the parent suite's own reporter.
      expect(evidence).toEqual({
        directFailed: true,
        protectedFailed: true,
        directLeaksSession: true,
        directLeaksSubmission: true,
        protectedLeaksSession: false,
        protectedLeaksSubmission: false,
        protectedHasRedaction: true,
        protectedHasFailureContext: true,
        protectedHasStderrContext: true,
      });
    } finally {
      unlinkSync(fixturePath);
    }
  });


  it('redacts URL-safe framed credentials in both worker and parent sanitizers', () => {
    const sessionToken = 'R'.repeat(43);
    const submissionToken = `af-sub-${'W'.repeat(43)}`;
    const reviewerToken = 'af-rev-12345678-1234-4234-8234-123456789abc';
    const framed = [
      `--${sessionToken}`,
      `prefix_${submissionToken}_suffix`,
      `-${reviewerToken}_`,
    ].join('\n');

    const workerOutput = redactMcpCliOutput(framed);
    const parentOutput = testRunnerSanitizer.sanitizeCapturedOutput({ stdout: framed }).stdout;
    const evidence = {
      workerLeaks: [
        workerOutput.includes(sessionToken),
        workerOutput.includes(submissionToken),
        workerOutput.includes(reviewerToken),
      ],
      parentLeaks: [
        parentOutput.includes(sessionToken),
        parentOutput.includes(submissionToken),
        parentOutput.includes(reviewerToken),
      ],
      workerHasMarker: workerOutput.includes(MCP_CLI_REDACTED_TOKEN),
      parentHasMarker: parentOutput.includes(MCP_CLI_REDACTED_TOKEN),
    };

    expect(evidence).toEqual({
      workerLeaks: [false, false, false],
      parentLeaks: [false, false, false],
      workerHasMarker: true,
      parentHasMarker: true,
    });
  });

  it('guards installed stdout/stderr sinks across split UTF-8 writes, final flush, callbacks, backpressure, and exception cleanup', () => {
    const sessionToken = 'T'.repeat(43);
    const submissionToken = `af-sub-${'X'.repeat(43)}`;
    const reviewerToken = 'af-rev-87654321-4321-4432-8432-cba987654321';
    const realStdoutWrite = process.stdout.write;
    const realStderrWrite = process.stderr.write;
    let privateStdout = '';
    let privateStderr = '';
    let callbackCount = 0;

    const sinkText = (chunk: unknown, encoding: unknown): string => {
      if (Buffer.isBuffer(chunk)) {
        return chunk.toString(typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8');
      }
      return String(chunk);
    };
    const stdoutSink = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      privateStdout += sinkText(chunk, encodingOrCallback);
      const done = typeof encodingOrCallback === 'function'
        ? encodingOrCallback as () => void
        : typeof callback === 'function' ? callback as () => void : undefined;
      done?.();
      return false;
    }) as typeof process.stdout.write;
    const stderrSink = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      privateStderr += sinkText(chunk, encodingOrCallback);
      const done = typeof encodingOrCallback === 'function'
        ? encodingOrCallback as () => void
        : typeof callback === 'function' ? callback as () => void : undefined;
      done?.();
      return false;
    }) as typeof process.stderr.write;

    let firstWriteReturned = true;
    let sawExpectedException = false;
    let restoredToPrivateSinks = false;
    process.stdout.write = stdoutSink;
    process.stderr.write = stderrSink;
    try {
      const uninstall = installMcpCliOutputGuard();
      try {
        const diagnostic = Buffer.from(`MCP_DIAGNOSTIC: ✓ --${sessionToken}\n`, 'utf8');
        const checkmarkStart = Buffer.from('MCP_DIAGNOSTIC: ', 'utf8').length;
        firstWriteReturned = process.stdout.write(
          diagnostic.subarray(0, checkmarkStart + 1),
          () => { callbackCount += 1; },
        );
        process.stdout.write(diagnostic.subarray(checkmarkStart + 1));

        process.stderr.write(`--${submissionToken.slice(0, 21)}`);
        process.stderr.write(`${submissionToken.slice(21)}\n`);
        // No newline: uninstall() must flush this value through the sanitizer.
        process.stderr.write(`--${reviewerToken}`);

        throw new Error('EXPECTED_GUARD_TEST_EXCEPTION');
      } catch (error) {
        sawExpectedException = error instanceof Error && error.message === 'EXPECTED_GUARD_TEST_EXCEPTION';
      } finally {
        uninstall();
      }
      restoredToPrivateSinks = process.stdout.write === stdoutSink && process.stderr.write === stderrSink;
    } finally {
      process.stdout.write = realStdoutWrite;
      process.stderr.write = realStderrWrite;
    }

    const evidence = {
      stdoutLeaksSession: privateStdout.includes(sessionToken),
      stderrLeaksSubmission: privateStderr.includes(submissionToken),
      stderrLeaksReviewer: privateStderr.includes(reviewerToken),
      stdoutHasRedaction: privateStdout.includes(MCP_CLI_REDACTED_TOKEN),
      stderrHasRedaction: privateStderr.includes(MCP_CLI_REDACTED_TOKEN),
      unicodePreserved: privateStdout.includes('MCP_DIAGNOSTIC: ✓'),
      callbackCount,
      firstWriteReturned,
      sawExpectedException,
      restoredToPrivateSinks,
    };
    expect(evidence).toEqual({
      stdoutLeaksSession: false,
      stderrLeaksSubmission: false,
      stderrLeaksReviewer: false,
      stdoutHasRedaction: true,
      stderrHasRedaction: true,
      unicodePreserved: true,
      callbackCount: 1,
      firstWriteReturned: false,
      sawExpectedException: true,
      restoredToPrivateSinks: true,
    });
  });

  it('preserves UTF-8 diagnostics split across Buffer writes', () => {
    const diagnostic = 'MCP_DIAGNOSTIC: ✓ request rejected';
    const bytes = Buffer.from(`${diagnostic}\n`, 'utf8');
    const checkmarkStart = Buffer.from('MCP_DIAGNOSTIC: ', 'utf8').length;

    const captured = captureMcpCliOutput(() => {
      process.stdout.write(bytes.subarray(0, checkmarkStart + 1));
      process.stdout.write(bytes.subarray(checkmarkStart + 1, checkmarkStart + 2));
      process.stdout.write(bytes.subarray(checkmarkStart + 2));
    });

    expect(captured.stdout).toBe(`${diagnostic}\n`);
    expect(captured.stdout).not.toContain('�');
  });

  it('keeps ordinary diagnostic text unchanged in both streaming boundaries', () => {
    const diagnostic = 'MCP_AUTHORITY_FENCED: request rejected';
    expect(redactMcpCliOutput(diagnostic)).toBe(diagnostic);
    const captured = captureMcpCliOutput(() => process.stdout.write(`${diagnostic}\n`));
    expect(captured.stdout).toBe(`${diagnostic}\n`);
  });
});
