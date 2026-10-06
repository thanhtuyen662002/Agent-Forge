'use strict';

// The test runner captures Vitest's parent-process output before forwarding it
// to the terminal. Keep the credential patterns here in CommonJS so the
// runner can sanitize assertion summaries and reporter output that never pass
// through a Vitest worker's setup file.
const REDACTED_TOKEN = '[REDACTED_TOKEN]';
// Intentionally do not require base64url boundaries. Test/CI diagnostics can
// concatenate credentials with URL-safe framing (for example an unknown
// `--<token>` argument). These sinks are fail-closed: consuming adjacent
// URL-safe characters is preferable to retaining a plaintext credential.
const SESSION_TOKEN_PATTERN = /[A-Za-z0-9_-]{43}/g;
const SUBMISSION_TOKEN_PATTERN = /af-sub-[A-Za-z0-9_-]{43}/gi;
const REVIEWER_TOKEN_PATTERN = /af-rev-[0-9a-f-]{36}/gi;

function redactMcpCliOutput(text) {
  return String(text)
    .replace(/("?(?:plaintext_token|plaintextToken)"?\s*:\s*")([^"\r\n]+)(")/gi, `$1${REDACTED_TOKEN}$3`)
    .replace(/(Plaintext\s+Token\s*:\s*)([^\s\r\n]+)/gi, `$1${REDACTED_TOKEN}`)
    .replace(SUBMISSION_TOKEN_PATTERN, REDACTED_TOKEN)
    .replace(REVIEWER_TOKEN_PATTERN, REDACTED_TOKEN)
    .replace(SESSION_TOKEN_PATTERN, REDACTED_TOKEN);
}

function sanitizeCapturedOutput(result) {
  return {
    stdout: redactMcpCliOutput(result && result.stdout ? result.stdout : ''),
    stderr: redactMcpCliOutput(result && result.stderr ? result.stderr : ''),
  };
}

module.exports = {
  REDACTED_TOKEN,
  redactMcpCliOutput,
  sanitizeCapturedOutput,
};
