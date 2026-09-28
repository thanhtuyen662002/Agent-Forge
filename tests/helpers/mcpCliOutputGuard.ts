/**
 * Test-only output boundary for the owner-only MCP administration CLIs.
 *
 * The CLIs intentionally deliver a newly issued credential on stdout. That
 * is correct for an interactive owner, but forwarding that value through a
 * test runner would persist it in local or CI logs. The guard keeps ordinary
 * diagnostics visible while replacing token-shaped values before they reach
 * the runner's real streams.
 */

const REDACTED_TOKEN = '[REDACTED_TOKEN]';

// Session tokens are unpadded base64url encodings of 32 bytes. Submission
// tokens add a stable `af-sub-` prefix. Reviewer tokens are included because
// the same test process can exercise the reviewer administration CLI.
const SESSION_TOKEN_PATTERN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const SUBMISSION_TOKEN_PATTERN = /(?<![A-Za-z0-9_-])af-sub-[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gi;
const REVIEWER_TOKEN_PATTERN = /(?<![A-Za-z0-9_-])af-rev-[0-9a-f-]{36}(?![A-Za-z0-9_-])/gi;

/**
 * Redacts credentials from text that is about to be written to a diagnostic
 * sink. The explicit field matcher handles future token formats as long as a
 * CLI labels the value with the existing public field/label.
 */
export function redactMcpCliOutput(text: string): string {
  return text
    .replace(/("?(?:plaintext_token|plaintextToken)"?\s*:\s*")([^"\r\n]+)(")/gi, `$1${REDACTED_TOKEN}$3`)
    .replace(/(Plaintext\s+Token\s*:\s*)([^\s\r\n]+)/gi, `$1${REDACTED_TOKEN}`)
    .replace(SUBMISSION_TOKEN_PATTERN, REDACTED_TOKEN)
    .replace(REVIEWER_TOKEN_PATTERN, REDACTED_TOKEN)
    .replace(SESSION_TOKEN_PATTERN, REDACTED_TOKEN);
}

type Writable = typeof process.stdout.write;

function textFromChunk(chunk: unknown, encoding?: unknown): string {
  if (Buffer.isBuffer(chunk)) {
    const bufferEncoding = typeof encoding === 'string' ? encoding as BufferEncoding : undefined;
    return chunk.toString(bufferEncoding);
  }
  return String(chunk);
}

function createRedactingWriter(original: Writable, stream: NodeJS.WritableStream): Writable {
  const boundOriginal = original.bind(stream);
  return ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const safeText = redactMcpCliOutput(textFromChunk(chunk, encodingOrCallback));
    if (typeof encodingOrCallback === 'function') {
      return boundOriginal(safeText, encodingOrCallback as () => void);
    }
    const bufferEncoding = typeof encodingOrCallback === 'string'
      ? encodingOrCallback as BufferEncoding
      : undefined;
    return boundOriginal(
      safeText,
      bufferEncoding,
      typeof callback === 'function' ? callback as () => void : undefined
    );
  }) as Writable;
}

/**
 * Installs the redacting boundary for the duration of a test suite.
 *
 * Tests that deliberately assert one-time delivery can temporarily replace
 * `process.stdout.write`/`stderr.write` with their own capture function. Once
 * they restore the saved writer, this boundary is active again.
 */
export function installMcpCliOutputGuard(): () => void {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const guardedStdoutWrite = createRedactingWriter(originalStdoutWrite, process.stdout);
  const guardedStderrWrite = createRedactingWriter(originalStderrWrite, process.stderr);

  process.stdout.write = guardedStdoutWrite;
  process.stderr.write = guardedStderrWrite;

  return () => {
    if (process.stdout.write === guardedStdoutWrite) {
      process.stdout.write = originalStdoutWrite;
    }
    if (process.stderr.write === guardedStderrWrite) {
      process.stderr.write = originalStderrWrite;
    }
  };
}

export interface CapturedMcpCliOutput<T> {
  result: T;
  stdout: string;
  stderr: string;
}

/**
 * Captures and sanitizes CLI output for assertions without forwarding it to
 * Vitest's process streams. This is intentionally separate from the suite
 * guard so a test can inspect the sanitized human and JSON representations.
 */
export function captureMcpCliOutput<T>(fn: () => T): CapturedMcpCliOutput<T> {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let stdout = '';
  let stderr = '';

  process.stdout.write = ((chunk: unknown) => {
    stdout += redactMcpCliOutput(textFromChunk(chunk));
    return true;
  }) as Writable;
  process.stderr.write = ((chunk: unknown) => {
    stderr += redactMcpCliOutput(textFromChunk(chunk));
    return true;
  }) as Writable;

  try {
    return { result: fn(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

export const MCP_CLI_REDACTED_TOKEN = REDACTED_TOKEN;
