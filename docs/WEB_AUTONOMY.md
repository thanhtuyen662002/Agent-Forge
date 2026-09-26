# Web-first autonomous engineering

## Purpose

This document defines how Agent Forge is developed by GitHub-connected web agents without depending on a continuously running developer workstation.

It governs **engineering of Agent Forge**. It does not remove the local desktop/runtime architecture from the Agent Forge product.

## Control-plane model

| Concern | Durable authority |
| --- | --- |
| Integrated source | GitHub `main` |
| Work queue | GitHub Issues |
| Dependencies | Issue `blocked_by` metadata |
| Work ownership | Earliest valid Draft PR |
| Implementation | PR branch commits |
| Verification | Exact-head GitHub Actions |
| Review | PR diff + review threads |
| Integration | Protected PR merge |
| Handoff | Issue/PR comments and metadata |
| Process audit | GitHub history |

Do not create a second mutable project-state file that duplicates Issue/PR state.

## Desired autonomous loop

```text
inspect main/issues/PRs
        |
repair/resume existing live claim
        |
otherwise select highest-priority READY issue
        |
create branch + Draft PR lease
        |
implement smallest complete slice
        |
tests / exact-head CI
        |
+------------------------------+
| CI failed -> diagnose/repair |
| CI queued -> release attention|
+------------------------------+
        |
exact-head self-review
        |
resolve review threads
        |
merge
        |
post-merge verification when high risk
        |
select next independent READY issue
```

A web agent should be able to start with no chat history and recover the same next action from GitHub.

## Why Draft PRs are leases

Issue comments alone are vulnerable to races. A Draft PR provides a visible branch, creation time, diff, CI, and linkage to the Issue.

Claim race rule: the earliest valid Draft PR for an Issue wins. Later duplicate claims must stop after re-checking PRs.

For cross-Issue path conflicts, the older live PR owns the overlapping path unless an Issue explicitly defines a stacked dependency.

## Lease heartbeat and stale claims

A lease is normally considered live when:

- PR is open; and
- one of these is true:
  - PR/branch was updated within the last 8 hours;
  - exact-head CI is currently queued/in progress;
  - the PR body/comment explicitly records a capacity/external wait with a future retry point;
  - the PR is waiting for a declared dependency that is still live.

A Watchdog may reclaim a Draft PR when it has no meaningful activity for more than 8 hours and none of the legitimate wait conditions applies.

Before reclaiming:

1. inspect PR comments and exact-head CI;
2. inspect whether commits contain useful unmerged work;
3. comment `AF_LEASE_EXPIRED` with reason;
4. create a replacement claim from current `main` if needed;
5. never discard useful work without preserving it in GitHub.

## Priority and selection

Priority order is `P0 > P1 > P2 > P3`.

Within a priority, prefer:

1. issues that unblock multiple other issues;
2. reliability/CI/queue defects that stop autonomous flow;
3. small independent tasks that maintain parallel throughput;
4. broad refactors only when decomposed into safe slices.

An agent must not select a blocked Issue merely because it is older.

The Lead/Watchdog should maintain at least three independent READY Issues when meaningful backlog exists, so CI or provider waits do not stall the project.

## Path-conflict protocol

Before claiming, inspect open PR changed filenames and declared `paths`.

Classify overlap:

- **NONE**: safe to work in parallel.
- **LOW**: shared docs/test fixture only; allowed if changes are independent.
- **MATERIAL**: same implementation module, schema, migration, workflow, or shared contract; do not work in parallel unless explicitly coordinated.
- **STACKED**: later Issue explicitly depends on the earlier PR; use its head as base and record that in metadata.

If uncertain, choose another READY Issue instead of creating merge debt.

## CI semantics

The protected branch rules are authoritative.

Agents must distinguish:

- queued/in-progress: wait state, not failure;
- cancelled because superseded by a newer same-purpose exact-head run: not a code failure;
- required check failure: implementation/CI repair required;
- infrastructure outage: retry/backoff, do not mutate code blindly.

While one PR waits for CI, the agent may claim another non-overlapping READY Issue.

## Review semantics

A review is valid only for the exact current PR head.

Review must check:

- acceptance criteria;
- diff scope;
- security/invariant regressions;
- tests added for new failure modes;
- docs/source consistency;
- backwards compatibility where required;
- no local-only dependency;
- no hidden owner/manual step introduced into an autonomous path.

Any head change invalidates the previous exact-head conclusion.

## Web-vs-local boundary

The following are unacceptable as required engineering state:

- a local-only commit SHA not pushed to GitHub;
- a local SQLite row needed to know what to do next;
- a terminal process that must stay alive for the project to progress;
- a secret/model route required merely to run deterministic repository tests;
- a local worktree containing the only copy of a fix.

Live-provider or installed-Windows proofs may still exist as explicit integration gates, but failure/unavailability of such evidence must not erase or obscure ordinary web-development state.

## Owner-free normal operation

Routine implementation, refactors, tests, CI repair, PR creation, exact-head review, and merge are autonomous.

Owner involvement is reserved for the exceptions listed in `AGENTS.md`.

## Completion definition

The web-first engineering system is healthy when a new agent can:

1. read `AGENTS.md`;
2. find READY Issues;
3. identify conflicts/dependencies;
4. claim one with a Draft PR;
5. implement and repair CI;
6. merge through protected `main`;
7. continue to the next Issue;

without receiving state from a previous chat or a developer workstation.
