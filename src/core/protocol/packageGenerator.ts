import {
  Project,
  Task,
  Review,
  Evidence,
  TestRun,
} from '../types/domain';
import { CoderProtocol } from '../types/protocols';
import { Repository } from '../database/repositories';
import {
  computeContextManifestHash,
  computePayloadHash,
  CanonicalExecutionPayload,
  CanonicalExecutionPayloadSchema,
} from '../services/ExecutionAuthorizationService';
import { CommandParser } from '../services/CommandParser';

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
      const parseResult = CanonicalExecutionPayloadSchema.safeParse(parsed);
      if (!parseResult.success) {
        throw new Error(parseResult.error.issues.map((i) => i.message).join(', '));
      }
      canonicalPayload = parseResult.data;
    } catch (err: any) {
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

    // 12. Derive verification guidance directly from durable project verification commands
    const verifCommands = repo.getVerificationCommandsByProject(auth.project_id);
    const testCmd = PackageGenerator.formatVerificationCommand(verifCommands, 'TEST');
    const lintCmd = PackageGenerator.formatVerificationCommand(verifCommands, 'LINT');
    const buildCmd = PackageGenerator.formatVerificationCommand(verifCommands, 'BUILD');

    // 13. Render instructions and context ONLY from verified frozen canonicalPayload
    const renderedInstructions =
      canonicalPayload.instructions.length > 0
        ? canonicalPayload.instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')
        : '1. No specific instructions provided.';

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

## Authorized Context Files
${renderedContextFiles}

## AgentForge Verification Guidance
Before completing work, ensure the following commands succeed locally:
- **Test**: ${testCmd}
- **Lint**: ${lintCmd}
- **Build**: ${buildCmd}

---

## Required Response Protocol (\`coder.v1\`)
When work is complete, return your final report strictly in the following JSON format:

\`\`\`json
{
  "protocol": "coder.v1",
  "message_id": "msg-cdr-${auth.task_id}-${Date.now()}",
  "project_id": "${auth.project_id}",
  "task_id": "${auth.task_id}",
  "attempt": 1,
  "status": "COMPLETED",
  "completed": [
    "Summary of what was implemented"
  ],
  "remaining": [],
  "files_claimed_changed": [
    "src/example.ts"
  ],
  "tests_claimed": [
    "npm test: all tests passing"
  ],
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
    repoOrCommands?: Repository | { test?: string; lint?: string; build?: string }
  ): string {
    const criteriaList = task.acceptance_criteria.length > 0
      ? task.acceptance_criteria.map((c, i) => `${i + 1}. [ ] ${c}`).join('\n')
      : 'None specified.';

    const constraintsList = task.constraints.length > 0
      ? task.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : 'None specified.';

    let testCmd = 'Not configured';
    let lintCmd = 'Not configured';
    let buildCmd = 'Not configured';

    if (repoOrCommands && typeof (repoOrCommands as Repository).getVerificationCommandsByProject === 'function') {
      const verifCommands = (repoOrCommands as Repository).getVerificationCommandsByProject(project.id);
      testCmd = PackageGenerator.formatVerificationCommand(verifCommands, 'TEST');
      lintCmd = PackageGenerator.formatVerificationCommand(verifCommands, 'LINT');
      buildCmd = PackageGenerator.formatVerificationCommand(verifCommands, 'BUILD');
    } else if (repoOrCommands && typeof repoOrCommands === 'object') {
      const custom = repoOrCommands as { test?: string; lint?: string; build?: string };
      if (custom.test && custom.test.trim().length > 0) {
        testCmd = custom.test.startsWith('`') ? custom.test : `\`${custom.test}\``;
      }
      if (custom.lint && custom.lint.trim().length > 0) {
        lintCmd = custom.lint.startsWith('`') ? custom.lint : `\`${custom.lint}\``;
      }
      if (custom.build && custom.build.trim().length > 0) {
        buildCmd = custom.build.startsWith('`') ? custom.build : `\`${custom.build}\``;
      }
    }

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
When work is complete, return your final report strictly in the following JSON format:

\`\`\`json
{
  "protocol": "coder.v1",
  "message_id": "msg-cdr-${task.id}-${Date.now()}",
  "project_id": "${project.id}",
  "task_id": "${task.id}",
  "attempt": 1,
  "status": "COMPLETED",
  "completed": [
    "Summary of what was implemented"
  ],
  "remaining": [],
  "files_claimed_changed": [
    "src/example.ts"
  ],
  "tests_claimed": [
    "npm test: all tests passing"
  ],
  "blockers": [],
  "review_requested": true,
  "expected_task_state": "CODING",
  "expected_revision": ${task.revision_count}
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
    gitDiffEvidence?: Evidence | null
  ): string {
    const criteriaList = task.acceptance_criteria.length > 0
      ? task.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : 'None specified.';

    const previousIssuesList = previousReviews.flatMap((r) => r.issues || []);
    const issuesText = previousIssuesList.length > 0
      ? previousIssuesList
          .map((iss) => `- **[${iss.severity}]** ${iss.title} (${iss.file_path || 'general'}): ${iss.description}`)
          .join('\n')
      : 'No previous review issues.';

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

    // Format Bounded Diff Content with Artifact Metadata for Large Diffs
    const MAX_DIFF_LENGTH = 32 * 1024;
    let formattedDiff = '';
    if (!gitDiffContent || !gitDiffContent.trim()) {
      formattedDiff = '(No git diff detected)';
    } else if (gitDiffContent.length <= MAX_DIFF_LENGTH) {
      formattedDiff = gitDiffContent;
    } else {
      if (!gitDiffEvidence) {
        throw new Error('AUTHORITATIVE_DIFF_EVIDENCE_MISSING: Large Git diff cannot be rendered in review package without authoritative evidence record.');
      }
      formattedDiff =
        gitDiffContent.substring(0, MAX_DIFF_LENGTH) +
        `\n\n... [TRUNCATED: Diff is ${gitDiffEvidence.byte_size} bytes]\n` +
        `- **Evidence ID**: \`${gitDiffEvidence.id}\`\n` +
        `- **SHA-256 Checksum**: \`${gitDiffEvidence.hash}\`\n` +
        `- **Byte Size**: \`${gitDiffEvidence.byte_size} bytes\`\n` +
        `- **Storage Type**: \`${gitDiffEvidence.storage_type}\``;
    }

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
