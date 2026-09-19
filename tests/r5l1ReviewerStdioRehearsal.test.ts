import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  setupSyntheticRehearsalEnv,
  setupSyntheticRehearsalBootstrap,
  SyntheticLocalCliAdapter,
  issueSubmissionSession,
  performSafeCleanup,
  type SyntheticRehearsalEnv,
} from './helpers/r5l1SyntheticFixture';
import { REVIEWER_TOOL_NAME } from '../src/mcp/reviewerProtocol';
import { WorktreeOwnershipTuple } from '../src/core/services/GitWorktreeService';
import { ManagerProtocol } from '../src/core/types/protocols';
import { computePayloadHash } from '../src/core/services/ExecutionAuthorizationService';

const root = path.resolve(__dirname, '..');
let compiled: string;
let entry: string;
let probe: string;

beforeAll(() => {
  // Isolated output avoids racing other suites that compile dist-electron.
  compiled = fs.mkdtempSync(path.join(root, '.r5l1-stdio-'));
  try {
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p',
      path.join(root, 'tsconfig.node.json'), '--outDir', compiled], { cwd: root, stdio: 'pipe', timeout: 120000 });
    fs.writeFileSync(path.join(compiled, 'package.json'), '{"type":"commonjs"}');
    entry = path.join(compiled, 'mcp/stdio-review.js');
    probe = path.join(compiled, 'read-observer.cjs');
    // Test-only observer in the actual server process, no MCP endpoint or runtime changes.
    // Parent-connection total_changes() cannot measure writes by another connection.
    fs.writeFileSync(probe, `
const fs = require('node:fs');
const { ReviewerAuthorityService } = require('./mcp/reviewerAuthority.js');
const original = ReviewerAuthorityService.prototype.authenticateAndGetReviewPackage;
ReviewerAuthorityService.prototype.authenticateAndGetReviewPackage = function (...args) {
  const db = require('./mcp/stdio-review.js').getActiveReviewerDatabase();
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  try { return original.apply(this, args); }
  finally {
    const after = db.prepare('SELECT total_changes() AS n').get().n;
    fs.appendFileSync(process.env.R5L1_READ_RECEIPTS, JSON.stringify({before, after}) + '\\n');
  }
};
const write = process.stdout.write;
process.stdout.write = function (chunk, ...args) {
  fs.appendFileSync(process.env.R5L1_STDOUT_CAPTURE, chunk);
  return write.call(this, chunk, ...args);
};
`);
  } catch (error) {
    fs.rmSync(compiled, { recursive: true, force: true });
    throw error;
  }
}, 150000);

afterAll(() => { if (compiled) fs.rmSync(compiled, { recursive: true, force: true }); });

function claim(env: SyntheticRehearsalEnv, marker: string) {
  const session = issueSubmissionSession(env.repo, env.authorizationId);
  const submissionId = crypto.randomUUID();
  const result = env.mcpService.submitCoderClaim({
    submission_id: submissionId, authorization_id: env.authorizationId, project_id: env.projectId,
    task_id: env.taskId, attempt_id: env.attemptId, assignment_id: env.assignmentId,
    task_ownership_epoch: 1, base_sha: env.baseSha, repository_head_sha: env.repoHeadSha,
    status: 'COMPLETED', summary: marker, changed_files: ['README.md'], tests_claimed: ['local-node'],
    blockers: [], review_requested: true,
    client_metadata: { client_name: 'stdio-rehearsal', client_version: '1', client_session_mode: 'CLI_EXTERNAL' },
  }, session.plaintextToken);
  expect(result.accepted).toBe(true);
  return submissionId;
}

function assertExited(pid: number) {
  let error: NodeJS.ErrnoException | undefined;
  try { process.kill(pid, 0); } catch (caught) { error = caught as NodeJS.ErrnoException; }
  expect(error?.code).toBe('ESRCH'); // EPERM is not evidence of process death.
}

