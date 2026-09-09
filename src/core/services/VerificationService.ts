import crypto from 'crypto';
import { ProcessRunner } from './ProcessRunner';
import { ArtifactStore } from './ArtifactStore';
import { PolicyService } from './PolicyService';
import { Repository } from '../database/repositories';
import { TestRun } from '../types/domain';
import {
  SealedVerificationExecutionInput,
  SealedVerificationResult,
  VerificationExecutionObservation,
} from '../types/adjudication';
import { computeSha256 } from '../../mcp/submissionProtocol';

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
  public processRunner?: { execute: typeof ProcessRunner.execute };

  constructor(
    private repo: Repository,
    private artifactStore: ArtifactStore
  ) {}

  public setProcessRunner(runner: { execute: typeof ProcessRunner.execute }): void {
    this.processRunner = runner;
  }

  public getArtifactStore(): ArtifactStore {
    return this.artifactStore;
  }

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

  public async executeSealedVerification(
    input: SealedVerificationExecutionInput
  ): Promise<VerificationExecutionObservation> {
    const startedAtIso = new Date().toISOString();

    // 1. Recompute and verify the sealed input before process spawn
    const recomputedCommandsHash = computeSha256(input.verification_commands_json);
    if (recomputedCommandsHash !== input.verification_commands_hash) {
      return {
        outcome: 'COMMAND_POLICY_REJECTED',
        failure_code: 'COMMAND_POLICY_REJECTED',
        reason: `Verification commands hash mismatch: expected "${input.verification_commands_hash}", computed "${recomputedCommandsHash}"`,
        command: '',
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
        exit_code: -1,
        duration_ms: 0,
        stdout: '',
        stderr: 'Verification commands hash mismatch',
        stdout_bytes: 0,
        stderr_bytes: 0,
        combined_output: '',
        metrics: { passedCount: 0, failedCount: 0, skippedCount: 0 },
        process_start: 'NOT_STARTED_PROVEN',
        process_termination: 'NOT_APPLICABLE',
        timed_out: false,
        cancelled: false,
      };
    }

    const recomputedWorkspaceHash = computeSha256(input.workspace_snapshot_before_json);
    if (recomputedWorkspaceHash !== input.workspace_snapshot_before_hash) {
      return {
        outcome: 'COMMAND_POLICY_REJECTED',
        failure_code: 'COMMAND_POLICY_REJECTED',
        reason: `Workspace snapshot before hash mismatch: expected "${input.workspace_snapshot_before_hash}", computed "${recomputedWorkspaceHash}"`,
        command: '',
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
        exit_code: -1,
        duration_ms: 0,
        stdout: '',
        stderr: 'Workspace snapshot before hash mismatch',
        stdout_bytes: 0,
        stderr_bytes: 0,
        combined_output: '',
        metrics: { passedCount: 0, failedCount: 0, skippedCount: 0 },
        process_start: 'NOT_STARTED_PROVEN',
        process_termination: 'NOT_APPLICABLE',
        timed_out: false,
        cancelled: false,
      };
    }

    // Strict positive bounded integer timeout validation
    const timeoutMs = input.policy?.timeout_ms;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 600000
    ) {
      return {
        outcome: 'COMMAND_POLICY_REJECTED',
        failure_code: 'COMMAND_POLICY_REJECTED',
        reason: `Timeout must be a validated positive bounded integer between 1 and 600000 ms (got ${timeoutMs})`,
        command: '',
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
        exit_code: -1,
        duration_ms: 0,
        stdout: '',
        stderr: 'Invalid timeout',
        stdout_bytes: 0,
        stderr_bytes: 0,
        combined_output: '',
        metrics: { passedCount: 0, failedCount: 0, skippedCount: 0 },
        process_start: 'NOT_STARTED_PROVEN',
        process_termination: 'NOT_APPLICABLE',
        timed_out: false,
        cancelled: false,
      };
    }

    // 2. Parse frozen command snapshot (must be non-null plain object)
    let parsedCommands: unknown;
    try {
      parsedCommands = JSON.parse(input.verification_commands_json);
    } catch {
      return {
        outcome: 'COMMAND_POLICY_REJECTED',
        failure_code: 'COMMAND_POLICY_REJECTED',
        reason: 'Verification commands snapshot is malformed JSON',
        command: '',
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
        exit_code: -1,
        duration_ms: 0,
        stdout: '',
        stderr: 'Malformed commands JSON',
        stdout_bytes: 0,
        stderr_bytes: 0,
        combined_output: '',
        metrics: { passedCount: 0, failedCount: 0, skippedCount: 0 },
        process_start: 'NOT_STARTED_PROVEN',
        process_termination: 'NOT_APPLICABLE',
        timed_out: false,
        cancelled: false,
      };
    }

    if (
      typeof parsedCommands !== 'object' ||
      parsedCommands === null ||
      Array.isArray(parsedCommands)
    ) {
      return {
        outcome: 'COMMAND_POLICY_REJECTED',
        failure_code: 'COMMAND_POLICY_REJECTED',
        reason: 'Verification commands snapshot must be a non-null plain object',
        command: '',
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
        exit_code: -1,
        duration_ms: 0,
        stdout: '',
        stderr: 'Snapshot must be plain object',
        stdout_bytes: 0,
        stderr_bytes: 0,
        combined_output: '',
        metrics: { passedCount: 0, failedCount: 0, skippedCount: 0 },
        process_start: 'NOT_STARTED_PROVEN',
        process_termination: 'NOT_APPLICABLE',
        timed_out: false,
        cancelled: false,
      };
    }

    const commandsObj = parsedCommands as Record<string, unknown>;
    const testCmd = commandsObj.TEST;
    if (
      typeof testCmd !== 'object' ||
      testCmd === null ||
      Array.isArray(testCmd)
    ) {
      return {
        outcome: 'COMMAND_POLICY_REJECTED',
        failure_code: 'COMMAND_POLICY_REJECTED',
        reason: 'No valid TEST command found in verification commands snapshot',
        command: '',
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
        exit_code: -1,
        duration_ms: 0,
        stdout: '',
        stderr: 'Missing TEST command',
        stdout_bytes: 0,
        stderr_bytes: 0,
        combined_output: '',
        metrics: { passedCount: 0, failedCount: 0, skippedCount: 0 },
        process_start: 'NOT_STARTED_PROVEN',
        process_termination: 'NOT_APPLICABLE',
        timed_out: false,
        cancelled: false,
      };
    }

    const testCmdObj = testCmd as Record<string, unknown>;
    if (typeof testCmdObj.executable !== 'string' || !Array.isArray(testCmdObj.args)) {
      return {
        outcome: 'COMMAND_POLICY_REJECTED',
        failure_code: 'COMMAND_POLICY_REJECTED',
        reason: 'TEST command missing valid executable string or args array',
        command: '',
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
        exit_code: -1,
        duration_ms: 0,
        stdout: '',
        stderr: 'Invalid TEST command structure',
        stdout_bytes: 0,
        stderr_bytes: 0,
        combined_output: '',
        metrics: { passedCount: 0, failedCount: 0, skippedCount: 0 },
        process_start: 'NOT_STARTED_PROVEN',
        process_termination: 'NOT_APPLICABLE',
        timed_out: false,
        cancelled: false,
      };
    }

    const executable = testCmdObj.executable;
    const args: string[] = [];
    for (const a of testCmdObj.args) {
      if (typeof a !== 'string') {
        return {
          outcome: 'COMMAND_POLICY_REJECTED',
          failure_code: 'COMMAND_POLICY_REJECTED',
          reason: 'TEST command args must only contain strings',
          command: '',
          repo_path: input.repo_path,
          started_at: startedAtIso,
          finished_at: new Date().toISOString(),
          exit_code: -1,
          duration_ms: 0,
          stdout: '',
          stderr: 'Invalid arg types',
          stdout_bytes: 0,
          stderr_bytes: 0,
          combined_output: '',
          metrics: { passedCount: 0, failedCount: 0, skippedCount: 0 },
          process_start: 'NOT_STARTED_PROVEN',
          process_termination: 'NOT_APPLICABLE',
          timed_out: false,
          cancelled: false,
        };
      }
      args.push(a);
    }

    const commandName = typeof testCmdObj.name === 'string' ? testCmdObj.name : 'Frozen Authorization Test Suite';
    const fullCommandStr = `${executable} ${args.join(' ')}`;

    // 3. PolicyService execution gate
    const policy = PolicyService.evaluateProcessExecution(executable, args, false);
    if (!policy.allowed) {
      return {
        outcome: 'COMMAND_POLICY_REJECTED',
        failure_code: 'POLICY_VIOLATION',
        reason: `Verification denied by PolicyService: ${policy.reason} (${policy.decision})`,
        command: fullCommandStr,
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
        exit_code: -1,
        duration_ms: 0,
        stdout: '',
        stderr: `Security Policy Violation: ${policy.reason}`,
        stdout_bytes: 0,
        stderr_bytes: 0,
        combined_output: '',
        metrics: { passedCount: 0, failedCount: 0, skippedCount: 0 },
        process_start: 'NOT_STARTED_PROVEN',
        process_termination: 'NOT_APPLICABLE',
        timed_out: false,
        cancelled: false,
      };
    }

    // 4. Spawn and execute with ProcessRunner (ZERO DB WRITES!)
    let result: import('./ProcessRunner').ProcessRunResult;
    try {
      const runner = this.processRunner || ProcessRunner;
      result = await runner.execute({
        executable,
        args,
        cwd: input.repo_path,
        timeoutMs,
        maxStdoutBytes: input.policy?.max_stdout_bytes,
        maxStderrBytes: input.policy?.max_stderr_bytes,
        allowedEnvKeys: input.policy?.allowed_env_keys,
        executionId: input.verification_execution_id,
        // ZERO DB WRITES: repo and artifactStore are omitted!
      });
    } catch (spawnErr: unknown) {
      const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      return {
        outcome: 'RECOVERY_FENCED',
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        error: `Ambiguous process execution failure: ${errMsg}`,
        command: fullCommandStr,
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
        exit_code: -1,
        duration_ms: 0,
        stdout: '',
        stderr: errMsg,
        stdout_bytes: 0,
        stderr_bytes: 0,
        combined_output: '',
        metrics: { passedCount: 0, failedCount: 0, skippedCount: 0 },
        process_start: 'START_AMBIGUOUS',
        process_termination: 'TERMINATION_UNRESOLVED',
        timed_out: false,
        cancelled: false,
      };
    }

    const finishedAtIso = new Date().toISOString();
    const stdout = result.stdout;
    const stderr = result.stderr;
    const combinedOutput = `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}`;
    const metrics = parseTestMetrics(stdout, result.exitCode);
    const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
    const stderrBytes = Buffer.byteLength(stderr, 'utf8');

    // 5. Explicit Process Truth Classification per Section 6.4:
    // - Policy / launch failure before spawn
    if (result.errorCode === 'PROCESS_LAUNCH_FAILED' && result.pid === null && result.processStart === 'NOT_STARTED_PROVEN') {
      return {
        outcome: 'PROCESS_START_FAILED',
        failure_code: 'PROCESS_START_FAILED',
        error: result.stderr || 'Process launch failed before spawn',
        command: fullCommandStr,
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: finishedAtIso,
        exit_code: -1,
        duration_ms: result.durationMs,
        stdout,
        stderr,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        combined_output: combinedOutput,
        metrics,
        process_start: 'NOT_STARTED_PROVEN',
        process_termination: 'NOT_APPLICABLE',
        timed_out: false,
        cancelled: false,
      };
    }

    // - Ambiguous process start or unresolved process tree termination MUST produce RECOVERY_FENCED
    if (
      result.processStart === 'START_AMBIGUOUS' ||
      result.processTermination === 'TERMINATION_UNRESOLVED' ||
      (result.pid !== null && (result.cancelled || (result.exitCode === -1 && !result.timedOut)))
    ) {
      let failureCode = 'ORPHANED_VERIFICATION_INTERRUPTED';
      if (result.processStart === 'START_AMBIGUOUS' || result.processStart === 'NOT_STARTED_PROVEN') {
        failureCode = 'PROCESS_START_FAILED';
      } else if (result.processTermination === 'TERMINATION_UNRESOLVED') {
        failureCode = 'PROCESS_TERMINATION_UNRESOLVED';
      }
      return {
        outcome: 'RECOVERY_FENCED',
        failure_code: failureCode,
        error: result.stderr || 'Process start or termination truth is not durably proven',
        command: fullCommandStr,
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: finishedAtIso,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
        stdout,
        stderr,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        combined_output: combinedOutput,
        metrics,
        process_start: result.processStart,
        process_termination: result.processTermination,
        timed_out: result.timedOut,
        cancelled: result.cancelled,
      };
    }

    // - Authoritative timeout with proven termination
    if (result.timedOut) {
      return {
        outcome: 'TEST_TIMEOUT',
        failure_code: 'VERIFICATION_TIMEOUT',
        error: `Test execution timed out after ${result.durationMs}ms`,
        command: fullCommandStr,
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: finishedAtIso,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
        stdout,
        stderr,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        combined_output: combinedOutput,
        metrics,
        process_start: result.processStart,
        process_termination: result.processTermination,
        timed_out: true,
        cancelled: false,
      };
    }

    // - Authoritative non-zero exit
    if (result.exitCode !== 0) {
      return {
        outcome: 'TEST_FAILED',
        failure_code: 'TESTS_FAILED',
        error: `Test run failed with exit code ${result.exitCode}`,
        command: fullCommandStr,
        repo_path: input.repo_path,
        started_at: startedAtIso,
        finished_at: finishedAtIso,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
        stdout,
        stderr,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        combined_output: combinedOutput,
        metrics,
        process_start: result.processStart,
        process_termination: result.processTermination,
        timed_out: false,
        cancelled: false,
      };
    }

    // - Authoritative 0 exit (Success)
    return {
      outcome: 'SUCCESS',
      failure_code: null,
      command: fullCommandStr,
      repo_path: input.repo_path,
      started_at: startedAtIso,
      finished_at: finishedAtIso,
      exit_code: 0,
      duration_ms: result.durationMs,
      stdout,
      stderr,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      combined_output: combinedOutput,
      metrics,
      process_start: result.processStart,
      process_termination: result.processTermination,
      timed_out: false,
      cancelled: false,
    };
  }

  public async runTestsWithFrozenCommand(
    projectId: string,
    taskId: string,
    attemptId: string | null,
    repoPath: string,
    frozenCommand: {
      executable: string;
      args: string[];
      timeout_ms?: number;
      name?: string;
    }
  ): Promise<TestRun> {
    const executable = frozenCommand.executable;
    const args = frozenCommand.args;
    const timeoutMs = frozenCommand.timeout_ms;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 600000
    ) {
      return this.recordFailure(
        projectId,
        taskId,
        attemptId,
        frozenCommand.name || 'Frozen Command',
        `COMMAND_POLICY_REJECTED: Frozen command timeout must be a positive integer between 1 and 600000 ms (got ${timeoutMs})`
      );
    }
    const commandName = frozenCommand.name || 'Frozen Authorization Test Suite';
    const fullCommandStr = `${executable} ${args.join(' ')}`;

    // 1. PolicyService execution gate
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

    // 2. Execute with ProcessRunner, persisting process output evidence
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

    // 3. Parse test results & metrics
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
