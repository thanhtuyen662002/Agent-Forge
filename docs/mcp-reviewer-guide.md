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
- **Single Approved Tool & Resource**: Exactly one tool (`agentforge_get_review_package`) and one resource template (`agentforge://reviews/packages/{adjudication_id}`) are exposed.

### 1.2 Comprehensive Read-Time Authority Fence
Before returning the frozen projection on every tool or resource read, the server evaluates a strict SELECT-only live authority revalidation:
- **Session Authentication & Scope**: Session exists, matches presented token hash, has supported scope (`AUTHORIZED_REVIEW_READ` or `REVIEWER_CONTEXT_READ`), is not revoked, and is not expired (`TOKEN_REVOKED`, `TOKEN_EXPIRED`).
- **Adjudication Live State**: Adjudication exists, status is `VERIFIED`, action is `ADMIT_VERIFICATION`, `recovery_fenced_at` is null, and authority snapshot hash matches the session (`STALE_REVIEWER_AUTHORITY`, `REVIEW_AUTHORITY_FENCED`).
- **Task Live State**: Task exists, remains in `REVIEW_READY` state, and task ownership epoch matches `session.task_ownership_epoch` (`TASK_STATE_INVALID`, `STALE_REVIEWER_AUTHORITY`).
- **Reviewer Agent Live State**: Reviewer agent exists, role is `REVIEWER`, status is not `OFFLINE`, and agent resource binding remains compatible with session resource (`REVIEWER_AGENT_INVALID`).
- **Reviewer Provider Live State**: Reviewer provider exists and is enabled (`REVIEWER_PROVIDER_INVALID`).
- **Reviewer Account Live State**: Reviewer account exists, belongs to reviewer provider, is enabled, and has operational health status in `AVAILABLE`, `BUSY`, `LOW_QUOTA` (`REVIEWER_ACCOUNT_INVALID`).
- **Reviewer Resource Live State**: Reviewer resource exists, belongs to reviewer provider, is enabled, has operational health status in `AVAILABLE`, `BUSY`, `LOW_QUOTA`, and has compatible account binding (`REVIEWER_RESOURCE_INVALID`).
- **Self-Review Prohibitions**: Agent-level self-review (`coder_attempt.agent_id != session.reviewer_agent_id`) and account-level self-review (`coder_submission.selected_account_id != session.reviewer_account_id`) prohibitions strictly hold (`SELF_REVIEW_FORBIDDEN`).

### 1.3 Frozen Projection Integrity on Every Read
Before returning `projection_json`, the read path validates:
- **Schema Version**: `session.projection_schema === 1` and `projection_schema_version === 1` (`PROJECTION_SCHEMA_INVALID`).
- **Payload Size Bound**: `projection_json` UTF-8 byte size does not exceed `PROJECTION_PAYLOAD_MAX_UTF8_BYTES` (512 KiB / 524,288 bytes) (`PROJECTION_PAYLOAD_TOO_LARGE`).
- **Cryptographic Hash Verification**: Recomputed SHA-256 over exact stored `projection_json` bytes matches `projection_hash` (`PROJECTION_HASH_MISMATCH`).
- **Bounded Structure Validation**: Parsed JSON object contains required bounded structure for adjudication, verification results, evidence (`git_status`, `git_diff`), and settled disposition (`PROJECTION_CORRUPTED`).

### 1.4 Atomic Rotation & Expiration
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

## 5. Authoritative Constants & Configuration

- **Token Prefix & Format**: `af-rev-` followed by lowercase UUIDv4 (e.g. `af-rev-12345678-1234-4234-8234-123456789abc`)
- **Token Scope**: `AUTHORIZED_REVIEW_READ` (supported alias: `REVIEWER_CONTEXT_READ`)
- **Token Storage**: The database stores only the SHA-256 hash of the token. Plaintext tokens are returned once upon issuance and never logged.
- **Diff Content Limit**: 32 KiB (`32,768` UTF-8 bytes); truncated at byte boundary preserving multibyte UTF-8 codepoints with `is_truncated: true`.
- **Projection Payload Limit**: 512 KiB (`524,288` UTF-8 bytes).
- **Session Duration**:
  - Default: 1 hour (`3,600` seconds)
  - Minimum: 1 minute (`60` seconds)
  - Maximum: 24 hours (`86,400` seconds)
- **Resource MIME Type**: `application/vnd.agentforge.review-package+json`
- **Approved Tool**: `agentforge_get_review_package`
- **Approved Resource Template**: `agentforge://reviews/packages/{adjudication_id}`
- **Environment Variables**:
  - `AGENTFORGE_MCP_REVIEWER_TOKEN`: Plaintext reviewer session token
  - `AGENTFORGE_MCP_DB_PATH`: Path to SQLite database file
