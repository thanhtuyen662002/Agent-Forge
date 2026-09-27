# Local self-host bootstrap

The bootstrap is a bounded PILOT inside Agent Forge, in `src/core/autonomy`.
It runs one or two explicitly configured file-editing workers and a manager/reviewer
provider pool. Product-task authorization, routed OmniRoute coder execution,
durable repair convergence, and supervised GitHub CI observation are implemented
behind the same exact-head and lease fences. It does not merge or replace the
running supervisor. Startup now performs read-only process-run and managed
worktree reconciliation; ambiguous state is retained and fenced for an explicit
operator decision.

## Implemented loop

1. Claim the SQLite supervisor owner record and reconcile unfinished processes.
2. Claim a durable task request, resolve its exact base SHA, and create a locked
   isolated worktree through the existing GitWorktreeService.
3. Ask the selected Manager resource to produce a validated workorder.v1; reject changes to seeded
   identity, paths, tests, constraints, or acceptance criteria.
4. Persist the WorkOrder and acquire its transactional slot/epoch before AGY.
5. Run agy --mode accept-edits --sandbox -p in that worktree. Workers use
   file tools; the supervisor exclusively executes the required tests.
6. Capture status, tracked diff, untracked content, SHA-256 snapshot, HEAD,
   test exit codes, timing, and sanitized logs.
7. Ask the selected Reviewer resource for managerreview.v1.
8. Accept PASS only when every test passed in the current TestRun returned by
   runVerification, bound to the active task and attempt. Historical passing runs
   cannot satisfy or mask missing or failing runs; truthful rerun history is
   preserved. ProductTaskAutonomyAdapter independently observes a fresh Git HEAD
   and working-tree snapshot after manager review and fences PASS against the
   exact evidence package (WORKING_TREE_SNAPSHOT_FENCING_VIOLATION,
   CODER_HEAD_MISMATCH). Record LOCAL_ACCEPTED; this is not a PR or merge.
9. REPAIR persists findings in a new attempt/epoch in the same worktree, carries
   a binding to authorization, ownership epoch, base/current HEAD, and selected
   provider/resource, and records no-progress/escalation evidence. Stop after
   three repair loops. BLOCKED affects only that task.

WorkerResult is informational. A zero process exit is insufficient; headless
permission denial is a contract failure. No permission-bypass flags are used.
CODEX_MANAGER_MODEL selects the manager model. JSONL logs preserve the official
thread ID. Reviews always receive fresh evidence.

## Product-task consolidation and compatibility

New product-task execution is adapted from the existing `tasks`, TaskService,
ExecutionAuthorization, AgentAssignment, ProviderResource, ContextManifest,
WorkerSlotLeaseService, process_runs, evidence, and test_runs authorities.
The product task state machine remains the sole lifecycle authority. The
operational self-host dispatcher routes product tasks strictly through
ProductTaskAutonomyAdapter with durable ExecutionAuthorization, failing closed
(PRODUCT_TASK_REQUIRES_EXECUTION_AUTHORIZATION) if unauthenticated and rejecting
any attempt to execute product tasks through legacy autonomy state
(PRODUCT_TASK_CANNOT_USE_LEGACY_AUTONOMY_LIFECYCLE). Furthermore,
ExecutionAuthorizationService authenticates execution scope (`branch`, absolute
`worktree`, `allowedPaths`, and `forbiddenPaths`) within the durable
CanonicalExecutionPayload and verifies it in `instruction_payload_hash`.
In the continuous queue dispatcher (`SupervisorContinuousQueue.defaultDispatch`),
product task dispatch resolves and validates the active durable ExecutionAuthorization
before constructing any runtime specification, deriving the exact authorized branch,
absolute worktree, allowed paths, forbidden paths, base SHA, task revision, and
ownership epoch directly from the authenticated canonical execution payload and
authoritative product task data, never inventing branch, worktree, paths, base SHA,
revision, or epoch, and never relying on synthesized task/worker naming conventions.
Runtime product dispatch uses the exact authorized absolute worktree and branch even
when they differ from synthesized conventions.
ProductTaskAutonomyAdapter requires this authenticated executionScope, builds its
WorkOrder strictly from the authorized scope values, and validates that runtime
scope does not differ in any way. Any missing scope (EXECUTION_SCOPE_MISSING,
RUNTIME_SCOPE_MISSING), expanded or narrowed/different allowed paths
(ALLOWED_PATHS_MISMATCH), changed forbidden paths (FORBIDDEN_PATHS_MISMATCH),
branch mismatch (BRANCH_MISMATCH), or worktree mismatch (WORKTREE_MISMATCH) fails
closed before worker slot lease acquisition and coder execution. Non-product
callers retain schema compatibility as executionScope is globally optional in
CanonicalExecutionPayloadSchema, but product autonomy strictly fails closed when
absent. ProductTaskAutonomyAdapter independently observes Git evidence and
enforces path boundaries before verification or review: any changed file outside
workOrder.allowed_paths or inside workOrder.forbidden_paths fails closed with
WORKER_PATH_VIOLATION. When a manager
review exception occurs (such as provider capacity, auth, rate-limit, timeout, offline,
or contract-invalid failures) or a post-review HEAD or working-tree snapshot freshness
violation occurs, the adapter transitions the authoritative task via TaskService using
FIX_VERDICT into the durable resumable repair state (CODING) while strictly fencing against
the active task ownership epoch, ensuring the task is never stranded in REVIEWING and can be
resumed with a new revision authorization while releasing the worker slot lease and preserving
exact-head and verification lineage gates. Legacy
`autonomy_*` rows are inventoried and retained as compatibility/audit evidence; they are not
silently discarded or authoritative for new product tasks. The consolidated path
enforces an explicitly configured maximum of `MAX_AGY_WORKERS=2` (accepting integers
from 1 through 2) in both AutonomySupervisor and autonomyCli, failing closed with
`CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS_BOUNDS` on any value below 1, above 2, or non-integer.

