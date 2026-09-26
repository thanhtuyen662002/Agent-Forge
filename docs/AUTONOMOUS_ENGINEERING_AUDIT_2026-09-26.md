# Autonomous engineering audit — 2026-09-26

This audit evaluates the repository as if a fresh GitHub-connected agent had to continue development with no local workstation state and no previous chat history.

## Executive finding

The product code contains substantial durability, authorization, recovery, routing, and verification machinery, but the **engineering workflow** was still local-Supervisor-first. That mismatch was the largest reason a process could be alive yet make no repository progress.

The new engineering target is:

> GitHub Issues are the queue, Draft PRs are leases, GitHub Actions are verification, and protected `main` is integrated truth.

The local desktop Supervisor remains product code, not the development scheduler.

## Audit perspectives

### Lead / throughput

**Finding: no executable GitHub backlog existed.** At audit time there were zero open Issues, so a web agent had nothing authoritative to claim even though many technical debts were known.

Action: seed Issues #70–#80 and define AF_TASK_V1.

**Finding: historical Draft PRs looked like live leases.** #58–#61 and #64–#66 remained open; several were unmergeable or based on old heads.

Action: #70.

**Finding: important work existed only locally.** PR #67 graduation referenced local-only candidate `2607cbb...`.

Action: #71 requires GitHub-only reconstruction/graduation.

### Autonomous scheduler / concurrency

**Finding: prior orchestration could be RUNNING but idle indefinitely.** Local continuous queue could only act on its own durable queue/observers. A live process did not imply GitHub progress.

Action: development orchestration is now GitHub-native.

**Finding: no distributed web claim protocol existed.** Multiple web agents could select the same work.

Action: earliest valid Draft PR wins; re-check after claim; path conflict protocol documented.

**Finding: dependency state was implicit in conversations/PR history.**

Action: AF_TASK_V1 `blocked_by`, `conflicts_with`, `base_mode`.

**Finding: CI waits could serialize all work socially even when scopes were independent.**

Action: CI wait releases agent attention; maintain several independent READY Issues.

### CI / release

**Finding: PR verification is highly duplicated.**

Current PR path performs full tests/build in:
- Fast PR Ubuntu;
- main CI Ubuntu;
- main CI Windows;
- Windows package job again before installer/update/installed/RC checks.

Protected-main rules additionally require the Windows package job for every PR.

Risk: CI becomes the dominant lead-time bottleneck and agents appear idle.

Action: #72.

**Finding: required branch protections are strong enough for autonomous merge.**

Current ruleset protects default branch with:
- pull-request-only integration;
- required thread resolution;
- strict required status checks;
- Windows validate;
- Ubuntu validate;
- Windows package;
- linear history;
- no bypass actor.

This allows autonomous PR merge without requiring routine owner approval, while still preventing direct-main shortcuts.

**Finding: release workflow is manual and write-capable by design.**

This is appropriate. Web autonomy must not convert production release publication into routine agent authority.

### Reliability / recovery

**Finding: local-only state is the main engineering durability hazard, not lack of product recovery code.**

The repository already contains extensive task/lease/recovery infrastructure, but development continuity failed when a candidate or wait lived only in a local worktree/SQLite DB.

Action: AGENTS.md now declares local-only implementation non-durable.

**Finding: dual lifecycle concepts remain.**

Product tasks/TaskService/ExecutionAuthorization are documented as authoritative while legacy `autonomy_*` state remains for bootstrap/compatibility.

Risk: future agents update the wrong lifecycle or infer authority from compatibility rows.

Action: #79, blocked by #71.

### Architecture / code health

**Finding: several files are context hot spots for AI agents.**

Approximate sizes at audit:
- `src/core/database/repositories.ts`: 468 KB;
- `src/core/services/CoderSubmissionAdjudicationService.ts`: 261 KB;
- `src/core/database/migrations.ts`: 191 KB;
- `tests/r5j5QuarantinedSubmissionAdjudication.test.ts`: 788 KB.