- **npm Scripts**:
  - `npm run mcp:reviewer-stdio`: Launch stdio MCP reviewer server
  - `npm run mcp:reviewer-admin`: Launch reviewer administrative CLI

---

## 6. Migration 24 Representation & Integrity Verification

Migration 24 (`024_r5j_reviewer_session_authority`) establishes the durable reviewer session schema. Its raw SQL is stored as compressed Base64/GZIP chunks in `MIGRATION_24_GZIP_CHUNKS` to guarantee deterministic DDL representation across CRLF/LF operating systems.

Deterministic integrity verification is performed in production via:
`decompressAndVerifyMigration24Sql(chunks: readonly string[], expectedHash: string): string`

This production function executes during module evaluation to construct `MIGRATION_24_RAW_SQL` prior to any database execution in `applyPendingMigrations()` / `db.exec()`. It:
1. Strictly decodes Base64 chunks (validating characters and canonical padding).
2. Decompresses the GZIP stream via `zlib.gunzipSync`.
3. Decodes the bytes using fatal UTF-8 decoding (`new TextDecoder('utf-8', { fatal: true })`).
4. Recomputes SHA-256 over the exact UTF-8 bytes.
5. Asserts exact equality with `MIGRATION_24_EXPECTED_SQL_SHA256` (`2fc99142425342a96d76c187ad86f5ed433c214718f0a3790e482c2767a751fd`).
6. Throws a fail-closed error `[MIGRATION_24_INTEGRITY_VIOLATION]` before database execution if decoding, decompression, UTF-8 parsing, or hash verification fails.

*(Note: This is deterministic integrity verification against chunk corruption or transport drift, not a separate cryptographic trust boundary, as the chunks and expected hash are checked within the same codebase.)*

In addition, schema authority post-migration asserts:
- Table `mcp_reviewer_sessions` contains exactly 19 columns with required types and CHECK constraints.
- Exactly 6 foreign keys with `ON DELETE RESTRICT`.
- Exactly 4 user indexes.
- Exactly 3 triggers: delete prevention, immutable update, and insert-time authority fencing.

---

## 7. One-Snapshot Read Authorization Architecture

Reviewer context reads use a single authoritative API:
`ReviewerAuthorityService.authenticateAndGetReviewPackage(token: string, adjudicationId: string)`

Both the MCP tool (`agentforge_get_review_package`) and MCP resource (`agentforge://reviews/packages/{adjudication_id}`) handlers call this single API.

### Transactional Guarantees & Linearization Point
- **Linearization Point**: The beginning of the explicit SQLite deferred read transaction (`Repository.runInReadTransaction`).
- **Snapshot Isolation**: The entire read operation (token format validation, token hash lookup, session validation, comprehensive live authority validation, projection hash verification, and strict structural validation) runs inside this single transaction. All queries observe one consistent database MVCC snapshot.
- **Strictly Read-Only**: Zero database mutations occur (`total_changes()` remains strictly unchanged). No INSERT, UPDATE, DELETE, cleanup, token rotation, last-read tracking, or expiration mutation is performed.
- **Single Live Authority Query**: The comprehensive live authority query (`getReviewerAuthorityLiveValidationState`) evaluates all 4-tuple bindings, adjudication status, task state, and self-review fences in the same transaction snapshot, superseding the redundant legacy fence query.

### Strict Frozen-Projection Validation
Projections are validated against `StrictFrozenProjectionSchema` via `validateFrozenProjection`:
- Top-level structure: exactly `projection_schema_version`, `adjudication`, `verification_results`, `evidence`, and `disposition` (unexpected properties rejected).
- Nested validation:
  - `adjudication`: action `ADMIT_VERIFICATION`, status `VERIFIED`, identifiers bound to both session and live authority state (`id`, `submission_id`, `task_id`, `project_id`, `task_ownership_epoch`).
  - `verification_results`: non-null plain object, test run ID, `exit_code === 0`, `failed_count === 0`, non-negative integer counts and duration, non-null envelope object, and consistent `verification_result_envelope_hash`.
  - `evidence.git_status`: non-null plain object, `is_clean` boolean, safe repository-relative file paths (rejecting absolute paths, empty segments, and traversal `..`).
  - `evidence.git_diff`: non-null plain object, content string <= 32 KiB, `byte_size` matching exact UTF-8 byte length, and consistent truncation metadata.
  - `disposition`: `SETTLED`, `ACCEPTED_VERIFIED`, valid ISO timestamp.
- Prototype-sensitive keys (`__proto__`, `constructor`, `prototype`) are rejected.
- Sanitized fail-closed errors are returned on any violation, exposing no projection content.
