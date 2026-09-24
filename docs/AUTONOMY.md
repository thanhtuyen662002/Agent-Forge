# Local self-host bootstrap

The bootstrap is a bounded PILOT inside Agent Forge, in `src/core/autonomy`.
It runs one file-editing Antigravity worker and a read-only manager provider pool.
It does not merge, replace the running supervisor, or automatically resume R5L1.

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
9. REPAIR persists findings in a new attempt/epoch in the same worktree.
   Stop after three repair loops. BLOCKED affects only that task.

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
dispatch: a dead direct PID alone cannot prove descendants exited. Interrupted
attempts with settled processes become BLOCKED and release capacity. Ambiguous
attempts and orphaned worktrees are retained. Do not delete process/owner rows to
bypass a fence. Inspect PIDs, registration, branch, HEAD, and diff before a new
authorized attempt. Full automatic orphan/process reconciliation remains backlog.

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
`autonomy:doctor:omniroute-coder` exercises the live coder contract (`AGENT_FORGE_CODER_MODEL`).
The coder doctor is documented as non-mutating and as reporting availability without exposing
endpoint or authorization values. Normal unit tests use fake endpoints.

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

Integrate existing product task/authorization/lease services, manager-selected
dependencies, cooldowns, process recovery proofs, provider failover, and
supervised self-update. Multi-worker scheduling is graduated to an explicitly configured two-worker maximum (`MAX_AGY_WORKERS=1` or `2`),
denying a third active worker while automatic integration remains disabled. Keep the running version fixed and implement self-development
in worktrees before reviewing and updating it.

The all-target fast-pr.yml supplements main-target CI. Windows/Ubuntu checks,
Windows packaging, installed-app verification, and RC verification remain.
Repository protection is unchanged.

On the bootstrap host, Antigravity required the documented read-only rule
`read_file(D:/Projects/AI/Agent-Forge-Worktrees)` in its global CLI settings to
read linked worktree files. No command, outside-write, or wildcard grant was added.
Reference: https://antigravity.google/docs/permissions/
