#!/usr/bin/env node
'use strict';

// Only public source IDs and bounded numeric timings enter this receipt.
// No test names, errors, import maps, fixture output or machine paths.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { sanitizeCapturedOutput } = require('./test-output-sanitizer.cjs');
const PROFILE_DIR = 'node_modules/.cache/agentforge-windows-profile';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_RECEIPTS = 40;
const ALGORITHM = 'vitest-default-sha1-four-shards-v1';
// Vitest module/setup/collection measurements are recorded separately. They
// are not CI job wall time and must not be presented as a latency guarantee.
const TIMINGS = ['durationMs', 'prepareMs', 'collectMs', 'setupMs', 'environmentMs'];
const fail = () => { throw new Error('CI_WINDOWS_PROFILE_INVALID'); };
const check = value => { if (!value) fail(); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function keys(value, expected) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  check(same(Object.keys(value).sort(), [...expected].sort()));
}
function inventory(files) {
  check(Array.isArray(files) && files.length >= 4 && files.length <= MAX_FILES);
  for (const file of files) {
    check(typeof file === 'string' && file.length <= 256 &&
      /^tests\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && !file.includes('..'));
  }
  check(new Set(files).size === files.length);
  return [...files].sort();
}
function publicId(root, absolute) {
  check(typeof absolute === 'string' && path.isAbsolute(absolute));
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  check(!relative.startsWith('../') && !path.isAbsolute(relative));
  return relative;
}
// Keep current dispatch. New/unprofiled files join complete discovery and use
// the same SHA1 assignment; timing history never filters the executable set.
function partition(files) {
  const sorted = inventory(files).map(file => ({ file, hash: crypto.createHash('sha1').update('/' + file).digest('hex') }))
    .sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
  check(new Set(sorted.map(entry => entry.hash)).size === sorted.length);
  let start = 0;
  return [1, 2, 3, 4].map(shard => {
    const size = Math.floor(sorted.length / 4) + (shard <= sorted.length % 4 ? 1 : 0);
    const result = sorted.slice(start, start + size).map(entry => entry.file).sort();
    start += size;
    return result;
  });
}
function parse(text) {
  try { check(typeof text === 'string' && Buffer.byteLength(text) <= MAX_BYTES); return JSON.parse(text); }
  catch { fail(); }
}
function read(file) {
  try { check(fs.statSync(file).size <= MAX_BYTES); return parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(); }
}
function write(file, value) {
  const text = JSON.stringify(value) + '\n';
  check(Buffer.byteLength(text) <= MAX_BYTES);
  fs.writeFileSync(file, text, { flag: 'wx' });
}
function source(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['diff', '--quiet', 'HEAD', '--']);
    const result = { commitSha: git(['rev-parse', 'HEAD']), treeSha: git(['rev-parse', 'HEAD^{tree}']) };
    check(/^[0-9a-f]{40}$/.test(result.commitSha) && /^[0-9a-f]{40}$/.test(result.treeSha));
    return result;
  } catch { fail(); }
}
function discover(root) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--json'], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Retain the parent boundary for collection failures; never print its JSON.
  sanitizeCapturedOutput(result);
  check(!result.error && result.status === 0);
  const data = parse(result.stdout);
  check(Array.isArray(data) && data.length <= MAX_FILES);
  const files = inventory(data.map(row => { keys(row, ['file']); return publicId(root, row.file); }));
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BYTES }).split('\0'));
  check(files.every(file => tracked.has(file)));
  return files;
}
function context(value) {
  keys(value, ['schemaVersion', 'algorithm', 'vitestVersion', 'source', 'run', 'platform', 'inventory']);
  check(value.schemaVersion === 1 && value.algorithm === ALGORITHM && value.platform === 'win32');
  check(typeof value.vitestVersion === 'string' && value.vitestVersion.length <= 32 && /^\d+\.\d+\.\d+$/.test(value.vitestVersion));
  keys(value.source, ['commitSha', 'treeSha']);
  check(typeof value.source.commitSha === 'string' && typeof value.source.treeSha === 'string' &&
    /^[0-9a-f]{40}$/.test(value.source.commitSha) && /^[0-9a-f]{40}$/.test(value.source.treeSha));
  keys(value.run, ['id', 'attempt']);
  check(typeof value.run.id === 'string' && /^[1-9][0-9]{0,19}$/.test(value.run.id));
  check(Number.isInteger(value.run.attempt) && value.run.attempt >= 1 && value.run.attempt <= 1000);
  const files = inventory(value.inventory);
  check(same(files, value.inventory));
  return value;
}
function currentContext(root, env) {
  const result = context({ schemaVersion: 1, algorithm: ALGORITHM,
    vitestVersion: require(path.join(root, 'node_modules/vitest/package.json')).version,
    source: source(root), run: { id: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT) },
    platform: process.platform, inventory: discover(root),
  });
  check(result.source.commitSha === env.AGENTFORGE_PROFILE_SOURCE_SHA);
  return result;
}
function shardArgument(args, env) {
  check(env.AGENTFORGE_TEST_SINGLE_RUN === '1' && !env.AGENTFORGE_TEST_FILES && !env.AGENTFORGE_TEST_PHASE);
  check(Array.isArray(args) && args.length === 1 && typeof args[0] === 'string' && /^--shard=[1-4]\/4$/.test(args[0]));
  return Number(args[0][8]);
}
function validate(receipt, expected, shard) {
  keys(receipt, ['schemaVersion', 'algorithm', 'vitestVersion', 'source', 'run', 'platform', 'inventory', 'shard', 'modules']);
  const { modules, shard: actualShard, ...metadata } = receipt;
  context(metadata); context(expected);
  check(actualShard === shard && Number.isInteger(shard) && shard >= 1 && shard <= 4);
  check(metadata.run.id === expected.run.id && metadata.run.attempt <= expected.run.attempt);
  check(same({ ...metadata, run: expected.run }, expected));
  const assigned = partition(expected.inventory)[shard - 1];
  check(Array.isArray(modules) && modules.length === assigned.length);
  const safeModules = modules.map(row => {
    keys(row, ['file', 'state', ...TIMINGS]);
    check(typeof row.file === 'string' && (row.state === 'passed' || row.state === 'skipped'));
    const safe = { file: row.file, state: row.state };
    for (const field of TIMINGS) {
      check(typeof row[field] === 'number' && Number.isFinite(row[field]) && row[field] >= 0 && row[field] <= 6 * 60 * 60 * 1000);
      safe[field] = Math.round(row[field] * 100) / 100;
    }
    return safe;
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  check(same(safeModules.map(row => row.file), assigned));
  return { ...metadata, shard, modules: safeModules };
}
function aggregate(receipts, expected) {
  check(Array.isArray(receipts) && receipts.length >= 4 && receipts.length <= MAX_RECEIPTS);
  const latest = new Map();
  const identities = new Set();
  let bytes = 0;
  for (const receipt of receipts) {
    const safe = validate(receipt, expected, receipt.shard);
    bytes += Buffer.byteLength(JSON.stringify(safe));
    check(bytes <= MAX_BYTES * 4);
    const identity = `${safe.shard}:${safe.run.attempt}`;
    check(!identities.has(identity)); identities.add(identity);
    const previous = latest.get(safe.shard);
    if (!previous || previous.run.attempt < safe.run.attempt) latest.set(safe.shard, safe);
  }
  check(latest.size === 4);
  const shards = [1, 2, 3, 4].map(shard => latest.get(shard));
  check(same(shards.flatMap(shard => shard.modules.map(row => row.file)).sort(), expected.inventory));
  return { ...expected, shards };
}
function prepare(root, env, args) {
  const shard = shardArgument(args, env);
  const metadata = currentContext(root, env);
  const directory = path.join(root, PROFILE_DIR);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ['input', 'draft', 'shard']) {
    const file = path.join(directory, `${name}-${shard}.json`);
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') fail(); }
  }
  write(path.join(directory, `input-${shard}.json`), metadata);
  return { metadata, shard, directory };
}
function finish(root, prepared) {
  check(same(source(root), prepared.metadata.source));
  const safe = validate(read(path.join(prepared.directory, `draft-${prepared.shard}.json`)), prepared.metadata, prepared.shard);
  check(safe.run.attempt === prepared.metadata.run.attempt);
  write(path.join(prepared.directory, `shard-${prepared.shard}.json`), safe);
}
class WindowsTestProfileReporter {
  onInit(ctx) {
    try {
      this.root = ctx.config.root;
      this.shard = ctx.config.shard?.index;
      check(ctx.config.shard?.count === 4);
      this.metadata = context(read(path.join(this.root, PROFILE_DIR, `input-${this.shard}.json`)));
    } catch { fail(); }
  }
  onTestRunStart(specifications) {
    try {
      check(Array.isArray(specifications) && specifications.length <= MAX_FILES);
      const selected = specifications.map(spec => { check(!spec.project.name); return publicId(this.root, spec.moduleId); }).sort();
      // Vitest announces the full specification set before its pool shards it.
      // Check discovery here; onTestRunEnd checks the actual executed shard.
      check(same(selected, this.metadata.inventory));
    } catch { fail(); }
  }
  onTestRunEnd(modules, errors, reason) {
    try {
      if (reason !== 'passed' || errors.length) return;
      check(Array.isArray(modules) && modules.length <= MAX_FILES);
      const receipt = { ...this.metadata, shard: this.shard, modules: modules.map(module => {
        const diagnostic = module.diagnostic();
        return { file: publicId(this.root, module.moduleId), state: module.state(),
          durationMs: diagnostic.duration, prepareMs: diagnostic.prepareDuration,
          collectMs: diagnostic.collectDuration, setupMs: diagnostic.setupDuration, environmentMs: diagnostic.environmentSetupDuration,
        };
      }) };
      write(path.join(this.root, PROFILE_DIR, `draft-${this.shard}.json`), validate(receipt, this.metadata, this.shard));
    } catch { fail(); }
  }
}
module.exports = WindowsTestProfileReporter;
Object.assign(module.exports, { PROFILE_DIR, MAX_BYTES, inventory, partition, parse, context, validate, aggregate, shardArgument, prepare, finish, discover });

if (require.main === module) {
  try {
    check(process.argv.length === 3 && process.argv[2] === 'aggregate');
    const root = path.resolve(__dirname, '..');
    const metadata = currentContext(root, process.env);
    const incoming = path.join(root, PROFILE_DIR, 'incoming');
    const directories = fs.readdirSync(incoming);
    check(directories.length >= 4 && directories.length <= MAX_RECEIPTS);
    let bytes = 0;
    const receipts = directories.map(name => {
      check(/^agentforge-windows-profile-[1-9][0-9]{0,19}-[1-9][0-9]{0,3}-[1-4]$/.test(name));
      const directory = path.join(incoming, name);
      const files = fs.readdirSync(directory);
      check(files.length === 1 && /^shard-[1-4]\.json$/.test(files[0]));
      bytes += fs.statSync(path.join(directory, files[0])).size;
      check(bytes <= MAX_BYTES * 4);
      const receipt = read(path.join(directory, files[0]));
      check(name === `agentforge-windows-profile-${receipt.run.id}-${receipt.run.attempt}-${receipt.shard}` && files[0] === `shard-${receipt.shard}.json`);
      return receipt;
    });
    write(path.join(root, PROFILE_DIR, 'combined.json'), aggregate(receipts, metadata));
    process.stdout.write('CI_WINDOWS_PROFILE_COMPLETE\n');
  } catch {
    process.stderr.write('CI_WINDOWS_PROFILE_INVALID\n');
    process.exitCode = 1;
  }
}
