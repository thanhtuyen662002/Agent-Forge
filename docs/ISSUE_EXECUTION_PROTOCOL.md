# Issue execution protocol

## AF_TASK_V1

Every autonomous engineering Issue should begin with a machine-readable fenced block.

```yaml
AF_TASK_V1:
  priority: P1
  status: READY
  area: autonomy
  type: feature
  execution: WEB
  base_mode: MAIN
  blocked_by: []
  conflicts_with: []
  paths:
    - src/core/autonomy/**
    - tests/**
  forbidden_paths:
    - .github/workflows/release-windows.yml
  risk: MEDIUM
```

Allowed values:

- `priority`: `P0 | P1 | P2 | P3`
- `status`: `READY | BLOCKED | EXTERNAL | DONE`
- `execution`: normally `WEB`; use `EXTERNAL` only when the work fundamentally requires unavailable hardware/credentials.
- `base_mode`: `MAIN | STACKED`
- `risk`: `LOW | MEDIUM | HIGH | CRITICAL`

The Issue body must also contain:

- **Problem**
- **Why this matters**
- **Scope**
- **Acceptance criteria**
- **Required tests**
- **Non-goals**
- **Safety / invariants**
- **Dependencies**
- **Evidence / references**, when relevant

## Executability

An Issue is READY only if all of these are true:

1. `status: READY`.
2. Every Issue in `blocked_by` is closed/satisfied.
3. No missing credential, external account, hardware, production permission, or business/legal decision is required for ordinary implementation.
4. No live Draft PR already claims it.
5. No material path conflict exists with another live PR unless `base_mode: STACKED` explicitly authorizes stacking.
6. Acceptance criteria are objective enough to review.

If any condition is false, update the Issue status instead of coding blindly.

## Claim protocol

The claiming agent must:

1. post a short claim comment containing:
   - `AF_CLAIM_V1`
   - intended branch
   - current `main` SHA
   - intended path scope
2. create branch `agent/issue-<number>-<slug>`;
3. create a Draft PR immediately;
4. include the PR contract below;
5. re-fetch PRs and verify no earlier valid claim won the race.

A claim comment without a Draft PR is not a durable lease.

## AF_PR_V1

New autonomous PRs must include:

```yaml
AF_PR_V1:
  issue: 123
  phase: IMPLEMENTING
  base_sha: <40-char-main-sha>
  base_mode: MAIN
  paths:
    - src/example/**
  blocked_by: []
  risk: MEDIUM
```

And the body must include:

- `Closes #123`
- Summary
- Acceptance criteria mapping
- Tests/evidence
- Risk and rollback notes
- Explicit statement of any deferred work

`phase` may be:

- `IMPLEMENTING`
- `WAITING_CI`
- `REVIEWING`
- `BLOCKED`
- `READY_TO_MERGE`

PR metadata is descriptive; GitHub commits/checks remain authoritative.

## Failure handling

### CI failure

Do not stop after pushing a failing commit.

1. inspect failing job/step/log;
2. decide whether failure is code, test, workflow, infrastructure, or stale/superseded run;
3. fix code/workflow only when evidence supports it;
4. push a new commit;
5. re-check exact-head CI.

### Review finding

Convert actionable review findings into code/tests in the same PR when in scope.

Open a follow-up Issue only when the finding is independent or deliberately deferred. Do not silently defer a required acceptance criterion.

### Provider/capacity failure

Provider availability does not consume a code repair attempt. Record the wait and continue independent work when possible.

### Dependency wait

Update PR phase to `BLOCKED`, reference the dependency, and release attention to another Issue. Do not create busy polling.

## Stale lease handling

The Watchdog applies the 8-hour lease rule from `docs/WEB_AUTONOMY.md`.

A stale claim is resolved in GitHub, never by assuming the abandoned agent will return.

## Merge rule

A PR may merge autonomously when:

- exact current head is reviewed;
- Issue acceptance criteria are satisfied;
- required status checks are green;
- unresolved review threads are zero;
- protected branch rules permit merge;
- no owner-only action is embedded in the merge.

A high-risk change to CI, authorization, release, security, migrations, or execution fencing should also receive post-merge `main` CI verification.

## Issue decomposition

Prefer Issues that can finish in one PR.

Split an Issue when:

- it changes unrelated subsystems;
- it would require more than one independently testable migration/refactor;
- it blocks parallelism unnecessarily;
- its path scope materially overlaps several active workstreams;
- it combines policy changes with broad implementation changes.

Do not split so finely that every Issue is a one-line mechanical edit with coordination overhead greater than the work.

## Dependency graph rules

Dependencies belong in Issues, not in chat memory.

- `blocked_by` is explicit.
- Circular dependencies are invalid; the Lead must break them.
- A parent/epic does not itself block children unless stated.
- An Issue in CI wait should not block an unrelated Issue.
- The Lead should prioritize bottleneck removal when one Issue blocks multiple READY candidates.
