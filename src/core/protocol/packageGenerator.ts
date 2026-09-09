import {
  Project,
  Task,
  Review,
  Evidence,
  TestRun,
} from '../types/domain';
import { CoderProtocol } from '../types/protocols';
import { Repository, CoderSubmission } from '../database/repositories';
import { CoderSubmissionAdjudication, VerifiedAdjudicationReviewProjection } from '../types/adjudication';
import {
  computeContextManifestHash,
  computePayloadHash,
  CanonicalExecutionPayload,
  CanonicalExecutionPayloadSchema,
} from '../services/ExecutionAuthorizationService';
import { CommandParser } from '../services/CommandParser';
import { computeSha256, CLAIM_CONTENT_KEYS } from '../../mcp/submissionProtocol';

export interface AdjudicationReviewPackageLinkage {
  adjudication: CoderSubmissionAdjudication;
  submission: CoderSubmission;
  testRun: TestRun | null;
  gitStatusEvidence: Evidence | null;
  gitDiffEvidence: Evidence | null;
}

export class PackageGenerator {
  private static formatVerificationCommand(
    commands: Array<{ command_type: string; executable: string; args: string[]; enabled?: boolean }>,
    type: 'TEST' | 'LINT' | 'BUILD'
  ): string {
    const cmd = commands.find((c) => c.command_type === type && (c.enabled === undefined || c.enabled));
    if (!cmd || !cmd.executable || cmd.executable.trim().length === 0) {
      return 'Not configured';
    }
    const formatted = CommandParser.format({ executable: cmd.executable, args: cmd.args });
    return formatted ? `\`${formatted}\`` : 'Not configured';
  }

