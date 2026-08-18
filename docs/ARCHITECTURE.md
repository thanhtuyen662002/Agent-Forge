# System Architecture: Agent-Forge

## 1. Architectural Overview

Agent-Forge is structured as a **local-first desktop control plane**. The architecture cleanly separates the **Durable Core & Process Engine** (running in the trusted Electron Main Node.js process) from the **Owner Presentation Layer** (running in the sandboxed React 19 Renderer process).

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                       React 19 Renderer Process                         │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                        Views & Navigation                       │   │
│   │   Dashboard │ Manual Bridge │ Task Board │ Agent Center         │   │
│   │   Capacity  │ Timeline      │ Decisions  │ Evidence Locker      │   │
│   └────────────────────────────────┬────────────────────────────────┘   │
│                                    │                                    │
│   ┌────────────────────────────────▼────────────────────────────────┐   │
│   │                    State Layer & UI Hooks                       │   │
│   │         OrchestratorContext │ useTasks │ useEvents              │   │
│   └────────────────────────────────┬────────────────────────────────┘   │
└────────────────────────────────────┼────────────────────────────────────┘
                                     │
                                     │ Typed IPC Bridge (preload.ts)
                                     │ contextIsolation=true, sandbox=true
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Electron Main Process (Node.js)                    │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                      Typed IPC Controller                       │   │
│   │              Zod Request Validation & Error Handling            │   │
│   └────────────────────────────────┬────────────────────────────────┘   │
│                                    │                                    │
│   ┌────────────────────────────────▼────────────────────────────────┐   │
│   │                       Application Core                          │   │
│   │   ProjectService      TaskService         AgentService          │   │
│   │   StateMachine        EventService        EvidenceService       │   │
│   │   GitService          PolicyService       QuotaService          │   │
│   │   HandoffService      ProgressService     ArtifactStore         │   │
│   │   ProcessRunner       CheckpointService   CrashRecoveryService  │   │
│   │   EmergencyStopService                    ProviderRegistry      │   │
│   └───────────────────────────────┬─────────────────────────────────┘   │
│                                   │                                     │
│   ┌───────────────────────────────▼─────────────────────────────────┐   │
│   │                     Persistence & OS Subsystems                 │   │
│   │                                                                 │   │
│   │   ┌────────────────────────┐      ┌─────────────────────────┐   │   │
│   │   │  better-sqlite3        │      │  Safe Process Runner    │   │   │
│   │   │  - Foreign Keys: ON    │      │  - Structured Exec      │   │   │
│   │   │  - Journal Mode: WAL   │      │  - shell: false         │   │   │
│   │   │  - Busy Timeout: 5000  │      │  - PID & Cancellation   │   │   │
│   │   │  - Migrations Engine   │      │  - Output Redaction     │   │   │
│   │   └────────────────────────┘      └─────────────────────────┘   │   │
│   │   ┌────────────────────────┐      ┌─────────────────────────┐   │   │
│   │   │  ArtifactStore         │      │  Git CLI Service        │   │   │
│   │   │  - Inline (<32KB)      │      │  - Safe read ops        │   │   │
│   │   │  - File (>=32KB)       │      │  - Worktree isolation   │   │   │
│   │   │  - SHA-256 Hashing     │      │  - Diff & Log parsing   │   │   │
│   │   └────────────────────────┘      └─────────────────────────┘   │   │
│   └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Desktop Shell & IPC Boundary

### Process Separation & Isolation
- **Renderer Process**: Completely untrusted presentation layer. `nodeIntegration = false`, `contextIsolation = true`, and `sandbox = true`. The renderer has zero direct access to Node.js `fs`, `child_process`, or SQLite.
- **Preload API (`preload.ts`)**: Exposes a single frozen, strictly typed API object (`window.orchestrator`).
- **IPC Handlers (`ipcHandlers.ts`)**: Every IPC invocation passes through schema validation (via Zod) on the main process side before execution. Invalid requests are rejected with structured error payloads.

### Content Security Policy (CSP)
Renderer enforces strict CSP headers:
```http
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
```

---

## 3. Database Engine & Persistence Strategy