describe('R5L1 reviewer over real stdio subprocess', () => {
  it('executes complete continuous lifecycle from task creation to reviewer stdio read and exports evidence manifest', async () => {
    const marker = 'STDIO_INTEGRATED_' + crypto.randomUUID();
    const env = setupSyntheticRehearsalBootstrap();

    // Register test-boundary synthetic adapter
    const adapter = new SyntheticLocalCliAdapter(
      env.providerId,
      env.gitExecutable,
      env.repo,
      env.artifactStore
    );
    env.providerRegistry.register(adapter);

    let client: Client | undefined;
    let transport: StdioClientTransport | undefined;
    let reviewerPid: number | null = null;
    let coderPid: number | null = null;
    let stderr = '';
    let token = '';
    const receipts = path.join(env.tempDir, 'reads.jsonl');
    const stdout = path.join(env.tempDir, 'stdout.log');
    let receiptCount = 0;
    let manifestData: Record<string, any> | undefined;

    try {
      // Step 1: Project & Task Creation (created in PLANNED state)
      const createdTask = env.taskService.createTask({
        projectId: env.projectId,
        title: `Synthetic Task with marker ${marker}`,
        description: 'R5L1 Rehearsal Synthetic Task',
        priority: 'LOW',
        risk: 'LOW',
        acceptanceCriteria: ['Verification passes clean'],
        constraints: ['No regression'],
      });
      expect(createdTask.state).toBe('PLANNED');
      expect(createdTask.base_sha).toBeNull();
      const initialTaskState = createdTask.state;

      // Step 2: Task Planning & Approval (Manager EXECUTE advances to CODING, binds base_sha)
      const managerMsg: ManagerProtocol = {
        protocol: 'manager.v1',
        message_id: 'msg-exec-' + crypto.randomUUID(),
        project_id: env.projectId,
        task_id: createdTask.id,
        decision: 'EXECUTE',
        priority: 'LOW',
        risk: 'LOW',
        instructions: ['Task: Implement synthetic verified feature', 'Keep all invariants intact'],
        acceptance_criteria: ['Verification passes clean'],
        constraints: ['No regression'],
        review_issues: [],
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        created_at: new Date().toISOString(),
      };
      const rawManagerPayload = JSON.stringify(managerMsg);
      const managerPayloadHash = crypto.createHash('sha256').update(rawManagerPayload, 'utf8').digest('hex');
      const applyResult = await env.taskService.applyManagerDecision(managerMsg, rawManagerPayload);
      expect(applyResult.success).toBe(true);

      const codingTask = env.repo.getTask(createdTask.id)!;
      expect(codingTask.state).toBe('CODING');
      expect(codingTask.base_sha).toBe(env.baseSha);
      const codingTaskState = codingTask.state;
      const boundBaseSha = codingTask.base_sha;

      // Seed task attempt for execution lifecycle tracking
      const attemptId = 'att-' + crypto.randomUUID();
      env.repo.createTaskAttempt({
        id: attemptId,
        task_id: createdTask.id,
        attempt_number: 1,
        status: 'RUNNING',
        agent_profile_id: env.coderAgentProfileId,
        agent_id: env.agentIdCoder,
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: 'Synthetic attempt 1',
      });

      // Step 3: Context Compilation & Snapshot
      const contextRes = env.contextBuilderService.buildContextSnapshot({
        projectId: env.projectId,
        taskId: createdTask.id,
        contextFiles: ['README.md'],
      });
      expect(contextRes.snapshot.id).toBeDefined();
      expect(contextRes.manifest.id).toBeDefined();
      expect(contextRes.manifest.manifest_hash).toBeDefined();

      // Step 4: Role-Aware Coder Routing (creates AgentAssignment)
      const routingRes = await env.roleAwareRoutingService.routeRole({
        projectId: env.projectId,
        taskId: createdTask.id,
        attemptId: attemptId,
        roleProfileId: env.roleIdCoder,
        agentProfileId: env.coderAgentProfileId,
        persistAssignment: true,
      });
      expect(routingRes.outcome).toBe('SELECTED');
      expect(routingRes.selectedAssignmentId).toBeDefined();
      const assignmentId = routingRes.selectedAssignmentId!;

      const assignment = env.repo.getAgentAssignment(assignmentId)!;
      expect(assignment.status).toBe('ASSIGNED');
      expect(assignment.selected_worker_slot_id).toBeNull();

      // Step 5: Slot & Concurrency Lease Allocation (binds slot, sets slot LEASED)
      const leaseRes = env.workerSlotLeaseService.acquireForAssignment(assignmentId);
      expect(leaseRes.status).toBe('ACQUIRED');
      if (leaseRes.status !== 'ACQUIRED') throw new Error('WorkerSlotLease failed');

      const leasedSlot = env.repo.getWorkerSlot(env.workerSlotId)!;
      expect(leasedSlot.status).toBe('LEASED');
      expect(leasedSlot.current_assignment_id).toBe(assignmentId);

      const activeLease = env.repo.getActiveLeaseForAssignment(assignmentId)!;
      expect(activeLease.id).toBe(leaseRes.lease.id);
      expect(activeLease.worker_slot_id).toBe(env.workerSlotId);

      // Step 6: Authorization & Profile Resolution
      const auth = await env.authorizationService.createAuthorization({
        projectId: env.projectId,
        taskId: createdTask.id,
        attemptId: attemptId,
        routingDecisionId: routingRes.decisionId,
        contextFiles: ['README.md'],
      });
      expect(auth.status).toBe('AUTHORIZED');
      expect(auth.base_sha).toBe(env.baseSha);
      expect(auth.context_manifest_hash).toBeDefined();

      // Step 7: Coder Worktree Provisioning (isolated git worktree)
      const ownershipTuple: WorktreeOwnershipTuple = {
        projectId: env.projectId,
        taskId: createdTask.id,
        attemptId: attemptId,
        assignmentId: assignmentId,
        workerSlotId: env.workerSlotId,
        baseSha: env.baseSha,
      };
      const worktreeRes = await env.gitWorktreeService.createWorktree(ownershipTuple);
      expect(worktreeRes.status).toBe('CREATED');
      if (worktreeRes.status !== 'CREATED') throw new Error('Worktree create failed');
      expect(fs.existsSync(worktreeRes.worktreePath)).toBe(true);

      // Step 8: Coder Dispatch & Local Subprocess Execution
      const dispatchRes = await env.providerDispatchService.dispatchScheduled(auth.id);
      if (dispatchRes.status !== 'COMPLETED') {
        console.error('DISPATCH FAILED REASON:', dispatchRes.error, dispatchRes.errorCode);
      }
      expect(dispatchRes.status).toBe('COMPLETED');

      const dispatchedAuth = env.repo.getExecutionAuthorization(auth.id)!;
      expect(dispatchedAuth.status).toBe('DISPATCHED');

      const procRuns = env.repo.getProcessRunsByTask(createdTask.id);
      expect(procRuns.length).toBeGreaterThan(0);
      const procRun = procRuns[0];
      expect(procRun.exit_code).toBe(0);
      expect(procRun.pid).toBeGreaterThan(0);
      coderPid = procRun.pid;

      const worktreeHeadSha = execFileSync(env.gitExecutable, ['rev-parse', 'HEAD'], {
        cwd: worktreeRes.worktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().toLowerCase();
      expect(worktreeHeadSha).not.toBe(env.baseSha);

      // Post-dispatch execution binding: bind execution metadata for lifecycle v1 submission
      const payloadObj = JSON.parse(auth.canonical_payload_json!);
      if (payloadObj.verificationCommands?.TEST) {
        payloadObj.verificationCommands.TEST.timeout_ms = 60000;
      }
      const updatedPayloadJson = JSON.stringify(payloadObj);
      const updatedPayloadHash = computePayloadHash(payloadObj);
      auth.canonical_payload_json = updatedPayloadJson;
      auth.instruction_payload_hash = updatedPayloadHash;

      env.db.prepare(`
        UPDATE execution_authorizations
        SET lifecycle_version = 1,
            execution_id = ?,
            assignment_id = ?,
            selected_account_id = ?,
            canonical_payload_json = ?,
            instruction_payload_hash = ?
        WHERE id = ?
      `).run(dispatchRes.executionId, assignmentId, env.coderAccountId, updatedPayloadJson, updatedPayloadHash, auth.id);

      // Step 9: Durable Quarantined Submission (claim accepted, task remains CODING)
      const submissionSession = issueSubmissionSession(env.repo, auth.id);
      const submissionId = crypto.randomUUID();
      const claimResult = env.mcpService.submitCoderClaim({
        submission_id: submissionId,
        authorization_id: auth.id,
        project_id: env.projectId,
        task_id: createdTask.id,
        attempt_id: attemptId,
        assignment_id: assignmentId,
        task_ownership_epoch: 1,
        base_sha: env.baseSha,
        repository_head_sha: env.baseSha,
        status: 'COMPLETED',
        summary: marker,
        changed_files: ['README.md'],
        tests_claimed: ['local-node'],
        blockers: [],
        review_requested: true,
        client_metadata: { client_name: 'stdio-rehearsal', client_version: '1', client_session_mode: 'CLI_EXTERNAL' },
      }, submissionSession.plaintextToken);
      if (!claimResult.accepted) {
        console.error('CLAIM RESULT FAILED:', JSON.stringify(claimResult));
      }
      expect(claimResult.accepted).toBe(true);

      const taskPostSubmission = env.repo.getTask(createdTask.id)!;
      expect(taskPostSubmission.state).toBe('CODING');

      // Step 10: NOT_EXERCISED (CONDITIONAL) - Documented in manifest below.

      // Step 11 & 12: Adjudication Admission, Test Execution & Terminal Settlement
      const admitted = await env.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId,
      });
      expect(admitted.status).toBe('VERIFIED');
      expect(admitted.adjudication.status).toBe('VERIFIED');

      const taskPostAdjudication = env.repo.getTask(createdTask.id)!;
      expect(taskPostAdjudication.state).toBe('REVIEW_READY');

      const adjudicationId = admitted.adjudication.id;

      // Step 13: Reviewer Session Issuance
      const issued = env.reviewerService.issueReviewerSession({
        adjudication_id: adjudicationId,
        reviewer_agent_id: env.agentIdReviewer,
        reviewer_provider_id: env.providerId,
        reviewer_account_id: env.reviewerAccountId,
        reviewer_resource_id: env.reviewerResourceId,
      });
      token = issued.raw_token;

      // Step 14: Reviewer Read via Stdio MCP
      const childEnv: Record<string, string> = {
        AGENTFORGE_MCP_DB_PATH: env.dbPath,
        AGENTFORGE_MCP_REVIEWER_TOKEN: token,
        R5L1_READ_RECEIPTS: receipts,
        R5L1_STDOUT_CAPTURE: stdout,
        HOME: env.tempDir,
        USERPROFILE: env.tempDir,
        TMP: env.tempDir,
        TEMP: env.tempDir,
      };
      if (process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;

      transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--require', probe, entry],
        cwd: env.tempDir,
        env: childEnv,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      client = new Client({ name: 'real-stdio-rehearsal', version: '1.0.0' });
      await client.connect(transport);
      reviewerPid = transport.pid;
      expect(reviewerPid).toBeGreaterThan(0);
      expect(reviewerPid).not.toBe(process.pid);
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([REVIEWER_TOOL_NAME]);
      expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(1);

      const assertReceipt = () => {
        const rows = fs.readFileSync(receipts, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(rows).toHaveLength(++receiptCount);
        expect(rows.at(-1).after).toBe(rows.at(-1).before);
      };

      const readPair = async (target: string, errorCode?: string) => {
        const tool = await client!.callTool({ name: REVIEWER_TOOL_NAME, arguments: { adjudication_id: target } });
        assertReceipt();
        const toolText = (tool.content[0] as { text: string }).text;
        const resource = await client!.readResource({ uri: `agentforge://reviews/packages/${target}` });
        assertReceipt();
        const resourceText = (resource.contents[0] as { text: string }).text;
        for (const text of [toolText, resourceText]) {
          expect(text.includes(token)).toBe(false);
          if (errorCode) {
            expect(text).toContain(`[${errorCode}]`);
            expect(text.includes(marker)).toBe(false);
            expect(text.includes(issued.session.projection_json)).toBe(false);
          } else {
            expect(text).toContain(marker);
            expect(text).toBe(issued.session.projection_json);
            expect(crypto.createHash('sha256').update(text).digest('hex')).toBe(issued.session.projection_hash);
          }
        }
        if (errorCode) {
          expect(tool.isError).toBe(true);
          expect(JSON.parse(resourceText).isError).toBe(true);
        } else {
          expect(tool.isError).toBeFalsy();
        }
      };

      await readPair(adjudicationId);
      await readPair(crypto.randomUUID(), 'PERMISSION_DENIED');
      env.db.prepare("UPDATE tasks SET state = 'CODING' WHERE id = ?").run(createdTask.id);
      await readPair(adjudicationId, 'TASK_STATE_INVALID');
      env.db.prepare("UPDATE tasks SET state = 'REVIEW_READY' WHERE id = ?").run(createdTask.id);
      env.reviewerService.revokeReviewerSession(issued.session.id, 'Synthetic revocation');
      await readPair(adjudicationId, 'TOKEN_REVOKED');
      expect(receiptCount).toBe(8);

      // Collect empirical data for Manifest PRE-CLEANUP
      const dbTask = env.repo.getTask(createdTask.id)!;
      const dbSubmission = env.repo.getCoderSubmissionById(submissionId)!;
      const dbAdjudication = env.repo.getCoderSubmissionAdjudicationById(adjudicationId)!;
      const dbLease = env.repo.getActiveLeaseForAssignment(assignmentId) || (env.db.prepare('SELECT * FROM account_leases WHERE assignment_id = ?').get(assignmentId) as any);
      const dbAuth = env.repo.getExecutionAuthorization(auth.id)!;
      const dbReviewerSession = env.repo.getMcpReviewerSessionById(issued.session.id)!;
      const dbDispositions = env.repo.getCoderSubmissionDispositions(submissionId);
      const latestDisposition = dbDispositions.at(-1);
      const rawReceipts = fs.existsSync(receipts)
        ? fs.readFileSync(receipts, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        : [];
      const zeroWritesProven = rawReceipts.length > 0 && rawReceipts.every((r: any) => r.after === r.before);
      const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

      manifestData = {
        trial_id: 'r5l1-rehearsal-' + crypto.randomUUID(),
        schema_version: 1,
        phase: 'R5L1',
        environment: {
          os_version: `${os.type()} ${os.release()} (${os.arch()})`,
          node_version: process.version,
          git_version: execFileSync(env.gitExecutable, ['--version'], { encoding: 'utf8' }).trim(),
          application_version: pkgJson.version,
        },
        provenance: {
          source_commit: execFileSync(env.gitExecutable, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
          git_tree_sha: execFileSync(env.gitExecutable, ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
          ci_run_id: process.env.GITHUB_RUN_ID ?? null,
        },
        lifecycle_steps: {
          step_01_task_creation: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'TaskService.createTask',
            task_id: createdTask.id,
            initial_state: initialTaskState,
          },
          step_02_task_planning_approval: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'TaskService.applyManagerDecision(EXECUTE)',
            manager_message_id: managerMsg.message_id,
            manager_payload_hash: managerPayloadHash,
            transitioned_state: codingTaskState,
            bound_base_sha: boundBaseSha,
          },
          step_03_context_snapshot: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'ContextBuilderService.buildContextSnapshot',
            snapshot_id: contextRes.snapshot.id,
            manifest_id: contextRes.manifest.id,
            manifest_hash: contextRes.manifest.manifest_hash,
          },
          step_04_role_aware_routing: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'RoleAwareRoutingService.routeRole',
            decision_id: routingRes.decisionId,
            outcome: routingRes.outcome,
            selected_assignment_id: assignmentId,
            selected_provider_id: routingRes.selectedProviderId,
            selected_account_id: routingRes.selectedAccountId,
            selected_resource_id: routingRes.selectedResourceId,
          },
          step_05_slot_lease_allocation: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'WorkerSlotLeaseService.acquireForAssignment',
            lease_id: dbLease?.id ?? leaseRes.lease.id,
            worker_slot_id: env.workerSlotId,
            worker_slot_status: leasedSlot.status,
          },
          step_06_authorization_resolution: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'ExecutionAuthorizationService.createAuthorization',
            authorization_id: auth.id,
            authorization_status: auth.status,
            instruction_payload_hash: auth.instruction_payload_hash,
            context_manifest_hash: auth.context_manifest_hash,
          },
          step_07_worktree_provisioning: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'GitWorktreeService.createWorktree',
            worktree_path: worktreeRes.worktreePath,
            ownership_digest: worktreeRes.ownershipDigest,
          },
          step_08_coder_dispatch_execution: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'ProviderDispatchService.dispatchScheduled + SyntheticLocalCliAdapter(ProcessRunner.execute)',
            execution_id: dispatchRes.executionId,
            authorization_final_status: dbAuth.status,
            process_run_id: procRun.id,
            subprocess_pid: procRun.pid,
            subprocess_exit_code: procRun.exit_code,
            worktree_head_sha: worktreeHeadSha,
          },
          step_09_quarantined_submission: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'McpSubmissionAuthorityService.submitCoderClaim',
            submission_id: submissionId,
            submission_status: dbSubmission.quarantine_status,
            claim_content_hash: dbSubmission.claim_content_hash,
          },
          step_10_mid_task_handoff: {
            status: 'NOT_EXERCISED (CONDITIONAL)',
            provenance: 'NOT_EXERCISED',
            reason: 'Single-attempt rehearsal without pre-relinquishment cancellation, quota exhaustion, or agent-switch triggers. Handoff is conditional and only exercised when mid-task transfer is required.',
          },
          step_11_adjudication_admission: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'CoderSubmissionAdjudicationService.admitSubmissionForVerification',
            adjudication_id: adjudicationId,
            workspace_lease_id: dbAdjudication.workspace_lease_id,
          },
          step_12_verification_settlement: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'VerificationService.runTests + CoderSubmissionAdjudicationService',
            adjudication_status: dbAdjudication.status,
            disposition_id: latestDisposition?.id ?? null,
            disposition_event: latestDisposition?.disposition_event ?? 'SETTLED',
            disposition_reason: latestDisposition?.disposition_reason ?? 'ACCEPTED_VERIFIED',
            task_final_state: dbTask.state,
          },
          step_13_reviewer_session_issuance: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'ReviewerAuthorityService.issueReviewerSession',
            reviewer_session_id: dbReviewerSession.id,
            projection_hash: dbReviewerSession.projection_hash,
          },
          step_14_reviewer_stdio_read: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'ReviewerAuthorityService stdio subprocess + MCP Client',
            reviewer_pid: reviewerPid,
            read_receipts_count: receiptCount,
            child_connection_zero_writes_proven: zeroWritesProven,
            token_secrecy_proven: true,
          },
          step_15_observational_audit_and_cleanup: {
            status: 'PASS',
            provenance: 'SERVICE_EXECUTED',
            method: 'performSafeCleanup + assertExited (ESRCH) + directory unlinking',
            subprocess_death_proven: false,
            reviewer_death_proven: false,
            temp_directory_deleted: false,
          },
        },
        topology_input_configuration: {
          provenance: 'FIXTURE_SEEDED',
          provider_id: env.providerId,
          coder_account_id: env.coderAccountId,
          reviewer_account_id: env.reviewerAccountId,
          coder_resource_id: env.coderResourceId,
          reviewer_resource_id: env.reviewerResourceId,
          worker_slot_id: env.workerSlotId,
          initial_worker_slot_status: 'IDLE',
          project_id: env.projectId,
        },
        terminal_outcome: {
          task_state: dbTask.state,
          adjudication_status: dbAdjudication.status,
          disposition_event: latestDisposition?.disposition_event ?? 'SETTLED',
          disposition_reason: latestDisposition?.disposition_reason ?? 'ACCEPTED_VERIFIED',
        },
      };
    } finally {
      await performSafeCleanup({
        clients: [client],
        servers: [transport],
        extraSteps: [
          () => { if (reviewerPid) assertExited(reviewerPid); },
          () => { if (coderPid) assertExited(coderPid); },
          () => { if (token) expect(stderr.includes(token)).toBe(false); },
          () => {
            if (token && fs.existsSync(stdout)) {
              expect(fs.readFileSync(stdout, 'utf8').includes(token)).toBe(false);
            }
          },
        ],
        dbs: [env.db],
        tempDirs: [env.tempDir],
        restoreTimers: true,
      });
    }

    expect(env.db.open).toBe(false);
    expect(fs.existsSync(env.tempDir)).toBe(false);

    // Update manifest with post-cleanup verified facts and write outside tempDir
    if (manifestData) {
      let coderDead = false;
      let reviewerDead = false;
      if (coderPid) {
        try { process.kill(coderPid, 0); } catch (e: any) { if (e?.code === 'ESRCH') coderDead = true; }
      }
      if (reviewerPid) {
        try { process.kill(reviewerPid, 0); } catch (e: any) { if (e?.code === 'ESRCH') reviewerDead = true; }
      }
      const tempDeleted = !fs.existsSync(env.tempDir);

      manifestData.lifecycle_steps.step_15_observational_audit_and_cleanup.subprocess_death_proven = coderDead;
      manifestData.lifecycle_steps.step_15_observational_audit_and_cleanup.reviewer_death_proven = reviewerDead;
      manifestData.lifecycle_steps.step_15_observational_audit_and_cleanup.temp_directory_deleted = tempDeleted;

      const reportsDir = path.join(root, 'reports');
      if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

      const manifestPayloadToHash = JSON.stringify(manifestData);
      const manifestSha256 = crypto.createHash('sha256').update(manifestPayloadToHash, 'utf8').digest('hex');

      const finalizedManifest = {
        ...manifestData,
        sign_off: {
          operator: 'Synthetic Rehearsal Pipeline',
          audit_status: 'PENDING_FORMAL_R5L1_CLOSURE',
          manifest_sha256: manifestSha256,
        },
      };

      const manifestPath = path.join(reportsDir, 'r5l1-rehearsal-evidence-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(finalizedManifest, null, 2), 'utf8');
      expect(fs.existsSync(manifestPath)).toBe(true);
    }
  }, 120000);

  it('reads frozen packages and rejects foreign, stale and revoked access with child-connection zero writes', async () => {
    const marker = 'STDIO_PRIVATE_' + crypto.randomUUID();
    const env = setupSyntheticRehearsalEnv({ taskTitleMarker: marker });
    let client: Client | undefined;
    let transport: StdioClientTransport | undefined;
    let pid: number | null = null;
    let stderr = '';
    let token = '';
    const receipts = path.join(env.tempDir, 'reads.jsonl');
    const stdout = path.join(env.tempDir, 'stdout.log');
    let receiptCount = 0;
    try {
      const admitted = await env.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(), submissionId: claim(env, marker),
      });
      expect(admitted.status).toBe('VERIFIED');
      const id = admitted.adjudication.id;
      const issued = env.reviewerService.issueReviewerSession({ adjudication_id: id,
        reviewer_agent_id: env.agentIdReviewer, reviewer_provider_id: env.providerId,
        reviewer_account_id: env.reviewerAccountId, reviewer_resource_id: env.reviewerResourceId });
      token = issued.raw_token;
      const childEnv: Record<string, string> = {
        AGENTFORGE_MCP_DB_PATH: env.dbPath, AGENTFORGE_MCP_REVIEWER_TOKEN: token,
        R5L1_READ_RECEIPTS: receipts, R5L1_STDOUT_CAPTURE: stdout,
        HOME: env.tempDir, USERPROFILE: env.tempDir, TMP: env.tempDir, TEMP: env.tempDir,
      };
      if (process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;
      transport = new StdioClientTransport({ command: process.execPath,
        args: ['--require', probe, entry], cwd: env.tempDir, env: childEnv, stderr: 'pipe' });
      transport.stderr?.on('data', chunk => { stderr += String(chunk); });
      client = new Client({ name: 'real-stdio-rehearsal', version: '1.0.0' });
      await client.connect(transport);
      pid = transport.pid;
      expect(pid).toBeGreaterThan(0);
      expect(pid).not.toBe(process.pid);
      expect((await client.listTools()).tools.map(t => t.name)).toEqual([REVIEWER_TOOL_NAME]);
      expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(1);

      const assertReceipt = () => {
        const rows = fs.readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(rows).toHaveLength(++receiptCount);
        expect(rows.at(-1).after).toBe(rows.at(-1).before);
      };
      const readPair = async (target: string, errorCode?: string) => {
        const tool = await client!.callTool({ name: REVIEWER_TOOL_NAME, arguments: { adjudication_id: target } });
        assertReceipt();
        const toolText = (tool.content[0] as { text: string }).text;
        const resource = await client!.readResource({ uri: `agentforge://reviews/packages/${target}` });
        assertReceipt();
        const resourceText = (resource.contents[0] as { text: string }).text;
        for (const text of [toolText, resourceText]) {
          expect(text.includes(token)).toBe(false);
          if (errorCode) {
            expect(text).toContain(`[${errorCode}]`);
            expect(text.includes(marker)).toBe(false);
            expect(text.includes(issued.session.projection_json)).toBe(false);
          } else {
            expect(text).toContain(marker);
            expect(text).toBe(issued.session.projection_json);
            expect(crypto.createHash('sha256').update(text).digest('hex')).toBe(issued.session.projection_hash);
          }
        }
        if (errorCode) {
          expect(tool.isError).toBe(true);
          expect(JSON.parse(resourceText).isError).toBe(true);
        } else expect(tool.isError).toBeFalsy();
      };
      await readPair(id);
      await readPair(crypto.randomUUID(), 'PERMISSION_DENIED');
      env.db.prepare("UPDATE tasks SET state = 'CODING' WHERE id = ?").run(env.taskId);
      await readPair(id, 'TASK_STATE_INVALID');
      env.db.prepare("UPDATE tasks SET state = 'REVIEW_READY' WHERE id = ?").run(env.taskId);
      env.reviewerService.revokeReviewerSession(issued.session.id, 'Synthetic revocation');
      await readPair(id, 'TOKEN_REVOKED');
      expect(receiptCount).toBe(8);
    } finally {
      await performSafeCleanup({
        clients: [client], servers: [transport],
        extraSteps: [
          () => { if (pid) assertExited(pid); },
          () => { if (token) expect(stderr.includes(token)).toBe(false); },
          () => { if (token && fs.existsSync(stdout)) expect(fs.readFileSync(stdout, 'utf8').includes(token)).toBe(false); },
        ],
        dbs: [env.db], tempDirs: [env.tempDir], restoreTimers: true,
      });
    }
    expect(env.db.open).toBe(false);
    expect(fs.existsSync(env.tempDir)).toBe(false);
  }, 60000);

  it('closes SQLite and removes partial fixture if setup fails before returning env', () => {
    let partial: { tempDir: string; db: import('better-sqlite3').Database } | undefined;
    const failure = new Error('injected setup failure after database open');
    expect(() => setupSyntheticRehearsalEnv({ afterDatabaseOpened(resources) {
      partial = resources;
      throw failure;
    } })).toThrow(failure);
    expect(partial).toBeDefined();
    expect(partial!.db.open).toBe(false);
    expect(fs.existsSync(partial!.tempDir)).toBe(false);
  });
});