  public static generateAuthorizedManualWorkOrder(
    authorizationId: string,
    repo: Repository
  ): string {
    // 1. Load durable execution authorization
    const auth = repo.getExecutionAuthorization(authorizationId);
    if (!auth) {
      throw new Error(`EXECUTION_AUTHORIZATION_NOT_FOUND: Execution authorization "${authorizationId}" not found.`);
    }

    // 2. State Guard: Must be DISPATCHED
    if (auth.status !== 'DISPATCHED') {
      throw new Error(
        `EXECUTION_AUTHORIZATION_NOT_DISPATCHED: Authorized manual WorkOrder requires status DISPATCHED, but current status is "${auth.status}".`
      );
    }

    // 3. Exact Routing Decision Validation
    const routingEvent = repo.getRoutingDecisionEvent(auth.routing_decision_id);
    if (!routingEvent) {
      throw new Error(
        `ROUTING_DECISION_NOT_FOUND: Bound routing decision "${auth.routing_decision_id}" not found in database.`
      );
    }

    const routingPayload = routingEvent.structured_payload as Record<string, unknown>;
    if (
      routingPayload.projectId !== auth.project_id ||
      routingPayload.taskId !== auth.task_id ||
      ((routingPayload.attemptId as string | null | undefined) ?? null) !== auth.attempt_id ||
      routingPayload.selectedResourceId !== auth.selected_resource_id ||
      routingPayload.selectedProviderId !== auth.selected_provider_id
    ) {
      throw new Error('ROUTING_DECISION_MISMATCH: Bound routing decision scope or selection does not match authorization.');
    }

    if (routingPayload.outcome !== 'MANUAL_HANDOFF_REQUIRED') {
      throw new Error(
        `MANUAL_HANDOFF_NOT_REQUIRED: Bound routing outcome is "${routingPayload.outcome}", but manual relay requires "MANUAL_HANDOFF_REQUIRED".`
      );
    }

    // 4. Validate Provider/Resource Manual Bridge Semantics
    const resource = repo.getProviderResource(auth.selected_resource_id);
    if (!resource) {
      throw new Error(`ROUTING_RESOURCE_NOT_FOUND: Selected resource "${auth.selected_resource_id}" not found.`);
    }
    const provider = repo.getProvider(resource.provider_id);
    if (!provider || provider.adapter_type !== 'MANUAL_BRIDGE') {
      throw new Error(
        `MANUAL_BRIDGE_PROVIDER_REQUIRED: Selected resource/provider does not represent a MANUAL_BRIDGE adapter.`
      );
    }

    // 5. Require frozen canonical_payload_json (Fail closed for legacy NULL records)
    if (!auth.canonical_payload_json) {
      throw new Error(
        'AUTHORIZED_WORKORDER_CANONICAL_PAYLOAD_MISSING: Execution authorization is missing frozen canonical_payload_json.'
      );
    }

    // 6. Safely parse and strictly validate canonical_payload_json structure
    let canonicalPayload: CanonicalExecutionPayload;
    try {
      const parsed = JSON.parse(auth.canonical_payload_json);
      if (!parsed || typeof parsed !== 'object' || parsed.verificationCommands === undefined) {
        throw new Error(
          'AUTHORIZED_WORKORDER_VERIFICATION_SNAPSHOT_MISSING: Execution authorization is missing required frozen verificationCommands snapshot.'
        );
      }
      const parseResult = CanonicalExecutionPayloadSchema.safeParse(parsed);
      if (!parseResult.success) {
        throw new Error(parseResult.error.issues.map((i) => i.message).join(', '));
      }
      canonicalPayload = parseResult.data;
    } catch (err: any) {
      if (err.message && err.message.includes('AUTHORIZED_WORKORDER_VERIFICATION_SNAPSHOT_MISSING')) {
        throw err;
      }
      throw new Error(`EXECUTION_AUTHORIZATION_CORRUPTED: Invalid canonical_payload_json (${err.message})`);
    }

    // 7. Verify frozen scope and authority bindings
    if (canonicalPayload.projectId !== auth.project_id) {
      throw new Error(
        `EXECUTION_AUTHORIZATION_TAMPERED: Canonical payload projectId mismatch (payload: "${canonicalPayload.projectId}", auth: "${auth.project_id}").`
      );
    }
    if (canonicalPayload.taskId !== auth.task_id) {
      throw new Error(
        `EXECUTION_AUTHORIZATION_TAMPERED: Canonical payload taskId mismatch (payload: "${canonicalPayload.taskId}", auth: "${auth.task_id}").`
      );
    }
    const normalizedPayloadAttempt = canonicalPayload.attemptId ?? null;
    const normalizedAuthAttempt = auth.attempt_id ?? null;
    if (normalizedPayloadAttempt !== normalizedAuthAttempt) {
      throw new Error(
        `EXECUTION_AUTHORIZATION_TAMPERED: Canonical payload attemptId mismatch (payload: "${normalizedPayloadAttempt}", auth: "${normalizedAuthAttempt}").`
      );
    }
    if (canonicalPayload.managerMessageId !== auth.manager_message_id) {
      throw new Error(
        `EXECUTION_AUTHORIZATION_TAMPERED: Canonical payload managerMessageId mismatch (payload: "${canonicalPayload.managerMessageId}", auth: "${auth.manager_message_id}").`
      );
    }
    if (canonicalPayload.managerPayloadHash !== auth.manager_payload_hash) {
      throw new Error(
        `EXECUTION_AUTHORIZATION_TAMPERED: Canonical payload managerPayloadHash mismatch (payload: "${canonicalPayload.managerPayloadHash}", auth: "${auth.manager_payload_hash}").`
      );
    }

    // 8. Parse canonical_instructions_json and context_files_json as string arrays
    let canonicalInstructions: string[];
    try {
      canonicalInstructions = JSON.parse(auth.canonical_instructions_json);
      if (!Array.isArray(canonicalInstructions) || !canonicalInstructions.every((i) => typeof i === 'string')) {
        throw new Error('Must be an array of strings');
      }
    } catch (err: any) {
      throw new Error(`EXECUTION_AUTHORIZATION_CORRUPTED: Invalid canonical_instructions_json (${err.message})`);
    }

    let contextFiles: string[];
    try {
      contextFiles = JSON.parse(auth.context_files_json);
      if (!Array.isArray(contextFiles) || !contextFiles.every((f) => typeof f === 'string')) {
        throw new Error('Must be an array of strings');
      }
    } catch (err: any) {
      throw new Error(`EXECUTION_AUTHORIZATION_CORRUPTED: Invalid context_files_json (${err.message})`);
    }

    // 9. Require exact deep equality between payload and authorization record fields
    if (
      canonicalPayload.instructions.length !== canonicalInstructions.length ||
      !canonicalPayload.instructions.every((val, idx) => val === canonicalInstructions[idx])
    ) {
      throw new Error('EXECUTION_AUTHORIZATION_TAMPERED: Canonical instructions mismatch between payload and authorization record.');
    }

    if (
      canonicalPayload.contextFiles.length !== contextFiles.length ||
      !canonicalPayload.contextFiles.every((val, idx) => val === contextFiles[idx])
    ) {
      throw new Error('EXECUTION_AUTHORIZATION_TAMPERED: Context files mismatch between payload and authorization record.');
    }

    // 10. Recompute Context Manifest Hash and verify exact equality
    const recomputedContextHash = computeContextManifestHash(canonicalPayload.contextFiles);
    if (recomputedContextHash !== auth.context_manifest_hash) {
      throw new Error('EXECUTION_AUTHORIZATION_TAMPERED: Context manifest hash mismatch.');
    }

    // 11. Early format guard and CRITICAL cryptographic instruction payload hash recomputation
    if (!auth.instruction_payload_hash || !/^[0-9a-f]{64}$/i.test(auth.instruction_payload_hash)) {
      throw new Error('EXECUTION_AUTHORIZATION_TAMPERED: Invalid instruction payload hash format.');
    }

    const recomputedPayloadHash = computePayloadHash(canonicalPayload);
    if (recomputedPayloadHash !== auth.instruction_payload_hash) {
      throw new Error(
        `EXECUTION_AUTHORIZATION_TAMPERED: Instruction payload hash mismatch (computed: "${recomputedPayloadHash}", stored: "${auth.instruction_payload_hash}").`
      );
    }

    // 12. Derive verification guidance ONLY from verified frozen verificationCommands snapshot
    const formatSnapshotCmd = (cmd: { executable: string; args: string[] } | null): string => {
      if (!cmd || !cmd.executable || cmd.executable.trim().length === 0) {
        return 'Not configured';
      }
      const formatted = CommandParser.format(cmd);
      return formatted ? `\`${formatted}\`` : 'Not configured';
    };

    const testCmd = formatSnapshotCmd(canonicalPayload.verificationCommands.TEST);
    const lintCmd = formatSnapshotCmd(canonicalPayload.verificationCommands.LINT);
    const buildCmd = formatSnapshotCmd(canonicalPayload.verificationCommands.BUILD);

    // 13. Render instructions, constraints, and context ONLY from verified frozen canonicalPayload
    const renderedInstructions =
      canonicalPayload.instructions.length > 0
        ? canonicalPayload.instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')
        : '1. No specific instructions provided.';

    const renderedConstraints =
      canonicalPayload.constraints.length > 0
        ? canonicalPayload.constraints.map((c) => `- ${c}`).join('\n')
        : 'None specified.';

    const renderedContextFiles =
      canonicalPayload.contextFiles.length > 0
        ? canonicalPayload.contextFiles.map((f) => `- \`${f}\``).join('\n')
        : 'None specified.';

    return `# AgentForge Authorized Manual Handoff

## Authorization Envelope
- **Authorization ID**: \`${auth.id}\`
- **Project ID**: \`${auth.project_id}\`
- **Task ID**: \`${auth.task_id}\`
- **Attempt ID**: \`${auth.attempt_id || 'None'}\`
- **Task Revision**: Rev ${auth.task_revision}
- **Manager Message ID**: \`${auth.manager_message_id}\`
- **Routing Decision ID**: \`${auth.routing_decision_id}\`
- **Selected Resource ID**: \`${auth.selected_resource_id}\`
- **Selected Provider ID**: \`${auth.selected_provider_id}\`
- **Base SHA**: \`${auth.base_sha || 'HEAD'}\`
- **Authorized Repository HEAD SHA**: \`${auth.repository_head_sha}\`
- **Instruction Payload SHA-256**: \`${auth.instruction_payload_hash}\`
- **Context Manifest SHA-256**: \`${auth.context_manifest_hash}\`

## Authorized Execution Instructions
${renderedInstructions}

## Authorized Constraints
${renderedConstraints}

## Authorized Context Files
${renderedContextFiles}

## AgentForge Verification Guidance
Before completing work, ensure the following commands succeed locally:
- **Test**: ${testCmd}
- **Lint**: ${lintCmd}
- **Build**: ${buildCmd}

---

## Required Response Protocol (\`coder.v1\`)
When work is complete, return your final report strictly in the following JSON format.
Guidelines:
- Populate \`files_claimed_changed\` ONLY with repository files you actually modified.
- Populate \`tests_claimed\` ONLY with verification commands you actually executed and their outcomes.
- Leave arrays empty (\`[]\`) if no truthful claim exists.
- Never copy hypothetical example evidence or claim unverified results.

\`\`\`json
{
  "protocol": "coder.v1",
  "message_id": "msg-cdr-${auth.task_id}-${auth.id}",
  "project_id": "${auth.project_id}",
  "task_id": "${auth.task_id}",
  "attempt": 1,
  "status": "COMPLETED",
  "completed": [],
  "remaining": [],
  "files_claimed_changed": [],
  "tests_claimed": [],
  "blockers": [],
  "review_requested": true,
  "expected_task_state": "CODING",
  "expected_revision": ${auth.task_revision}
}
\`\`\`
`;
  }