### Engine Selection: `better-sqlite3`
- **Single Production Engine**: Agent-Forge exclusively utilizes `better-sqlite3` for synchronous, low-latency, crash-resilient SQLite operations.
- **No Silent Fallback**: If `better-sqlite3` fails to load (e.g. missing native compilation), the application **fails closed immediately** with a clear, actionable error instructing the user to rebuild native modules. Pure-JS engines like `sql.js` are strictly relegated to in-memory unit tests if explicitly requested.
- **Native Rebuild Configuration**:
  ```powershell
  npx @electron/rebuild -f -w better-sqlite3
  ```

### Database Initialization & Pragmas
On application startup, the SQLite database is initialized with:
```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
```

### Schema Migrations Engine
- Migrations are versioned SQL scripts executed within explicit transactions.
- The `schema_migrations` table records version, name, and timestamp.
- If a migration fails, the transaction rolls back, and startup is aborted.

---

## 4. Large Evidence Storage (`ArtifactStore`)

To prevent SQLite bloat and performance degradation from unbounded command outputs, diffs, and test suites:

- **Configurable Threshold**: Default `32 KB` (`32,768 bytes`).
- **Inline Storage**: Payloads `< 32 KB` are stored directly in SQLite `evidence.raw_payload`.
- **File Storage**: Payloads `>= 32 KB` are written to disk under `.agent-forge/artifacts/<sha256>.bin`.
- **Integrity**: Every artifact calculates and verifies a `SHA-256` checksum on write and read.
- **Metadata**: SQLite records `storage_type` (`INLINE` vs `FILE`), `file_path`, `hash`, `byte_size`, and `content_type`.

---

## 5. Safe Process Execution Engine (`ProcessRunner`)

All command executions (tests, linter, typecheck, git) are executed through `ProcessRunner`:

### Execution Contract
```typescript
interface ProcessExecutionRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  environmentAllowlist?: Record<string, string>;
  allowShell?: boolean; // Default FALSE
}
```

### Safety Guarantees
1. **Default `shell: false`**: Executables are invoked with direct argument arrays, eliminating shell injection vectors.
2. **PID Tracking & Cancellation**: Every spawned child process is assigned a UUID, tracked in memory and SQLite `process_runs`, and attached to an `AbortController`.
3. **Emergency Stop Termination**: Triggering Emergency Stop issues `SIGTERM` followed by `SIGKILL` (or `taskkill /F /T /PID` on Windows) to all tracked process trees.
4. **Secret Redaction**: Standard patterns (API keys, bearer tokens, passwords) are filtered before persisting logs.

---

## 6. Provider Resource & Model Architecture

Agent-Forge does not treat raw model strings as architectural truth. Providers, adapters, and resources are modeled explicitly:

### Provider Resource & Routing Architecture (`ProviderRoutingService`)
- **Routing Target**: Routes by `ProviderResource` ID (which owns discrete capabilities, model name, health status, and quota metadata), resolving through `ProviderRegistry` to concrete `ProviderAdapter` implementations.
- **Explicit Candidate Policy**: Routing requests must provide an explicit, ordered list of candidate resource IDs. Duplicate candidates are rejected explicitly. Empty candidate lists yield `NO_ELIGIBLE_PROVIDER`.
- **Deterministic Eligibility Tiers**:
  - **Tier 1 (AVAILABLE Automated)**: Provider is enabled, satisfies required capabilities (subset of both resource and adapter), live health is `AVAILABLE`, and quota is not authoritatively exhausted.
  - **Tier 2 (LOW_QUOTA Automated)**: Provider satisfies capabilities, health is `LOW_QUOTA`, and quota is not authoritatively exhausted.
  - **Tier 3 (Manual Bridge)**: Permitted only when `allowManualBridge=true`, resource is enabled, and required capabilities match. Yields `MANUAL_HANDOFF_REQUIRED` (never automated `SELECTED`).
  - **Tie-Breaking**: Within the same eligibility tier, candidate input ordering is preserved deterministically without random selection or fake quota percentages.
