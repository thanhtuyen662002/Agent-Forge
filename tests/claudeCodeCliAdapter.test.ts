import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { ClaudeCodeCliAdapter, classifyClaudeFailure } from '../src/core/adapters/ClaudeCodeCliAdapter';
import type { AgentExecutionRequest } from '../src/core/adapters/ProviderAdapter';

const CODER = {
  protocol: 'coder.v1', message_id: 'claude-1', project_id: 'PROJ-CLAUDE', task_id: 'TSK-CLAUDE', attempt: 1, status: 'COMPLETED',
  completed: ['done'], remaining: [], files_claimed_changed: [], tests_claimed: [], blockers: [], review_requested: true,
  expected_task_state: 'CODING', expected_revision: 0,
};

/** #242: Claude Code CLI as an account-bound, non-interactive worker. */
describe('Claude Code CLI adapter (#242)', () => {
  let tmpDir: string;
  let projectRoot: string;
  let logFile: string;
  let scenarioFile: string;
  let executable: string;
  let db: Database.Database;
  let repo: Repository;
  let resolver: NativeProfileResolver;
  let adapter: ClaudeCodeCliAdapter;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adapter-')));
    projectRoot = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    execFileSync('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: projectRoot, stdio: 'ignore', windowsHide: true });
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'claude', 'c01'), { recursive: true });
    resolver = new NativeProfileResolver({ baseProfilesDir: path.join(tmpDir, 'profiles') });
    logFile = path.join(tmpDir, 'invocation.json');
    scenarioFile = path.join(tmpDir, 'scenario.txt');

    const script = path.join(tmpDir, 'fake-claude.js');
    fs.writeFileSync(script, `
      const fs = require('fs');
      let stdin = '';
      try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
      fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({
        argv: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR || null,
        apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY), stdin,
      }));
      const scenario = fs.existsSync(${JSON.stringify(scenarioFile)}) ? fs.readFileSync(${JSON.stringify(scenarioFile)}, 'utf8') : 'SUCCESS';
      const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
      if (scenario === 'SUCCESS') { out({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(JSON.stringify(CODER))} }); process.exit(0); }
      if (scenario === 'IS_ERROR') { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Something went wrong' }); process.exit(0); }
      if (scenario === 'NOT_LOGGED_IN') { out({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }); process.exit(1); }
      if (scenario === 'LIMIT') { out({ type: 'result', is_error: true, result: "You've hit your session limit · resets 3:45pm" }); process.exit(1); }
    `, 'utf8');
    if (process.platform === 'win32') {
      executable = path.join(tmpDir, 'fake-claude.cmd');
      fs.writeFileSync(executable, `@node "${script}" %*`, 'utf8');
    } else {
      executable = path.join(tmpDir, 'fake-claude.sh');
      fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
      fs.chmodSync(executable, 0o755);
    }

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    const now = new Date().toISOString();
    repo.createProject({
      id: 'PROJ-CLAUDE', name: 'Claude project', description: null, repository_path: projectRoot, default_branch: 'main', status: 'READY',
      contract: null, created_at: now, updated_at: now, started_at: null, completed_at: null,
    }, captureRepositoryRoot(projectRoot));
    repo.createTask({
      id: 'TSK-CLAUDE', project_id: 'PROJ-CLAUDE', milestone_id: null, title: 'Claude task', description: null, state: 'CODING', paused_from_state: null,
      priority: 'LOW', risk: 'LOW', assigned_agent_id: null, revision_count: 0, max_revisions: 5, base_sha: '0'.repeat(40), current_sha: '0'.repeat(40),
      progress_cache_percent: 0, progress_computed_at: null, acceptance_criteria: ['x'], constraints: [], created_at: now, updated_at: now,
    });
    adapter = new ClaudeCodeCliAdapter({ executable, repo, artifactStore: new ArtifactStore(path.join(tmpDir, 'artifacts')), profileResolver: resolver, timeoutMs: 20_000 });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-host-key-must-not-leak';
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const request = (overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest => ({
    taskId: 'TSK-CLAUDE', projectId: 'PROJ-CLAUDE', instructions: ['Edit src/a.ts'], contextFiles: ['src'],
    runtimeBinding: {
      authorizationId: 'auth-c', routingDecisionId: 'dec-c', assignmentId: 'asg-c', providerId: 'prov-claude-code-cli', accountId: 'acct-c',
      resourceId: 'res-c', modelName: 'claude-sonnet-4-5', adapterType: 'LOCAL_CLI', accountAuthMode: 'NATIVE_PROFILE', profileRef: 'native-profile://claude/c01',
    },
    ...overrides,
  });
  const log = () => JSON.parse(fs.readFileSync(logFile, 'utf8')) as { argv: string[]; configDir: string | null; apiKeyPresent: boolean; stdin: string };

  it('runs a coder non-interactively in its own profile, with file tools only and no permission bypass', async () => {
    const result = await adapter.execute(request());

    expect(result.status).toBe('COMPLETED');
    expect(JSON.parse(result.outputProtocol!).protocol).toBe('coder.v1');
    const call = log();
    expect(call.argv.slice(0, 5)).toEqual(['-p', '--output-format', 'json', '--model', 'claude-sonnet-4-5']);
    expect(call.argv).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Glob,Grep', '--no-session-persistence',
      '--setting-sources', 'user', '--strict-mcp-config']));
    expect(call.argv.join(' ')).not.toMatch(/dangerously|bypassPermissions|Bash/);
    expect(call.configDir).toBe(path.join(tmpDir, 'profiles', 'claude', 'c01'));
    expect(call.apiKeyPresent).toBe(false); // The host's API key never reaches the child.
    expect(call.stdin).toContain('Edit src/a.ts');
  });

  it('runs a reviewer read-only', async () => {
    fs.writeFileSync(scenarioFile, 'IS_ERROR');
    await adapter.execute(request({ expectedProtocol: 'review.v1' }));
    expect(log().argv).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep']));
    expect(log().argv).not.toContain('acceptEdits');
  });

  it('never turns an error result into success', async () => {
    fs.writeFileSync(scenarioFile, 'IS_ERROR');
    expect(await adapter.execute(request())).toMatchObject({ status: 'FAILED', errorCode: 'PROTOCOL_INVALID' });
  });

  it('classifies sign-in and usage-limit failures', async () => {
    fs.writeFileSync(scenarioFile, 'NOT_LOGGED_IN');
    expect(await adapter.execute(request())).toMatchObject({ status: 'FAILED', errorCode: 'AUTH_ERROR' });
    fs.writeFileSync(scenarioFile, 'LIMIT');
    const limited = await adapter.execute(request());
    expect(limited).toMatchObject({ status: 'FAILED', errorCode: 'QUOTA_EXHAUSTED' });
    expect(limited.error).toContain('3:45pm');
    expect(classifyClaudeFailure('Login expired · Please run /login')?.errorCode).toBe('AUTH_ERROR');
    expect(classifyClaudeFailure('Repeated 529 Overloaded errors')).toBeNull();
    // The model's own text and JSON numbers are never classified.
    expect(classifyClaudeFailure('I added rate limit handling; duration_ms 14013, status 401 docs')).toBeNull();
  });

  it('refuses a profile of another CLI or one that was never signed in', async () => {
    const wrong = request();
    wrong.runtimeBinding = { ...wrong.runtimeBinding!, profileRef: 'native-profile://codex/c01' };
    expect(await adapter.execute(wrong)).toMatchObject({ status: 'FAILED', errorCode: 'RESOURCE_UNAVAILABLE' });
    const missing = request();
    missing.runtimeBinding = { ...missing.runtimeBinding!, profileRef: 'native-profile://claude/never-signed-in' };
    const result = await adapter.execute(missing);
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'RESOURCE_UNAVAILABLE' });
    expect(result.error).toContain('PROFILE_DIRECTORY_NOT_FOUND');
  });
});