  public static generateWorkOrder(
    project: Project,
    task: Task,
    repo: Repository
  ): string {
    const criteriaList = task.acceptance_criteria.length > 0
      ? task.acceptance_criteria.map((c, i) => `${i + 1}. [ ] ${c}`).join('\n')
      : 'None specified.';

    const constraintsList = task.constraints.length > 0
      ? task.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : 'None specified.';

    const verifCommands = repo.getVerificationCommandsByProject(project.id);
    const testCmd = PackageGenerator.formatVerificationCommand(verifCommands, 'TEST');
    const lintCmd = PackageGenerator.formatVerificationCommand(verifCommands, 'LINT');
    const buildCmd = PackageGenerator.formatVerificationCommand(verifCommands, 'BUILD');

    return `# WORK ORDER: ${task.id} — ${task.title}

## Project Context
- **Project**: ${project.name} (${project.id})
- **Repository**: \`${project.repository_path}\`
- **Default Branch**: \`${project.default_branch}\`
- **Base SHA**: \`${task.base_sha || 'HEAD'}\`

## Task Specification
- **Task ID**: \`${task.id}\`
- **Priority**: \`${task.priority}\` | **Risk**: \`${task.risk}\`
- **Revision**: ${task.revision_count} / ${task.max_revisions}

### Objective & Description
${task.description || 'No detailed description provided.'}

### Acceptance Criteria
${criteriaList}

### Technical Constraints
${constraintsList}

## Verification Commands
Before completing work, ensure the following commands succeed locally:
- **Test**: ${testCmd}
- **Lint**: ${lintCmd}
- **Build**: ${buildCmd}

---

## Required Response Protocol (\`coder.v1\`)
When work is complete, return your final report strictly in the following JSON format.
Guidelines:
- Populate \`files_claimed_changed\` ONLY with repository files you actually modified.
- Populate \`tests_claimed\` ONLY with verification commands you actually executed and their outcomes.
- Leave arrays empty (\`[]\`) if no truthful claim exists.
- Never copy hypothetical example evidence or claim unverified results.

\`\`\`json
{
  "protocol": "coder.v1",
  "message_id": "msg-cdr-${task.id}-rev${task.revision_count}",
  "project_id": "${project.id}",
  "task_id": "${task.id}",
  "attempt": 1,
  "status": "COMPLETED",
  "completed": [],
  "remaining": [],
  "files_claimed_changed": [],
  "tests_claimed": [],
  "blockers": [],
  "review_requested": true,
  "expected_task_state": "CODING",
  "expected_revision": ${task.revision_count}
}
\`\`\`
`;
  }