SQLite lives at RUNTIME_ROOT/state/agent-forge.sqlite. Provider logs, prompts,
review/session events, and evidence live in that database. Operator files belong
in runtime logs, prompts, and evidence subdirectories.

## Operator commands

From the control repository (use npm.cmd if PowerShell blocks npm.ps1):
Build once with `npm.cmd run build` while the supervisor is stopped. Operator
commands use that fixed build and never rebuild a running controller.

```powershell
npm.cmd run autonomy:doctor
npm.cmd run autonomy:doctor:omniroute
npm.cmd run autonomy:doctor:omniroute-coder
npm.cmd run autonomy:shadow
npm.cmd run autonomy:pilot
npm.cmd run autonomy:start
npm.cmd run autonomy:status
npm.cmd run autonomy:stop
npm.cmd run autonomy:recover
npm.cmd run autonomy:observe
npm.cmd run autonomy:register-ci <runtime-watch-json>
npm.cmd run autonomy:trial-log-collect <runtime-log-input.json> [relative-output.json]
npm.cmd run autonomy:trial-log-verify <relative-collection.json>
```

Doctor exercises live provider contracts and disposable worktree creation/removal.
Normal tests use fakes and require no live accounts. SHADOW currently exercises
recovery only; manager planning is exercised by PILOT. PILOT runs a disposable
file-edit/verification/review proof. START is a continuous queue pump running up to `MAX_AGY_WORKERS` (1 or 2)
concurrent tasks with distinct worker identities, gated on a recorded local PASS. STOP requests cancellation through SQLite
so it reaches the actual owner process. STATUS reads durable attempts.

Enqueue a JSON task request from a file under the runtime root:

```powershell
node dist-electron/electron/autonomyCli.js enqueue D:\Projects\AI\Agent-Forge-Runtime\prompts\task.json
```

Requests contain task_id, objective, base_sha, allowed_paths, required_tests,
acceptance_criteria, context_files, and constraints. Tests are executable and
argument strings, not shell scripts. Existing process policy applies; inline
code commands may be rejected. Requests are immutable and deduplicated in
SQLite. Claims are persisted before preparation; interrupted claims are
retained rather than silently replayed.

## Paths and isolation

- Control: D:\Projects\Agent-Forge
- Worktrees: D:\Projects\AI\Agent-Forge-Worktrees
- Runtime: D:\Projects\AI\Agent-Forge-Runtime

Configure AGENT_FORGE_CONTROL_REPO, AGENT_FORGE_WORKTREE_ROOT, and
AGENT_FORGE_RUNTIME_ROOT. Workers run outside the control checkout. Path escapes
and writes outside WorkOrder paths are rejected during verification.
Git worktrees provide coordination isolation, not an operating-system security
boundary. Only trusted local provider accounts are supported. The child
environment does not forward GitHub token variables. Authentication remains
owned by the installed CLIs; credentials are never copied into Git.

## Recovery

