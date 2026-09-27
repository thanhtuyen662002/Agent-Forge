# Agent Forge web-first autonomous engineering policy

## Mission

Develop Agent Forge primarily through GitHub-connected web agents. The desktop/local Supervisor remains product/runtime code under test; it is **not** the development control plane.

The engineering control plane is:

- GitHub `main` = integrated source of truth.
- GitHub Issues = executable backlog and dependency graph.
- Draft pull requests = distributed work leases.
- GitHub Actions = authoritative repository verification.
- PR discussion/review threads = review findings and handoff record.
- Git commits/diffs = implementation truth.

Do not depend on a developer's local SQLite database, local worktree, local-only commit, terminal session, or chat history to resume engineering work.

## Mandatory start/resume protocol

At the start of every engineering run:

1. Read this file.
2. Read:
   - `docs/WEB_AUTONOMY.md`
   - `docs/ISSUE_EXECUTION_PROTOCOL.md`
   - `docs/WEB_AGENT_ROLES.md`
3. Fetch current `main`.
4. Inspect all open Issues and open PRs.
5. Inspect exact-head CI for live PRs relevant to the work.
6. Check whether another live Draft PR already claims the Issue or overlaps the intended files.
7. Resume an existing valid claim before starting new work.
8. Only if no valid claim exists, select the highest-priority READY Issue allowed by dependencies and scope.

Never rely on a remembered repository state.

## Issue contract

Autonomous work must originate from a GitHub Issue using the `AF_TASK_V1` contract described in `docs/ISSUE_EXECUTION_PROTOCOL.md`.

An Issue is executable only when:

- its status is `READY`;
- every `blocked_by` Issue is closed or explicitly satisfied;
- required external credentials or owner-only decisions are not missing;
- no live Draft PR already owns it;
- no live PR has a conflicting path scope.

If the Issue is underspecified, improve the Issue first. Do not guess business requirements.

## Distributed lease: Draft PR

A Draft PR is the engineering lease.

Claim sequence:

1. Re-read the Issue and all open PRs.
2. Create branch `agent/issue-<number>-<short-slug>` from current `main`.
3. Create a Draft PR immediately, before substantial implementation.
4. PR title must include `[#<issue>]`.
5. PR body must contain `AF_PR_V1`, `Closes #<issue>`, exact base SHA, intended path scope, dependencies, and current phase.
6. Re-fetch open PRs after creating the Draft PR.
7. If an earlier valid PR claims the same Issue, or an earlier PR has materially overlapping scope, stop and close/abandon the duplicate claim unless the Issues explicitly permit parallel work.

Earliest valid Draft PR wins a claim race.

A claim is considered live while its PR is open and has meaningful activity/CI within the lease rules in `docs/ISSUE_EXECUTION_PROTOCOL.md`. The Watchdog role resolves stale claims.

## Concurrency

Parallelism is encouraged across independent path scopes.

Before editing:

- compare intended paths with open PR changed files and declared scopes;
- do not modify another live PR's owned paths unless the Issue explicitly coordinates the dependency;
- do not stack on another PR unless the Issue says `base_mode: STACKED`;
- prefer small independently mergeable slices over one broad PR.

Waiting for CI is not a reason to stop all engineering. A CI-waiting PR does not consume implementation attention; an agent may work on another independent READY Issue.

## Implementation authority

For a claimed Issue, agents may autonomously:

- inspect/refactor implementation;
- add/update tests;
- create branches and Draft PRs;
- repair CI;
- rebase/restack on `main`;
- update documentation required by the Issue;
- respond to review findings;
- merge when all repository gates and Issue acceptance criteria are satisfied.

Do not ask the owner about routine implementation choices already covered by architecture/policy.

## Verification and review

Worker/model prose is never proof.

Before marking a PR ready or merging:

- inspect the exact PR head SHA;
- inspect the complete diff;
- verify the Issue acceptance criteria against code/evidence;
- require all branch-protection checks for that exact head;
- resolve all review threads;
- ensure no unexpected files are changed;
- ensure no secret, local path dependency, generated runtime state, or local-only artifact was introduced;
- ensure documentation claims match current code.

If the head changes after review, review the new exact head again.

A cancelled or superseded CI run is not a failure when a newer same-purpose exact-head run succeeded. A real failed required check must be repaired before merge.

## Merge and completion

Merge only through a PR. Never push directly to protected `main`.

After merge:

1. Verify the PR is merged and the Issue is closed or close it through `Closes #...`.
2. Verify post-merge `main` CI when the change is high-risk or changes CI/runtime/release/security.
3. Remove stale successor claims made obsolete by the merge.
4. Continue with the next highest-priority independent READY Issue if execution time remains.

## Watchdog responsibility

Every Lead/Watchdog run must look for:

- READY backlog starvation;
- duplicate Issue claims;
- overlapping PR path scopes;
- PRs waiting on CI with no follow-up after failure;
- stale Draft PR leases;
- dependency chains that unnecessarily serialize work;
- required checks that dominate cycle time;
- documentation/source drift;
- local-only evidence or commits that cannot be recovered from GitHub;
- giant files/tests creating context bottlenecks;
- Issues blocked only because no one converted a known problem into an executable task.

The Watchdog fixes process/documentation defects directly when safe, otherwise opens or improves Issues.

## Security and destructive actions

Never commit credentials, provider tokens, cookies, auth caches, private keys, local runtime databases, or secret-bearing logs.

Do not autonomously:

- publish a production release;
- rotate or reveal credentials;
- weaken branch protection or required checks merely to merge;
- delete repositories/history;
- perform irreversible production/database actions;
- bypass unresolved security findings.

Escalate only for:

- missing external credentials/accounts that are genuinely required;
- destructive or irreversible production action;
- business/legal decision with no repository policy;
- irreconcilable architecture conflict.

Provider unavailability is normally a waiting/failover condition, not an owner escalation.

## Local runtime boundary

Local paths such as `D:\Projects\Agent-Forge`, local SQLite state, local OmniRoute availability, or a developer machine may be used as optional product evidence, but web engineering must remain resumable without them.

Any important implementation that exists only on a local machine is considered **not durable** until represented by a Git commit/PR, Issue evidence, or reproducible specification in GitHub.

## Product invariants

While developing the product, preserve these established invariants unless an Issue explicitly changes architecture:

- role/profile/provider/model/account/worker-slot identities remain separated;
- product tasks and durable ExecutionAuthorization remain authoritative for product execution;
- leases/ownership epochs fence stale execution;
- exact-head review is mandatory;
- worker/provider claims are independently verified;
- provider failures do not silently become task success;
- secrets stay outside Git and sanitized evidence;
- protected `main` and required CI checks are not bypassed;
- release publication remains owner-controlled unless repository policy is explicitly changed.
