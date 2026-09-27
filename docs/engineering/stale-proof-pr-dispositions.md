# Historical Draft proof PR dispositions

Checked against `main` at `4fd7b58a45e074439e33ab396a9d2fd9234261d9` for Issue #70. These branches predate the Draft PR lease protocol and have no `AF_PR_V1` claim. Closing a PR leaves its commits, conversation and diff reachable on GitHub. Do not treat old local test reports as current exact-head CI.

| PR | Durable evidence and current-main comparison | Disposition |
| --- | --- | --- |
| #58 | One test-file edit for reviewer stdio and fixture cleanup; overlaps the later #59 approach. | Superseded by #59's narrower fixture split. Preserve as historical evidence; recover valid behavior through #85. |
| #59 | Adds `tests/helpers/r5l1SyntheticFixture.ts` and `tests/r5l1ReviewerStdioRehearsal.test.ts`, both absent from current main; changes the original rehearsal test. CI and review evidence are tied to its old head. | Do not merge the stale branch. Port and reverify useful tests from the current main baseline under #85. |
| #60 | Depends on #59, adds a generated evidence manifest and asserts continuous lifecycle completion. The later #61 investigation reports that initial authorization/dispatch rejected before coder execution. | Do not merge or promote its manifest as end-to-end proof. #86 requires truthful stage provenance and resolution of the blockers. |
| #61 | Depends on #59 and adds `tests/r5l1LifecycleBoundary.test.ts`, absent from main. Its PR body documents a context-manifest hash mismatch, missing durable assignment/account binding and coder-worktree HEAD gap; downstream stages were unexercised. | Preserve the diagnosis; port and update the boundary test under #86 after #85. |
| #64 | Contains older two-worker scheduling code and a three-line concurrent proof A note. Main already has two-worker scheduling through `17162c9` and queue-lifetime fix through `48bbedb`, with later changes on top. | Keep the PR/commit as historical proof; do not merge the older source or use the note as a current integration gate. |
| #65 | Depends on the same old two-worker branch; adds a three-line proof B note. | Keep the PR/commit as historical proof; no distinct source task remains. |
| #66 | Depends on the same old two-worker branch; adds a three-line CI-wait task C note. | Keep the PR/commit as historical proof; no distinct source task remains. |

## Reconciliation

- #85 is a READY, test-only recovery task for #58/#59.
- #86 is a bounded lifecycle integration task blocked by #85; it preserves #60/#61 diagnostics without asserting an unproven success.
- No historical proof PR is a current engineering lease. PR #67 remains a separate live migration lease tied to #71.
- If a recovered test exposes a product defect, fix it in the relevant current Issue/PR with fresh exact-head CI. Do not resurrect obsolete branches as shortcuts.
