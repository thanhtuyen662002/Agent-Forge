import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import {
  AntigravityCliAdapter, buildAntigravityArgs, classifyAntigravityFailure, parseAntigravityResult,
} from '../src/core/adapters/AntigravityCliAdapter';
import { parseAgyModels } from '../src/core/services/ModelCatalogService';
import type { AgentExecutionRequest } from '../src/core/adapters/ProviderAdapter';

const CODER = {
  protocol: 'coder.v1', message_id: 'agy-1', project_id: 'PROJ-AGY', task_id: 'TSK-AGY', attempt: 1, status: 'COMPLETED',
  completed: ['done'], remaining: [], files_claimed_changed: [], tests_claimed: [], blockers: [], review_requested: true,
  expected_task_state: 'CODING', expected_revision: 0,
};
// Recorded from agy 1.4.6 on the owner's machine (2026-10-25).
const QUOTA_STDOUT = '{"conversation_id":"e33716b4","status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 117h59m19s.","duration_seconds":0,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}';
const QUOTA_STDERR = 'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 117h59m19s.\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 117h59m19s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,"error_id":"57f18e2b-1"}';
const SUCCESS_STDOUT = '{"conversation_id":"79e429a2","status":"SUCCESS","response":"OK\\n","duration_seconds":14.79,"num_turns":1,"usage":{"input_tokens":7635,"output_tokens":1317,"thinking_tokens":1316,"cache_read_tokens":0,"total_tokens":8952}}';

describe('Antigravity CLI output contract (#265)', () => {
  it('builds read-only plan runs for reviewers and sandboxed accept-edits runs for coders, with the prompt last', () => {
    const review = buildAntigravityArgs('review.v1', 'gemini-3.8-flash-high', 'PROMPT');
    expect(review).toEqual(['--output-format', 'json', '--model', 'gemini-3.8-flash-high', '--mode', 'plan', '--disable-slash-commands', '-p', 'PROMPT']);
    const coder = buildAntigravityArgs(undefined, 'm', 'PROMPT');
    expect(coder).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--sandbox']));
    expect(coder.slice(-2)).toEqual(['-p', 'PROMPT']);
    expect([...review, ...coder].join(' ')).not.toMatch(/dangerously/);
  });

  it('reads the recorded success and quota replies', () => {
    expect(parseAntigravityResult(SUCCESS_STDOUT)).toMatchObject({ status: 'SUCCESS', response: 'OK\n' });
    expect(classifyAntigravityFailure(QUOTA_STDOUT, QUOTA_STDERR)).toEqual({ errorCode: 'QUOTA_EXHAUSTED', error: 'Antigravity quota reached; resets in 117h59m19s.' });
    expect(classifyAntigravityFailure('', 'AGY_ERROR: {"status":"UNAUTHENTICATED","error_code":401}')?.errorCode).toBe('AUTH_ERROR');
    // Observed 2026-10-27 (#302): Google asks to verify the account.
    const ineligible = JSON.stringify({ conversation_id: '', status: 'ERROR', response: '',
      error: 'Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue.' });
    expect(classifyAntigravityFailure(ineligible, '')).toMatchObject({ errorCode: 'AUTH_ERROR' });
    // The model's own text is never classified.
    expect(classifyAntigravityFailure('{"status":"SUCCESS","response":"I added rate limit handling for 429 and quota reached cases"}', '')).toBeNull();
    expect(classifyAntigravityFailure('', 'some unexpected crash')).toBeNull();
  });

  it('parses `agy models`, skipping unsafe ids and marking the first as default', () => {
    const models = parseAgyModels('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\nbad id\tx\n\nnot-a-row\n');
    expect(models.map((entry) => [entry.id, entry.label, entry.isDefault])).toEqual([
      ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)', true], ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)', false],
    ]);
  });
});