  public static renderVerifiedAdjudicationReviewProjection(
    projection: VerifiedAdjudicationReviewProjection
  ): string {
    if (!projection || typeof projection !== 'object' || !projection.projection_hash) {
      throw new Error('VERIFIED_PROJECTION_INVALID: Review package requires a verified projection with valid projection_hash.');
    }

    const criteriaList = projection.acceptance_criteria.length > 0
      ? projection.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : 'None specified.';

    const issuesText = projection.previous_issues.length > 0
      ? projection.previous_issues
          .map((iss) => `- **[${iss.severity}]** ${iss.title} (${iss.file_path || 'general'}): ${iss.description}`)
          .join('\n')
      : 'No previous review issues.';

    const MAX_DIFF_LENGTH = 32 * 1024;
    let formattedDiff = '';
    const diffSummary = projection.authoritative_git_diff;
    if (!diffSummary || !diffSummary.diff_content.trim()) {
      formattedDiff = '(No git diff detected)';
    } else if (diffSummary.diff_content.length <= MAX_DIFF_LENGTH) {
      formattedDiff = diffSummary.diff_content;
    } else {
      formattedDiff =
        diffSummary.diff_content.substring(0, MAX_DIFF_LENGTH) +
        `\n\n... [TRUNCATED: Diff is ${diffSummary.byte_size} bytes]\n` +
        `- **Evidence ID**: \`${diffSummary.evidence_id}\`\n` +
        `- **SHA-256 Checksum**: \`${diffSummary.evidence_hash}\`\n` +
        `- **Byte Size**: \`${diffSummary.byte_size} bytes\`\n` +
        `- **Storage Type**: \`${diffSummary.storage_type}\``;
    }

    const testVerif = projection.authoritative_verification;
    const testEvidenceText = testVerif.test_run_id
      ? `
- **Test Run ID**: \`${testVerif.test_run_id}\`
- **Command Snapshot SHA-256**: \`${testVerif.command_snapshot_hash || 'None'}\`
- **Command**: \`${testVerif.command}\`
- **Authoritative Verdict**: ${testVerif.exit_code === 0 ? '🟢 PASSED' : '🔴 FAILED'} (Exit Code: \`${testVerif.exit_code}\`)
- **Metrics**: ${testVerif.passed_count} Passed | ${testVerif.failed_count} Failed | ${testVerif.skipped_count} Skipped
- **Duration**: ${testVerif.duration_ms}ms
- **Evidence Reference**: \`${testVerif.test_result_evidence_id || 'INLINE'}\`
`
      : '⚠️ [TEST EVIDENCE UNAVAILABLE / NOT RUN / ERROR]';

    const claim = projection.untrusted_claim;
    const gitStatus = projection.authoritative_git_status;

    return `# REVIEW PACKAGE: ${projection.task_id} — ${projection.task_title}

## Task Overview
- **Project**: ${projection.project_name} (${projection.project_id})
- **Task ID**: \`${projection.task_id}\`
- **Priority**: \`${projection.task_priority}\` | **Risk**: \`${projection.task_risk}\`
- **Current Revision**: ${projection.task_revision_count} / ${projection.task_max_revisions}
- **Base SHA**: \`${projection.task_base_sha}\`
- **Working SHA**: \`${projection.task_working_sha}\`

### Acceptance Criteria
${criteriaList}

---

## Authoritative Verification Evidence (Ground Truth)

### Owner Adjudication
- **Adjudication ID**: \`${projection.adjudication_id}\`
- **Recovery Classification**: ${projection.recovery_fencing_state?.is_fenced ? 'RECOVERY_FENCED' : 'NORMAL'}
- **Projection Hash**: \`${projection.projection_hash}\`

### Authoritative Test Evidence
${testEvidenceText}

### Git Status Evidence
- **Evidence ID**: \`${gitStatus?.evidence_id || 'None'}\`
- **SHA-256 Checksum**: \`${gitStatus?.evidence_hash || 'None'}\`
- **Storage Type**: \`${gitStatus?.storage_type || 'None'}\`

### Git Diff Evidence
- **Evidence ID**: \`${diffSummary?.evidence_id || 'None'}\`
- **SHA-256 Checksum**: \`${diffSummary?.evidence_hash || 'None'}\`
- **Byte Size**: \`${diffSummary?.byte_size ?? 0} bytes\`
- **Storage Type**: \`${diffSummary?.storage_type || 'None'}\`

\`\`\`diff
${formattedDiff}
\`\`\`

---

### Coder Claims (Unverified)
*(Non-Authoritative — Untrusted Coder Claim)*
- **Submission ID**: \`${projection.submission_id}\`
- **Claim Content SHA-256**: \`${claim.claim_content_hash}\`
- **Summary**: ${claim.summary || 'No summary provided.'}
- **Completed Items**:
${claim.completed.length > 0 ? claim.completed.map((c) => `  - ${c}`).join('\n') : '  - None'}
- **Files Claimed Changed**:
${claim.files_claimed_changed.length > 0 ? claim.files_claimed_changed.map((f) => `  - \`${f}\``).join('\n') : '  - None'}
- **Tests Claimed**:
${claim.tests_claimed.length > 0 ? claim.tests_claimed.map((t) => `  - ${t}`).join('\n') : '  - None'}
- **Blockers**:
${claim.blockers.length > 0 ? claim.blockers.map((b) => `  - ${b}`).join('\n') : '  - None'}

