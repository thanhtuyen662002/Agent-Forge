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
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const vitestEntry = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');
const reporterArgs = process.argv.slice(2);

const runVitest = (label, args) => {
  process.stdout.write(`\n=== Agent Forge ${label} test phase ===\n`);
  const result = spawnSync(process.execPath, [vitestEntry, 'run', ...args, ...reporterArgs], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
  });

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

if (process.env.AGENTFORGE_TEST_PHASE === 'parallel') {
  process.exitCode = runParallel();
} else if (process.env.AGENTFORGE_TEST_PHASE === 'serialized') {
  process.exitCode = runSerialized();
} else {
  const broadStatus = runParallel();
  const serializedStatus = runSerialized();
  process.exitCode = broadStatus !== 0 ? broadStatus : serializedStatus;
}
