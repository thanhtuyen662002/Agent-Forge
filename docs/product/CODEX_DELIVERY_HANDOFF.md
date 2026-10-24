# Codex continuation: usable autonomous Agent-Forge

Read [OWNER_EXPERIENCE_ROADMAP.md](OWNER_EXPERIENCE_ROADMAP.md) first. It contains the source-grounded gap matrix, official reference links, three screenshot lessons, functional contracts, priorities and acceptance scenarios U01–U13.

## Owner outcome

Build a complete, understandable desktop product for an owner who is not technically trained. The owner describes the desired result, manages projects and multiple agents/accounts, chooses a supported automation scope, and sees work execute, get verified and produce useful results. Normal operation must not require JSON, protocol relay, config-file editing or a terminal. Technical diagnostics and advanced import/export remain available.

This brief is a delivery specification, not evidence that any feature works. It does not change AGENTS, existing ownership, provider terms or release/security policy. Do not claim unlimited automation/concurrency. Ordinary preauthorized operations should flow without repetitive prompts; exceptions must be visible and actionable.

## 1. Recover the live state before editing

1. Read AGENTS.md, docs/WEB_AUTONOMY.md, docs/ISSUE_EXECUTION_PROTOCOL.md and docs/WEB_AGENT_ROLES.md.
   Also read docs/OWNER_WORKFLOWS.md if present on the current implementation candidate; #226 owns that file. Reconcile the guidance without overwriting its writer’s work.
2. Fetch current main, all open issues/PRs, changed paths, relevant exact-head checks and handoff comments. Do not use this document's snapshot as current execution state.
3. Inspect #225 and #226 first. They already own the first guided-desktop/runtime slice. At this document's audit, main was `15cfbcd82312f6d27cb56096d22daa589cafbbf8`; #226 was Draft at `12a47e56df725cc2672d059a7907a2c3ee666a88`, zero changed files. Unpublished work may exist. Locate its handoff and preserve it; no reset, branch takeover or duplicate implementation merely because the diff is empty.
4. Documentation #227/#228 only owns these two docs/product files. It does not own runtime paths or replace #225 acceptance. #224 and dependency PRs are separate. #195 remains external product-readiness work.
5. Continue the valid claim if you are its authorized writer. Otherwise coordinate a durable handoff or select a genuinely non-overlapping READY issue under the repository protocol. Do not expand #226 into the whole roadmap without a bounded scope amendment.

## 2. First delivery: complete the usable core

Deliver vertical slices with real readback, not ornamental controls:

- Agent Center: guided creation/editing, all supported roles, provider/account/model choices, active-work display, disable/archive, restart persistence. Keep role/profile/provider/account/model/slot distinct internally; hide unnecessary implementation vocabulary from the normal form.
- Projects/tasks: plain-text goal/constraints/acceptance forms, project picker, plan preview and reachable approval, list/search, trash/restore, selection reconciliation. Preserve repositories/history. Restore must not reactivate old execution authority automatically.
- Account setup: supported native sign-in and connection test with clear user actions. Secrets remain within existing protected native boundaries. No browser-cookie scraping or copying credentials into repo/logs.
- Runtime: desktop Start invokes real bounded execution over current TaskService/ExecutionAuthorization/lease boundaries. Fix genuine producer/consumer acknowledgement and payload-binding defects rather than weakening validation. Display actual queued/running/waiting/verifying/failed/finished evidence.
- Pause/cancel/resume: explicit semantics and real process settlement; stop new dispatch on pause, retain partial work/history, fence uncertain termination, reconcile before restart.
- Quota: supported official telemetry where available, source/reset/freshness and manual refresh; bounded polling with backoff. Unsupported/signed-out/error/stale remain explicit. Do not turn account health into numeric remaining quota or silently clear failures during polling.
- Minimal inbox/results: show the one next useful action, readable output and verification result. JSON and raw capability payloads move to Advanced/details; existing ordinary test/lint/build input fields are reused and improved, not falsely described as JSON-only.