Risk:
- context waste;
- harder adversarial review;
- broad path conflicts;
- higher accidental-edit probability;
- slower decomposition.

Actions: #75, #76, #77, #78.

**Finding: compatibility re-export duplication exists.**

`src/core/services/ProductTaskAutonomyAdapter.ts` is only a re-export of the autonomy implementation. This is not itself a defect, but it illustrates namespace/ownership ambiguity that should be resolved as part of lifecycle consolidation rather than through opportunistic cleanup.

### Documentation curator

**Finding: README/AUTONOMY contain historical contradictions.**

Examples include:
- one-worker bootstrap wording alongside implemented two-worker support;
- automatic GitHub/CI described as future in one location and implemented elsewhere;
- local Supervisor prose presented as if it were the only engineering control plane.

Action: #74.

**Finding: mutable status documentation would be dangerous.**

A new PROJECT_STATE-style file was deliberately **not** introduced. Issues/PRs already provide live state; duplicating them in a manually updated status file would create another drift source.

### Security / authority

**Finding: repository protection is compatible with owner-free routine development.**

No approval count is required, but protected `main`, required checks, linear history, and thread resolution are enforced.

**Finding: web-agent administrative access must not become policy authority.**

AGENTS.md explicitly forbids weakening protections, publishing releases, credential operations, or irreversible production actions merely for convenience.

**Finding: issue/PR contracts are currently advisory.**

Templates can be ignored by a model.

Action: #73 adds deterministic validation with historical grandfathering.

### Watchdog

**Finding: bottleneck detection is not yet materialized as a cheap GitHub health signal.**

A web agent must currently inspect Issues/PRs/checks from scratch.

Action: #80, intentionally blocked by CI restructuring #72 to avoid concurrent workflow churn.

## Seeded dependency graph

```text
P0 READY
#70 stale Draft PR reconciliation
#71 GitHub-only graduation of PR #67
#72 CI throughput / evidence matrix

P1 READY
#73 AF_TASK/AF_PR contract validation
#74 documentation reconciliation
#75 Repository monolith extraction
#76 adjudication service extraction
#77 adjudication mega-test split

P2 READY
#78 migration registry modularization

BLOCKED
#79 legacy autonomy lifecycle retirement <- #71
#80 GitHub-native watchdog report      <- #72
```

This intentionally provides multiple independent READY tasks so one CI wait does not stop the project.

## Files added by the control-plane bootstrap

- `AGENTS.md` — web-first durable policy
- `docs/WEB_AUTONOMY.md` — control-plane and lease semantics
- `docs/ISSUE_EXECUTION_PROTOCOL.md` — AF_TASK_V1 / AF_PR_V1
- `docs/WEB_AGENT_ROLES.md` — Lead, Implementer, Reviewer, CI, Security, Reliability, Watchdog, Documentation roles
- `.github/ISSUE_TEMPLATE/autonomous-task.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- this audit

## Remaining systemic risks

1. CI cycle time remains high until #72 lands.
2. PR #67 remains a live architectural dependency until #71 resolves it from GitHub-only evidence.
3. Old Draft proof PRs remain lease noise until #70 closes/reconciles them.
4. Contract metadata is advisory until #73.
5. Web health reporting is manual until #80.
6. Large code/test monoliths remain context bottlenecks until #75–#78 progress.
7. Legacy autonomy lifecycle ambiguity remains until #79.

## Healthy-state criteria

The repository reaches the desired web-autonomous state when:

- a fresh agent can select work using only GitHub;
- every live task has an Issue and every active implementation has a Draft PR lease;
- stale leases are detectable and reclaimable;
- at least several independent READY tasks are available when backlog exists;
- CI failure is repaired automatically by the active agent rather than handed to the owner;
- no engineering milestone depends on local-only state;
- exact-head review and branch protections remain intact;
- finished PRs merge and close Issues without owner relay.
