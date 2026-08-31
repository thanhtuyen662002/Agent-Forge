# Structured Protocols & Messaging Specifications

Agent-Forge enforces structured, machine-validated protocols for all communication between the Owner Control Center, AI Managers, and AI Coders.

---

## 1. Core Protocols

### 1.1 Manager Protocol (`manager.v1`)
Used by AI Managers (e.g. ChatGPT Manager) to issue task decomposition, dispatch orders, review verdicts, or escalation requests.

```json
{
  "protocol": "manager.v1",
  "message_id": "msg-mgr-20260817-001",
  "project_id": "AGENT-FORGE",
  "task_id": "AUTH-014",
  "decision": "EXECUTE",
  "priority": "HIGH",
  "risk": "MEDIUM",
  "instructions": [
    "Implement JWT validation middleware",
    "Add unit tests for token expiration and bad signature"
  ],
  "acceptance_criteria": [
    "Returns 401 on expired token",
    "Returns 403 on invalid signature",
    "All unit tests pass"
  ],
  "constraints": [
    "Do not modify user table schema",
    "Use existing jose/jsonwebtoken library"
  ],
  "expected_task_state": "PLANNED",
  "expected_revision": 0,
  "created_at": "2026-08-17T23:30:00.000Z",
  "review_issues": [
    {
      "severity": "REQUIRED",
      "title": "Missing signature check",
      "file_path": "src/auth.ts",
      "line_number": 42,
      "description": "Ensure signature verification occurs prior to claims extraction"
    }
  ]
}
```

#### Valid Decisions:
- `CREATE_TASKS`: Initial task decomposition for a project milestone.
- `EXECUTE`: Approves task for coding dispatch.
- `PASS`: Review verdict passing the task; moves to `DONE`.
- `FIX_REQUIRED`: Review verdict requesting fixes; increments revision and returns to `CODING`.
- `BLOCK`: Flags an external or architectural blocker; moves to `BLOCKED`.
- `PAUSE`: Requests task suspension; moves to `PAUSED`.
- `CANCEL`: Cancels task; moves to `CANCELLED`.
- `NEEDS_OWNER`: Escalates decision to human owner.

---

### 1.2 Coder Protocol (`coder.v1`)
Used by AI Coders (e.g. Gemini Coder) to report work progress, claimed changes, test claims, and request review.

```json
{
  "protocol": "coder.v1",
  "message_id": "msg-cdr-20260817-001",
  "project_id": "AGENT-FORGE",
  "task_id": "AUTH-014",
  "attempt": 1,
  "status": "COMPLETED",
  "completed": [
    "Implemented JWT middleware in src/middleware/auth.ts",
    "Added 8 unit tests in tests/auth.test.ts"
  ],
  "remaining": [],
  "files_claimed_changed": [
    "src/middleware/auth.ts",
    "tests/auth.test.ts"
  ],
  "tests_claimed": [
    "tests/auth.test.ts: 8 passed"
  ],
  "blockers": [],
  "review_requested": true,
  "expected_task_state": "CODING",
  "expected_revision": 0,
  "created_at": "2026-08-17T23:35:00.000Z"
}
```

> **Authoritative Rule**: Coder claims are informational. They are cross-checked against actual Git diffs and test runner outputs. Real execution evidence is authoritative.

---

### 1.3 Handoff Protocol (`handoff.v1`)
Generated when an agent hits quota, context exhaustion, or encounters an unexpected crash.

```json
{
  "protocol": "handoff.v1",
  "message_id": "msg-hnd-20260817-001",
  "task_id": "AUTH-014",
  "attempt": 1,
  "previous_agent": "gemini-1.5-pro",
  "reason": "QUOTA_EXHAUSTED",
  "completed": [
    "Defined middleware structure in src/middleware/auth.ts"
  ],
  "remaining": [
    "Implement signature validation algorithm",
    "Run unit tests"
  ],
  "known_failures": [
    "TypeScript compile error on line 28 of auth.ts"
  ],
  "base_sha": "7f8b9a1",
  "current_sha": "4c3d2e1",
  "relevant_files": [
    "src/middleware/auth.ts"
  ],
  "next_action": "Fix type signature on verifyToken() and execute npm test",
  "created_at": "2026-08-17T23:40:00.000Z"
}
```

---

### 1.4 Implementation Status Report Protocol (`coder-report.v1`)
Used during development phases to communicate progress between implementation agents and managers.