A live owner prevents a second supervisor. Any unsettled process record fences
dispatch: a dead direct PID alone cannot prove descendants exited. The process
recovery scanner records stable identity and classifies live, dead, missing, and
unknown PID evidence without terminalizing a `RUNNING` row. The autonomy recovery
scanner also inventories managed Git worktrees, checks path containment,
registration, top-level, branch, exact HEAD, and dirty state, and reports orphaned
worktrees. Interrupted attempts, ambiguous worktrees, and orphans are retained;
no recovery path deletes, unlocks, repairs, or reuses them. Clean `CI_WAIT` and
`PR_OPEN` rows release their implementation slot only after the worktree matches
the durable identity. Dangling slots and mismatches remain fenced for an explicit
operator decision. External GitHub PR metadata and remote-claim reconciliation
remain a separate bounded follow-up because they require authoritative remote
observation.

Reviews survive restart. No remote branch or PR is inferred from local PASS.
CI_WAIT releases the Antigravity slot. The GitHub observer now binds a Draft PR
to its repository, branch, task, and exact expected head SHA; polls checks with
bounded exponential backoff; fetches failed job logs through `gh run view <workflow-run-id>
--log-failed`, resolving the workflow run ID parsed from a validated GitHub Actions
`detailsUrl` rather than status-check `databaseId`; persists sanitized evidence; and transitions CI_WAIT to
MERGE_READY or REPAIR. A machine-readable REPAIR diagnosis creates a durable
repair request. After a locally accepted repair, the Supervisor commits only
allowed files and pushes with `--force-with-lease` against the exact observed
head before returning the watch to CI_WAIT. A changed PR head, non-Draft PR,
branch mismatch, duplicate claim, missing review, or push lease mismatch fails
closed.

All autonomous Manager and Reviewer call paths—WorkOrder planning, local verification
review, and GitHub CI failure diagnosis—use an explicitly configured manager provider
pool rather than a singleton Codex dependency. When enabled, `manager-omniroute` and
`reviewer-omniroute` are the preferred resources and use a direct Responses-compatible
HTTP transport. `codex-chatgpt-primary` remains a bootstrap/fallback resource; the
independently billed `codex-api-fallback` remains opt-in
(`AGENT_FORGE_ENABLE_OPENAI_API_FALLBACK=1`). Resources record route-level
`AVAILABLE`, `DEGRADED`, `AUTH_ERROR`, `RATE_LIMITED`, `CREDITS_EXHAUSTED`,
`CAPACITY_EXHAUSTED`, `COOLDOWN`, `TIMEOUT`, `OFFLINE`, or `CONTRACT_INVALID` state.
Active cooldowns and known unavailable resources are skipped without invoking them.
Every review receives the durable `managercontext.v1` package, including task identity,
immutable WorkOrder, acceptance criteria, exact base SHA, fresh current HEAD, actual diff/evidence,
deterministic tests, previous manager decisions, repair history, PR state, CI state, and policy context.
The package is stored by content hash and can be resumed via `reviewStored` by a newly configured provider only while
its recorded current HEAD still matches a fresh Supervisor observation.
Similarly, manager planning requests persist an immutable planning context by content hash and can be
resumed via `planStored(planSha, expectedBaseSha)` across provider restarts or failovers, rejecting stale
base SHAs.
Planning and review fail over across eligible providers upon capacity, rate limits, or contract failures.
Provider switching strictly preserves exact-head review fencing, leases, authorization, deterministic
test gates, and audit trails. ChatGPT workspace capacity and OpenAI API quota/billing state
remain separate. A manager outage leaves the affected task resumable and does not stop Antigravity slots,
GitHub CI observation, or unrelated executable work. Stale reviewed HEADs force a `REPAIR` verdict,
malformed provider contracts fail closed, and ChatGPT accounts are never rotated automatically.

### OmniRoute configuration

The company URL, authorization value, and model aliases stay outside Git. Agent Forge
does not inspect or rotate accounts behind the route. Configure the direct transport
through the process environment:

```text
AGENT_FORGE_OMNIROUTE_ENABLED=1
AGENT_FORGE_OMNIROUTE_BASE_URL=<external Responses-compatible base URL>
AGENT_FORGE_OMNIROUTE_AUTH_ENV=OMNIROUTE_AUTH_HEADER
AGENT_FORGE_OMNIROUTE_AUTH_HEADER_NAME=<configured HTTP header name>
AGENT_FORGE_MANAGER_MODEL=<configured manager model or route>
AGENT_FORGE_REVIEWER_MODEL=<configured reviewer model or route; defaults to manager>
AGENT_FORGE_CODER_MODEL=<configured coder model or route, when Phase C is enabled>
AGENT_FORGE_OMNIROUTE_TIMEOUT_MS=120000
```

