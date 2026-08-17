import crypto from 'crypto';
import { ProcessRunner } from './ProcessRunner';
import { ArtifactStore } from './ArtifactStore';
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
    customCommand: string = 'npm test'
  ): Promise<TestRun> {
    const parts = customCommand.split(' ');
    const executable = parts[0] || 'npm';
    const args = parts.slice(1);

    const result = await ProcessRunner.execute({
      executable,
      args,
      cwd: repoPath,
      timeoutMs: 120000, // 2 mins timeout
    });

    const outputLog = `=== STDOUT ===\n${result.stdout}\n=== STDERR ===\n${result.stderr}`;

    // Parse simple test numbers (e.g. "X passed, Y failed" or Vitest/Jest output)
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
      failed = 1; // Mark failure if exit code is non-zero
    }

    // Store evidence in ArtifactStore
    const evidenceId = crypto.randomUUID();
    const evidence = this.artifactStore.store(
      evidenceId,
      projectId,
      taskId,
      attemptId,
      'TEST_RESULT',
      `Test run: ${customCommand} (Exit: ${result.exitCode})`,
      outputLog,
      'text/plain'
    );
    this.repo.createEvidence(evidence);

    const testRun: TestRun = {
      id: crypto.randomUUID(),
      task_id: taskId,
      command: customCommand,
      passed_count: passed,
      failed_count: failed,
      skipped_count: skipped,
      duration_ms: result.durationMs,
      exit_code: result.exitCode,
      evidence_id: evidenceId,
      created_at: new Date().toISOString(),
    };

    return testRun;
  }
}
