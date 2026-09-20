# Local self-host bootstrap

The bootstrap is a bounded PILOT inside Agent Forge, in `src/core/autonomy`.
It runs one file-editing Antigravity worker and a read-only Codex manager.
It does not merge, replace the running supervisor, or automatically resume R5L1.

## Implemented loop

1. Claim the SQLite supervisor owner record and reconcile unfinished processes.
2. Claim a durable task request, resolve its exact base SHA, and create a locked
   isolated worktree through the existing GitWorktreeService.
3. Ask Codex to produce a validated workorder.v1; reject changes to seeded
   identity, paths, tests, constraints, or acceptance criteria.
4. Persist the WorkOrder and acquire its transactional slot/epoch before AGY.
5. Run agy --mode accept-edits --sandbox -p in that worktree. Workers use
   file tools; the supervisor exclusively executes the required tests.
6. Capture status, tracked diff, untracked content, SHA-256 snapshot, HEAD,
   test exit codes, timing, and sanitized logs.
7. Ask codex exec --json --sandbox read-only for managerreview.v1.
8. Accept PASS only when every test passed and both HEAD and the working-file
   snapshot are unchanged. Record LOCAL_ACCEPTED; this is not a PR or merge.
9. REPAIR persists findings in a new attempt/epoch in the same worktree.
   Stop after three repair loops. BLOCKED affects only that task.

WorkerResult is informational. A zero process exit is insufficient; headless
permission denial is a contract failure. No permission-bypass flags are used.
CODEX_MANAGER_MODEL selects the manager model. JSONL logs preserve the official
thread ID. Reviews always receive fresh evidence.

## Reuse and provisional boundaries

The kernel reuses DatabaseEngine/WAL, existing product migrations,
ProcessRunner/PolicyService, Repository.process_runs, GitWorktreeService, and
ArtifactStore path containment checks. Bootstrap WorkOrders, slots, runs,
reviews, claims, and events currently use an idempotent SQLite extension schema.
They are not yet connected to the desktop TaskService, execution authorization,
account routing, or WorkerSlotLeaseService. Consolidation is required before
adopting existing product tasks. There is no migration 25 in this slice.

SQLite lives at RUNTIME_ROOT/state/agent-forge.sqlite. Provider logs, prompts,
review/session events, and evidence live in that database. Operator files belong
in runtime logs, prompts, and evidence subdirectories.

## Operator commands

From the control repository (use npm.cmd if PowerShell blocks npm.ps1):
Build once with `npm.cmd run build` while the supervisor is stopped. Operator
commands use that fixed build and never rebuild a running controller.

```powershell
npm.cmd run autonomy:doctor
npm.cmd run autonomy:shadow
npm.cmd run autonomy:pilot
npm.cmd run autonomy:start
npm.cmd run autonomy:status
npm.cmd run autonomy:stop
npm.cmd run autonomy:recover
```

Doctor exercises live provider contracts and disposable worktree creation/removal.
Normal tests use fakes and require no live accounts. SHADOW currently exercises
recovery only; manager planning is exercised by PILOT. PILOT runs a disposable
file-edit/verification/review proof. START is a continuous single-worker queue
pump, gated on a recorded local PASS. STOP requests cancellation through SQLite
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
CI_WAIT slot release is available as a primitive; automatic GitHub publication
and CI polling are not wired into this kernel.

## Next work through the self-host supervisor

Integrate existing product task/authorization/lease services, manager-selected
dependencies, cooldowns, process recovery proofs, GitHub claims and Draft PRs,
CI_WAIT observation, and supervised self-update. Multi-worker scheduling and
automatic integration remain disabled. Keep the running version fixed and
implement self-development in worktrees before reviewing and updating it.

The all-target fast-pr.yml supplements main-target CI. Windows/Ubuntu checks,
Windows packaging, installed-app verification, and RC verification remain.
Repository protection is unchanged.

On the bootstrap host, Antigravity required the documented read-only rule
`read_file(D:/Projects/AI/Agent-Forge-Worktrees)` in its global CLI settings to
read linked worktree files. No command, outside-write, or wildcard grant was added.
Reference: https://antigravity.google/docs/permissions/