---

## Previous Review History
${issuesText}

---

## Required Response Protocol (\`manager.v1\`)
Evaluate the authoritative evidence above against the acceptance criteria and return your verdict in the following JSON format:

\`\`\`json
{
  "protocol": "manager.v1",
  "message_id": "msg-mgr-${projection.task_id}-${Date.now()}",
  "project_id": "${projection.project_id}",
  "task_id": "${projection.task_id}",
  "decision": "PASS | FIX_REQUIRED | BLOCK | NEEDS_OWNER",
  "priority": "${projection.task_priority}",
  "risk": "${projection.task_risk}",
  "instructions": [
    "Specific feedback or next instructions"
  ],
  "acceptance_criteria": [
    "Remaining criteria if fix required"
  ],
  "review_issues": [
    {
      "severity": "BLOCKER | REQUIRED | OPTIONAL | NIT",
      "title": "Issue title",
      "file_path": "src/file.ts",
      "description": "Specific issue description"
    }
  ],
  "expected_task_state": "REVIEWING",
  "expected_revision": ${projection.task_revision_count}
}
\`\`\`
`;
  }

  public static generateReviewPackage(
    project: Project,
    task: Task,
    coderReport: CoderProtocol | null,
    gitDiffStat: string,
    gitDiffContent: string,
    testRun: TestRun | null,
    previousReviews: Review[] = [],
    gitDiffEvidence?: Evidence | null,
    adjudicationLinkageOrProjection?: VerifiedAdjudicationReviewProjection | AdjudicationReviewPackageLinkage | null
  ): string {
    if (adjudicationLinkageOrProjection && 'projection_hash' in adjudicationLinkageOrProjection) {
      return PackageGenerator.renderVerifiedAdjudicationReviewProjection(
        adjudicationLinkageOrProjection as VerifiedAdjudicationReviewProjection
      );
    }

    const taskRecord = task as unknown as Record<string, unknown>;
    const criteria = Array.isArray(task.acceptance_criteria)
      ? task.acceptance_criteria
      : (typeof taskRecord.acceptance_criteria_json === 'string'
          ? (JSON.parse(taskRecord.acceptance_criteria_json) as string[])
          : []);
    const criteriaList = criteria.length > 0
      ? criteria.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n')
      : 'None specified.';

    const previousIssuesList = previousReviews.flatMap((r) => r.issues || []);
    const issuesText = previousIssuesList.length > 0
      ? previousIssuesList
          .map((iss) => `- **[${iss.severity}]** ${iss.title} (${iss.file_path || 'general'}): ${iss.description}`)
          .join('\n')
      : 'No previous review issues.';

    // Format Bounded Diff Content with Artifact Metadata for Large Diffs
    const MAX_DIFF_LENGTH = 32 * 1024;
    let formattedDiff = '';
    if (!gitDiffContent || !gitDiffContent.trim()) {
      formattedDiff = '(No git diff detected)';
    } else if (gitDiffContent.length <= MAX_DIFF_LENGTH) {
      formattedDiff = gitDiffContent;
    } else {
      const activeEv = (adjudicationLinkageOrProjection && 'gitDiffEvidence' in adjudicationLinkageOrProjection)
        ? adjudicationLinkageOrProjection.gitDiffEvidence
        : gitDiffEvidence;
      if (!activeEv) {
        throw new Error('AUTHORITATIVE_DIFF_EVIDENCE_MISSING: Large Git diff cannot be rendered in review package without authoritative evidence record.');
      }
      formattedDiff =
        gitDiffContent.substring(0, MAX_DIFF_LENGTH) +
        `\n\n... [TRUNCATED: Diff is ${activeEv.byte_size} bytes]\n` +
        `- **Evidence ID**: \`${activeEv.id}\`\n` +
        `- **SHA-256 Checksum**: \`${activeEv.hash}\`\n` +
        `- **Byte Size**: \`${activeEv.byte_size} bytes\`\n` +
        `- **Storage Type**: \`${activeEv.storage_type}\``;
    }

    if (adjudicationLinkageOrProjection && 'adjudication' in adjudicationLinkageOrProjection) {
      const { adjudication, submission, testRun: linkedTestRun, gitStatusEvidence, gitDiffEvidence: linkedDiffEv } = adjudicationLinkageOrProjection;

      // Fail closed validation: never silently substitute a different submission, test run, or evidence row
      if (adjudication.submission_id !== submission.id) {
        throw new Error(`ADJUDICATION_LINKAGE_MISMATCH: submission ID mismatch (${adjudication.submission_id} vs ${submission.id})`);
      }
      if (adjudication.task_id !== task.id) {
        throw new Error(`ADJUDICATION_LINKAGE_MISMATCH: task ID mismatch (${adjudication.task_id} vs ${task.id})`);
      }
      if (adjudication.project_id !== project.id) {
        throw new Error(`ADJUDICATION_LINKAGE_MISMATCH: project ID mismatch (${adjudication.project_id} vs ${project.id})`);
      }

      // Recompute stored hashes
      if (computeSha256(submission.claim_content_json) !== submission.claim_content_hash) {
        throw new Error('ADJUDICATION_LINKAGE_MISMATCH: submission claim_content_hash mismatch');
      }
      if (computeSha256(submission.canonical_envelope_json) !== submission.canonical_envelope_hash) {
        throw new Error('ADJUDICATION_LINKAGE_MISMATCH: submission canonical_envelope_hash mismatch');
      }
      if (computeSha256(adjudication.authority_snapshot_json) !== adjudication.authority_snapshot_hash) {
        throw new Error('ADJUDICATION_LINKAGE_MISMATCH: adjudication authority_snapshot_hash mismatch');
      }
      if (
        adjudication.verification_commands_json &&
        computeSha256(adjudication.verification_commands_json) !== adjudication.verification_commands_hash
      ) {
        throw new Error('ADJUDICATION_LINKAGE_MISMATCH: adjudication verification_commands_hash mismatch');
      }

      if (adjudication.test_run_id) {
        if (!linkedTestRun || adjudication.test_run_id !== linkedTestRun.id) {
          throw new Error(`ADJUDICATION_LINKAGE_MISMATCH: test run ID mismatch (${adjudication.test_run_id} vs ${linkedTestRun?.id ?? 'null'})`);
        }
        if (linkedTestRun.task_id !== task.id) {
          throw new Error(`ADJUDICATION_LINKAGE_MISMATCH: test run task ID mismatch (${linkedTestRun.task_id} vs ${task.id})`);
        }
      } else if (linkedTestRun) {
        throw new Error('ADJUDICATION_LINKAGE_MISMATCH: test run provided when adjudication has no test_run_id');
      }

      if (adjudication.git_status_evidence_id) {
        if (!gitStatusEvidence || adjudication.git_status_evidence_id !== gitStatusEvidence.id) {
          throw new Error(`ADJUDICATION_LINKAGE_MISMATCH: git status evidence ID mismatch (${adjudication.git_status_evidence_id} vs ${gitStatusEvidence?.id ?? 'null'})`);
        }
        if (
          gitStatusEvidence.project_id !== project.id ||
          gitStatusEvidence.task_id !== task.id ||
          gitStatusEvidence.evidence_type !== 'GIT_STATUS' ||
          (typeof gitStatusEvidence.raw_payload === 'string' && computeSha256(gitStatusEvidence.raw_payload) !== gitStatusEvidence.hash)
        ) {
          throw new Error('ADJUDICATION_LINKAGE_MISMATCH: git status evidence authority or payload hash mismatch');
        }
      } else if (gitStatusEvidence) {
        throw new Error('ADJUDICATION_LINKAGE_MISMATCH: git status evidence provided when adjudication has no git_status_evidence_id');
      }

      if (adjudication.git_diff_evidence_id) {
        if (!linkedDiffEv || adjudication.git_diff_evidence_id !== linkedDiffEv.id) {
          throw new Error(`ADJUDICATION_LINKAGE_MISMATCH: git diff evidence ID mismatch (${adjudication.git_diff_evidence_id} vs ${linkedDiffEv?.id ?? 'null'})`);
        }
        if (
          linkedDiffEv.project_id !== project.id ||
          linkedDiffEv.task_id !== task.id ||
          linkedDiffEv.evidence_type !== 'GIT_DIFF' ||
          (typeof linkedDiffEv.raw_payload === 'string' && computeSha256(linkedDiffEv.raw_payload) !== linkedDiffEv.hash)
        ) {
          throw new Error('ADJUDICATION_LINKAGE_MISMATCH: git diff evidence authority or payload hash mismatch');
        }
      } else if (linkedDiffEv) {
        throw new Error('ADJUDICATION_LINKAGE_MISMATCH: git diff evidence provided when adjudication has no git_diff_evidence_id');
      }

      // Parse untrusted claim fields strictly; fail closed on malformed JSON or extra/missing keys
      let rawClaim: Record<string, unknown>;
      try {
        const parsed = JSON.parse(submission.claim_content_json);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('claim_content_json must be a non-null plain object');
        }
        const claimKeys = Object.keys(parsed).sort();
        const expectedKeys = [...CLAIM_CONTENT_KEYS].sort();
        if (claimKeys.length !== expectedKeys.length || claimKeys.some((k, i) => k !== expectedKeys[i])) {
          throw new Error(`claim_content_json own-property set mismatch: ${claimKeys.join(',')}`);
        }
        rawClaim = parsed;
      } catch (err) {
        throw new Error(
          `ADJUDICATION_LINKAGE_MISMATCH: Malformed claim JSON in submission: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const completedClaimed: string[] = Array.isArray(rawClaim.completed) ? (rawClaim.completed as string[]) : [];
      const filesClaimed: string[] = Array.isArray(rawClaim.files_claimed_changed) ? (rawClaim.files_claimed_changed as string[]) : [];
      const testsClaimed: string[] = Array.isArray(rawClaim.tests_claimed) ? (rawClaim.tests_claimed as string[]) : [];
      const blockersClaimed: string[] = Array.isArray(rawClaim.blockers) ? (rawClaim.blockers as string[]) : [];

      const activeTestRun = linkedTestRun;
      const activeDiffEv = linkedDiffEv;

      const testEvidenceText = activeTestRun
        ? `
- **Test Run ID**: \`${activeTestRun.id}\`
- **Command Snapshot SHA-256**: \`${adjudication.verification_commands_hash || 'None'}\`
- **Command**: \`${activeTestRun.command}\`
- **Authoritative Verdict**: ${activeTestRun.exit_code === 0 ? '🟢 PASSED' : '🔴 FAILED'} (Exit Code: \`${activeTestRun.exit_code}\`)
- **Metrics**: ${activeTestRun.passed_count} Passed | ${activeTestRun.failed_count} Failed | ${activeTestRun.skipped_count} Skipped
- **Duration**: ${activeTestRun.duration_ms}ms
- **Evidence Reference**: \`${activeTestRun.evidence_id || 'INLINE'}\`
`
        : '⚠️ [TEST EVIDENCE UNAVAILABLE / NOT RUN / ERROR]';

      return `# REVIEW PACKAGE: ${task.id} — ${task.title}

## Task Overview
- **Project**: ${project.name} (${project.id})
- **Task ID**: \`${task.id}\`
- **Priority**: \`${task.priority}\` | **Risk**: \`${task.risk}\`
- **Current Revision**: ${task.revision_count} / ${task.max_revisions}
- **Base SHA**: \`${task.base_sha || 'HEAD'}\`
- **Working SHA**: \`${task.current_sha || 'UNCOMMITTED / UNKNOWN'}\`

### Acceptance Criteria
${criteriaList}

---

## Authoritative Verification Evidence (Ground Truth)

### Owner Adjudication
- **Adjudication ID**: \`${adjudication.id}\`
- **Action**: \`${adjudication.action}\`
- **Actor Boundary**: \`OWNER_LOCAL_UI\`
- **Status**: \`${adjudication.status}\`
- **Lifecycle Version**: ${adjudication.lifecycle_version}
- **Authority Snapshot SHA-256**: \`${adjudication.authority_snapshot_hash}\`
- **Created At**: \`${adjudication.created_at}\`
- **Verification Started At**: \`${adjudication.verification_started_at || 'None'}\`
- **Completed At**: \`${adjudication.completed_at || 'None'}\`
- **Recovery Classification**: ${adjudication.recovery_fenced_at ? 'RECOVERY_FENCED' : 'NORMAL'}

### Authoritative Test Evidence
${testEvidenceText}

### Git Status Evidence
- **Evidence ID**: \`${gitStatusEvidence?.id || 'None'}\`
- **SHA-256 Checksum**: \`${gitStatusEvidence?.hash || 'None'}\`
- **Storage Type**: \`${gitStatusEvidence?.storage_type || 'None'}\`

### Git Diff Evidence
- **Evidence ID**: \`${activeDiffEv?.id || 'None'}\`
- **SHA-256 Checksum**: \`${activeDiffEv?.hash || 'None'}\`
- **Byte Size**: \`${activeDiffEv?.byte_size ?? 0} bytes\`
- **Storage Type**: \`${activeDiffEv?.storage_type || 'None'}\`
- **Statistics**: \`${gitDiffStat || 'No Git diff statistics available.'}\`

\`\`\`diff
${formattedDiff}
\`\`\`

---

### Coder Claims (Unverified)
*(Non-Authoritative — Untrusted Coder Claim)*
- **Submission ID**: \`${submission.id}\`
- **Quarantine Status**: \`${submission.quarantine_status}\`
- **Canonical Envelope SHA-256**: \`${submission.canonical_envelope_hash}\`
- **Claim Content SHA-256**: \`${submission.claim_content_hash}\`
- **Submitted At**: \`${submission.submitted_at}\`
- **Status Claimed**: \`${submission.claimed_status}\`
- **Summary**: ${submission.summary || 'No summary provided.'}
- **Completed Items**:
${completedClaimed.length > 0 ? completedClaimed.map((c) => `  - ${c}`).join('\n') : '  - None'}
- **Files Claimed Changed**:
${filesClaimed.length > 0 ? filesClaimed.map((f) => `  - \`${f}\``).join('\n') : '  - None'}
- **Tests Claimed**:
${testsClaimed.length > 0 ? testsClaimed.map((t) => `  - ${t}`).join('\n') : '  - None'}
- **Blockers**:
${blockersClaimed.length > 0 ? blockersClaimed.map((b) => `  - ${b}`).join('\n') : '  - None'}

---

## Previous Review History
${issuesText}

---

## Required Response Protocol (\`manager.v1\`)
Evaluate the authoritative evidence above against the acceptance criteria and return your verdict in the following JSON format:

\`\`\`json
{
  "protocol": "manager.v1",
  "message_id": "msg-mgr-${task.id}-${Date.now()}",
  "project_id": "${project.id}",
  "task_id": "${task.id}",
  "decision": "PASS | FIX_REQUIRED | BLOCK | NEEDS_OWNER",
  "priority": "${task.priority}",
  "risk": "${task.risk}",
  "instructions": [
    "Specific feedback or next instructions"
  ],
  "acceptance_criteria": [
    "Remaining criteria if fix required"
  ],
  "review_issues": [
    {
      "severity": "BLOCKER | REQUIRED | OPTIONAL | NIT",
      "title": "Issue title",
      "file_path": "src/file.ts",
      "description": "Specific issue description"
    }
  ],
  "expected_task_state": "REVIEWING",
  "expected_revision": ${task.revision_count}
}
\`\`\`
`;
    }

    const coderClaimsText = coderReport
      ? `
- **Status Claimed**: \`${coderReport.status}\`
- **Completed Items**:
${coderReport.completed.map((c) => `  - ${c}`).join('\n') || '  - None'}
- **Files Claimed Changed**:
${coderReport.files_claimed_changed.map((f) => `  - \`${f}\``).join('\n') || '  - None'}
- **Tests Claimed**:
${coderReport.tests_claimed.map((t) => `  - ${t}`).join('\n') || '  - None'}
`
      : 'No structured coder report provided.';

    const testEvidenceText = testRun
      ? `
