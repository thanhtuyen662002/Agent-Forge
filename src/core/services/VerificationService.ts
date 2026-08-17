import crypto from 'crypto';
import { ProcessRunner } from './ProcessRunner';
import { ArtifactStore } from './ArtifactStore';
import { PolicyService } from './PolicyService';
import { Repository } from '../database/repositories';
import { TestRun } from '../types/domain';

export class VerificationService {
  constructor(
    private repo: Repository,
    private artifactStore: ArtifactStore
  ) {}

  public async runTests(
    projectId: string,
    taskId: string,
    attemptId: string | null,
    repoPath: string,
    commandConfigId?: string
  ): Promise<TestRun> {
    // 1. Resolve configured command or create default
    let executable = 'npm';
    let args = ['test'];
    let timeoutMs = 120000;
    let commandName = 'npm test';

    if (commandConfigId) {
      const cfg = this.repo.getVerificationCommandById(commandConfigId);
      if (cfg && cfg.project_id === projectId && cfg.enabled) {
        executable = cfg.executable;
        args = cfg.args;
        timeoutMs = cfg.timeout_ms || 120000;
        commandName = cfg.name;
      }
    } else {
      // Check if project has any configured test command
      const cmds = this.repo.getVerificationCommandsByProject(projectId);
      const testCmd = cmds.find((c) => c.command_type === 'TEST' && c.enabled);
      if (testCmd) {
        executable = testCmd.executable;
        args = testCmd.args;
        timeoutMs = testCmd.timeout_ms || 120000;
        commandName = testCmd.name;
      }
    }

    const fullCommandStr = `${executable} ${args.join(' ')}`;

    // 2. PolicyService execution gate
    const policy = PolicyService.evaluateProcessExecution(executable, args, false);
    if (!policy.allowed) {
      const errorMsg = `Verification denied by PolicyService: ${policy.reason} (${policy.decision})`;
      const evidenceId = crypto.randomUUID();
      const evidence = this.artifactStore.store(
        evidenceId,
        projectId,
        taskId,
        attemptId,
        'TEST_RESULT',
        `Verification Policy Violation: ${fullCommandStr}`,
        errorMsg,
        'text/plain'
      );
      this.repo.createEvidence(evidence);

      const failedRun: TestRun = {
        id: crypto.randomUUID(),
        task_id: taskId,
        command: fullCommandStr,
        passed_count: 0,
        failed_count: 1,
        skipped_count: 0,
        duration_ms: 0,
        exit_code: -1,
        evidence_id: evidenceId,
        created_at: new Date().toISOString(),
      };
      this.repo.createTestRun(failedRun);
      return failedRun;
    }

    // 3. Execute with ProcessRunner
    const result = await ProcessRunner.execute({
      executable,
      args,
      cwd: repoPath,
      timeoutMs,
      repo: this.repo,
    });

    const outputLog = `=== COMMAND ===\n${fullCommandStr}\n=== STDOUT ===\n${result.stdout}\n=== STDERR ===\n${result.stderr}`;

    let passed = 0;
    let failed = 0;
    let skipped = 0;

    const passMatch = outputLog.match(/(\d+)\s+(?:passed|passing)/i);
    if (passMatch && passMatch[1]) {
      passed = parseInt(passMatch[1], 10);
    }

    const failMatch = outputLog.match(/(\d+)\s+(?:failed|failing)/i);
    if (failMatch && failMatch[1]) {
      failed = parseInt(failMatch[1], 10);
    }

    if (result.exitCode !== 0 && failed === 0) {
      failed = 1;
    }

    // Store evidence in ArtifactStore
    const evidenceId = crypto.randomUUID();
    const evidence = this.artifactStore.store(
      evidenceId,
      projectId,
      taskId,
      attemptId,
      'TEST_RESULT',
      `Test run: ${fullCommandStr} (Exit: ${result.exitCode})`,
      outputLog,
      'text/plain'
    );
    this.repo.createEvidence(evidence);

    const testRun: TestRun = {
      id: crypto.randomUUID(),
      task_id: taskId,
      command: fullCommandStr,
      passed_count: passed,
      failed_count: failed,
      skipped_count: skipped,
      duration_ms: result.durationMs,
      exit_code: result.exitCode,
      evidence_id: evidenceId,
      created_at: new Date().toISOString(),
    };

    // 4. Persist durable TestRun
    this.repo.createTestRun(testRun);

    return testRun;
  }
}