- **Truthful Quota & Exhaustion Semantics**:
  - Quota is never guessed or cross-compared across different units (e.g. tokens vs requests).
  - Hard exhaustion occurs only when health is `QUOTA_EXHAUSTED` or authoritative remaining quota is $\le 0$ under `MEASURED`, `PROVIDER_REPORTED`, or `MANUAL` sources.
  - `UNKNOWN` quota or `ESTIMATED` remaining $= 0$ does not hard-block dispatch if health is `AVAILABLE`.
- **Pre-Dispatch-Only Failover & AUTH_ERROR Hard Stop**:
  - Ineligible candidates (e.g. `RATE_LIMITED`, `OFFLINE`, `UNHEALTHY`) are skipped **before** dispatch.
  - Encountering `AUTH_ERROR` halts routing immediately with `NEEDS_OWNER` and zero failover to prevent silent authority or credential bypass.
- **Durable Routing Audit Trail**: Every routing decision persists a `PROVIDER_ROUTING_DECISION` audit event in SQLite capturing decision ID, outcome, reason, and telemetry snapshots, free from prompts, instructions, or secrets. Pure routing never mutates task state or resource configuration.

- **Provider Resource / Model**: Represents specific model endpoints with discrete:
  - Health status (`AVAILABLE`, `LOW_QUOTA`, `RATE_LIMITED`, `QUOTA_EXHAUSTED`, `OFFLINE`, `UNKNOWN`)
  - Quota snapshot with confidence rating (`MEASURED`, `PROVIDER_REPORTED`, `MANUAL`, `ESTIMATED`, `UNKNOWN`)
  - Supported capabilities (`CODING`, `PLANNING`, `REVIEW`, `SECURITY_REVIEW`, `LARGE_CONTEXT`, etc.)
  - Enabled / disabled flag

---

## 7. Durable Execution Authorization & Orchestration Binding

**Routing Authority $\neq$ Execution Payload Authority $\neq$ Task State Alone.**

- **ManagerProtocol Truth**: Approved work authority originates strictly from the applied Manager protocol ledger (`manager.v1` with decision `EXECUTE` or `FIX_REQUIRED`). Non-authorizing decisions (`PASS`, `BLOCK`, `PAUSE`, `CANCEL`, `NEEDS_OWNER`, `CREATE_TASKS`) and arbitrary task states alone cannot authorize execution.
- **RoutingDecision**: Decides *which ProviderResource may execute* (`SELECTED` or `MANUAL_HANDOFF_REQUIRED`).
- **ExecutionAuthorization**: Decides *what exact approved work that provider is authorized to execute*.
- **Git Authority**: Distinguishes `base_sha` (the task/diff baseline) from `repository_head_sha` (actual repository Git HEAD captured at authorization creation and verified prior to dispatch).

No provider execution may be authorized solely by a `decisionId` plus caller-supplied instructions. All execution payloads and context manifests originate strictly from approved durable AgentForge state.

### Security & Authority Chain
```text
Manager Protocol Ledger (manager.v1 APPLIED: EXECUTE | FIX_REQUIRED)
        ↓
ExecutionAuthorization (Canonical Payload Hash, Context Manifest Hash, Real Git HEAD)
        ↓
ProviderRoutingDecision (Selected Resource & Provider Mapping)
        ↓
ProviderDispatchService.dispatch(authorizationId)
        ↓
EXACTLY ONE Provider Execution
```

### Execution Authorization Invariants (`ExecutionAuthorizationService`, `ProviderDispatchService`)
- **Durable Immutable Record**: Persisted in SQLite `execution_authorizations` (Migration 6) with foreign keys enforcing `ON DELETE RESTRICT` to prevent historical scope tampering:
  `id`, `project_id`, `task_id`, `attempt_id`, `task_revision`, `base_sha`, `repository_head_sha`, `manager_message_id`, `manager_payload_hash`, `routing_decision_id`, `selected_resource_id`, `selected_provider_id`, `instruction_payload_hash`, `context_manifest_hash`, `canonical_instructions_json`, `context_files_json`, `status: AUTHORIZED | DISPATCHED | INVALIDATED`.
