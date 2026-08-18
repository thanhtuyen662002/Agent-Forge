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

### Provider Registry & Discovery Truth
- **ProviderRegistry**: In-memory adapter lookup registry with unique ID enforcement. Rejects duplicate IDs and fails closed on unregistered provider requests without silent fallback or autonomous routing (`AUTONOMOUS_ROUTING_IMPLEMENTED=NO`).
- **Manual Bridge (`prov-manual-bridge`)**: SUPPORTED reference/fallback adapter. Returns `AWAITING_OWNER` status (never `COMPLETED`) to preserve lifecycle truthfulness during manual relay.
- **Codex Automated CLI (`prov-codex-cli`)**: NOT AVAILABLE ON REVIEW HOST (`CODEX_CLI_DISCOVERED=NO`, `CODEX_CONTRACT_VERIFIED=NO`). Health is `OFFLINE`, and capabilities are `[]` while unavailable. `execute()` unconditionally fails closed with `CODEX_CLI_UNAVAILABLE` without spawning child processes. No production option, boolean, configuration flag, or constructor parameter can enable Codex execution in this foundation. Future Codex automation requires a separate evidence-backed milestone that discovers the actual CLI, proves its non-interactive invocation contract, implements that exact contract, and validates it before enabling execution.
- **Antigravity Integration**: NOT AVAILABLE as an automated CLI (`ANTIGRAVITY_CLI_DISCOVERED=NO`, `ANTIGRAVITY_AUTOMATION_MODE=MANUAL_BRIDGE_ONLY`). Manual Bridge remains the supported Antigravity transport. No GUI automation or process scraping is permitted.

### Local CLI Adapter Foundation (`LocalCliAdapterBase`)
- Executes local tools safely through `ProcessRunner` with `shell: false`.
- **Durable Working Directory**: Requires a configured `Repository` to resolve the project root. Has zero fallback to `process.cwd()`. Unknown projects fail closed immediately without spawning.
- **Context Security**: Evaluates all context file paths via `PolicyService`, rejecting directory traversal (`../`) and sensitive files (`.env`, `.ssh`, `.aws`, `.gnupg`).
- **Privacy & Redaction**: Passes prompts securely via `child.stdin` without leaking instructions into CLI arguments or `process_runs.command`. Secrets are scrubbed before logging.
- **Process & Evidence Ownership**: Binds process lifecycle to `projectId`, `taskId`, and `attemptId`, recording durable stdout and stderr `Evidence` records in `ArtifactStore`.
- **Protocol Gate**: Validates exit 0 outputs with `ProtocolParser` against Zod `CoderProtocolSchema`. Exit 0 without valid protocol yields `FAILED` (`PROTOCOL_INVALID`).
- **Truthful Telemetry**: Probes health truthfully and reports `UNKNOWN` quota with `0.0` confidence without estimation.

- **Provider Resource / Model**: Represents specific model endpoints with discrete:
  - Health status (`AVAILABLE`, `LOW_QUOTA`, `RATE_LIMITED`, `QUOTA_EXHAUSTED`, `OFFLINE`, `UNKNOWN`)
  - Quota snapshot with confidence rating (`MEASURED`, `PROVIDER_REPORTED`, `MANUAL`, `ESTIMATED`, `UNKNOWN`)
  - Supported capabilities (`CODING`, `PLANNING`, `REVIEW`, `SECURITY_REVIEW`, `LARGE_CONTEXT`, etc.)
  - Enabled / disabled flag

---

## 7. Deterministic Derived Progress

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
