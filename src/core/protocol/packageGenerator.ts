import {
  Project,
  Task,
  Review,
  ReviewIssue,
  Evidence,
  TestRun,
} from '../types/domain';
import { CoderProtocol } from '../types/protocols';

export class PackageGenerator {
  public static generateWorkOrder(
    project: Project,
    task: Task,
    verificationCommands: { test?: string; lint?: string; build?: string } = {}
  ): string {
    const criteriaList = task.acceptance_criteria.length > 0
      ? task.acceptance_criteria.map((c, i) => `${i + 1}. [ ] ${c}`).join('\n')
      : 'None specified.';

    const constraintsList = task.constraints.length > 0
      ? task.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : 'None specified.';

    const testCmd = verificationCommands.test || 'npm test';
    const lintCmd = verificationCommands.lint || 'npm run lint';
    const buildCmd = verificationCommands.build || 'npm run build';

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
- **Test**: \`${testCmd}\`
- **Lint**: \`${lintCmd}\`
- **Build**: \`${buildCmd}\`

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
    previousReviews: Review[] = []
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