HTTPS is required by default. A previously approved non-TLS company route must
set `AGENT_FORGE_OMNIROUTE_ALLOW_HTTP=1` explicitly; the doctor otherwise fails
closed.

The auth source stores only an `env://...` reference. The secret value is read at
dispatch time and is never included in a WorkOrder, ManagerContextPackage, SQLite
evidence, diagnostics, or logs.

OmniRoute configuration distinguishes the Manager/Reviewer doctor from the coder doctor:
`autonomy:doctor:omniroute` performs an explicit live Responses contract probe for the
Manager and Reviewer roles (`AGENT_FORGE_MANAGER_MODEL` and `AGENT_FORGE_REVIEWER_MODEL`)
and reports only compatibility/state and configured model names. In contrast,
`autonomy:doctor:omniroute-coder` exercises the live coder contract (`AGENT_FORGE_CODER_MODEL`)
by sending a bounded synthetic WorkOrder with fixed task, authorization, source HEAD,
and allowed-path identities. It validates the returned `coderbundle.v1` bindings but
does not apply proposed edits or write repository files. Its output reports only
compatibility/status and the configured model, without endpoint or authorization values.
Normal unit tests use fake endpoints.

Coder routing already uses the product ProviderAdapter/role-aware resource path. A
configured external-router coder adapter is available for Phase C, but AGY CLI remains
the self-host bootstrap implementation until a real coder contract and model alias are
explicitly configured and proven.

Register a watch using a JSON file under the runtime root:

```json
{"task_id":"task-1","work_order_id":"<sqlite-work-order-id>","repository":"owner/repo","pr_number":62,"branch":"agent/task-1","expected_head_sha":"<40-char-sha>"}
```

`autonomy:observe` performs one due poll. `autonomy:start` performs the same
bounded observation between durable task dispatches; it does not busy-poll.

## Next work through the self-host supervisor

Complete authoritative external PR-claim reconciliation, provider-failover edge
proofs, and supervised self-update while preserving the product
task/authorization/lease authorities already used by the consolidated path.
Local process and managed-worktree reconciliation is implemented above; the
remaining PR claim step requires an authenticated remote observation. Multi-worker
scheduling is graduated to an explicitly configured two-worker maximum
(`MAX_AGY_WORKERS=1` or `2`), denying a third active worker. Automatic
merge/integration remains disabled; repository protections and the exact observed
head stay the final authority. Keep the running version fixed and implement
self-development in worktrees before reviewing and updating it.

### Recovery, health replay, and trial evidence contracts

Startup recovery now performs a read-only process-run reconciliation before the
execution and adjudication scanners. A persisted `RUNNING` process row is never
changed to `CANCELLED` merely because the supervisor restarted: direct-PID
liveness cannot prove that detached descendants are gone. The scanner records a
stable process identity hash, classifies live/dead/missing/unknown PID evidence,
and keeps every unresolved row fenced. Expired task leases remain fenced while
an associated process row is still `RUNNING`.

Provider health observations are ingested and applied through the single
`AccountHealthService` writer. Application is a separate durable step from
observation ingestion, so a crash between the two steps is recovered by
ordered, idempotent startup replay. Unknown or malformed authority remains
unresolved and cannot invent account health state.

Production-trial evidence is represented by the strict, canonical manifest
contract in `src/core/autonomy/trialEvidence.ts`. It binds phase, trial ID,
source commit/tree SHA, CI run, package/projection hashes, lifecycle IDs,
context hashes, redacted evidence entries, approvals, retention location, and a
manifest SHA-256. The CLI exposes:

```text
npm run autonomy:trial-manifest -- <runtime-input.json> [relative-output.json]
npm run autonomy:verify-trial-manifest -- <manifest.json> [expected-sha256]
```

Both commands require files beneath `AGENT_FORGE_RUNTIME_ROOT`; traversal,
symlinks, malformed hashes, duplicate evidence IDs, and secret-like values are
rejected. `src/core/autonomy/failureInjection.ts` provides deterministic
FI-01..FI-15 checkpoints for safe rehearsal fixtures. The harness is
side-effect-free by itself: a production trial must still connect each
checkpoint to an approved fixture and retain evidence for every FI scenario.

