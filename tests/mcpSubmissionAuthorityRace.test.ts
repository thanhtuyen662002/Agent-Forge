import fs from 'fs';
import path from 'path';
import child_process from 'child_process';
import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { McpSubmissionAuthorityService } from '../src/core/services/McpSubmissionAuthorityService';

const VALID_TOKEN = `af-sub-${'a'.repeat(43)}`;

function validInput(): Record<string, unknown> {
  return {
    submission_id: crypto.randomUUID(),
    authorization_id: 'authorization-race-test',
    project_id: 'project-race-test',
    task_id: 'task-race-test',
    attempt_id: 'attempt-race-test',
    assignment_id: 'assignment-race-test',
    task_ownership_epoch: 1,
    base_sha: 'b'.repeat(40),
    repository_head_sha: 'c'.repeat(40),
    status: 'COMPLETED',
    summary: 'race admission test',
    changed_files: ['src/example.ts'],
    tests_claimed: ['race-test'],
    blockers: [],
    review_requested: false,
    client_metadata: {
      client_name: 'race-test',
      client_version: '1.0.0',
      client_session_mode: 'CLI_EXTERNAL',
    },
  };
}

describe('MCP submission Git-head race boundary', () => {
  it('does not spawn Git before the immediate transaction revalidates the session', () => {
    const now = new Date(Date.now() + 60_000).toISOString();
    const session = {
      id: 'session-race-test',
      authorization_id: 'authorization-race-test',
      revoked_at: null,
      expires_at: now,
    };
    const auth = {
      id: 'authorization-race-test',
      project_id: 'project-race-test',
      repository_head_sha: 'c'.repeat(40),
    };
    const project = { id: 'project-race-test', repository_path: process.cwd() };
    const db = {
      prepare: () => ({ get: () => ({ c: 0 }) }),
    } as any;
    const repo = {
      getMcpSubmissionSessionByTokenHash: () => session,
      getCoderSubmissionById: () => null,
      getExecutionAuthorization: () => auth,
      getProject: () => project,
      getMcpSubmissionSessionById: () => ({ ...session, revoked_at: new Date().toISOString() }),
      runInImmediateTransaction: (callback: () => unknown) => callback(),
    } as any;
    const service = new McpSubmissionAuthorityService(repo, db);
    const gitSpy = vi.spyOn(child_process, 'execFileSync');

    const result = service.submitCoderClaim(validInput(), VALID_TOKEN);

    expect(result).toMatchObject({ accepted: false, error_code: 'MCP_SESSION_REVOKED' });
    expect(gitSpy).not.toHaveBeenCalled();
    gitSpy.mockRestore();
  });

  it('keeps both trusted HEAD observations inside the transaction and before insertion', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/core/services/McpSubmissionAuthorityService.ts'),
      'utf8'
    );
    const transactionStart = source.indexOf('runInImmediateTransaction<SubmissionResult>');
    const firstObservation = source.indexOf('const observedHeadSha = this.observeRepositoryHead(');
    const secondObservation = source.indexOf('const finalObservedHeadSha = this.observeRepositoryHead(');
    const firstInsert = source.indexOf('this.repo.createCoderSubmission(submissionRecord)');

    expect(transactionStart).toBeGreaterThanOrEqual(0);
    expect(firstObservation).toBeGreaterThan(transactionStart);
    expect(secondObservation).toBeGreaterThan(firstObservation);
    expect(secondObservation).toBeLessThan(firstInsert);
  });
});