- **Manager Ledger Authority Binding & Liveness**:
  - Requires an applied `manager.v1` protocol message with `EXECUTE` or `FIX_REQUIRED`.
  - Strict revision binding: For `EXECUTE`, `manager.expected_revision === task.revision_count`. For `FIX_REQUIRED`, strictly requires `manager.expected_revision + 1 === task.revision_count` (the pre-fix revision incremented on fix cycle entry).
  - Deterministic Manager ledger ordering across all queries uses canonical total-order key `(created_at, id)`:
    - Chronological traversal: `ORDER BY created_at ASC, id ASC` (`Repository.getProtocolMessagesByTask`).
    - Latest APPLIED authority resolver: `ORDER BY created_at DESC, id DESC LIMIT 1` (`Repository.getLatestAppliedManagerProtocolMessage`).
  - **Transaction-Bound Supersession**: In PR #7, `TaskService.applyManagerDecision` applies six Manager decisions: `EXECUTE`, `FIX_REQUIRED`, `PASS`, `BLOCK`, `PAUSE`, and `CANCEL`. When any of these six decisions is newly and successfully `APPLIED`, all previous still-`AUTHORIZED` execution authorizations for that task are invalidated (`status = 'INVALIDATED'`) within the SAME SQLite transaction (`Repository.invalidateAuthorizedExecutionAuthorizationsForTask`).
  - `NEEDS_OWNER` and `CREATE_TASKS` exist in the `manager.v1` protocol schema vocabulary, but `TaskService` does NOT apply them in PR #7; therefore PR #7 defines no TaskService execution supersession path for `NEEDS_OWNER` or `CREATE_TASKS`.
  - Decisions marked `REJECTED` do NOT invalidate existing authorizations.
  - `DUPLICATE` (already processed) Manager messages do NOT invalidate existing authorizations.
  - Transaction rollback automatically rolls back authorization invalidations.
  - **Dispatch-Time Defense-in-Depth**: At dispatch, `ProviderDispatchService.dispatch` re-evaluates the latest applied Manager protocol record using `Repository.getLatestAppliedManagerProtocolMessage`. If the bound record is no longer the latest applied record or if payload hash differs, dispatch fails closed with `EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_SUPERSEDED`, transitions `AUTHORIZED -> INVALIDATED`, and executes zero providers.
- **Dispatch-Time Task State Liveness**:
  - Re-evaluates current `task.state` after loading `RoutingDecision` but prior to atomic CAS claim.
  - Automated `SELECTED` execution requires `task.state === 'CODING'`.
  - `MANUAL_HANDOFF_REQUIRED` requires `task.state === 'CODING' || task.state === 'HANDOFF_REQUIRED'`.
  - If task transitioned out of valid states between authorization and dispatch, dispatch fails closed with `EXECUTION_AUTHORIZATION_STALE_TASK_STATE`, transitions `AUTHORIZED -> INVALIDATED`, and executes zero providers.
- **Real Git Repository Authority**:
  - Captures live `repository_head_sha` via `GitService.getHeadSha(project.repository_path)`.
  - Re-probes live Git repository HEAD at dispatch before claiming authorization. If repository HEAD has moved, dispatch fails closed with `EXECUTION_AUTHORIZATION_STALE_GIT_HEAD` and permanently invalidates the authorization.
- **Canonical Payload & Manifest Hashing**:
  - `instructionPayloadHash = SHA-256(canonicalPayload)` derived deterministically from task title, description, acceptance criteria, constraints, Manager instructions, and context files.
  - `contextManifestHash = SHA-256(canonicalContextFiles)` with strict relative path containment, no traversal (`../`), no sensitive credential paths (`.env`, `.ssh`, `.aws`, `.gnupg`), and deterministic lexicographical sorting.
