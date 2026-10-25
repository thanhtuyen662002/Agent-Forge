# Owner desktop workflows

This document describes owner workflows that are implemented and covered by
tests in the desktop app. It is written against the code in this repository,
not against a live provider account or a signed installer. Remaining work for
Issue #225 is listed at the end.

## Agent Center: add, edit, remove and restore agents

Open **Agent Center** in the sidebar. Agents are grouped by role (managers,
coders, reviewers, tool agents). Every group is shown, even when it is empty.

### Add an agent

Click **Add agent**. The form has three steps:

1. **Name and role.** Pick one of *Primary manager*, *Backup manager*, *Coder*,
   *Reviewer* or *Tool*. Each role has a one-line explanation.
2. **How it connects.** Only connections Agent Forge can actually run are
   offered:
   - **Manual Bridge**: you relay each work order to a chat window yourself.
     The agent has no account and no worker slots.
   - **Codex CLI** / **Gemini CLI**: the local command-line tool runs on this
     computer. Agent Forge creates a separate native sign-in profile reference
     (`native-profile://codex/<name>` or `native-profile://gemini/<name>`). You
     may name the profile or leave it empty to generate one. You also choose
     how many tasks it may run in parallel (1 or 2, matching the bounded
     self-host runtime).
   - Pick the model (#263). The list depends on the connection:
     - **Codex CLI**: the list comes live from Codex's own `model/list`. The
       CLI's default model is preselected, and each model shows its
       description. It is read in a temporary, empty `CODEX_HOME` (no sign-in,
       token or profile is read), cached for 10 minutes, and replaced by a
       built-in list if the read fails.
     - **Claude Code / Gemini CLI**: the CLI's aliases (`sonnet`, `opus`,
       `haiku`; `auto`, `pro`, `flash`, `flash-lite`) always resolve to the
       latest version, followed by specific model IDs.
     - **Other (type it)** accepts any model name. The manual bridge keeps a
       plain text field.
3. **Optional instructions** that are stored on the agent's profile.

Saving runs one immediate SQLite transaction
(`WorkspaceManagementService.createAgent`) that creates, as separate rows:

| Identity | Table | Notes |
| --- | --- | --- |
| Role profile | `role_profiles` | Reuses the first enabled profile for the role, otherwise creates one. |
| Agent profile | `agent_profiles` | Name, instructions and connection kind. |
| Provider | `providers` | `prov-manual-bridge`, `prov-codex-cli` or `prov-gemini-cli`, created only if missing. |
| Account | `provider_accounts` | CLI connections only. `NATIVE_PROFILE` auth, no credential, health `UNKNOWN`. |
| Resource | `provider_resources` | Model name, role capabilities, quota `UNKNOWN`. |
| Worker slots | `worker_slots` | CLI connections only, `IDLE`. |
| Agent | `agents` | Linked to the resource and agent profile (migration 027). |

If any step fails, for example because the sign-in profile is already bound
to another account, nothing is written. New accounts and resources start as
`UNKNOWN`; the form says so, and nothing marks them healthy until a supported
observation exists. Creating a CLI agent does **not** sign in to Codex or
Gemini and does not prove the tool is installed.

### Edit an agent

**Edit** changes the display name, the instructions and the model name. The
role and connection are fixed after creation; create a new agent for a
different connection. The model cannot change while the agent has active work
(see blockers below), so approved work never runs against a model the owner
did not see.

### Remove and restore an agent

**Remove** asks for confirmation, then sets `agents.removed_at` and parks the
agent `OFFLINE`. It also disables the agent's resource (so routing skips it),
its worker slots and its agent profile. No row is deleted: decisions, events,
reviewer sessions, assignments and evidence keep their references. Seeded
agents can be removed too, and startup seeding does not bring them back.

Turn on **Show removed agents** to see removed agents and **Restore** them.
Restore clears the marker, re-enables the resource and profile, and returns
disabled slots to `IDLE`. Restore does not remember why a resource was disabled before
removal: a resource or slot disabled for another reason is enabled again.

Remove is refused, and the card lists the reason, while the agent has any of
these:

