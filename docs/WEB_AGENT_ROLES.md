# Web agent roles

Roles are engineering viewpoints, not provider identities. A single agent may perform several roles, but should keep the responsibilities distinct.

## Lead / Planner

Keep work flowing from GitHub.

- inspect main, Issues, PRs, CI, and dependencies;
- maintain several independent READY Issues when backlog exists;
- split broad work into mergeable slices;
- prioritize bottleneck removal;
- avoid taking over a live specialist claim.

## Implementer

Finish one claimed Issue with a small complete diff.

- create a Draft PR lease first;
- stay inside declared scope;
- add deterministic regression tests;
- repair exact-head CI failures;
- update affected documentation.

## Reviewer / Adversarial QA

Look beyond green CI.

Check acceptance criteria, failure paths, concurrency, idempotency, stale-head risk, compatibility, security boundaries, test truthfulness, documentation drift, and hidden local/manual dependencies.

## CI / Release Engineer

Keep gates trustworthy and feedback fast.

- classify failures correctly;
- preserve exact-head checks;
- remove duplicated expensive work where safe;
- keep required check contexts stable;
- keep release publication explicitly controlled.

## Security / Authority Reviewer

Check that autonomous throughput does not weaken repository or runtime boundaries.

Focus on branch protections, authorization and lease fencing, secret handling, path containment, provider-output trust, release boundaries, and destructive-operation safeguards.

## Reliability / Recovery Engineer

Ensure work can resume from durable state.

Look for local-only commits/evidence, stranded states, retry accounting errors, stale leases, non-idempotent resume, and work that could disappear after rebase/restart/provider switch.

## Bottleneck Watchdog

On every pass ask:

1. Are several independent READY Issues available?
2. Can a serial dependency be split?
3. Is any Draft PR stale?
4. Which CI check dominates cycle time?
5. Are tests/builds duplicated?
6. Are giant files causing context or review bottlenecks?
7. Are old proof PRs confusing ownership?
8. Is any work blocked by a local-only artifact?
9. Is failed CI waiting without an active repair?
10. Are unresolved review threads stopping merge?

The Watchdog should repair process defects when safe or create a focused Issue.

## Documentation / Architecture Curator

Make the repository sufficient for a fresh agent.

- remove stale historical claims;
- distinguish product runtime from engineering control plane;
- keep terminology consistent;
- link to authoritative modules instead of duplicating mutable state;
- do not create status files that compete with Issues and PRs.

## Durable handoff

- implementation state -> PR;
- outstanding work -> Issue;
- review finding -> review thread or Issue;
- dependency -> `blocked_by`;
- waiting condition -> PR/Issue comment with reason and retry condition.

Chat-only prose is not a durable handoff.