`trial-log-collect` reads explicitly selected text files or directories below
the runtime root, rejects symlink/junction and traversal paths, applies the
same bounded secret redaction before persistence, and writes a canonical,
atomically created collection with per-file and bundle SHA-256 hashes. Input
and output byte/file limits are enforced before and after redaction;
`trial-log-verify` rechecks canonical ordering, hashes, redaction, and limits.
The collector is local only and never uploads or discovers credentials.

The all-target fast-pr.yml supplements main-target CI. Windows/Ubuntu checks,
Windows packaging, installed-app verification, and RC verification remain.
Repository protection is unchanged.

On the bootstrap host, Antigravity required the documented read-only rule
`read_file(D:/Projects/AI/Agent-Forge-Worktrees)` in its global CLI settings to
read linked worktree files. No command, outside-write, or wildcard grant was added.
Reference: https://antigravity.google/docs/permissions/

## Repair Convergence Contract (`repaircontext.v1`)

The bounded repair convergence subsystem ensures that iterative repair attempts converge deterministically toward acceptable solutions or cleanly escalate without repeating failed strategies.

### 1. Versioned Schema & Deterministic Hash
- **Protocol**: `repaircontext.v1` validates strict input parameters including task authority, ownership epoch, attempt number, base SHA, exact Git HEAD, working-tree snapshot SHA, immutable acceptance criteria, allowed/forbidden paths, required tests, reviewer findings, unresolved/resolved finding IDs, prior coder actions, known failed approaches, non-regression constraints, and escalation stage.
- **Canonical Serialization**: Canonical JSON key sorting produces deterministic SHA-256 digests (`computeRepairContextHash`) across processes and restarts.

### 2. Durable SQLite Lineage & Reconstruction
- Every `RepairContextPackage`, `RepairOutcome`, and `REPAIR_NO_PROGRESS` event is durably written to `autonomy_events` in the SQLite state store.
- On process crash or daemon restart, `rebuildRepairLineage(taskId)` restores complete lineage without losing authorization, epoch, findings, failed approaches, coder resource, snapshot, or exact Git HEAD identity.

### 3. Stable Deterministic Reviewer Finding IDs
- Reviewer findings report `finding_id`, `severity`, `title`, `description`, `file_path`, `line_number`, `evidence`, `required_action`, and `acceptance_evidence`.
- Explicit IDs are preserved; legacy findings lacking explicit IDs derive deterministic IDs via `deriveFindingId` from normalized title, description, file path, line number, and required action, guaranteeing identity stability across revisions.

### 4. Whole-Response Coder Bundle & Independent Reconciliation
- `coderbundle.v1` accepts `addressed_finding_ids`, `unresolved_finding_ids`, `implementation_summary`, `changed_files`, and `known_risks` as native JSON parsed as a whole response.
- Coder claims are **never** treated as proof; Supervisor independently reconciles closure via `reconcileFindingClosure` using diff modified files, deterministic test results, post-review snapshots, and manager review verdicts.

### 5. Semantic No-Progress Detection (`REPAIR_NO_PROGRESS`)
Supervisor detects and durably records non-progress across 6 categories:
1. `NO_OP_WITH_UNRESOLVED_ACTIONS`: Coder proposed no edits while unresolved findings remain.
2. `UNCHANGED_SNAPSHOT_OR_DIFF`: Working tree snapshot or diff is identical to the prior attempt.
3. `REPEATED_FAILING_TEST_SIGNATURES`: Exact normalized test failure signatures match a prior recorded attempt.
4. `UNCHANGED_UNRESOLVED_FINDINGS`: Set of unresolved finding IDs after review is unchanged.
5. `SEMANTICALLY_EQUIVALENT_REPEATED_PATCH`: Patch content normalizes to an identical hash as a prior attempt.
6. `REGRESSION_OR_REVERSION_OF_EARLIER_VALID_FIX`: A finding closed in an earlier attempt regressed or was reverted.

### 6. Three-Attempt Escalation Policy (`MAX_REPAIR_LOOPS=3`)
- **Attempt 1 (`NORMAL_CODER`)**: Dispatches the normally authorized coder with the full repair context package.
- **Attempt 2 (`EXPLICIT_EVIDENCE`)**: Refreshes evidence and explicitly highlights unresolved finding IDs and prior failed approaches.
- **Attempt 3 (`SPECIALIST_OR_FALLBACK`)**: Requires fresh explicit ExecutionAuthorization specifically bound to either the configured repair specialist (`AGENT_FORGE_REPAIR_CODER_MODEL`) or AGY fallback (`res-antigravity-cli-coder`). Normal coder authorizations fail closed. Zero silent fallback across models or resources is permitted.