- **Zero Caller-Supplied Instructions at Dispatch**: `ProviderDispatchService.dispatch(authorizationId)` accepts **ONLY** `authorizationId`. The execution payload is reconstructed internally from durable state.
- **Atomic One-Time Claim**: Compare-and-set claim (`UPDATE ... SET status = 'DISPATCHED' WHERE id = ? AND status = 'AUTHORIZED'`) guarantees that concurrent calls or replayed authorizations execute zero additional times.
- **Permanent Invalidation on Stale Checks**: Any validation failure (superseded Manager authority, stale task revision/state, changed Git HEAD, routing scope mismatch, malformed payload JSON) permanently consumes the row as `INVALIDATED` (`UPDATE ... SET status = 'INVALIDATED' WHERE id = ? AND status = 'AUTHORIZED'`).
- **Safe Rejection Evidence**: Discarded or rejected authorizations record `EXECUTION_AUTHORIZATION_REJECTED` events with safe structured metadata (hashes, IDs, reason) and strictly zero prompt text, instructions, or secrets.
- **Zero Post-Dispatch Failover**: If execution fails (process crash, protocol invalid, timeout, cancellation), the authorization remains consumed (`DISPATCHED`) and never automatically triggers a second provider execution.

---

## 8. Deterministic Derived Progress

Task and project progress are never derived from AI self-estimation.

### Progress Formula
$$\text{Task Progress} = \sum (\text{Completed Work Units} \times \text{Weight})$$

Default Work Unit Weights:
- Analysis & Plan Approved: `10%`
- Implementation & Git Changes: `40%`
- Targeted Test Passing: `20%`
- Regression & Lint Passing: `15%`
- Review Evidence Package Created: `5%`
- Manager Review PASS: `10%`

If work units cannot be verified, the UI displays `PROGRESS UNKNOWN`.

---

## 9. Owner Routing & Manual Bridge Relay Loop (`ManualBridgeView`, Typed IPC)

AgentForge PR #8 introduces the complete Owner-facing Human-in-the-Loop routing and manual relay control station on top of the durable PR #6 routing and PR #7 authorization backbones.

### Workflow Sequence
```
Manager Inbox (APPLY EXECUTE / FIX_REQUIRED)
                   ↓
Owner Selects Task & Verifies Manager Authority
                   ↓
Owner Selects & Orders Candidate ProviderResources (Move Up / Down)
                   ↓
Owner Toggles `Allow Manual Bridge Fallback`
                   ↓
`routing:routeTask` IPC → `ProviderRoutingService.route` → Durable RoutingDecision
                   ↓
`routing:authorizeTask` IPC → `ExecutionAuthorizationService.createAuthorization`
                   ↓
`routing:dispatchAuthorization` IPC → `ProviderDispatchService.dispatch(authorizationId)`
                   ↓
ManualBridgeAdapter returns `AWAITING_OWNER` & consumes authorization (`DISPATCHED`)
                   ↓
Owner clicks `GENERATE WORKORDER` & `1-CLICK COPY WORKORDER`
                   ↓
Owner manually relays prompt to Gemini Coder (zero browser or clipboard scraping)
                   ↓
Owner pastes Gemini report into Coder Inbox → Protocol validation & Verification tests
```

### IPC Security & Process Isolation Invariants
- **Strict Schema Enforcement**: All routing IPC payloads (`RouteTaskIpcSchema`, `AuthorizeRoutedTaskIpcSchema`, `DispatchAuthorizationIpcSchema`, `GetOwnerHandoffSnapshotIpcSchema`) are validated with strict Zod schemas in the Electron main process.
- **Zero Renderer Prompt/Instruction Overrides**: IPC schemas strictly prohibit `instructions`, `prompt`, `selectedProvider`, or `AgentExecutionRequest` payloads from being supplied by the untrusted renderer process. All execution payloads are constructed internally by core services from durable SQLite truth.
- **Single-Identifier Dispatch**: `routing:dispatchAuthorization` accepts **ONLY** `{ authorizationId: string }`.
- **Durable Snapshot Reconstruction**: The UI does not maintain ephemeral React state as ground truth. `routing:getHandoffSnapshot` reloads task status, Manager authority ledger records, Git repository HEAD SHA, provider resources, latest routing decisions, and execution authorizations directly from SQLite.
- **Truthful UI Quota Semantics**: Provider resources with `quota_source = 'UNKNOWN'` or `remaining_quota = null` render truthfully as `UNKNOWN (conf: 0.0)` in the UI and are never falsified as `0`, `unlimited`, or `healthy`.
- **Atomic Replay Prevention**: Once dispatched, authorizations remain in `DISPATCHED` state across application restarts and reject subsequent dispatch attempts fail-closed.
