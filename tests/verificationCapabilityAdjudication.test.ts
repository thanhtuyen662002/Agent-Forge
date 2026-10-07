import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { VerificationCapabilityService } from '../src/core/services/VerificationCapabilityService';
import { ProcessRunner } from '../src/core/services/ProcessRunner';
import { GitService } from '../src/core/services/GitService';
import { evaluateCanonicalSettlementDecision, validateAndParseCanonicalResultEnvelope } from '../src/core/services/CoderSubmissionAdjudicationService';
import { createTestDatabase, setupFullSubmissionGraph, issueSubmissionSessionHelper, createValidSubmissionPayload,
  type FullAdjudicationFixtures } from './r5j5/harness';

describe('durable capability rejection at adjudication settlement', () => {
  let root: string;
  let fixture: FullAdjudicationFixtures;
  beforeEach(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-cap-adjudication-')));
    const project = path.join(root, 'repo');
    fs.mkdirSync(project);
    for (const args of [['init'], ['config', 'user.name', 'Test User'], ['config', 'user.email', 'test@example.com']]) {
      execFileSync('git', args, { cwd: project, stdio: 'ignore', windowsHide: true });
    }
    fs.writeFileSync(path.join(project, 'README.md'), '# Fixture\n');
    fs.writeFileSync(path.join(project, '.gitignore'), 'temp-artifacts\n');
    execFileSync('git', ['add', '.'], { cwd: project, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['commit', '-m', 'Fixture'], { cwd: project, stdio: 'ignore', windowsHide: true });
    fixture = await setupFullSubmissionGraph(createTestDatabase(root, 'state.sqlite').db, project, path.join(root, 'artifacts'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (fixture?.db.open) fixture.db.close();
    if (fs.realpathSync.native(root) !== root || !path.basename(root).startsWith('af-cap-adjudication-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it.each(['after-child', 'final-git', 'settlement'] as const)('persists policy failure with actual exit zero after withdrawal at %s, including recovery replay', async (phase) => {
    const { repo, adjudicationService, recoveryScanner } = fixture;
    const command = JSON.parse(repo.getExecutionAuthorization(fixture.authorizationId)!.canonical_payload_json!).verificationCommands.TEST;
    let childCompleted = false;
    let revoked = false;
    const revoke = () => {
      new VerificationCapabilityService(repo).revoke(command.capability!);
      revoked = true;
    };
    const execute = ProcessRunner.execute.bind(ProcessRunner);
    vi.spyOn(ProcessRunner, 'execute').mockImplementation(async (options) => {
      const result = await execute(options);
      if (options.verificationBoundary) {
        expect(result).toMatchObject({ exitCode: 0, processStart: 'STARTED_PROVEN' });
        childCompleted = true;
        if (phase === 'after-child') revoke();
      }
      return result;
    });
    const getDiff = GitService.getDiff.bind(GitService);
    vi.spyOn(GitService, 'getDiff').mockImplementation(async (...args) => {
      const result = await getDiff(...args);
      if (phase === 'final-git' && childCompleted && !revoked) revoke();
      return result;
    });
    const immediate = repo.runInImmediateTransaction.bind(repo);
    vi.spyOn(repo, 'runInImmediateTransaction').mockImplementation((fn) => {
      if (phase === 'settlement' && childCompleted && !revoked) revoke();
      return immediate(fn);
    });
    const { plaintextToken } = issueSubmissionSessionHelper(repo, fixture.authorizationId);
    const submissionId = crypto.randomUUID();
    fixture.mcpService.submitCoderClaim(createValidSubmissionPayload(fixture, submissionId), plaintextToken);
    const result = await adjudicationService.admitSubmissionForVerification({ requestId: crypto.randomUUID(), submissionId });
    expect(childCompleted && revoked).toBe(true);
    expect(result).toMatchObject({ status: 'VERIFICATION_FAILED', adjudication: { failure_code: 'COMMAND_POLICY_REJECTED', lifecycle_version: 3 } });
    expect(repo.getTask(fixture.taskId)?.state).not.toBe('REVIEW_READY');
    expect(repo.getLatestTestRun(fixture.taskId)?.exit_code).toBe(0);
    expect(repo.getWorkspaceLeaseByAdjudication(result.adjudication.id)).toMatchObject({ state: 'RELEASED' });
    const parsed = validateAndParseCanonicalResultEnvelope(result.adjudication.verification_result_envelope_json!, result.adjudication.verification_result_envelope_hash!);
    expect(parsed).toMatchObject({ valid: true, envelope: { exit_classification: 'EXIT_ZERO', failure_code: 'COMMAND_POLICY_REJECTED',
      process_start_classification: 'SPAWNED_PROVEN', termination_classification: 'TERMINATION_PROVEN' } });
    expect(evaluateCanonicalSettlementDecision({
      rawEnvelopeJson: result.adjudication.verification_result_envelope_json!, storedEnvelopeHash: result.adjudication.verification_result_envelope_hash!,
      rawManifestJson: result.adjudication.artifact_manifest_json!, storedManifestHash: result.adjudication.artifact_manifest_hash!,
      adjudication: result.adjudication, testRun: repo.getLatestTestRun(fixture.taskId)!,
      gitStatusEvidenceId: result.adjudication.git_status_evidence_id, gitDiffEvidenceId: result.adjudication.git_diff_evidence_id,
      testResultEvidenceId: repo.getLatestTestRun(fixture.taskId)!.evidence_id!, repo, artifactStore: fixture.artifactStore,
    })).toMatchObject({ valid: true, isSuccess: false, targetStatus: 'VERIFICATION_FAILED', failureCode: 'COMMAND_POLICY_REJECTED' });
    expect(repo.getCoderSubmissionDispositions(submissionId).some((row) => row.disposition_reason === 'ACCEPTED_VERIFIED')).toBe(false);
    const before = JSON.stringify(repo.getCoderSubmissionAdjudicationById(result.adjudication.id));
    recoveryScanner.scanAndReconcile();
    recoveryScanner.scanAndReconcile();
    expect(JSON.stringify(repo.getCoderSubmissionAdjudicationById(result.adjudication.id))).toBe(before);
    expect(repo.getCoderSubmissionAdjudicationEvents(result.adjudication.id).filter((event) => event.event_type === 'VERIFICATION_FAILED')).toHaveLength(1);
  });
});
