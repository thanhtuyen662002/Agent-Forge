#!/usr/bin/env node

/**
 * Run Agent Forge's test suite in two deterministic phases.
 *
 * Most unit tests are independent and retain Vitest's normal parallelism.
 * A small set of MCP/adjudication files intentionally launches real child
 * processes, worker threads, SQLite databases, and temporary Git repositories.
 * Running those known contention-prone files in one worker prevents unrelated
 * suites from starving their five-to-thirty-second protocol budgets or
 * deleting a fixture while a child still owns a file handle. The files are
 * excluded from the first phase so every test runs exactly once.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { sanitizeCapturedOutput } = require('./test-output-sanitizer.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const vitestEntry = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');
const reporterArgs = process.argv.slice(2);
// Windows runner TEMP commonly uses a DOS short-name alias. Ordinary fixtures
// must start at a canonical root; production selection still rejects aliases.
// Set this before any fixture exists and preserve the sanitizer around Vitest.
const testTemporaryRoot = fs.realpathSync.native(os.tmpdir());
const testEnvironment = { ...process.env };
if (process.platform === 'win32') {
  for (const key of Object.keys(testEnvironment)) {
    if (/^(TEMP|TMP)$/i.test(key)) delete testEnvironment[key];
  }
  testEnvironment.TEMP = testTemporaryRoot;
  testEnvironment.TMP = testTemporaryRoot;
} else {
  testEnvironment.TMPDIR = testTemporaryRoot;
}
const focusedFiles = String(process.env.AGENTFORGE_TEST_FILES || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const runVitest = (label, args) => {
  process.stdout.write(`\n=== Agent Forge ${label} test phase ===\n`);
  const result = spawnSync(process.execPath, [vitestEntry, 'run', ...args, ...reporterArgs], {
    cwd: repositoryRoot,
    env: testEnvironment,
    // Capture the Vitest parent process so reporter assertion summaries pass
    // through the same fail-closed credential boundary as worker output.
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

  const safeOutput = sanitizeCapturedOutput(result);
  if (safeOutput.stdout) process.stdout.write(safeOutput.stdout);
  if (safeOutput.stderr) process.stderr.write(safeOutput.stderr);

  if (result.error) {
    process.stderr.write(`${label} test phase failed to start: ${result.error.message}\n`);
    return 1;
  }
  if (typeof result.status === 'number') return result.status;
  if (result.signal) {
    process.stderr.write(`${label} test phase terminated by ${result.signal}\n`);
    return 1;
  }
  return 1;
};

const broadExclusions = [
  '--exclude',
  'tests/r5jMcpClientBridge.test.ts',
  '--exclude',
  'tests/r5jMcpSessionAuthorityAndContextRead.test.ts',
  '--exclude',
  'tests/r5jMcpServerFoundation.test.ts',
  '--exclude',
  'tests/r5j5/group7c-durable-recovery.test.ts',
  '--exclude',
  'tests/r5j5/group7e-canonical-recovery.test.ts',
  '--exclude',
  'tests/r5j5/group7f-cancellation-snapshots.test.ts',
];

const serialFiles = [
  'tests/r5jMcpClientBridge.test.ts',
  'tests/r5jMcpSessionAuthorityAndContextRead.test.ts',
  'tests/r5jMcpServerFoundation.test.ts',
  'tests/r5j5/group7c-durable-recovery.test.ts',
  'tests/r5j5/group7e-canonical-recovery.test.ts',
  'tests/r5j5/group7f-cancellation-snapshots.test.ts',
];

const runParallel = () => runVitest('parallel', broadExclusions);
const runSerialized = () => runVitest('serialized MCP/adjudication', ['--maxWorkers=1', ...serialFiles]);
const runSingleWorker = () => runVitest('single deterministic worker', ['--maxWorkers=1']);
const runFocused = () => runVitest('focused protected', ['--maxWorkers=1', ...focusedFiles]);

if (focusedFiles.length > 0) {
  // Focused execution must still cross the parent-process sanitizer. Use
  // AGENTFORGE_TEST_FILES rather than invoking Vitest directly when a test
  // can render MCP credentials in reporter diagnostics.
  process.exitCode = runFocused();
} else if (process.env.AGENTFORGE_TEST_SINGLE_RUN === '1') {
  // Windows CI historically ran the entire suite in one Vitest process. Keep
  // that mode available because splitting the process can retain native file
  // handles between phases even when every phase uses one worker.
  process.exitCode = runSingleWorker();
} else if (process.env.AGENTFORGE_TEST_PHASE === 'parallel') {
  process.exitCode = runParallel();
} else if (process.env.AGENTFORGE_TEST_PHASE === 'serialized') {
  process.exitCode = runSerialized();
} else {
  const broadStatus = runParallel();
  const serializedStatus = runSerialized();
  process.exitCode = broadStatus !== 0 ? broadStatus : serializedStatus;
}
