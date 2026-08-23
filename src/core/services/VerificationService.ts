import crypto from 'crypto';
import { ProcessRunner } from './ProcessRunner';
import { ArtifactStore } from './ArtifactStore';
import { PolicyService } from './PolicyService';
import { Repository } from '../database/repositories';
import { TestRun } from '../types/domain';

export { shouldRunCoderVerification } from '../state/taskStateMachine';

export interface ParsedTestMetrics {
  passedCount: number;
  failedCount: number;
  skippedCount: number;
}

export function parseTestMetrics(stdout: string, exitCode: number): ParsedTestMetrics {
  if (!stdout || typeof stdout !== 'string') {
    return exitCode === 0
      ? { passedCount: 1, failedCount: 0, skippedCount: 0 }
      : { passedCount: 0, failedCount: 1, skippedCount: 0 };
  }

  // Priority 1: Node.js node:test TAP / spec summary forms:
  // e.g. "# pass 9", "ℹ pass 9", "# fail 0", "ℹ fail 0", "# skipped 2", "ℹ skipped 2"
  // Must be bounded to start of line to avoid random test prose.
  const tapPassMatch = stdout.match(/(?:^|\r?\n)\s*(?:#|ℹ)?\s*pass\s+(\d+)\b/i);
  const tapFailMatch = stdout.match(/(?:^|\r?\n)\s*(?:#|ℹ)?\s*fail\s+(\d+)\b/i);
  const tapSkipMatch = stdout.match(/(?:^|\r?\n)\s*(?:#|ℹ)?\s*(?:skipped|skip)\s+(\d+)\b/i);

  // Priority 2: Count-first formats:
  // e.g. "9 passed", "9 pass", "Tests  440 passed (440)", "2 failed", "1 skipped"
  const countFirstPassMatch = stdout.match(/(?:^|\r?\n|\s)(\d+)\s+pass(?:ed|es)?\b/i);
  const countFirstFailMatch = stdout.match(/(?:^|\r?\n|\s)(\d+)\s+fail(?:ed|ing|s)?\b/i);
  const countFirstSkipMatch = stdout.match(/(?:^|\r?\n|\s)(\d+)\s+skip(?:ped|s)?\b/i);

  const hasTapMetric = tapPassMatch !== null || tapFailMatch !== null || tapSkipMatch !== null;
  const hasCountFirstMetric =
    countFirstPassMatch !== null || countFirstFailMatch !== null || countFirstSkipMatch !== null;

  if (!hasTapMetric && !hasCountFirstMetric) {
    return exitCode === 0
      ? { passedCount: 1, failedCount: 0, skippedCount: 0 }
      : { passedCount: 0, failedCount: 1, skippedCount: 0 };
  }

  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  if (tapPassMatch) {
    passedCount = parseInt(tapPassMatch[1], 10);
  } else if (countFirstPassMatch) {
    passedCount = parseInt(countFirstPassMatch[1], 10);
  }

  if (tapFailMatch) {
    failedCount = parseInt(tapFailMatch[1], 10);
  } else if (countFirstFailMatch) {
    failedCount = parseInt(countFirstFailMatch[1], 10);
  }

  if (tapSkipMatch) {
    skippedCount = parseInt(tapSkipMatch[1], 10);
  } else if (countFirstSkipMatch) {
    skippedCount = parseInt(countFirstSkipMatch[1], 10);
  }

  return {
    passedCount,
    failedCount,
    skippedCount,
  };
}

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
    // 1. Resolve configured command with strict fail-closed validation
    let executable: string;
    let args: string[];
    let timeoutMs: number;
    let commandName: string;

    if (commandConfigId) {
      const cfg = this.repo.getVerificationCommandById(commandConfigId);
      if (!cfg) {
        return this.recordFailure(
          projectId,
          taskId,
          attemptId,
          `Config ID: ${commandConfigId}`,
          `VERIFICATION_CONFIG_NOT_FOUND: Configured verification command "${commandConfigId}" does not exist.`
        );
      }
      if (cfg.project_id !== projectId) {
        return this.recordFailure(
          projectId,
          taskId,
          attemptId,
          cfg.name,
          `VERIFICATION_CROSS_PROJECT_MISMATCH: Verification command "${commandConfigId}" belongs to project "${cfg.project_id}", not "${projectId}".`
        );
      }
      if (!cfg.enabled) {
        return this.recordFailure(
          projectId,
          taskId,
          attemptId,
          cfg.name,
          `VERIFICATION_CONFIG_DISABLED: Verification command "${cfg.name}" is disabled.`
        );
      }
      if (cfg.command_type !== 'TEST') {
        return this.recordFailure(
          projectId,
          taskId,
          attemptId,
          cfg.name,
          `VERIFICATION_TYPE_MISMATCH: Verification command "${cfg.name}" has type "${cfg.command_type}", expected "TEST".`
        );
      }

      executable = cfg.executable;
      args = cfg.args;
      timeoutMs = cfg.timeout_ms || 120000;
      commandName = cfg.name;
    } else {
      // Look up enabled default TEST command for project
      const cmds = this.repo.getVerificationCommandsByProject(projectId);
      const testCmd = cmds.find((c) => c.command_type === 'TEST' && c.enabled);
      if (!testCmd) {
        return this.recordFailure(
          projectId,
          taskId,
          attemptId,
          'Unconfigured Test Suite',
          `VERIFICATION_NOT_CONFIGURED: No enabled TEST verification command is configured for project "${projectId}".`
        );
      }

      executable = testCmd.executable;
      args = testCmd.args;
      timeoutMs = testCmd.timeout_ms || 120000;
      commandName = testCmd.name;
    }

    const fullCommandStr = `${executable} ${args.join(' ')}`;

    // 2. PolicyService execution gate
    const policy = PolicyService.evaluateProcessExecution(executable, args, false);
    if (!policy.allowed) {
      return this.recordFailure(
        projectId,
        taskId,
        attemptId,
        fullCommandStr,
        `Verification denied by PolicyService: ${policy.reason} (${policy.decision})`
      );
    }

    // 3. Execute with ProcessRunner, persisting process output evidence
    const result = await ProcessRunner.execute({
      executable,
      args,
      cwd: repoPath,
      timeoutMs,
      repo: this.repo,
      artifactStore: this.artifactStore,
      projectId,
      taskId,
    });

    // 4. Parse test results & metrics
    const stdout = result.stdout;
    const stderr = result.stderr;
    const combinedOutput = `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}`;

    const evidenceId = crypto.randomUUID();
    const evidence = this.artifactStore.store(
      evidenceId,
      projectId,
      taskId,
      attemptId,
      'TEST_RESULT',
      `Test Execution (${commandName}): Exit Code ${result.exitCode}`,
      combinedOutput,
      'text/plain'
    );
    this.repo.createEvidence(evidence);

    const metrics = parseTestMetrics(stdout, result.exitCode);

    const testRun: TestRun = {
      id: crypto.randomUUID(),
      task_id: taskId,
      command: fullCommandStr,
      passed_count: metrics.passedCount,
      failed_count: metrics.failedCount,
      skipped_count: metrics.skippedCount,
      duration_ms: result.durationMs,
      exit_code: result.exitCode,
      evidence_id: evidenceId,
      created_at: new Date().toISOString(),
    };

    this.repo.createTestRun(testRun);
    return testRun;
  }

  private recordFailure(
    projectId: string,
    taskId: string,
    attemptId: string | null,
    commandStr: string,
    errorMessage: string
  ): TestRun {
    const evidenceId = crypto.randomUUID();
    const evidence = this.artifactStore.store(
      evidenceId,
      projectId,
      taskId,
      attemptId,
      'TEST_RESULT',
      `Verification Configuration Failure: ${commandStr}`,
      errorMessage,
      'text/plain'
    );
    this.repo.createEvidence(evidence);

    const failedRun: TestRun = {
      id: crypto.randomUUID(),
      task_id: taskId,
      command: commandStr,
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
}
