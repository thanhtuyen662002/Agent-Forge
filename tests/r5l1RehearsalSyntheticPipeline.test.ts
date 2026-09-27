import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import child_process from 'child_process';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildAgentForgeReviewerMcpServer } from '../src/mcp/reviewerServer';
import { REVIEWER_TOOL_NAME, REVIEWER_MIME_TYPE } from '../src/mcp/reviewerProtocol';
import { computeSha256 } from '../src/mcp/submissionProtocol';
import { setupSyntheticRehearsalEnv, issueSubmissionSession, getDbTotalChanges, performSafeCleanup, type SyntheticRehearsalEnv } from './helpers/r5l1SyntheticFixture';

describe('R5L1 Rehearsal Synthetic Pipeline Suite', () => {
  let env: SyntheticRehearsalEnv | null = null;

  afterEach(async () => {
    const currentEnv = env;
    env = null;
    if (currentEnv) {
      await performSafeCleanup({
        dbs: [currentEnv.db],
        tempDirs: [currentEnv.tempDir],
        restoreTimers: true,
      });
    } else {
      vi.useRealTimers();
    }
  });

  // =========================================================================
  // SCENARIO 1: Complete Happy Path
  // Quarantined Submission -> Admission -> Verification -> Settlement -> Reviewer Read
  // =========================================================================
  it('1. Full synthetic pipeline: quarantined submission -> admission -> verification -> settlement -> reviewer read (zero-write)', async () => {
    const PROJECTION_CONFIDENTIAL_MARKER = 'FROZEN_PROJECTION_SECRET_MARKER_' + crypto.randomUUID();
    env = setupSyntheticRehearsalEnv({ failVerification: false, taskTitleMarker: PROJECTION_CONFIDENTIAL_MARKER });
    const { repo, db, mcpService, adjudicationService, reviewerService } = env;

    // --- STEP 1: Quarantined Submission ---
    const { plaintextToken } = issueSubmissionSession(repo, env.authorizationId);
    const submissionId = crypto.randomUUID();
    const claimPayload = {
      submission_id: submissionId,
      authorization_id: env.authorizationId,
      project_id: env.projectId,
      task_id: env.taskId,
      attempt_id: env.attemptId,
      assignment_id: env.assignmentId,
      task_ownership_epoch: 1,
      base_sha: env.baseSha,
      repository_head_sha: env.repoHeadSha,
      status: 'COMPLETED',
      summary: `Synthetic execution completed with marker ${PROJECTION_CONFIDENTIAL_MARKER}`,
      changed_files: ['README.md'],
      tests_claimed: ['test-synthetic-1'],
      blockers: [],
      review_requested: true,
      client_metadata: {
        client_name: 'synthetic-coder-agent',
        client_version: '1.0.0',
        client_session_mode: 'CLI_EXTERNAL',
      },
    };

    const submitRes = mcpService.submitCoderClaim(claimPayload, plaintextToken);
    expect(submitRes.accepted).toBe(true);

    const submission = repo.getCoderSubmissionById(submissionId);
    expect(submission).toBeDefined();
    expect(submission?.quarantine_status).toBe('QUARANTINED');
    expect(submission?.claimed_status).toBe('COMPLETED');
    expect(submission?.authorization_id).toBe(env.authorizationId);
    expect(submission?.task_id).toBe(env.taskId);
    expect(submission?.project_id).toBe(env.projectId);

    // --- STEP 2 & 3: Owner Admission & Verification ---
    const admitRequestId = crypto.randomUUID();
    const admitRes = await adjudicationService.admitSubmissionForVerification({
      requestId: admitRequestId,
      submissionId,
    });

    expect(admitRes.status).toBe('VERIFIED');
    expect(admitRes.adjudication).toBeDefined();
    const adjudicationId = admitRes.adjudication.id;

    // Verify task state transitioned to REVIEW_READY
    const taskAfter = repo.getTask(env.taskId);
    expect(taskAfter?.state).toBe('REVIEW_READY');

    // Verify workspace lease (coder_submission_workspace_leases) was acquired and released cleanly
    expect(admitRes.adjudication.workspace_lease_id).toBeDefined();
    expect(typeof admitRes.adjudication.workspace_lease_id).toBe('string');
    const workspaceLease = repo.getWorkspaceLease(admitRes.adjudication.workspace_lease_id!);
    expect(workspaceLease).toBeDefined();
    expect(workspaceLease?.state).toBe('RELEASED');
    expect(workspaceLease?.released_at).not.toBeNull();

    // Verify worker-slot lease (account_leases) was NOT mutated or released by adjudication
    const workerSlotLease = repo.getAccountLease(env.accountLeaseId);
    expect(workerSlotLease).toBeDefined();
    expect(workerSlotLease?.released_at).toBeNull(); // Worker slot lease remains managed by worker lifecycle

    // --- STEP 4: Settlement Dispositions & Events ---
    const dispositions = repo.getCoderSubmissionDispositions(submissionId);
    expect(dispositions.length).toBeGreaterThanOrEqual(1);
    const settledDisp = dispositions.find((d) => d.disposition_event === 'SETTLED');
    expect(settledDisp).toBeDefined();
    expect(settledDisp?.disposition_reason).toBe('ACCEPTED_VERIFIED');

    const adjEvents = repo.getCoderSubmissionAdjudicationEvents(adjudicationId);
    expect(adjEvents.length).toBeGreaterThanOrEqual(3);
    const eventTypes = adjEvents.map((e) => e.event_type);
    expect(eventTypes).toContain('ADMITTED');
    expect(eventTypes).toContain('VERIFICATION_CLAIMED');
    expect(eventTypes).toContain('VERIFICATION_SUCCEEDED');

    // --- STEP 5: Projection Integrity ---
    const projection = adjudicationService.buildVerifiedAdjudicationReviewProjection(adjudicationId);
    expect(projection).toBeDefined();
    expect(projection.adjudication_id).toBe(adjudicationId);
    expect(projection.authoritative_verification.verdict).toBe('PASSED');
    expect(projection.projection_hash).toBeDefined();
    expect(typeof projection.projection_hash).toBe('string');
    expect(projection.projection_hash.length).toBe(64);

    // --- STEP 6: Reviewer MCP Tool & Resource Read (Zero-Write over InMemoryTransport) ---
    const issuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: env.agentIdReviewer,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });
    expect(issuance.raw_token).toBeDefined();

    let mcpServer: any | null = null;
    let mcpClient: Client | null = null;

    try {
      mcpServer = buildAgentForgeReviewerMcpServer({
        db,
        reviewerToken: issuance.raw_token,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcpServer.connect(serverTransport);
      mcpClient = new Client({ name: 'synthetic-reviewer-client', version: '1.0.0' });
      await mcpClient.connect(clientTransport);

      // Baseline database state before reviewer reads
      const changesBefore = getDbTotalChanges(db);
      const dataVersionBefore = db.pragma('data_version', { simple: true }) as number;

      // Reviewer reads tool
      const toolRes = await mcpClient.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: adjudicationId },
      });
      expect(toolRes.isError).toBeFalsy();
      expect(toolRes.content).toHaveLength(1);
      const toolText = (toolRes.content[0] as { type: 'text'; text: string }).text;
      const toolPackage = JSON.parse(toolText);
      expect(toolPackage.adjudication.id).toBe(adjudicationId);
      expect(computeSha256(toolText)).toBe(issuance.session.projection_hash);
      // Verify confidential marker is present in successful tool projection read
      expect(toolText).toContain(PROJECTION_CONFIDENTIAL_MARKER);

      // Reviewer reads resource
      const resourceRes = await mcpClient.readResource({
        uri: `agentforge://reviews/packages/${adjudicationId}`,
      });
      expect(resourceRes.contents).toHaveLength(1);
      expect(resourceRes.contents[0].mimeType).toBe(REVIEWER_MIME_TYPE);
      const resourceText = (resourceRes.contents[0] as { text: string }).text;
      const resourcePackage = JSON.parse(resourceText);
      expect(resourcePackage.adjudication.id).toBe(adjudicationId);
      expect(computeSha256(resourceText)).toBe(issuance.session.projection_hash);
      // Verify confidential marker is present in successful resource projection read
      expect(resourceText).toContain(PROJECTION_CONFIDENTIAL_MARKER);

      // Assert Zero-Write: no row modifications and no data version bump during reads
      const changesAfter = getDbTotalChanges(db);
      const dataVersionAfter = db.pragma('data_version', { simple: true }) as number;
      expect(changesAfter).toBe(changesBefore);
      expect(dataVersionAfter).toBe(dataVersionBefore);
    } finally {
      await performSafeCleanup({
        clients: [mcpClient],
        servers: [mcpServer],
      });
    }

    // --- STEP 7: Teardown Cleanliness (No leaked worktree / process) ---
    const worktreeList = child_process
      .execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: env.repoDir, encoding: 'utf8' })
      .trim();
    const worktreeCount = worktreeList.split('\n').filter((l) => l.startsWith('worktree ')).length;
    expect(worktreeCount).toBe(1); // Only the root repository worktree remains
  });

  // =========================================================================
  // SCENARIO 2: Verification Failure Branch
  // Non-zero exit code -> VERIFICATION_FAILED -> Task stays fail-closed -> Lease released
  // =========================================================================
  it('2. Verification failure branch: non-zero exit classification transitions to VERIFICATION_FAILED and releases lease', async () => {
    env = setupSyntheticRehearsalEnv({ failVerification: true });
    const { repo, mcpService, adjudicationService } = env;

    const { plaintextToken } = issueSubmissionSession(repo, env.authorizationId);
    const submissionId = crypto.randomUUID();
    const claimPayload = {
      submission_id: submissionId,
      authorization_id: env.authorizationId,
      project_id: env.projectId,
      task_id: env.taskId,
      attempt_id: env.attemptId,
      assignment_id: env.assignmentId,
      task_ownership_epoch: 1,
      base_sha: env.baseSha,
      repository_head_sha: env.repoHeadSha,
      status: 'COMPLETED',
      summary: 'Execution with failing test',
      changed_files: ['README.md'],
      tests_claimed: ['test-failure'],
      blockers: [],
      review_requested: true,
      client_metadata: { client_name: 'synthetic-coder-agent', client_version: '1.0.0', client_session_mode: 'CLI_EXTERNAL' },
    };

    mcpService.submitCoderClaim(claimPayload, plaintextToken);

    const admitRes = await adjudicationService.admitSubmissionForVerification({
      requestId: crypto.randomUUID(),
      submissionId,
    });

    expect(admitRes.status).toBe('VERIFICATION_FAILED');
    expect(admitRes.adjudication.status).toBe('VERIFICATION_FAILED');
    expect(admitRes.adjudication.failure_code).toBe('TESTS_FAILED');

    // Task state must NOT advance to REVIEW_READY (transitions back to CODING / revision incremented)
    const taskAfter = repo.getTask(env.taskId);
    expect(taskAfter?.state).not.toBe('REVIEW_READY');
    expect(taskAfter?.state).toBe('CODING');
    expect(taskAfter?.revision_count).toBe(2);

    // Workspace lease must be released - assertion is strictly enforced
    expect(admitRes.adjudication.workspace_lease_id).toBeDefined();
    expect(typeof admitRes.adjudication.workspace_lease_id).toBe('string');
    expect(admitRes.adjudication.workspace_lease_id!.length).toBeGreaterThan(0);
    const lease = repo.getWorkspaceLease(admitRes.adjudication.workspace_lease_id!);
    expect(lease).toBeDefined();
    expect(lease?.state).toBe('RELEASED');
    expect(lease?.released_at).not.toBeNull();

    // Disposition must record failure
    const dispositions = repo.getCoderSubmissionDispositions(submissionId);
    const failDisp = dispositions.find((d) => d.disposition_event === 'REJECTED');
    expect(failDisp).toBeDefined();
    expect(failDisp?.disposition_reason).toBe('FENCED_PRECONDITION');
  });

  // =========================================================================
  // SCENARIO 3: Reviewer Read Rejection Branches
  // Expired token, revoked session, cross-adjudication, task-state drift, projection tamper
  // =========================================================================
  it('3. Reviewer read rejection branches: expired token, revoked session, cross-adjudication, and task-state drift', async () => {
    const REJECTION_PROJECTION_MARKER = 'FROZEN_REJECTION_PROJECTION_MARKER_' + crypto.randomUUID();
    env = setupSyntheticRehearsalEnv({ failVerification: false, taskTitleMarker: REJECTION_PROJECTION_MARKER });
    const { repo, db, mcpService, adjudicationService, reviewerService } = env;

    const { plaintextToken } = issueSubmissionSession(repo, env.authorizationId);
    const submissionId = crypto.randomUUID();
    mcpService.submitCoderClaim(
      {
        submission_id: submissionId,
        authorization_id: env.authorizationId,
        project_id: env.projectId,
        task_id: env.taskId,
        attempt_id: env.attemptId,
        assignment_id: env.assignmentId,
        task_ownership_epoch: 1,
        base_sha: env.baseSha,
        repository_head_sha: env.repoHeadSha,
        status: 'COMPLETED',
        summary: `Submission containing ${REJECTION_PROJECTION_MARKER}`,
        changed_files: ['README.md'],
        tests_claimed: ['test-synth'],
        blockers: [],
        review_requested: true,
        client_metadata: { client_name: 'synthetic-agent', client_version: '1.0.0', client_session_mode: 'CLI_EXTERNAL' },
      },
      plaintextToken
    );

    const admitRes = await adjudicationService.admitSubmissionForVerification({
      requestId: crypto.randomUUID(),
      submissionId,
    });
    const adjudicationId = admitRes.adjudication.id;
    const nowIso = new Date().toISOString();
    const revAgentA = 'agent-rev-a-' + crypto.randomUUID();
    const revAgentB = 'agent-rev-b-' + crypto.randomUUID();
    const revAgentC = 'agent-rev-c-' + crypto.randomUUID();
    db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'Reviewer Agent A', 'REVIEWER', ?, 'IDLE', NULL, ?)`).run(revAgentA, env.reviewerResourceId, nowIso);
    db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'Reviewer Agent B', 'REVIEWER', ?, 'IDLE', NULL, ?)`).run(revAgentB, env.reviewerResourceId, nowIso);
    db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'Reviewer Agent C', 'REVIEWER', ?, 'IDLE', NULL, ?)`).run(revAgentC, env.reviewerResourceId, nowIso);

    // --- Branch A: Expired Token (Tool & Resource, Zero-Write, Sanitized Error) ---
    const expiredIssuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: revAgentA,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });

    let clientExp: Client | null = null;
    let serverExpired: any | null = null;
    try {
      serverExpired = buildAgentForgeReviewerMcpServer({ db, reviewerToken: expiredIssuance.raw_token });
      const [cTransExp, sTransExp] = InMemoryTransport.createLinkedPair();
      await serverExpired.connect(sTransExp);
      clientExp = new Client({ name: 'expired-client', version: '1.0.0' });
      await clientExp.connect(cTransExp);

      // Fast-forward time past expiration
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 7200 * 1000));

      // Tool Call Rejection
      const tcBeforeTool = getDbTotalChanges(db);
      const expiredToolCall = await clientExp.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: adjudicationId },
      });
      const tcAfterTool = getDbTotalChanges(db);
      expect(tcAfterTool).toBe(tcBeforeTool);
      expect(expiredToolCall.isError).toBe(true);
      const toolErrText = (expiredToolCall.content[0] as { text: string }).text;
      expect(toolErrText).toContain('TOKEN_EXPIRED');
      expect(toolErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(toolErrText).not.toContain(expiredIssuance.raw_token);
      expect(toolErrText).not.toContain('authoritative_verification');
      expect(toolErrText).not.toContain('untrusted_claim');

      // Resource Read Rejection
      const tcBeforeRes = getDbTotalChanges(db);
      const expiredResourceRes = await clientExp.readResource({
        uri: `agentforge://reviews/packages/${adjudicationId}`,
      });
      const tcAfterRes = getDbTotalChanges(db);
      expect(tcAfterRes).toBe(tcBeforeRes);
      const resErrText = (expiredResourceRes.contents[0] as { text: string }).text;
      expect(resErrText).toContain('TOKEN_EXPIRED');
      expect(resErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(resErrText).not.toContain(expiredIssuance.raw_token);
      expect(resErrText).not.toContain('authoritative_verification');
      expect(resErrText).not.toContain('untrusted_claim');
    } finally {
      await performSafeCleanup({
        clients: [clientExp],
        servers: [serverExpired],
        restoreTimers: true,
      });
    }

    // --- Branch B: Revoked Session (Tool & Resource, Zero-Write, Sanitized Error) ---
    const revokedIssuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: revAgentB,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });
    reviewerService.revokeReviewerSession(revokedIssuance.session.id, 'Security revocation for test');

    let clientRev: Client | null = null;
    let serverRevoked: any | null = null;
    try {
      serverRevoked = buildAgentForgeReviewerMcpServer({ db, reviewerToken: revokedIssuance.raw_token });
      const [cTransRev, sTransRev] = InMemoryTransport.createLinkedPair();
      await serverRevoked.connect(sTransRev);
      clientRev = new Client({ name: 'revoked-client', version: '1.0.0' });
      await clientRev.connect(cTransRev);

      // Tool Call Rejection
      const tcBeforeTool = getDbTotalChanges(db);
      const revokedToolCall = await clientRev.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: adjudicationId },
      });
      const tcAfterTool = getDbTotalChanges(db);
      expect(tcAfterTool).toBe(tcBeforeTool);
      expect(revokedToolCall.isError).toBe(true);
      const toolErrText = (revokedToolCall.content[0] as { text: string }).text;
      expect(toolErrText).toContain('TOKEN_REVOKED');
      expect(toolErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(toolErrText).not.toContain(revokedIssuance.raw_token);
      expect(toolErrText).not.toContain('authoritative_verification');
      expect(toolErrText).not.toContain('untrusted_claim');

      // Resource Read Rejection
      const tcBeforeRes = getDbTotalChanges(db);
      const revokedResourceRes = await clientRev.readResource({
        uri: `agentforge://reviews/packages/${adjudicationId}`,
      });
      const tcAfterRes = getDbTotalChanges(db);
      expect(tcAfterRes).toBe(tcBeforeRes);
      const resErrText = (revokedResourceRes.contents[0] as { text: string }).text;
      expect(resErrText).toContain('TOKEN_REVOKED');
      expect(resErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(resErrText).not.toContain(revokedIssuance.raw_token);
      expect(resErrText).not.toContain('authoritative_verification');
      expect(resErrText).not.toContain('untrusted_claim');
    } finally {
      await performSafeCleanup({
        clients: [clientRev],
        servers: [serverRevoked],
      });
    }

    // --- Branch C: Cross-Adjudication Access Rejection (Tool & Resource, Zero-Write, Sanitized Error) ---
    const validIssuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: revAgentC,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });

    let clientVal: Client | null = null;
    let serverValid: any | null = null;
    try {
      serverValid = buildAgentForgeReviewerMcpServer({ db, reviewerToken: validIssuance.raw_token });
      const [cTransVal, sTransVal] = InMemoryTransport.createLinkedPair();
      await serverValid.connect(sTransVal);
      clientVal = new Client({ name: 'valid-client', version: '1.0.0' });
      await clientVal.connect(cTransVal);

      const foreignAdjudicationId = crypto.randomUUID();

      // Tool Call Rejection
      const tcBeforeTool = getDbTotalChanges(db);
      const crossAdjToolCall = await clientVal.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: foreignAdjudicationId },
      });
      const tcAfterTool = getDbTotalChanges(db);
      expect(tcAfterTool).toBe(tcBeforeTool);
      expect(crossAdjToolCall.isError).toBe(true);
      const toolErrText = (crossAdjToolCall.content[0] as { text: string }).text;
      expect(toolErrText).toContain('PERMISSION_DENIED');
      expect(toolErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(toolErrText).not.toContain(validIssuance.raw_token);
      expect(toolErrText).not.toContain('authoritative_verification');
      expect(toolErrText).not.toContain('untrusted_claim');

      // Resource Read Rejection
      const tcBeforeRes = getDbTotalChanges(db);
      const crossAdjResourceRes = await clientVal.readResource({
        uri: `agentforge://reviews/packages/${foreignAdjudicationId}`,
      });
      const tcAfterRes = getDbTotalChanges(db);
      expect(tcAfterRes).toBe(tcBeforeRes);
      const resErrText = (crossAdjResourceRes.contents[0] as { text: string }).text;
      expect(resErrText).toContain('PERMISSION_DENIED');
      expect(resErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(resErrText).not.toContain(validIssuance.raw_token);
      expect(resErrText).not.toContain('authoritative_verification');
      expect(resErrText).not.toContain('untrusted_claim');
    } finally {
      await performSafeCleanup({
        clients: [clientVal],
        servers: [serverValid],
      });
    }

    // --- Branch D: Stale Authority (Task State Drift) Rejection ---
    // If task leaves REVIEW_READY state, live authority fence rejects the reviewer read
    db.prepare(`UPDATE tasks SET state = 'CODING' WHERE id = ?`).run(env.taskId);

    let clientDrift: Client | null = null;
    let serverDrift: any | null = null;
    try {
      serverDrift = buildAgentForgeReviewerMcpServer({ db, reviewerToken: validIssuance.raw_token });
      const [cTransDrift, sTransDrift] = InMemoryTransport.createLinkedPair();
      await serverDrift.connect(sTransDrift);
      clientDrift = new Client({ name: 'drift-client', version: '1.0.0' });
      await clientDrift.connect(cTransDrift);

      // Tool Call Rejection
      const tcBeforeTool = getDbTotalChanges(db);
      const driftToolCall = await clientDrift.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: adjudicationId },
      });
      const tcAfterTool = getDbTotalChanges(db);
      expect(tcAfterTool).toBe(tcBeforeTool);
      expect(driftToolCall.isError).toBe(true);
      const toolErrText = (driftToolCall.content[0] as { text: string }).text;
      expect(toolErrText).toContain('TASK_STATE_INVALID');
      expect(toolErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(toolErrText).not.toContain(validIssuance.raw_token);
      expect(toolErrText).not.toContain('authoritative_verification');
      expect(toolErrText).not.toContain('untrusted_claim');

      // Resource Read Rejection
      const tcBeforeRes = getDbTotalChanges(db);
      const driftResourceRes = await clientDrift.readResource({
        uri: `agentforge://reviews/packages/${adjudicationId}`,
      });
      const tcAfterRes = getDbTotalChanges(db);
      expect(tcAfterRes).toBe(tcBeforeRes);
      const resErrText = (driftResourceRes.contents[0] as { text: string }).text;
      expect(resErrText).toContain('TASK_STATE_INVALID');
      expect(resErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(resErrText).not.toContain(validIssuance.raw_token);
      expect(resErrText).not.toContain('authoritative_verification');
      expect(resErrText).not.toContain('untrusted_claim');
    } finally {
      await performSafeCleanup({
        clients: [clientDrift],
        servers: [serverDrift],
        extraSteps: [
          () => {
            // Restore task state to REVIEW_READY
            db.prepare(`UPDATE tasks SET state = 'REVIEW_READY' WHERE id = ?`).run(env!.taskId);
          },
        ],
      });
    }
  });

  // =========================================================================
  // SCENARIO 4: Teardown Audit & Process Termination Receipt
  // =========================================================================
  it('4. Teardown audit: process termination receipt, worktree pruning, connection closing, and clean directory deletion', async () => {
    // Dedicated isolated environment for teardown verification
    const testEnv = setupSyntheticRehearsalEnv({ failVerification: false });
    let client: Client | null = null;
    let server: any | null = null;
    let tempDirCleaned = false;

    try {
      const { repo, db, mcpService, adjudicationService, reviewerService } = testEnv;

      // 1. Execute an admission and verification cycle
      const { plaintextToken } = issueSubmissionSession(repo, testEnv.authorizationId);
      const submissionId = crypto.randomUUID();
      mcpService.submitCoderClaim(
        {
          submission_id: submissionId,
          authorization_id: testEnv.authorizationId,
          project_id: testEnv.projectId,
          task_id: testEnv.taskId,
          attempt_id: testEnv.attemptId,
          assignment_id: testEnv.assignmentId,
          task_ownership_epoch: 1,
          base_sha: testEnv.baseSha,
          repository_head_sha: testEnv.repoHeadSha,
          status: 'COMPLETED',
          summary: 'Submission for teardown audit',
          changed_files: ['README.md'],
          tests_claimed: ['test-teardown'],
          blockers: [],
          review_requested: true,
          client_metadata: { client_name: 'synthetic-agent', client_version: '1.0.0', client_session_mode: 'CLI_EXTERNAL' },
        },
        plaintextToken
      );

      const admitRes = await adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId,
      });

      // 2. Authoritative Process Termination Receipt Verification
      // Inspect execution observation: proves process termination truth is proven and recorded
      expect(admitRes.status).toBe('VERIFIED');
      expect(admitRes.adjudication).toBeDefined();
      const adj = repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id);
      expect(adj).toBeDefined();
      expect(adj!.verification_result_envelope_json).toBeDefined();
      const envelope = JSON.parse(adj!.verification_result_envelope_json!);
      expect(envelope.process_start_classification).toBe('SPAWNED_PROVEN');
      expect(envelope.termination_classification).toBe('TERMINATION_PROVEN');
      expect(envelope.exit_classification).toBe('EXIT_ZERO');

      const testRun = repo.getTestRun(adj!.test_run_id!);
      expect(testRun).toBeDefined();
      expect(testRun?.exit_code).toBe(0);

      // Verify no dangling active process records in SQLite (process_runs table)
      const activeProcesses = (db.prepare("SELECT COUNT(*) as c FROM process_runs WHERE status = 'RUNNING'").get() as { c: number }).c;
      expect(activeProcesses).toBe(0);

      // 3. Worktree Pruning Verification
      // Verification worktree created during sealed execution must be pruned cleanly
      const worktreeList = child_process
        .execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: testEnv.repoDir, encoding: 'utf8' })
        .trim();
      const activeWorktrees = worktreeList.split('\n').filter((l) => l.startsWith('worktree '));
      expect(activeWorktrees).toHaveLength(1); // Only root repository worktree remains

      // 4. Setup MCP server & client to verify connection closing
      const issuance = reviewerService.issueReviewerSession({
        adjudication_id: admitRes.adjudication.id,
        reviewer_agent_id: testEnv.agentIdReviewer,
        reviewer_provider_id: testEnv.providerId,
        reviewer_account_id: testEnv.reviewerAccountId,
        reviewer_resource_id: testEnv.reviewerResourceId,
        duration_seconds: 3600,
      });

      server = buildAgentForgeReviewerMcpServer({ db, reviewerToken: issuance.raw_token });
      const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
      await server.connect(sTrans);
      client = new Client({ name: 'teardown-client', version: '1.0.0' });
      await client.connect(cTrans);

      // Verify connected
      const toolRes = await client.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: admitRes.adjudication.id },
      });
      expect(toolRes.isError).toBeFalsy();
    } finally {
      // Guaranteed cleanup even if assertions fail
      await performSafeCleanup({
        clients: [client],
        servers: [server],
        dbs: [testEnv.db],
        tempDirs: [testEnv.tempDir],
        restoreTimers: true,
      });
      tempDirCleaned = !fs.existsSync(testEnv.tempDir);
    }

    // Verify temp directory has actually vanished from filesystem
    expect(tempDirCleaned).toBe(true);
    expect(fs.existsSync(testEnv.tempDir)).toBe(false);
  });

  // =========================================================================
  // SCENARIO 5: Teardown Helper Resilience Under Partial Failure
  // =========================================================================
  it('5. Shared teardown helper resilience: error in earlier step does not block subsequent steps and propagates error', async () => {
    const dummyTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-test-cleanup-resilience-'));
    const dummyDbPath = path.join(dummyTempDir, 'dummy.db');
    const dummyDb = new Database(dummyDbPath);

    expect(fs.existsSync(dummyTempDir)).toBe(true);
    expect(dummyDb.open).toBe(true);

    // Simulated failing server whose close method throws an error
    const simulatedError = new Error('Simulated server close failure');
    const failingServer = {
      close: async () => {
        throw simulatedError;
      },
    };

    let caughtError: Error | null = null;
    try {
      await performSafeCleanup({
        servers: [failingServer],
        dbs: [dummyDb],
        tempDirs: [dummyTempDir],
        restoreTimers: true,
      });
    } catch (err: any) {
      caughtError = err;
    }

    // 1. Error was propagated and not swallowed
    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain('Simulated server close failure');

    // 2. Subsequent steps still executed despite the earlier failure:
    // - Database was closed
    expect(dummyDb.open).toBe(false);
    // - Temporary directory was deleted
    expect(fs.existsSync(dummyTempDir)).toBe(false);
  });
});
