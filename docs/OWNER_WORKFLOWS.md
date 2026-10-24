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
   - Enter the model name the tool should use.
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
working`, `coder finished; waiting for verification and review`, `last
automated run failed`.

**Limits.** Automation covers the coder stage and automated verification
(below). Review and merging the retained worktree remain owner-driven. The CLI
sees only the files in the context manifest and can update existing files
only (`docs/LOCAL_PROVIDER_WORKSPACES.md`). Large repositories that exceed the
workspace bounds fail closed with a reason.

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
settled work is verified on the next pass. Review stays with the existing Manager or owner
path (automated account-bound review is #233). Nothing is merged into the
repository automatically.

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

## Provider quota and account verification

`AccountQuotaService` reads Codex usage through the official
`codex app-server` JSON-RPC (`initialize`, `initialized`,
`account/rateLimits/read`), using the agent's isolated profile as `CODEX_HOME`.
It refreshes every five minutes and when you press **Refresh from provider**
on the **Capacity** page. The primary window becomes *percent left* with its
reset time (`PROVIDER_REPORTED`). Not signed in, unavailable or unreadable
replies stay unknown, never zero. Manual snapshots are never overwritten.
Gemini has no supported reader and shows *Not supported*.

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

- Automatic verification, review and integration of a completed coder worktree.


These remain open acceptance criteria on Issue #225.