- a current task, or `BUSY` status;
- an open (unrevoked, unexpired) reviewer MCP session;
- an `ASSIGNED`/`RUNNING` assignment on its resource;
- an `AUTHORIZED` execution authorization, or a dispatched one whose adapter
  started and has not finished;
- a worker slot that is `LEASED`, `RUNNING`, or holds an assignment or execution;
- an unreleased account lease on one of its slots (expired leases still block
  until recovery releases them).

### IPC surface

All channels go through the trusted-sender check and sanitize their output.

| Channel | Payload | Reply |
| --- | --- | --- |
| `agents:roster` | `{ includeRemoved }` | `AgentRosterEntry[]` |
| `agents:create` | `CreateAgentIpcSchema` | `{ success: true, agent }` or `{ success: false, errorCode, error, blockers? }` |
| `agents:update` | `UpdateAgentIpcSchema` | same |
| `agents:remove` | `{ agentId }` | same |
| `agents:restore` | `{ agentId }` | same |

The renderer (`src/ui/agentRoster.ts`) only treats a reply as saved when it is
an explicit success envelope that carries the persisted agent. Malformed
replies show an error and are not counted as success.

## Project plan: plain-text input and plan approval

The **Project plan** section of **Projects** replaces the old JSON-only
contract importer. The owner fills labeled fields in plain words:

- **What should this project achieve?** (required) and an optional
  **Background**;
- list fields, one item per line: how you will know it works, when it is
  finished, testing requirements, technical and architecture constraints,
  security requirements, out of scope, and your rules for the agents. Bullets
  and numbering (`- `, `* `, `• `, `1. `, `2) `) are removed automatically.

**Save plan** converts the fields into the existing `ProjectContract`
(`src/ui/projectContractForm.ts`) and sends it through
`project:importContract`. The form is prefilled from the stored contract.
Editing JSON is still possible under **Advanced: edit the plan as JSON**;
malformed JSON is refused in the renderer and never sent.

**Approve the plan** appears when the project is `DRAFT` or `PLANNING` and has
a stored goal. It sends `PLAN_APPROVED`, which moves the project to `READY`.
Approval does not start work: the project runs only after **Start** in the
header.

Both channels now reply with typed acknowledgements, so the renderer's
success check works:

| Channel | Success | Failure |
| --- | --- | --- |
| `project:importContract` | `{ success: true, project }` | `{ success: false, errorCode: 'PROJECT_NOT_FOUND', error }` |
| `project:transition` | `{ success: true, status, project }` | `{ success: false, errorCode: 'INVALID_TRANSITION' \| 'EMERGENCY_STOP_LATCHED' \| 'PROJECT_NOT_FOUND' \| 'TRANSITION_REJECTED', error }` |

