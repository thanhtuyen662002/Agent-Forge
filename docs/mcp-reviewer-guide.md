# AgentForge Reviewer MCP Context Authority Guide (R5J7)

## Overview

The AgentForge Reviewer MCP server provides an independently authorized external reviewer with a durable, frozen, verified review package through exactly one read-only MCP tool and one read-only MCP resource.

Under the R5J7 security contract, an external reviewer cannot gain task mutation, Git mutation, verdict ingestion, adjudication, promotion, or deployment authority. The server operates over standard I/O (stdio) transport only and does not access or reconstruct data from the mutable live workspace.

---

## 1. Architecture and Security Model

### 1.1 Read-Only & Zero-Write Guarantees
- **Zero-Write Reads**: Every tool call (`agentforge_get_review_package`) and resource read (`agentforge://reviews/packages/{adjudication_id}`) is guaranteed to perform zero SQLite database writes (`changes_after - changes_before === 0`).
- **Frozen Projection**: The review package projection is constructed deterministically at session issuance time from canonical, verified adjudication artifacts. Subsequent reads return byte-identical frozen projection bytes.
- **No Live Workspace Access**: The read path never inspects the working tree, Git HEAD, or filesystem files. Mutations to the live workspace after session issuance have zero effect on the returned review package.

### 1.2 Stale Authority Fence
Before returning the frozen projection, the server evaluates a SELECT-only authority check:
- **Session Revocation**: If `revoked_at IS NOT NULL`, fails closed with `TOKEN_REVOKED`.
- **Session Expiration**: If `now >= expires_at`, fails closed with `TOKEN_EXPIRED`.
- **Adjudication Recovery Fencing**: If adjudication status is `RECOVERY_FENCED` or `recovery_fenced_at IS NOT NULL`, fails closed with `REVIEW_AUTHORITY_FENCED`.
- **Task Ownership Epoch Mismatch**: If `tasks.ownership_epoch != session.task_ownership_epoch`, fails closed with `STALE_REVIEWER_AUTHORITY`.
- **Authority Snapshot Hash Mismatch**: If the current adjudication authority snapshot hash does not match `session.authority_snapshot_hash`, fails closed with `STALE_REVIEWER_AUTHORITY`.

### 1.3 Atomic Rotation & Expiration
- There is no background sweeper, timer, or cron daemon.
- When an expired session is presented on read, it fails closed with `TOKEN_EXPIRED` without mutating the database.
- When a replacement session is issued for the same adjudication and reviewer agent binding where an existing session has expired, the expired session is atomically revoked in the same transaction with reason `EXPIRED_AUTOMATIC_ROTATION`.

---

## 2. MCP Tool Contract

### Single Approved Tool: `agentforge_get_review_package`

The server exposes strictly one tool. No aliases or legacy endpoints (`get_review_context`, `get_task_evidence`, `get_verification_details`, `get_diff_summary`) exist.

#### Annotations
- `readOnlyHint`: `true`
- `destructiveHint`: `false`
- `idempotentHint`: `true`
- `openWorldHint`: `false`

#### Input Schema
```json
{
  "type": "object",
  "properties": {
    "adjudication_id": {
      "type": "string"
    }
  },
  "required": ["adjudication_id"],
  "additionalProperties": false
}
```

Any unrecognized or extra properties (such as `session_id` or `reviewer_id`) are rejected fail-closed with standard JSON-RPC `InvalidParams`.

#### Cross-Adjudication Fencing
The authenticated reviewer session is immutably bound to a single `adjudication_id`. If the caller requests a different `adjudication_id`, the call fails closed with `PERMISSION_DENIED`.

---

## 3. MCP Resource Contract

### Resource Template: `agentforge://reviews/packages/{adjudication_id}`
- **MIME Type**: `application/vnd.agentforge.review-package+json`
- **Canonical Parity**: Returns byte-identical JSON and matching SHA-256 hash to the `agentforge_get_review_package` tool.
- **Cross-Adjudication Fencing**: Attempting to read a URI for an adjudication other than the authenticated session's bound adjudication fails closed with `PERMISSION_DENIED`.

---

## 4. Administrative CLI (`reviewerAdmin`)

The administrative entrypoint exposes strictly four commands:

```bash
# Display help and usage
node dist-electron/mcp/reviewerAdmin.js --help

# 1. Issue a reviewer session
node dist-electron/mcp/reviewerAdmin.js issue \
  --db <path-to-db> \
  --adjudication <adjudication-uuid> \
  [--agent <agent-id>] \
  [--provider <provider-id>] \
  [--account <account-id>] \
  [--resource <resource-id>] \
  [--ttl <seconds>] \
  [--json]

# 2. Revoke an active reviewer session
node dist-electron/mcp/reviewerAdmin.js revoke \
  --db <path-to-db> \
  (--session <session-id> | --adjudication <adjudication-id>) \
  --reason "<nonempty-reason>" \
  [--json]

# 3. List active and historical reviewer sessions (Zero token/hash leakage)
node dist-electron/mcp/reviewerAdmin.js list \
  --db <path-to-db> \
  [--session <session-id>] \
  [--adjudication <adjudication-id>] \
  [--json]

# 4. Generate client configuration template (Print-only, never mutates files)
node dist-electron/mcp/reviewerAdmin.js configure-client \
  --client <antigravity|cursor|claude> \
  [--db <path-to-db>] \
  [--json]
```

### Exit Codes
- `0`: Success
- `1`: Configuration / validation error (invalid CLI flags, missing required arguments, forbidden commands)
- `2`: Authority error (adjudication not found, unverified, recovery fenced, self-review rejected, stale authority)

### Forbidden Commands
`inspect`, `sweep`, `cleanup`, `rotate`, `adjudicate`, `submit-verdict`, `promote`, `commit`, `push`, and `apply` are strictly forbidden and rejected with exit code 1.

---

## 5. Token Format & Environment Variables

- **Prefix**: `af-rev-` followed by lowercase UUIDv4 (e.g. `af-rev-12345678-1234-4234-8234-123456789abc`)
- **Storage**: The database stores only the SHA-256 hash of the token. Plaintext tokens are returned once upon issuance and never logged.
- **Environment Variable**: `AGENTFORGE_MCP_REVIEWER_TOKEN`
- **Database Path Variable**: `AGENTFORGE_MCP_DB_PATH`
