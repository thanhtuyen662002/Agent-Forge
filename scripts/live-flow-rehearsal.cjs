#!/usr/bin/env node
/**
 * Live rehearsal of the automated product flow with the owner's real CLIs.
 *
 * Runs each stage exactly as the desktop runtime does (the real adapters, the
 * real prompts from ProductManagerService / ProductReviewService and the real
 * parsers) against a disposable copy of a trial repository:
 *   1. Manager PLAN (plan.v1)  2. Manager START (manager.v1)
 *   3. Coder (coder.v1, files synced back)  4. Reviewer (review.v1)
 *
 * It costs a little provider quota. It never touches the app database or the
 * source repository. Usage (after `npx tsc -p tsconfig.node.json --outDir <dir>`):
 *   node scripts/live-flow-rehearsal.cjs <compiledDir> <sourceRepo> <managerProfileRef> <coderProfileRef> <reviewerProfileRef>
 *     [--manager-model sonnet] [--coder-model gpt-6.1-sol] [--reviewer-model sonnet]
 * Profile refs look like native-profile://claude/<id> or native-profile://codex/<id>.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [compiled, sourceRepo, managerRef, coderRef, reviewerRef] = process.argv.slice(2);
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
if (!compiled || !sourceRepo || !managerRef || !coderRef || !reviewerRef) {
  console.error('usage: live-flow-rehearsal.cjs <compiledDir> <sourceRepo> <managerProfileRef> <coderProfileRef> <reviewerProfileRef>');
  process.exit(2);
}
const load = (relative) => require(path.resolve(compiled, relative));
const Database = require(require.resolve('better-sqlite3', { paths: [process.cwd()] }));
const { MigrationRunner } = load('core/database/migrations');
const { Repository } = load('core/database/repositories');
const { ArtifactStore } = load('core/services/ArtifactStore');
const { captureRepositoryRoot } = load('core/services/RepositoryRootIdentity');
const { ProductManagerService } = load('core/services/ProductManagerService');
const { ProductReviewService } = load('core/services/ProductReviewService');
const { contractSha256 } = load('core/protocol/planProtocol');
const { ProtocolParser } = load('core/protocol/parser');
const { parseReviewProtocol } = load('core/protocol/reviewProtocol');
const { ClaudeCodeCliAdapter } = load('core/adapters/ClaudeCodeCliAdapter');
const { CodexCliAdapter } = load('core/adapters/CodexCliAdapter');
const { AntigravityCliAdapter } = load('core/adapters/AntigravityCliAdapter');
const { NativeProfileResolver } = load('core/credentials/NativeProfileResolver');

const adapterFor = (ref, repo, artifactStore) => {
  const provider = ref.split('://')[1].split('/')[0];
  const options = { repo, artifactStore, profileResolver: new NativeProfileResolver(), timeoutMs: 10 * 60_000 };
  if (provider === 'claude') return { providerId: 'prov-claude-code-cli', adapter: new ClaudeCodeCliAdapter(options) };
  if (provider === 'codex') return { providerId: 'prov-codex-cli', adapter: new CodexCliAdapter(options) };
  if (provider === 'antigravity') return { providerId: 'prov-antigravity-cli', adapter: new AntigravityCliAdapter(options) };
  throw new Error(`unsupported profile provider: ${provider}`);
};

const report = [];
const step = (name, ok, detail) => {
  report.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`);
};

(async () => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-rehearsal-')));
  const repoDir = path.join(work, 'repo');
  execFileSync('git', ['clone', '-q', sourceRepo, repoDir], { windowsHide: true });
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);
  const repo = new Repository(db);
  const artifactStore = new ArtifactStore(path.join(work, 'artifacts'));
  const now = new Date().toISOString();
  const contract = {
    goal: 'Thêm hàm slugify vào src/text.js: chuyển chuỗi thành chữ thường, bỏ dấu tiếng Việt (kể cả đ/Đ), thay khoảng trắng và ký tự đặc biệt bằng một dấu gạch nối, bỏ gạch nối thừa ở hai đầu.',
    acceptance_criteria: ['slugify("Xin Chào Việt Nam") trả về "xin-chao-viet-nam"', 'slugify("  Đường   số 1!! ") trả về "duong-so-1"', 'Các test cũ vẫn chạy qua'],
    testing_requirements: ['Thêm test cho slugify trong thư mục test, chạy bằng node --test'],
    non_goals: ['Không thêm thư viện ngoài'],
    owner_policies: ['Không sửa file run-tests.js'],
    definition_of_done: [], technical_constraints: [], architecture_constraints: [], security_requirements: [],
  };
  const projectId = 'PROJ-REHEARSAL';
  repo.createProject({
    id: projectId, name: 'Rehearsal', description: null, repository_path: repoDir, default_branch: 'main', status: 'RUNNING',
    contract, created_at: now, updated_at: now, started_at: now, completed_at: null,
  }, captureRepositoryRoot(repoDir));
  const project = repo.getProjectMetadata(projectId);
  const binding = (ref, providerId, modelName, suffix) => ({
    authorizationId: `auth-${suffix}`, routingDecisionId: `dec-${suffix}`, assignmentId: `asg-${suffix}`, providerId,
    accountId: `acct-${suffix}`, resourceId: `res-${suffix}`, modelName, adapterType: 'LOCAL_CLI', accountAuthMode: 'NATIVE_PROFILE', profileRef: ref,
  });

  // 1. Manager PLAN
  const manager = adapterFor(managerRef, repo, artifactStore);
  const hash = contractSha256(contract);
  repo.createTask({
    id: 'TSK-PLAN', project_id: projectId, milestone_id: null, title: 'Plan the project', description: null, state: 'PLANNED', paused_from_state: null,
    priority: 'MEDIUM', risk: 'LOW', assigned_agent_id: null, revision_count: 0, max_revisions: 3, base_sha: headSha, current_sha: headSha,
    progress_cache_percent: 0, progress_computed_at: null, acceptance_criteria: ['A plan exists'], constraints: [], created_at: now, updated_at: now,
  });
  const planResult = await manager.adapter.execute({
    projectId, taskId: 'TSK-PLAN', contextFiles: ['src', 'test', 'package.json', 'README.md'], expectedProtocol: 'plan.v1',
    runtimeBinding: binding(managerRef, manager.providerId, option('--manager-model', 'sonnet'), 'plan'),
    instructions: ProductManagerService.prototype.planningInstructions.call({}, project, hash),
  });
  let plan = null;
  try { plan = planResult.status === 'COMPLETED' ? JSON.parse(planResult.outputProtocol) : null; } catch { plan = null; }
  step('1. Manager plan.v1', !!plan && plan.contract_sha256 === hash && plan.project_id === projectId,
    plan ? `${plan.tasks.length} task(s): ${plan.tasks.map((t) => t.title).join(' / ')}` : `${planResult.errorCode}: ${String(planResult.error).slice(0, 200)}`);
  if (!plan) return finish();
  const planned = plan.tasks[0];
  repo.createTask({
    id: 'TSK-1', project_id: projectId, milestone_id: null, title: planned.title, description: planned.description || null, state: 'PLANNED', paused_from_state: null,
    priority: planned.priority, risk: planned.risk, assigned_agent_id: null, revision_count: 0, max_revisions: 3, base_sha: headSha, current_sha: headSha,
    progress_cache_percent: 0, progress_computed_at: null, acceptance_criteria: planned.acceptance_criteria, constraints: planned.constraints, created_at: now, updated_at: now,
  });

  // 2. Manager START
  const task = repo.getTask('TSK-1');
  const startResult = await manager.adapter.execute({
    projectId, taskId: 'TSK-1', contextFiles: [], expectedProtocol: 'manager.v1',
    runtimeBinding: binding(managerRef, manager.providerId, option('--manager-model', 'sonnet'), 'start'),
    instructions: ProductManagerService.prototype.instructions.call({ repo, previousRevisionResults: () => [] }, task, 'START'),
  });
  const decision = startResult.status === 'COMPLETED' ? ProtocolParser.parse(startResult.outputProtocol) : null;
  const decided = decision && decision.success && decision.data.type === 'manager.v1' ? decision.data.data : null;
  step('2. Manager manager.v1', !!decided && decided.decision === 'EXECUTE' && decided.task_id === 'TSK-1',
    decided ? `${decided.decision}, ${decided.instructions.length} instruction(s)` : `${startResult.errorCode}: ${String(startResult.error).slice(0, 200)}`);
  if (!decided) return finish();

  // 3. Coder
  const coder = adapterFor(coderRef, repo, artifactStore);
  const contextPaths = planned.context_paths && planned.context_paths.length ? planned.context_paths : ['src', 'test', 'package.json'];
  const coderResult = await coder.adapter.execute({
    projectId, taskId: 'TSK-1', contextFiles: contextPaths, expectedProtocol: undefined,
    runtimeBinding: binding(coderRef, coder.providerId, option('--coder-model', 'gpt-6.1-sol'), 'code'),
    instructions: decided.instructions,
  });
  const coderParsed = coderResult.status === 'COMPLETED' ? ProtocolParser.parse(coderResult.outputProtocol) : null;
  const coded = coderParsed && coderParsed.success && coderParsed.data.type === 'coder.v1' ? coderParsed.data.data : null;
  const changed = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }).trim();
  step('3. Coder coder.v1', !!coded && coded.task_id === 'TSK-1' && coded.project_id === projectId,
    coded ? `${coded.status}; synced changes: ${changed.replace(/\s+/g, ' ') || '(none)'}` : `${coderResult.errorCode}: ${String(coderResult.error).slice(0, 300)}`);
  let testsOk = false;
  try { execFileSync(process.execPath, ['run-tests.js'], { cwd: repoDir, stdio: 'pipe', timeout: 120000 }); testsOk = true; } catch { testsOk = false; }
  step('3b. node run-tests.js on the synced result', testsOk, testsOk ? 'tests pass' : 'tests fail');
  if (!coded) return finish();

  // 4. Reviewer
  const reviewer = adapterFor(reviewerRef, repo, artifactStore);
  const snapshotSha = 'ab'.repeat(32);
  const diff = execFileSync('git', ['diff', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }) + execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' });
  const auth = { project_id: projectId, task_revision: 0 };
  const reviewResult = await reviewer.adapter.execute({
    projectId, taskId: 'TSK-1', contextFiles: contextPaths, expectedProtocol: 'review.v1',
    runtimeBinding: binding(reviewerRef, reviewer.providerId, option('--reviewer-model', 'sonnet'), 'review'),
    instructions: ProductReviewService.prototype.instructions.call({ repo }, 'TSK-1', auth, { headSha, snapshotSha }, changed.split(/\r?\n/).map((l) => l.slice(3)), diff),
  });
  const review = reviewResult.status === 'COMPLETED' ? parseReviewProtocol(reviewResult.outputProtocol) : null;
  const reviewed = review && review.success ? review.data : null;
  step('4. Reviewer review.v1', !!reviewed && reviewed.task_id === 'TSK-1' && reviewed.reviewed_head_sha.toLowerCase() === headSha && reviewed.reviewed_snapshot_sha === snapshotSha,
    reviewed ? `${reviewed.verdict}, ${reviewed.issues.length} issue(s): ${reviewed.summary.slice(0, 160)}` : `${reviewResult.errorCode || review?.reasonCode}: ${String(reviewResult.error || '').slice(0, 300)}`);
  finish();

  function finish() {
    db.close();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
    const failed = report.filter((entry) => !entry.ok).length;
    console.log(failed === 0 ? 'REHEARSAL_PASSED' : `REHEARSAL_FAILED (${failed})`);
    process.exitCode = failed === 0 ? 0 : 1;
  }
})().catch((error) => { console.error('REHEARSAL_ERROR', error && error.stack ? error.stack.slice(0, 800) : error); process.exitCode = 1; });
