#!/usr/bin/env node
'use strict';

/** A matrix result is success only when every shard has succeeded. */
function evaluateWindowsTestGate({ classifyResult, packageRequired, shardsResult } = {}) {
  if (classifyResult !== 'success') return { ok: false, code: 'CI_CLASSIFICATION_FAILED' };
  if (packageRequired !== 'true' && packageRequired !== 'false') {
    return { ok: false, code: 'CI_CLASSIFICATION_INVALID' };
  }
  if (packageRequired === 'true') {
    return shardsResult === 'success'
      ? { ok: true, code: 'CI_WINDOWS_FULL_SUITE_PASSED' }
      : { ok: false, code: 'CI_WINDOWS_SHARDS_INCOMPLETE' };
  }
  return shardsResult === 'skipped'
    ? { ok: true, code: 'CI_WINDOWS_CLASSIFIED_DOCS_ONLY' }
    : { ok: false, code: 'CI_WINDOWS_SHARDS_SKIP_MISMATCH' };
}

module.exports = { evaluateWindowsTestGate };

if (require.main === module) {
  const result = evaluateWindowsTestGate({
    classifyResult: process.env.CI_CLASSIFY_RESULT,
    packageRequired: process.env.CI_PACKAGE_REQUIRED,
    shardsResult: process.env.CI_WINDOWS_SHARDS_RESULT,
  });
  // Emit fixed codes only; untrusted metadata must never become log content.
  process.stdout.write(`${result.code}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