/** The adapter end to end, with a recorded-format fake agy run by the trusted Node binary. */
describe('Antigravity CLI adapter (#265)', () => {
  let tmpDir: string;
  let projectRoot: string;
  let logFile: string;
  let scenarioFile: string;
  let script: string;
  let db: Database.Database;
  let repo: Repository;
  let resolver: NativeProfileResolver;
  let adapter: AntigravityCliAdapter;

  /**
   * The fake runs as `agy.exe <script> …` (a link to the Node binary): a .cmd
   * shim could not carry a multi-line prompt, and `node … -p` is refused by policy.
   */
  let binDir: string;
  let fakeAgy: string;
  beforeAll(() => {
    binDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bin-')));
    fakeAgy = path.join(binDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
    try { fs.linkSync(process.execPath, fakeAgy); } catch { fs.copyFileSync(process.execPath, fakeAgy); }
  });
  afterAll(() => fs.rmSync(binDir, { recursive: true, force: true }));

  class TestAdapter extends AntigravityCliAdapter {
    protected override buildExecutionArgs(request: AgentExecutionRequest, prompt: string): string[] {
      return [script, ...super.buildExecutionArgs(request, prompt)];
    }
  }

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-adapter-')));
    projectRoot = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    execFileSync('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: projectRoot, stdio: 'ignore', windowsHide: true });
    resolver = new NativeProfileResolver({ baseProfilesDir: path.join(tmpDir, 'profiles') });
    logFile = path.join(tmpDir, 'invocation.json');
    scenarioFile = path.join(tmpDir, 'scenario.txt');
    script = path.join(tmpDir, 'fake-agy.js');
    fs.writeFileSync(script, `
      const fs = require('fs');
      let stdin = '';
      try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
      fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({
        argv: process.argv.slice(2), home: process.env.USERPROFILE || null, homeVar: process.env.HOME || null, stdin,
      }));
      const scenario = fs.existsSync(${JSON.stringify(scenarioFile)}) ? fs.readFileSync(${JSON.stringify(scenarioFile)}, 'utf8') : 'SUCCESS';
      if (scenario === 'SUCCESS') { process.stdout.write(JSON.stringify({ status: 'SUCCESS', response: ${JSON.stringify(JSON.stringify(CODER))} }) + '\\n'); process.exit(0); }
      if (scenario === 'QUOTA') { process.stdout.write(${JSON.stringify(QUOTA_STDOUT)} + '\\n'); process.stderr.write(${JSON.stringify(QUOTA_STDERR)} + '\\n'); process.exit(3); }
      if (scenario === 'ERROR_RESULT') { process.stdout.write(JSON.stringify({ status: 'ERROR', response: '', error: 'Something went wrong' }) + '\\n'); process.exit(0); }
    `, 'utf8');

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    const now = new Date().toISOString();
    repo.createProject({
      id: 'PROJ-AGY', name: 'Antigravity project', description: null, repository_path: projectRoot, default_branch: 'main', status: 'READY',
      contract: null, created_at: now, updated_at: now, started_at: null, completed_at: null,
    }, captureRepositoryRoot(projectRoot));
    repo.createTask({
      id: 'TSK-AGY', project_id: 'PROJ-AGY', milestone_id: null, title: 'Antigravity task', description: null, state: 'CODING', paused_from_state: null,
      priority: 'LOW', risk: 'LOW', assigned_agent_id: null, revision_count: 0, max_revisions: 5, base_sha: '0'.repeat(40), current_sha: '0'.repeat(40),
      progress_cache_percent: 0, progress_computed_at: null, acceptance_criteria: ['x'], constraints: [], created_at: now, updated_at: now,
    });
    adapter = new TestAdapter({ executable: fakeAgy, repo, artifactStore: new ArtifactStore(path.join(tmpDir, 'artifacts')), profileResolver: resolver, timeoutMs: 20_000 });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const request = (overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest => ({
    taskId: 'TSK-AGY', projectId: 'PROJ-AGY', instructions: ['Edit src/a.ts', 'Keep "quotes" & lines\nintact'], contextFiles: ['src'],
    runtimeBinding: {
      authorizationId: 'auth-a', routingDecisionId: 'dec-a', assignmentId: 'asg-a', providerId: 'prov-antigravity-cli', accountId: 'acct-a',
      resourceId: 'res-a', modelName: 'gemini-3.8-flash-high', adapterType: 'LOCAL_CLI', accountAuthMode: 'NATIVE_PROFILE', profileRef: 'native-profile://antigravity/a01',
    },
    ...overrides,
  });
  const log = () => JSON.parse(fs.readFileSync(logFile, 'utf8')) as { argv: string[]; home: string | null; homeVar: string | null; stdin: string };

  it('runs a coder in its own profile home with the prompt as the -p value and an empty stdin', async () => {
    const result = await adapter.execute(request());

    expect(result.status).toBe('COMPLETED');
    expect(JSON.parse(result.outputProtocol!).protocol).toBe('coder.v1');
    const call = log();
    expect(call.argv).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--sandbox', '--model', 'gemini-3.8-flash-high']));
    const prompt = call.argv[call.argv.indexOf('-p') + 1];
    expect(prompt).toContain('Edit src/a.ts');
    expect(prompt).toContain('Keep "quotes" & lines\nintact'); // Passed verbatim, no shell.
    expect(call.stdin).toBe('');
    const profile = path.join(tmpDir, 'profiles', 'antigravity', 'a01');
    expect(call.home).toBe(profile);
    expect(call.homeVar).toBe(profile);
  });

  it('runs a reviewer read-only and never turns an error result into success', async () => {
    fs.writeFileSync(scenarioFile, 'ERROR_RESULT');
    expect(await adapter.execute(request({ expectedProtocol: 'review.v1' }))).toMatchObject({ status: 'FAILED' });
    expect(log().argv).toEqual(expect.arrayContaining(['--mode', 'plan']));
    expect(log().argv).not.toContain('accept-edits');
  });

  it('classifies the recorded quota failure with its reset time', async () => {
    fs.writeFileSync(scenarioFile, 'QUOTA');
    const result = await adapter.execute(request());
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'QUOTA_EXHAUSTED' });
    expect(result.error).toContain('117h59m19s');
  });

  it('refuses a profile of another CLI and a prompt beyond the command-line limit', async () => {
    const wrong = request();
    wrong.runtimeBinding = { ...wrong.runtimeBinding!, profileRef: 'native-profile://gemini/a01' };
    expect(await adapter.execute(wrong)).toMatchObject({ status: 'FAILED', errorCode: 'RESOURCE_UNAVAILABLE' });
    const huge = await adapter.execute(request({ instructions: ['x'.repeat(30_000)] }));
    expect(huge).toMatchObject({ status: 'FAILED', errorCode: 'RESOURCE_UNAVAILABLE' });
    expect(huge.error).toContain('PROMPT_TOO_LONG');
    expect(fs.existsSync(logFile)).toBe(false); // Nothing was spawned.
  });
});
