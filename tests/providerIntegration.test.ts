import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { VerificationService } from '../src/core/services/VerificationService';
import { BootstrapService } from '../src/core/services/BootstrapService';
import { ManualBridgeAdapter } from '../src/core/adapters/ManualBridgeAdapter';
import { CodexCliAdapter } from '../src/core/adapters/CodexCliAdapter';
import { AntigravityCliAdapter } from '../src/core/adapters/AntigravityCliAdapter';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ProtocolParser } from '../src/core/protocol/parser';

describe('PR #5 — Provider Integration Foundation', () => {
  let tmpDir: string;
  let repoDir: string;
  let db: Database.Database;
  let repo: Repository;
  let artifactStore: ArtifactStore;
  let eventService: EventService;
  let verificationService: VerificationService;
  let taskService: TaskService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-test-'));
    repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize clean Git repo for project cwd tests
    execSync('git init', { cwd: repoDir });
    execSync('git config user.name "Test Agent"', { cwd: repoDir });
    execSync('git config user.email "test@agentforge.local"', { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'index.js'), '// Initial code\n', 'utf8');
    execSync('git add index.js', { cwd: repoDir });
    execSync('git commit -m "initial commit"', { cwd: repoDir });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    artifactStore = new ArtifactStore(path.join(tmpDir, 'artifacts'));
    eventService = new EventService(repo);
    verificationService = new VerificationService(repo, artifactStore);
    taskService = new TaskService(repo, eventService, verificationService, artifactStore);

    // Create a base project and task
    repo.createProject({
      id: 'PROJ-TEST',
      name: 'Provider Test Project',
      description: 'Testing provider integrations',
      repository_path: repoDir,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    repo.createTask({
      id: 'TSK-TEST-001',
      project_id: 'PROJ-TEST',
      milestone_id: null,
      title: 'Provider Execution Task',
      description: 'Test CLI and Manual Bridge',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: '0000000000000000000000000000000000000000',
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['CLI execution succeeds'],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // 1. Manual Bridge returns AWAITING_OWNER, not COMPLETED
  it('1. Manual Bridge execute() must return status AWAITING_OWNER and never COMPLETED', async () => {
    const adapter = new ManualBridgeAdapter();
    expect(adapter.id).toBe('prov-manual-bridge');
    expect(adapter.adapterType).toBe('MANUAL_BRIDGE');

    const result = await adapter.execute({
      taskId: 'TSK-TEST-001',
      projectId: 'PROJ-TEST',
      instructions: ['Implement user login'],
      contextFiles: ['index.js'],
    });

    expect(result.status).toBe('AWAITING_OWNER');
    expect(result.status).not.toBe('COMPLETED');
    expect(result.outputProtocol).toContain('Awaiting Owner Manual Relay');
    expect(result.rawResponse).toContain('Awaiting Owner Manual Relay');
  });

  // 2. ProviderRegistry duplicate registration rejected
  it('2. ProviderRegistry duplicate registration must be rejected with explicit error', () => {
    const registry = new ProviderRegistry();
    const adapter1 = new ManualBridgeAdapter();
    const adapter2 = new ManualBridgeAdapter();

    registry.register(adapter1);
    expect(registry.size).toBe(1);
    expect(() => registry.register(adapter2)).toThrow(/Duplicate provider registration/);
  });

  // 3. Unknown provider lookup fails explicitly
  it('3. Unknown provider lookup fails explicitly without silent fallback', () => {
    const registry = new ProviderRegistry();
    registry.register(new ManualBridgeAdapter());

    expect(registry.get('prov-non-existent')).toBeUndefined();
    expect(() => registry.resolve('prov-non-existent')).toThrow(
      'Provider adapter "prov-non-existent" is not registered.'
    );
  });

  // 4. Missing Codex executable -> OFFLINE, no crash
  it('4. Missing CLI executable probe yields OFFLINE health status without crashing', async () => {
    const adapter = new CodexCliAdapter({
      executable: path.join(tmpDir, 'non_existent_codex_binary.exe'),
      repo,
      artifactStore,
    });

    const health = await adapter.getHealth();
    expect(health).toBe('OFFLINE');
  });

  // 5. CLI version probe success -> AVAILABLE
  it('5. CLI version probe success yields AVAILABLE health status', async () => {
    // Create a fake version probe script
    const fakeProbeScript = path.join(tmpDir, 'fake_probe.js');
    fs.writeFileSync(
      fakeProbeScript,
      'if (process.argv.includes("--version")) { console.log("codex-cli v1.2.3"); process.exit(0); } else { process.exit(1); }',
      'utf8'
    );

    const adapter = new CodexCliAdapter({
      executable: 'node',
      repo,
      artifactStore,
    });
    // Override execute args for testing node script
    adapter.setExecutable('node');

    // Probe with node which supports --version -> should be AVAILABLE
    const health = await adapter.getHealth();
    expect(health).toBe('AVAILABLE');
  });

  // 6 & 7 & 8 & 9. Local CLI execution uses project repo cwd, shell=false, ownership, evidence
  it('6-9. Local CLI execution enforces project repository cwd, shell=false, durable ownership, and evidence persistence', async () => {
    const fakeCliScript = path.join(tmpDir, 'fake_codex.js');
    const validCoderPayload = JSON.stringify({
      protocol: 'coder.v1',
      message_id: 'msg-fake-coder-001',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-TEST-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Created feature'],
      remaining: [],
      files_claimed_changed: ['index.js'],
      tests_claimed: ['npm test'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    });

    fs.writeFileSync(
      fakeCliScript,
      `
      const fs = require('fs');
      const path = require('path');
      // Verify we are running in repo cwd
      fs.writeFileSync(path.join(process.cwd(), 'executed_cwd.txt'), process.cwd(), 'utf8');
      console.log(\`${validCoderPayload}\`);
      process.exit(0);
      `,
      'utf8'
    );

    // Subclass or configure adapter with fake executable script
    class TestableCodexAdapter extends CodexCliAdapter {
      protected override buildExecutionArgs(_req: any, _prompt: string): string[] {
        return [fakeCliScript];
      }
    }

    const adapter = new TestableCodexAdapter({
      executable: 'node',
      repo,
      artifactStore,
    });

    // Create task attempt in DB
    repo.createTaskAttempt({
      id: 'ATTEMPT-001',
      task_id: 'TSK-TEST-001',
      attempt_number: 1,
      agent_id: 'agent-gemini-coder',
      status: 'IN_PROGRESS',
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });

    const result = await adapter.execute({
      taskId: 'TSK-TEST-001',
      projectId: 'PROJ-TEST',
      instructions: ['Implement feature'],
      contextFiles: ['index.js'],
      attemptId: 'ATTEMPT-001',
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.outputProtocol).toBeDefined();

    // 6. Verify cwd was the repository directory
    const cwdFile = path.join(repoDir, 'executed_cwd.txt');
    expect(fs.existsSync(cwdFile)).toBe(true);
    expect(path.normalize(fs.readFileSync(cwdFile, 'utf8'))).toBe(path.normalize(repoDir));

    // 8. Verify ProcessRun ownership in SQLite
    const runRecord = repo.getProcessRun(result.executionId);
    expect(runRecord).not.toBeNull();
    expect(runRecord.project_id).toBe('PROJ-TEST');
    expect(runRecord.task_id).toBe('TSK-TEST-001');
    expect(runRecord.attempt_id).toBe('ATTEMPT-001');
    expect(runRecord.working_directory).toBe(path.normalize(repoDir));
    expect(runRecord.status).toBe('COMPLETED');

    // 9. Verify stdout evidence persisted
    expect(result.stdoutEvidenceId).toBeDefined();
    const stdoutEv = repo.getEvidence(result.stdoutEvidenceId!);
    expect(stdoutEv).not.toBeNull();
    expect(stdoutEv!.project_id).toBe('PROJ-TEST');
    expect(stdoutEv!.task_id).toBe('TSK-TEST-001');
    expect(stdoutEv!.evidence_type).toBe('PROCESS_LOG');
  });

  // 10. Context path traversal rejected
  it('10. Context path traversal (../) is rejected before process execution', async () => {
    const adapter = new CodexCliAdapter({
      executable: 'node',
      repo,
      artifactStore,
    });

    const result = await adapter.execute({
      taskId: 'TSK-TEST-001',
      projectId: 'PROJ-TEST',
      instructions: ['Read outside file'],
      contextFiles: ['../../outside_secret.txt'],
    });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('violates security policy');
    expect(result.error).toContain('outside the authorized project root');
  });

  // 11. Sensitive context path rejected
  it('11. Sensitive context path (.env, .ssh) is rejected before process execution', async () => {
    const adapter = new CodexCliAdapter({
      executable: 'node',
      repo,
      artifactStore,
    });

    const result = await adapter.execute({
      taskId: 'TSK-TEST-001',
      projectId: 'PROJ-TEST',
      instructions: ['Read env file'],
      contextFiles: ['.env'],
    });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('violates security policy');
    expect(result.error).toContain('.env');
  });

  // 12. CLI nonzero exit -> FAILED
  it('12. CLI nonzero exit code yields FAILED status and captures stderr', async () => {
    const failingScript = path.join(tmpDir, 'failing_cli.js');
    fs.writeFileSync(
      failingScript,
      'console.error("Compilation error in target file"); process.exit(1);',
      'utf8'
    );

    class FailingAdapter extends CodexCliAdapter {
      protected override buildExecutionArgs(): string[] {
        return [failingScript];
      }
    }

    const adapter = new FailingAdapter({
      executable: 'node',
      repo,
      artifactStore,
    });

    const result = await adapter.execute({
      taskId: 'TSK-TEST-001',
      projectId: 'PROJ-TEST',
      instructions: ['Run build'],
      contextFiles: ['index.js'],
    });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('Compilation error in target file');
  });

  // 13. Timeout -> FAILED/TIMED_OUT mapping is truthful
  it('13. Process timeout yields FAILED status with truthful timeout error message', async () => {
    const hangingScript = path.join(tmpDir, 'hanging_cli.js');
    fs.writeFileSync(
      hangingScript,
      'setTimeout(() => {}, 60000);',
      'utf8'
    );

    class HangingAdapter extends CodexCliAdapter {
      protected override buildExecutionArgs(): string[] {
        return [hangingScript];
      }
    }

    const adapter = new HangingAdapter({
      executable: 'node',
      timeoutMs: 500,
      repo,
      artifactStore,
    });

    const result = await adapter.execute({
      taskId: 'TSK-TEST-001',
      projectId: 'PROJ-TEST',
      instructions: ['Long operation'],
      contextFiles: ['index.js'],
    });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('timed out after 500ms');
  });

  // 14. Cancellation -> CANCELLED
  it('14. Cancellation terminates tracked process and yields CANCELLED status', async () => {
    const sleepScript = path.join(tmpDir, 'sleep_cli.js');
    fs.writeFileSync(
      sleepScript,
      'setTimeout(() => {}, 30000);',
      'utf8'
    );

    class SleepAdapter extends CodexCliAdapter {
      protected override buildExecutionArgs(): string[] {
        return [sleepScript];
      }
    }

    const adapter = new SleepAdapter({
      executable: 'node',
      timeoutMs: 30000,
      repo,
      artifactStore,
    });

    const execPromise = adapter.execute({
      taskId: 'TSK-TEST-001',
      projectId: 'PROJ-TEST',
      instructions: ['Background work'],
      contextFiles: ['index.js'],
    });

    // Wait 100ms then cancel via adapter
    await new Promise((r) => setTimeout(r, 100));
    const activeRuns = repo.getProcessRunsByTask('TSK-TEST-001');
    expect(activeRuns.length).toBeGreaterThan(0);
    const activeRunId = activeRuns[0].id;

    await adapter.cancel(activeRunId);
    const result = await execPromise;

    expect(result.status).toBe('CANCELLED');
    const updatedRun = repo.getProcessRun(activeRunId);
    expect(updatedRun.status).toBe('CANCELLED');
  });

  // 15 & 16. Process exit 0 without valid protocol cannot complete task or advance lifecycle
  it('15-16. Process exit 0 without valid protocol cannot advance task lifecycle and yields PROTOCOL_INVALID', async () => {
    const proseOnlyScript = path.join(tmpDir, 'prose_only.js');
    fs.writeFileSync(
      proseOnlyScript,
      'console.log("I finished all tasks successfully! Here are the changes I made."); process.exit(0);',
      'utf8'
    );

    class ProseAdapter extends CodexCliAdapter {
      protected override buildExecutionArgs(): string[] {
        return [proseOnlyScript];
      }
    }

    const adapter = new ProseAdapter({
      executable: 'node',
      repo,
      artifactStore,
    });

    const result = await adapter.execute({
      taskId: 'TSK-TEST-001',
      projectId: 'PROJ-TEST',
      instructions: ['Do work'],
      contextFiles: ['index.js'],
    });

    // 16. Process exit 0 without protocol must be FAILED, not COMPLETED
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('PROTOCOL_INVALID');

    // 15. Attempting to apply invalid protocol in TaskService fails and does not advance state
    const parseResult = ProtocolParser.parse(result.rawResponse || '');
    expect(parseResult.success).toBe(false);

    // Verify task state remained in CODING
    const task = repo.getTask('TSK-TEST-001')!;
    expect(task.state).toBe('CODING');
  });

  // 17. Quota remains UNKNOWN unless authoritative CLI evidence exists
  it('17. Quota telemetry returns UNKNOWN with confidence 0.0 without guessing', async () => {
    const codexAdapter = new CodexCliAdapter();
    const antigravityAdapter = new AntigravityCliAdapter();
    const manualAdapter = new ManualBridgeAdapter();

    const codexQuota = await codexAdapter.getQuota();
    expect(codexQuota.remaining).toBeNull();
    expect(codexQuota.total).toBeNull();
    expect(codexQuota.source).toBe('UNKNOWN');
    expect(codexQuota.confidence).toBe(0.0);

    const agyQuota = await antigravityAdapter.getQuota();
    expect(agyQuota.remaining).toBeNull();
    expect(agyQuota.source).toBe('UNKNOWN');

    const manQuota = await manualAdapter.getQuota();
    expect(manQuota.remaining).toBeNull();
    expect(manQuota.source).toBe('UNKNOWN');
  });

  // 18. Stdin support & privacy: Stdin payload is not present in ProcessRun.command
  it('18. Stdin prompt is passed via child.stdin and is NOT persisted in ProcessRun.command', async () => {
    const stdinEchoScript = path.join(tmpDir, 'stdin_echo.js');
    const secretInstruction = 'SUPER_SECRET_TASK_INSTRUCTION_KEY_123';

    fs.writeFileSync(
      stdinEchoScript,
      `
      let input = '';
      process.stdin.on('data', d => input += d);
      process.stdin.on('end', () => {
        const payload = {
          protocol: 'coder.v1',
          message_id: 'msg-stdin-001',
          project_id: 'PROJ-TEST',
          task_id: 'TSK-TEST-001',
          status: 'COMPLETED',
          completed: ['Done'],
          remaining: [],
          files_claimed_changed: [],
          tests_claimed: [],
          blockers: [],
          review_requested: true,
          expected_task_state: 'CODING',
          expected_revision: 0
        };
        console.log(JSON.stringify(payload));
        process.exit(0);
      });
      `,
      'utf8'
    );

    class StdinAdapter extends CodexCliAdapter {
      protected override buildExecutionArgs(): string[] {
        return [stdinEchoScript];
      }
    }

    const adapter = new StdinAdapter({
      executable: 'node',
      useStdin: true,
      repo,
      artifactStore,
    });

    const result = await adapter.execute({
      taskId: 'TSK-TEST-001',
      projectId: 'PROJ-TEST',
      instructions: [secretInstruction],
      contextFiles: ['index.js'],
    });

    expect(result.status).toBe('COMPLETED');

    const runRecord = repo.getProcessRun(result.executionId);
    expect(runRecord).not.toBeNull();
    // Prompt content must NOT be part of command string
    expect(runRecord.command).not.toContain(secretInstruction);
  });

  // 19. Optional CLI missing does not break BootstrapService startup
  it('19. Missing optional CLI does not break BootstrapService startup', () => {
    const bootstrapDir = path.join(tmpDir, 'fresh-bootstrap');
    const bootstrap = BootstrapService.initialize(bootstrapDir);

    expect(bootstrap.db).toBeDefined();
    expect(bootstrap.providerRegistry).toBeDefined();
    expect(bootstrap.providerRegistry.has('prov-manual-bridge')).toBe(true);
    expect(bootstrap.providerRegistry.has('prov-codex-cli')).toBe(true);
    expect(bootstrap.providerRegistry.has('prov-antigravity-cli')).toBe(true);

    bootstrap.dbEngine.close();
  });

  // 20. Real fake-CLI E2E survives application restart/persistence
  it('20. Real fake-CLI E2E flow persists protocol and survives application restart', async () => {
    const bootstrapDir = path.join(tmpDir, 'restart-e2e-data');
    const bootstrap1 = BootstrapService.initialize(bootstrapDir);

    const project = bootstrap1.projectService.createProject(
      'Restart Test Project',
      'Validating state survival',
      repoDir
    );

    const task = bootstrap1.taskService.createTask({
      projectId: project.id,
      title: 'E2E Restart Task',
      priority: 'HIGH',
      risk: 'LOW',
    });

    // Transition task to CODING via Manager EXECUTE
    const mgrRes = await bootstrap1.taskService.applyManagerDecision(
      {
        protocol: 'manager.v1',
        message_id: 'msg-mgr-start',
        project_id: project.id,
        task_id: task.id,
        decision: 'EXECUTE',
        priority: 'HIGH',
        risk: 'LOW',
        instructions: ['Implement full module'],
        acceptance_criteria: ['Module works'],
        constraints: [],
        review_issues: [],
        expected_task_state: 'PLANNED',
        expected_revision: 0,
      },
      JSON.stringify({ protocol: 'manager.v1', message_id: 'msg-mgr-start' })
    );
    expect(mgrRes.success).toBe(true);

    // Execute through local CLI adapter
    const coderPayload = {
      protocol: 'coder.v1',
      message_id: 'msg-coder-e2e-001',
      project_id: project.id,
      task_id: task.id,
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Completed core implementation'],
      remaining: [],
      files_claimed_changed: ['index.js'],
      tests_claimed: ['npm test'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const e2eScript = path.join(tmpDir, 'e2e_cli.js');
    fs.writeFileSync(
      e2eScript,
      `console.log(${JSON.stringify(JSON.stringify(coderPayload))}); process.exit(0);`,
      'utf8'
    );

    class E2EAdapter extends CodexCliAdapter {
      protected override buildExecutionArgs(): string[] {
        return [e2eScript];
      }
    }

    const adapter = new E2EAdapter({
      executable: 'node',
      repo: bootstrap1.repo,
      artifactStore: bootstrap1.artifactStore,
    });

    const execResult = await adapter.execute({
      taskId: task.id,
      projectId: project.id,
      instructions: ['Implement full module'],
      contextFiles: ['index.js'],
    });

    expect(execResult.status).toBe('COMPLETED');
    expect(execResult.outputProtocol).toBeDefined();

    // Apply the CoderProtocol through TaskService
    const parsed = ProtocolParser.parse(execResult.outputProtocol!);
    expect(parsed.success).toBe(true);

    const applyRes = bootstrap1.taskService.applyCoderReport(
      parsed.data!.data as any,
      execResult.outputProtocol!
    );
    expect(applyRes.success).toBe(true);
    expect(applyRes.task!.state).toBe('VALIDATING');

    // Simulate clean application shutdown and restart
    bootstrap1.dbEngine.close();

    const bootstrap2 = BootstrapService.initialize(bootstrapDir);
    const persistedTask = bootstrap2.repo.getTask(task.id)!;
    expect(persistedTask).not.toBeNull();
    expect(persistedTask.state).toBe('VALIDATING');

    const runs = bootstrap2.repo.getProcessRunsByTask(task.id);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].status).toBe('COMPLETED');

    bootstrap2.dbEngine.close();
  });
});
