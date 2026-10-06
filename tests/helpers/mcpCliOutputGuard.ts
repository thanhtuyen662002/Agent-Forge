/**
 * Test-only output boundary for the owner-only MCP administration CLIs.
 *
 * The CLIs intentionally deliver a newly issued credential on stdout. That
 * is correct for an interactive owner, but forwarding that value through a
 * test runner would persist it in local or CI logs. The guard keeps ordinary
 * diagnostics visible while replacing token-shaped values before they reach
 * the runner's real streams.
 */

import { StringDecoder } from 'node:string_decoder';

const REDACTED_TOKEN = '[REDACTED_TOKEN]';

// Session tokens are unpadded base64url encodings of 32 bytes. Submission
// tokens add a stable `af-sub-` prefix. Reviewer tokens are included because
// the same test process can exercise the reviewer administration CLI.
// Bare session tokens must be bounded so long URL-safe diagnostics are not
// mistaken for credentials. Parser diagnostics can still frame a real token as
// an unknown `--<token>` argument, so keep a narrow matcher for that form.
const SESSION_TOKEN_PATTERN = /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{43})(?=$|[^A-Za-z0-9_-])/g;
const PARSER_FRAMED_SESSION_TOKEN_PATTERN = /(^|[^A-Za-z0-9_-])(--)([A-Za-z0-9_-]{43})(?=$|[^A-Za-z0-9_-])/g;
const SUBMISSION_TOKEN_PATTERN = /af-sub-[A-Za-z0-9_-]{43}/gi;
const REVIEWER_TOKEN_PATTERN = /af-rev-[0-9a-f-]{36}/gi;

// Keep an incomplete line until its terminating newline (or an explicit
// flush). A credential can be split over arbitrary stream writes, and
// redacting each chunk independently would allow the concatenated token to
// reach the diagnostic sink. The cap is a fail-closed guard for a test that
// writes an unterminated, unbounded diagnostic line.
const MAX_PENDING_LINE_BYTES = 64 * 1024;

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
    .replace(PARSER_FRAMED_SESSION_TOKEN_PATTERN, `$1$2${REDACTED_TOKEN}`)
    .replace(SESSION_TOKEN_PATTERN, `$1${REDACTED_TOKEN}`);
}

type Writable = typeof process.stdout.write;

class StreamingMcpCliRedactor {
  private pending = '';
  private decoder = new StringDecoder('utf8');

  public pushChunk(chunk: unknown): string {
    if (Buffer.isBuffer(chunk)) {
      return this.push(this.decoder.write(chunk));
    }

    // A decoded string cannot complete a partial UTF-8 byte sequence from a
    // previous Buffer write. End that byte stream before appending the string
    // so diagnostics are neither silently dropped nor combined incorrectly.
    const pendingBytes = this.decoder.end();
    this.decoder = new StringDecoder('utf8');
    return this.push(`${pendingBytes}${String(chunk)}`);
  }

  public push(text: string): string {
    this.pending += text;
    let safeOutput = '';
    let newlineIndex = this.pending.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.pending.slice(0, newlineIndex + 1);
      this.pending = this.pending.slice(newlineIndex + 1);
      safeOutput += redactMcpCliOutput(line);
      newlineIndex = this.pending.indexOf('\n');
    }

    if (Buffer.byteLength(this.pending, 'utf8') > MAX_PENDING_LINE_BYTES) {
      // A line without a boundary cannot be safely streamed indefinitely.
      // Preserve the security invariant by emitting only a generic marker;
      // ordinary bounded diagnostics continue through the normal redactor.
      safeOutput += `${REDACTED_TOKEN}\n`;
      this.pending = '';
    }
    return safeOutput;
  }

  public flush(): string {
    this.pending += this.decoder.end();
    this.decoder = new StringDecoder('utf8');
    const safeOutput = redactMcpCliOutput(this.pending);
    this.pending = '';
    return safeOutput;
  }
}

interface RedactingWriter {
  write: Writable;
  flush: () => string;
}

function createRedactingWriter(original: Writable, stream: NodeJS.WritableStream): RedactingWriter {
  const boundOriginal = original.bind(stream);
  const redactor = new StreamingMcpCliRedactor();
  const write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const safeText = redactor.pushChunk(chunk);
    const done = typeof encodingOrCallback === 'function'
      ? encodingOrCallback as () => void
      : typeof callback === 'function' ? callback as () => void : undefined;
    if (!safeText) {
      // Preserve Node's normal callback/backpressure behavior even while the
      // line buffer is waiting for a newline. An empty write is observable to
      // callers that depend on the callback timing and return value.
      const bufferEncoding = typeof encodingOrCallback === 'string'
        ? encodingOrCallback as BufferEncoding
        : undefined;
      if (typeof encodingOrCallback === 'function') {
        return boundOriginal('', encodingOrCallback as () => void);
      }
      return boundOriginal(
        '',
        bufferEncoding,
        done,
      );
    }
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

  return {
    write,
    flush: () => {
      const safeText = redactor.flush();
      if (safeText) boundOriginal(safeText);
      return safeText;
    },
  };
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
  const guardedStdout = createRedactingWriter(originalStdoutWrite, process.stdout);
  const guardedStderr = createRedactingWriter(originalStderrWrite, process.stderr);

  process.stdout.write = guardedStdout.write;
  process.stderr.write = guardedStderr.write;

  return () => {
    // Flush after any test temporarily replaced the public writer, but use
    // the original bound sink so a partial line cannot remain buffered or be
    // restored without sanitization.
    guardedStdout.flush();
    guardedStderr.flush();
    if (process.stdout.write === guardedStdout.write) {
      process.stdout.write = originalStdoutWrite;
    }
    if (process.stderr.write === guardedStderr.write) {
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
  const stdoutRedactor = new StreamingMcpCliRedactor();
  const stderrRedactor = new StreamingMcpCliRedactor();
  let stdout = '';
  let stderr = '';

  process.stdout.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    stdout += stdoutRedactor.pushChunk(chunk);
    const done = typeof encodingOrCallback === 'function'
      ? encodingOrCallback as () => void
      : typeof callback === 'function' ? callback as () => void : undefined;
    done?.();
    return true;
  }) as Writable;
  process.stderr.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    stderr += stderrRedactor.pushChunk(chunk);
    const done = typeof encodingOrCallback === 'function'
      ? encodingOrCallback as () => void
      : typeof callback === 'function' ? callback as () => void : undefined;
    done?.();
    return true;
  }) as Writable;

  let result!: T;
  try {
    result = fn();
  } finally {
    stdout += stdoutRedactor.flush();
    stderr += stderrRedactor.flush();
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  return { result, stdout, stderr };
}

export const MCP_CLI_REDACTED_TOKEN = REDACTED_TOKEN;