- **Command**: \`${testRun.command}\`
- **Authoritative Verdict**: ${testRun.exit_code === 0 ? '🟢 PASSED' : '🔴 FAILED'} (Exit Code: \`${testRun.exit_code}\`)
- **Metrics**: ${testRun.passed_count} Passed | ${testRun.failed_count} Failed | ${testRun.skipped_count} Skipped
- **Duration**: ${testRun.duration_ms}ms
- **Evidence Reference**: \`${testRun.evidence_id || 'INLINE'}\`
`
      : '⚠️ [TEST EVIDENCE UNAVAILABLE / NOT RUN / ERROR]';

    return `# REVIEW PACKAGE: ${task.id} — ${task.title}

## Task Overview
- **Project**: ${project.name} (${project.id})
- **Task ID**: \`${task.id}\`
- **Priority**: \`${task.priority}\` | **Risk**: \`${task.risk}\`
- **Current Revision**: ${task.revision_count} / ${task.max_revisions}
- **Base SHA**: \`${task.base_sha || 'HEAD'}\`
- **Working SHA**: \`${task.current_sha || 'UNCOMMITTED / UNKNOWN'}\`

### Acceptance Criteria
${criteriaList}

---

## Authoritative Verification Evidence (Ground Truth)

### Git Diff Statistics
\`\`\`text
${gitDiffStat || 'No Git diff statistics available.'}
\`\`\`

### Real Git Diff
\`\`\`diff
${formattedDiff}
\`\`\`

### Automated Test Execution Evidence
${testEvidenceText}

---

## Coder Self-Report (Informational — Non-Authoritative)
${coderClaimsText}

---

## Previous Review History
${issuesText}

---

## Required Response Protocol (\`manager.v1\`)
Evaluate the authoritative evidence above against the acceptance criteria and return your verdict in the following JSON format:

\`\`\`json
{
  "protocol": "manager.v1",
  "message_id": "msg-mgr-${task.id}-${Date.now()}",
  "project_id": "${project.id}",
  "task_id": "${task.id}",
  "decision": "PASS | FIX_REQUIRED | BLOCK | NEEDS_OWNER",
  "priority": "${task.priority}",
  "risk": "${task.risk}",
  "instructions": [
    "Specific feedback or next instructions"
  ],
  "acceptance_criteria": [
    "Remaining criteria if fix required"
  ],
  "review_issues": [
    {
      "severity": "BLOCKER | REQUIRED | OPTIONAL | NIT",
      "title": "Issue title",
      "file_path": "src/file.ts",
      "description": "Specific issue description"
    }
  ],
  "expected_task_state": "REVIEWING",
  "expected_revision": ${task.revision_count}
}
\`\`\`
`;
  }
}