First prove one supported real provider flow. Then prove multiple independent workers within the supported cap. Do not call browser demo data or an incremented project status an execution proof.

## 3. Next deliveries after core acceptance

### Dependable multi-agent orchestration

Support many saved profiles with visible, tested execution limits. Schedule independent tasks fairly across projects, preserve per-run configuration, isolate repository work and prevent conflicting writers. Validate dependencies, cycles and missing prerequisites. Handle quota exhaustion, stalled workers and supported failover without duplicate side effects or losing context. Preserve independent review requirements; renaming an agent is not independence.

### Understandable run experience

Provide an event-backed stage projection: Setup → Plan/review → approval if required → implementation/review → QA/repair → result or Draft PR. Expand attempts and evidence on demand. Show not-run, unsupported, not-needed and failed separately. Keep exact code revision with checks. Never manufacture cost, progress or completion.

Add an actionable inbox and project rollups. Start with List/Kanban and Ready now. Add dependency graph/focused paths over the same authoritative tasks; do not create a competing graph scheduler. A graph is not required to complete a simple task.

### Scheduling and visual polish

After on-demand execution works, provide one-off/repeating schedules with editable timezone and next-run preview, pause/edit/run-now/history, overlap and missed-run behavior. Respect current project/account scope and existing approval boundaries on every execution.

Use shared components and readable Vietnamese/English from the first slice. Light/dark/system first; extra palettes and dense engineering views later. Preserve accessibility, entered data, focus and clear empty/error/loading states. No wholesale UI-library migration solely for cosmetic similarity to reference screenshots.

## 4. Verification and completion requirements

Use roadmap U01–U13 as acceptance scenarios, scoped to each actual delivery. Every feature needs UI → IPC → service → persistence → readback coverage, including negative cases.

Mandatory high-risk cases include duplicate Start, busy archive, stale selection/approval, changing profile mid-run, malformed IPC replies, crash recovery, provider auth/quota failures, loss of termination proof, two workers contending for the same work and upgrade of an existing user profile.

Run the repository's pinned toolchain, focused tests, full required checks and packaged Windows checks for the exact candidate. Inspect the installed UI with disposable data. Show a real authorized run that edits an isolated repo, executes tests, handles a failing test, receives review, and produces the result. Record unsupported provider/test gates as NOT_RUN or BLOCKED, never substitute stubs for live evidence.

A small novice-usability session should verify that the owner completes setup and a task without JSON, terminal/config-file edits or unexplained dead ends. Record assistance needed and actual time; do not invent benchmark results.

Return:
- exact branch/base/head and changed paths;
- acceptance mapping by requirement/U-scenario;
- actual commands, test/CI outcomes and artifact links;
- screenshots/video of implemented desktop actions and run evidence;
- remaining unsupported integrations, limits and explicit next step;
- user-readable changes, not a report consisting only of internal terminology.

Keep failures and evidence. Do not delete assertions, bypass checks, fake quota/progress or hide missing runtime behind a successful build. Merge only under existing protected-PR rules and authorization; this documentation handoff does not itself authorize production release, publishing user results, paid operations or credential/security changes.

## 5. Practical first action

**Updated after PR #226 merged (main `f2b83a7`).** Stage A's usable core shipped through #225/#226; see `docs/OWNER_WORKFLOWS.md` and the status table in the roadmap. The coordinated successors are:

- **#231**: product execution restart recovery and termination evidence (PR #232).
- **#230**: automated verification on the retained worktree, then hand-off to review. It also fixes the authorized worktree path.
- **#233**: account-bound automated reviewer.

Continue with the highest-priority READY one under the repository protocol. Do not reopen #225's scope. Graph, theme and scheduling work (stages C/D) waits until the verified run pipeline (#230/#233) is accepted.
