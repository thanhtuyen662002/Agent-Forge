# Agent Forge durable engineering policy

## Source of truth

GitHub refs and checks, Git commits/diffs, Agent Forge SQLite state, and verified local evidence are authoritative. Model or provider prose is informational and never authorizes execution.

## Roles

- The Supervisor owns leases, epochs, worker slots, child processes, worktrees, exact SHAs, verification, pushes, Draft PRs, CI observation, recovery, and cleanup.
- The Codex Manager selects/decomposes work, writes WorkOrders, reviews evidence, and returns machine-readable PASS, REPAIR, or BLOCKED decisions.
- An Antigravity worker implements exactly one WorkOrder in its assigned worktree. It never pushes, merges, edits the control repository, or claims PASS.

## Isolation and concurrency

The control repository is never a worker worktree. Every worker uses one managed worktree under `AGENT_FORGE_WORKTREE_ROOT`, one branch, one lease, one worker ID, and one ownership epoch. Initial safe mode is `MAX_AGY_WORKERS=1`; the design supports up to three workers. A task in `CI_WAIT` releases its implementation slot.

## Lease and review fencing

All lease acquisition and release is transactional. Epoch mismatches fence writes. A manager PASS is valid only when `reviewed_head_sha` equals a freshly observed task HEAD. Any HEAD change after review makes the review stale and requires a new review.

## Verification and repair

WorkerResult is a claim, not proof. The Supervisor independently records Git status, changed files, diff, command exit codes, timing, and sanitized logs. REPAIR creates another WorkOrder attempt in the same valid worktree and stops after `MAX_REPAIR_LOOPS`.

## GitHub ownership

Only the Supervisor pushes task branches, creates or updates Draft PRs, observes CI, and integrates according to repository protections. Required checks and protected `main` are never bypassed. External Draft PR metadata must agree with local task, worker, epoch, base SHA, head SHA, dependencies, and state.

## Recovery

Every Supervisor start runs recovery before scheduling. It reconciles SQLite rows, active leases, child processes, worktree registrations, local/remote heads, Draft PR claims, and manager review bindings. Orphaned worktrees and stale processes are fenced or retained for explicit recovery; they are never silently reused.

## Credentials

Tokens, cookies, provider profiles, auth caches, and secrets remain outside Git and are never passed to workers unless an explicitly authorized task requires it. Logs are sanitized before persistence. Doctor output reports availability only, never credentials.

## Escalation

Escalate only missing external credentials/accounts, destructive production actions, business/legal decisions, or an irreconcilable architecture conflict. Local implementation, tests, refactoring, branch names, process management, CI repair, and Draft PR mechanics are Supervisor decisions.