```json
{
  "protocol": "coder-report.v1",
  "message_id": "cr-phase0-001",
  "phase": "PHASE_0",
  "status": "COMPLETED",
  "summary": "Phase 0 architecture corrections applied.",
  "files_changed": [
    "docs/ARCHITECTURE.md",
    "docs/STATE_MACHINES.md",
    "docs/DATA_MODEL.md",
    "docs/PROTOCOLS.md",
    "docs/THREAT_MODEL.md",
    "docs/SECURITY.md",
    "README.md"
  ],
  "tests_run": [],
  "tests_passed": [],
  "tests_failed": [],
  "known_issues": [],
  "security_notes": [
    "Electron security boundary specified (contextIsolation, sandbox, CSP)",
    "ProcessRunner shell execution disabled by default"
  ],
  "next_phase": "PHASE_1",
  "requires_manager_review": true,
  "created_at": "2026-08-17T23:45:00.000Z"
}
```

---

## 2. Idempotency & Stale-Write Protection

### Message Ledger Verification
1. **Message ID Deduplication**: Every incoming message must carry a unique `message_id`. If `message_id` already exists in `protocol_messages`, the duplicate paste is detected and safely ignored.
2. **Payload Hash Deduplication**: The SHA-256 hash of the normalized payload is checked. Identical payloads receive `DUPLICATE` status.
3. **State & Revision Guarding**:
   - `expected_task_state`: The message is rejected with `STALE_STATE_ERROR` if the current task state in SQLite does not match.
   - `expected_revision`: The message is rejected with `STALE_REVISION_ERROR` if `tasks.revision_count` has progressed beyond `expected_revision`.

---

## 3. Outbox Package Formats

### 3.1 Work Order (Desktop -> Coder)
Contains:
- Task ID, Title, Description, Priority, Risk
- Milestone & Project Context
- Acceptance Criteria & Constraints
- Relevant Architecture Decisions
- Current Git Base SHA & Task Branch
- Target Verification Commands
- Required Output Protocol (`coder.v1`)

### 3.2 Review Package (Desktop -> Manager)
Contains:
- Task Definition & Goals
- Authoritative Git Diff & Stat (from Git CLI)
- Authoritative Test Runner Results (Exit code, pass/fail counts)
- Coder Self-Report Claims
- Previous Review History & Unresolved Issues
- Required Output Protocol (`manager.v1`)

---

## 4. Cross-Provider Handoff & Settlement Protocols (R5I)

### 4.1 Handoff Successor Authorization Formula (`auth-handoff.v1`)
The successor execution authorization ID is deterministically computed via:
```text
computeHandoffAuthorizationId({
  version: 1,
  transfer_id,
  successor_attempt_id,
  successor_assignment_id,
  successor_ownership_epoch,
  routing_decision_id,
  handoff_route_spec_hash,
  successor_context_spec_hash,
  manager_message_id,
  manager_payload_hash
})
```
Where `handoff_route_spec_hash` and `successor_context_spec_hash` are SHA-256 digests over canonically stringified JSON descriptors.

### 4.2 Trusted Provider Execution Provenance (`ProviderExecutionProvenanceV1`)
Stamped exclusively by `ProviderDispatchService` upon adapter return; all adapter-supplied provenance overrides are stripped:
```json
{
  "version": 1,
  "source": "PROVIDER_DISPATCH_SERVICE",
  "mode": "SCHEDULED",
  "adapterInvocation": "RETURNED",
  "authorizationId": "auth-handoff-...",
  "executionId": "948045e6-8a73-4a3b-ac0c-00cb8a2c5255",
  "projectId": "proj-1",
  "taskId": "task-1",
  "attemptId": "att-2",
  "routingDecisionId": "rd-1",
  "providerId": "prov-gemini",
  "resourceId": "res-gemini-flash",
  "assignmentId": "asgn-succ-1",
  "accountId": "acc-gemini-prod"
}
```

### 4.3 Authentic Durable Settlement Evidence (`SettlementEvidenceV1`)
19-field envelope sealed in `execution_authorizations.settlement_evidence_json`:
```json
{
  "authorization_id": "auth-handoff-...",
  "execution_id": "948045e6-8a73-4a3b-ac0c-00cb8a2c5255",
  "transfer_id": "xfer-1",
  "project_id": "proj-1",
  "task_id": "task-1",
  "attempt_id": "att-2",
  "assignment_id": "asgn-succ-1",
  "provider_id": "prov-gemini",
  "resource_id": "res-gemini-flash",
  "account_id": "acc-gemini-prod",
  "routing_decision_id": "rd-1",
  "ownership_epoch": 2,
  "lifecycle_version": 1,
  "settlement_status": "COMPLETED",
  "outcome": "RETURNED",
  "started_at": "2026-08-31T20:00:00.000Z",
  "finished_at": "2026-08-31T20:01:00.000Z",
  "result_payload": { "status": "COMPLETED" },
  "error_json": null
}
```