Previously `project:importContract` returned a bare boolean and
`project:transition` a bare status string, so the renderer reported both
(including the header's Start and Pause) as invalid responses even when they
succeeded.

## Projects and tasks: search, trash and restore

**Projects** lists every active project with a search box (case- and
accent-insensitive, so `lap trinh` finds `Lập trình`). Each row has **Open**
and **Move to trash**. **Task Board** has the same search over task titles and
IDs, and a **Move to trash** control on tasks that are eligible.

Moving to the trash asks for confirmation and runs one immediate transaction
in `WorkspaceManagementService`:

- A row is added to `workspace_trash` (migration 027). Nothing else is
  deleted: the project or task row, its events, evidence, attempts and the
  repository on disk are untouched. A `PROJECT_TRASHED` / `TASK_TRASHED`
  event is recorded.
- Every still-`AUTHORIZED` execution authorization of the task (or of every
  task in the project) is set to `INVALIDATED`. The dispatch claim only
  accepts `AUTHORIZED`, so approved work cannot start after trashing, and
  restoring does not bring it back; approve again if needed.

A task can be trashed only in `CREATED`, `PLANNED`, `DONE`, `FAILED` or
`CANCELLED`. A queued or active task could still be picked up by the runtime,
so it is refused with the reason. Trash is also refused while the task has an
unreleased task lease, an `ASSIGNED`/`RUNNING` assignment, an execution whose
adapter started and has not finished, or an agent working on it. A project is
refused while it is `RUNNING`, `FINAL_REVIEW` or `WAITING_FOR_CAPACITY`, or
while any of its tasks has one of these blockers; every blocker is listed.

Trashed items leave `project:list` and `task:list` (tasks of a trashed project
are hidden too). If the selected project is trashed, the app selects the first
remaining project. **Show trash** lists trashed items with **Restore**.
Restoring a project brings back its tasks, except tasks that were trashed on
their own; a task cannot be restored while its project is in the trash.

These IPC channels refuse a trashed project or task with
`ENTITY_IN_TRASH` before their handler runs: `project:importContract`,
`project:transition`, `task:create`, `task:startReview`, `protocol:apply`,
`protocol:generateWorkOrder`, `protocol:generateReviewPackage`,
`verification:runTests`, `verification:saveCommands`, `routing:routeTask`,
`routing:authorizeTask`, `routing:dispatchAuthorization` and
`routing:generateAuthorizedWorkOrder`. `ProviderDispatchService` also checks
the trash before claiming an authorization.

| Channel | Payload | Reply |
| --- | --- | --- |
| `trash:list` | none | `{ projects, tasks }` |
| `trash:project` / `trash:restoreProject` | `{ projectId }` | `{ success: true, entityType, entityId, invalidatedAuthorizations }` or `{ success: false, errorCode, error, blockers? }` |
| `trash:task` / `trash:restoreTask` | `{ taskId }` | same |

There is no permanent delete.

## Automatic coder execution (Start / Pause)

`DesktopAutomationService` (started by `src/electron/main.ts`) checks RUNNING
projects every 15 seconds and right after **Start**/**Resume**. **Pause** in
the header stops new dispatch for that project. For a task that is `CODING`
and whose latest applied Manager decision is `EXECUTE` for its current
revision (or `FIX_REQUIRED` for the previous one), it runs the real product
chain, with no shortcuts:

1. a `RUNNING` task attempt bound to the coder agent's profile;
2. `RoleAwareRoutingService.routeRole` with a persisted assignment;
3. an assignment-bound context manifest (`ContextBuilderService`) of the
   repository's top-level entries, excluding `.git`, `node_modules`, build
   output and `.env*`;
4. an immutable `PRODUCT_BOUND` `ExecutionAuthorization`;
5. `ConcurrentExecutionScheduler`: worker-slot lease, managed worktree under
   `<userData>/worktrees/<projectId>`, scheduled dispatch to the Codex or
   Gemini CLI adapter, settlement.

If anything fails before the dispatch claim (routing, context, authorization,
lease or worktree), the unclaimed authorization is invalidated, and the
assignment and attempt are ended as `FAILED`, so the task is never left
blocked. Approved work waiting for its first pass is shown as `queued`.

It uses only active, owner-created CLI coders whose provider adapter is
registered, whose account is enabled and proven `AVAILABLE`/`LOW_QUOTA`
(the same rule as the slot lease), and that have an idle slot. It runs at most
one execution per project (two overall) and never re-runs a revision that
already settled.

This required three dispatch/settlement repairs, which also make manual
product-bound dispatch work:

- assignment-bound lifecycle-v1 authorizations that are not handoff
  successors are fenced by
  `Repository.validateProductAssignmentExecutionAuthority` (task
  epoch/revision/base, assignment, role-aware routing decision,
  assignment-bound manifest, RUNNING attempt, every settlement binding)
  instead of the handoff fence, which rejected them with
  `TRANSFER_NOT_FOUND`;
- dispatch compares the durable manifest hash and includes the bound
  execution scope in the payload hash, exactly as creation does;
- settlement uses a product path (`settleProductAssignmentExecution`) that
  terminalizes the attempt and assignment and records a
  `PRODUCT_EXECUTION_*` event.

`tests/r5l1LifecycleBoundary.test.ts` and `tests/desktopAutomation.test.ts`
run this chain with real services; only the provider adapter is synthetic.

The header shows the automation phase next to the project status, because a
RUNNING project is not proof that a worker is running: `not running`,
`waiting for an approved task`, `only Manual Bridge coders`, `waiting for a
usable coder` (with a reason such as *account not verified*), `coder is
working`, `running your approved tests`, `reviewer agent is checking the
tested changes`, `coder finished; waiting for review` (with a reason such as
*no Reviewer agent*), `last automated run failed`.

**Limits.** Automation covers the coder stage, automated verification and
automated review (below). Merging the retained worktree remains owner-driven. The CLI
sees only the files in the context manifest and can update existing files
only (`docs/LOCAL_PROVIDER_WORKSPACES.md`). Large repositories that exceed the
workspace bounds fail closed with a reason.

## Automated Manager decisions

A **Manager** agent (role *Primary* or *Backup Manager*, Codex CLI, its own
account) gives the coder its authority, so tasks run without pasted JSON
(#239). `ProductManagerService` asks it when:

- a task is `PLANNED` and has no Manager decision yet, or
- a task is `CODING` at a revision that no Manager decision authorizes. This
  happens after automated tests failed or the reviewer asked for fixes, and the
  prompt then includes the review issues and the failed result.

The call uses role-aware routing, a lease and a heartbeat. It runs read-only:
no repository context is copied, and the CLI runs with `--sandbox read-only`.
Gemini CLI cannot be a Manager. The answer must be a `manager.v1` object for
exactly this task, its current state and revision, with decision `EXECUTE` (the
coder starts with the Manager's instructions) or `BLOCK` (the owner decides).
Review verdicts are never taken from the Manager. The provider's message id is
replaced, so it can never replay an earlier decision.

**Mode** (Dashboard → *Manager decisions*, per project):

- **I approve each decision** (default): the proposal is shown with its
  instructions. *Approve* re-checks that the task has not moved, then applies
  the decision through `TaskService.applyManagerDecision`. *Reject* records the
  rejection; that revision is not asked again.
- **Manager decides automatically:** the decision is applied directly, through
  the same validation.

A malformed, disallowed, stale or other-task decision is recorded as
`AUTOMATION_MANAGER_FAILED` and not retried. Provider failures are retried
after five minutes, at most three times. The header then says the Manager
could not decide, and the owner decides. Without a usable Manager agent the
header says so. A Manager call interrupted by a restart is fenced like a
review: its expired lease is released, nothing is applied, and the revision is
asked again.

**Planning (#245).** When a project is `RUNNING` with an approved contract and
no tasks, a *Plan the project* task is created as the durable planning record.
The Manager is asked, in the same read-only call, for a `plan.v1` breakdown:
at most 20 tasks, each with a title, a description and acceptance criteria,
bound to the project and to the SHA-256 of the exact contract. Tasks are
created only through `TaskService.createTask`, and only if the contract hash
still matches and no other tasks exist. The planning record then becomes
`APPROVED` and leaves the active task list (system trash, so it is never
counted or dispatched; no Manager decision is ever accepted for it, pasted
ones included). The Manager starts the first task next. Planning results are
bound to the contract's hash: after a rejected or failed plan, editing the
contract plans again, and creating a task by hand ends planning.
In *approve each decision* mode the proposed task list is shown under *Manager
decisions* first. A malformed plan, or a plan for another project or contract,
creates nothing.

**Task context (#254).** A planned task may name up to 32 `context_paths`:
repository files or directories the coder needs. Each must be a portable
relative path inside the repository that exists, is not a link, and is allowed
by policy (`.git`, secrets and agent configuration are denied). A plan naming
an invalid path is retried. The paths are stored per task and checked again at
dispatch; the coder is then authorized for exactly those paths instead of the
repository's top-level entries, so large repositories stay within the workspace
bounds. A directory there is also where the coder may create new files (#240).
A stored path that no longer exists stops the dispatch with
`TASK_CONTEXT_INVALID`.

**Edit a task's context (#261).** The task view has a **Coder context** box
with one repository path per line. Save validates every path with the same
rules as planning and dispatch: inside the repository, existing, not a link,
not policy-denied, at most 32. A rejection names the reason and the offending
path, and nothing is stored. Duplicates and blank lines are dropped. An empty
box clears the list, so the coder gets the repository's top-level entries
again. A change applies from the next coder run, not to a run already in
progress. A task in the trash cannot be changed.

## Automated verification after a completed coder run

When a coder execution settles `COMPLETED`, `AutomatedVerificationService`
tests the coder's changes in the exact managed worktree that the
authorization names. The automation pre-binds the worker slot and authorizes
the scheduler-derived `afw-<digest>` path, so the verification capability
fence admits that worktree and nothing else. Before running, it checks that:

- the project is `RUNNING`, not trashed and not emergency-stopped;
- the task is still `CODING` at the authorized revision and epoch;
- the worktree is registered, exists, still sits on the authorized base, and is
  the authorized path;
- the project has an approved `TEST` command.

It then moves the task only through `TaskService.transitionAuthorizedTask`:
`SUBMIT_REPORT` (to `VALIDATING`), runs the approved `TEST` command with
`VerificationService.runTests` in the worktree, then `EVIDENCE_GATHERED` (to
`REVIEW_READY`) on a pass, or `TESTS_FAILED` (back to `CODING` at the next
revision, so the Manager must authorize again) on a failure or when the
command could not run. Each result is an `AUTOMATION_VERIFICATION_*` event
bound to the authorization and to the work it tested: the worktree HEAD, a
content snapshot of the uncommitted changes and the changed files. If the
worktree changes while the command runs, the result is a failure
(`WORKTREE_CHANGED_DURING_VERIFICATION`). A run is verified once. Settled work
left unverified by a restart is picked up on the next pass.

If no `TEST` command is approved, the task is not moved, and the header says
the changes were not tested. Once the owner approves a `TEST` command, the same
settled work is verified on the next pass. Verified work then goes to automated
review (below) when a Reviewer agent is configured, otherwise to the existing
Manager or owner path. Nothing is merged into the repository automatically.

## Automated review of verified work

When a task is `REVIEW_READY` with an `AUTOMATION_VERIFICATION_PASSED` result
at its current revision, `ProductReviewService` asks a **Reviewer** agent to
review it. Add one in Agent Center (role *Reviewer*, Codex CLI) and sign it in
to **its own** account: a reviewer never uses the coder's account. Only
adapters that report the `REVIEW` capability are used; Gemini CLI has no
read-only review mode, so a Gemini Reviewer is skipped in favour of one that
can review.

The review runs on the product authority path:

- a `desktop-review` attempt and a REVIEWER routing decision with a persisted
  assignment, under the `sep-automated-review` separation policy (different
  account, no self-review);
- an account lease and worker slot from `WorkerSlotLeaseService`, renewed while
  the reviewer runs; a lost lease or a stop cancels the review;
- the reviewer's own CLI profile (`CODEX_HOME`), on an isolated **read-only**
  copy of the verified worktree (`--sandbox read-only`). The copy is never
  synchronized back. The diff is included in the prompt; diffs over 256 KB are
  not reviewed (`REVIEW_DIFF_TOO_LARGE`).

The task moves to `REVIEWING` only after every fence passes. A verdict is a
`review.v1` object (`PASS`, `FIX_REQUIRED` or `BLOCKED`, issues, and the
reviewed `task_revision`, `reviewed_head_sha` and `reviewed_snapshot_sha`). It
is applied only when it names exactly the verified work, the worktree did not
change while the reviewer ran, and the review still holds its lease. The
review row and the task transition are written in one transaction:

| Verdict | Result |
| --- | --- |
| `PASS` | `PASS_VERDICT`: the task is `DONE`. The changes stay in the retained worktree; nothing is merged. |
| `FIX_REQUIRED` | `FIX_VERDICT`: back to `CODING` at the next revision (or `NEEDS_HUMAN` at the revision limit). The Manager must authorize the next revision. |
| `BLOCKED` | Recorded; the task stays `REVIEWING` for the Manager or owner. |

A provider failure, a malformed or wrong-protocol answer, or a verdict for a
stale snapshot or another revision is recorded as `AUTOMATION_REVIEW_FAILED`
or `AUTOMATION_REVIEW_STALE` and never becomes a verdict. A review that ran is
not retried; the header says so, and the Manager or owner reviews instead. A
review that could not **start** (no routable reviewer, lease contention, a
transient Git error) records `AUTOMATION_REVIEW_NOT_RUN`, leaves the task
`REVIEW_READY` and is offered again after five minutes. PASS cannot carry
`BLOCKER` or `REQUIRED` issues, and `FIX_REQUIRED` needs at least one issue;
contradictory verdicts are malformed. The review row, task transition and
outcome event are committed together.

**Restart.** A review attempt left `RUNNING` by a previous process is never
completed from a guess. While its `process_runs` row is still `RUNNING`,
everything stays fenced and an `AUTOMATION_REVIEW_INTERRUPTED` event says the
process is not proven stopped. Once the process is terminal and the lease has
expired, the lease is released through the guarded recovery primitive, the
attempt and assignment end `FAILED` (`COMPLETED` only when a verdict was
already applied), and the task stays `REVIEWING`. The same transaction closes
any startup quarantine marker (`PRODUCT_LEASE_RECOVERY_REQUIRED`) for that
lease. A late result from the old process is discarded because it no longer
holds its lease.

## Taking reviewed work: create a branch or discard

When a task passes automated review it is `DONE`, and its changes are still
uncommitted in a hidden managed worktree. The header then shows *reviewed work
is ready* (`READY_FOR_INTEGRATION`). Under **Dashboard → Reviewed work** the
owner chooses what happens to it (#238). Nothing happens without that action,
and nothing is ever merged or pushed.

- **Create branch.** The worktree must still hold exactly the reviewed
  snapshot (same HEAD and snapshot as the PASS review), otherwise
  `SNAPSHOT_CHANGED_SINCE_REVIEW`. The changes are committed with Git plumbing
  (`add` → `write-tree` → `commit-tree` → `update-ref` with an empty old value)
  as one commit on the reviewed base. They land on a **new** branch
  `agent/<task-title>-<task-id>-r<revision>`, authored by *Agent Forge*.
  - Line endings are not converted; the commit holds the reviewed bytes.
  - Changes are staged into a private copy of the worktree's index, so the
    reviewed snapshot never changes. The commit's files (rename detection off)
    must equal the reviewed ones *before* any branch is written. The exact
    commit is recorded as an intent first.
  - The default branch, the owner's checkout and every existing branch are
    never modified. An existing branch name is never overwritten.
  - The retained worktree is then cleaned and removed through
    `GitWorktreeService`. The branch stays in the repository for the owner to
    merge with their usual Git tool.
- **Discard** (terminal tasks only: `DONE`, `CANCELLED`, `FAILED`). The task's
  retained worktrees are cleaned and removed. The repository policy forbids
  `git reset --hard` and `git clean -f`, so discard only unstages, restores
  tracked files from the base, and deletes the worktree's untracked files
  inside the managed path. Deletion never follows a symlink or junction: the
  link itself is removed and its target is untouched. Removal then requires the
  exact checkout again. A repository whose `.gitattributes` converts line
  endings or applies filters can fail this check; the discard then reports
  `DISCARD_INCOMPLETE` and keeps the copy. If the branch was created but its
  hidden copy could not be removed, the panel offers *Remove leftover copy*,
  which keeps the branch.
- **Restart.** If an earlier attempt wrote the branch but was interrupted
  before recording it, the next *Create branch* adopts the branch. It does so
  only if the branch tip is exactly the recorded intended commit, one commit on
  the reviewed base. Any other branch with that name, for example one of the
  owner's, is refused (`BRANCH_EXISTS`) and left untouched.

## Restart recovery for automated executions

At startup, `ExecutionRecoveryScanner` sends lifecycle-v1 product
authorizations (assignment-bound, no handoff transfer) to
`DirectProductExecutionLifecycle`. It acts only on exact durable receipts and
records a `PRODUCT_EXECUTION_RECOVERY` event:

| Durable state | Recovery |
| --- | --- |
| `AUTHORIZED` | Untouched; an owner may still dispatch it. Desktop automation expires only authorizations whose attempt it created (`desktop-automation` marker) when it starts. |
| `DISPATCHED`, adapter start never claimed | Expired; lease and slot released through the guarded primitive; attempt and assignment `FAILED`. |
| Adapter started, not settled | Stays fenced. A terminal `process_runs` row without a settlement is reported as *result missing*, never as success. |
| Settled with verified product evidence | A lease and slot that the interrupted scheduler did not release are released. Tampered evidence is rejected and nothing is released. |

Product settlement records the execution's `process_runs` truth
(`process_run: { status, exit_code }`, or `null` when no native process
started, for example an early adapter validation failure). It refuses to
settle while that process is still `RUNNING`. A rejection after the dispatch
claim but before the adapter start (status `DISPATCHED`, no start) is
expired at runtime too, so the task is not blocked.

## Claude Code and Gemini CLI agents

Agent Center offers four connections: Manual Bridge, **Codex CLI**, **Claude
Code CLI** and **Gemini CLI** (#242). Each agent gets its own account and its
own profile directory, so any number of accounts per CLI can run side by side
without sharing a login:

| CLI | Profile variable | Coder run | Reviewer / Manager run |
| --- | --- | --- | --- |
| Codex | `CODEX_HOME` | `--sandbox workspace-write` | `--sandbox read-only` |
| Claude Code | `CLAUDE_CONFIG_DIR` | `claude -p --output-format json --permission-mode acceptEdits --tools Read,Edit,Write,Glob,Grep` | `--permission-mode dontAsk --tools Read,Glob,Grep` |
| Gemini | `GEMINI_CLI_HOME` | `--approval-mode auto_edit` | `--approval-mode plan` |

All runs happen in the isolated provider workspace. Child processes get only a
minimal environment, so host credentials such as `ANTHROPIC_API_KEY` never
reach them. Permission-bypass flags are never used. Gemini no longer passes
`--sandbox` (it needs Docker); headless `default` approval denied every edit.
Claude runs with `--setting-sources user --strict-mcp-config`, so only the
agent profile's own settings apply. Agent CLI project configuration
(`.claude/`, `.gemini/`, `.codex/`, `.mcp.json`) is a policy-denied path. It is
never copied into a workspace, and a run that creates it fails, because hooks,
MCP servers or endpoint overrides in it could run commands or redirect
credentials. Claude reports no `TEST_EXECUTION`, and Gemini no `TERMINAL` or
`TEST_EXECUTION`: their headless modes have no shell.

**Sign-in.** For a Claude Code or Gemini agent whose account is not verified
yet, *Sign in* opens a terminal running the CLI's own sign-in with that
agent's profile: `claude auth login`, or `gemini` and then *Sign in with
Google*. After finishing in the browser, the owner presses *Check sign-in*.

- **Claude:** the app runs `claude auth status`. Only a subscription login
  (`claude.ai` or `oauth_token`) counts.
- **Gemini:** the app checks that a cached login exists (presence only; it is
  never read), then runs a one-line read-only prompt. Exit `41` means not
  signed in.

A verified, never-used account is initialized through `AccountHealthService`.
Auth and usage-limit failures in runs are classified, for example Claude's
*You've hit your session limit · resets …*, and never become success. Codex
keeps its device-code sign-in. Checks use the adapter's own executable (npm
`.cmd` shims run through the trusted `cmd.exe`) from an empty private
directory. **Expired logins (#247).** An account whose login expired (`AUTH_ERROR`)
shows *Sign in again* in Agent Center, for Codex, Claude Code and Gemini. The
expired state is cleared through `AccountHealthService.recordReauthenticated`
only after the CLI's own check proves the same profile is signed in: an
authenticated official quota read for Codex, `claude auth status` for Claude,
or a read-only prompt for Gemini. The account then becomes `AVAILABLE` again
and its failure code is cleared. Cooldowns, quota exhaustion and rate limits are
never cleared this way, and an account with an unreleased lease or a running
assignment is refused.

## Provider quota and account verification

`AccountQuotaService` reads Codex usage through the official
`codex app-server` JSON-RPC (`initialize`, `initialized`,
`account/rateLimits/read`), using the agent's isolated profile as `CODEX_HOME`.
It refreshes every five minutes and when you press **Refresh from provider**
on the **Capacity** page. The primary window becomes *percent left* with its
reset time (`PROVIDER_REPORTED`). Not signed in, unavailable or unreadable
replies stay unknown, never zero. Manual snapshots are never overwritten.

**Router-style overview (#243).** The Capacity page shows one card per account,
grouped by CLI, with a usable/total summary per CLI. Each card shows:

- the agents and models on the account, and its plan;
- one bar per limit window (5-hour, weekly, …) with remaining %, colour
  (more than 50 % green, 20–50 % amber, under 20 % red) and a reset countdown;
- whether the account is usable now;
- the **source** of the numbers:

| Source | Meaning |
| --- | --- |
| Official | Codex `account/rateLimits/read`. |
| Unofficial (read like routers) | Claude Code and Gemini, read the way quota routers do (#250). See below. |
| Observed from a run | When a run hits a usage limit, the recorded health shows that limit as exhausted until its recorded reset. An expired sign-in shows as *Not signed in*. A recorded limit or lost sign-in takes priority over an unofficial reading. |
| Unknown | Nothing is known; no number is shown. |

**Unofficial Claude Code and Gemini readers (#250).** Neither CLI has an
official usage API. The owner chose on 2026-10-25 to read them the way routers
do. The switch **Read Claude Code and Gemini quota like routers do** on the
Capacity page turns this off again. It is kept in `quota-preferences.json` in
the app data folder. With it off, no sign-in file is opened and nothing is
requested.

- Claude Code reads `<CLAUDE_CONFIG_DIR>/.credentials.json`
  (`claudeAiOauth.accessToken`) and calls `GET
  https://api.anthropic.com/api/oauth/usage`. Its card shows the 5-hour and
  7-day windows.
- Gemini reads `<GEMINI_CLI_HOME>/.gemini/oauth_creds.json` (`access_token`)
  and calls Code Assist `v1internal:loadCodeAssist` and then
  `v1internal:retrieveUserQuota` on `cloudcode-pa.googleapis.com`. Its card
  shows one bar per model bucket, tightest first, with the account's tier.

Boundaries:

- The token is only read, in memory. It is never refreshed, written, stored,
  logged, shown or sent anywhere but those fixed provider hosts.
- Redirects are refused. Every failure message is fixed text.
- An expired token is left for the CLI to renew on its next run; the card asks
  you to run that CLI once.
- These endpoints are undocumented and may change or be blocked. Any failure
  falls back to the observed or unknown state.

Unofficial and observed values are display telemetry. They are never stored as
provider-reported quota, never verify or recover an account, and never feed
scheduling.

New CLI accounts start `UNKNOWN` and cannot be leased. A successful
authenticated read lets `AccountHealthService.initializeVerifiedAccount` (the
single health writer) promote a never-used `UNKNOWN` account to `AVAILABLE`,
with an atomic identity check. It never clears a recorded failure or cooldown
and records no success timestamp.

**Sign in a Codex coder.** A Codex CLI card whose account is `UNKNOWN` or
`AUTH_ERROR` shows **Sign in**. It starts `codex app-server` with the agent's
isolated profile as `CODEX_HOME` and requests `account/login/start` with type
`chatgptDeviceCode`. The dialog shows only the one-time code. **Open sign-in
page** asks the main process to open the verification URL it holds for that
session; the URL is only accepted as `https` on an OpenAI host. Codex stores
the credentials in the profile. Agent Forge never reads them, and the
renderer never sees them. When `account/login/completed` reports success, the
app runs an authenticated quota read, which initializes the account as
described above, and nudges automation. Sign-in is optional, cancellable, and
times out after 15 minutes. As an alternative you can run
`codex login` yourself with `CODEX_HOME` set to
`%LOCALAPPDATA%\AgentForge\profiles\codex\<name>`.

## Dashboard guidance

The dashboard starts with a **Getting started** checklist computed from real
state: project, manager and coder agents, saved plan, approved plan, tasks,
started project. Each step links to the page where you do it. Start is only
explained there, never triggered. **Needs your attention** lists blocked,
waiting, failed and fix-required tasks with a plain-language reason and an
**Open task** button.

## Not yet covered by this slice of Issue #225

- Automatic merge of a reviewed branch into the default branch. Automated
  verification (#230), review (#233) and the owner's branch hand-off (#238)
  are covered above; merging stays with the owner.


These remain open acceptance criteria on Issue #225.
