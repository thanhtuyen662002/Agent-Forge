# Agent-Forge: nontechnical owner experience and autonomous delivery

**Specification date:** 2026-10-17. **Documentation issue:** #227. **Implementation owner:** #225 / #226 for the currently claimed desktop slice. **Codex entry point:** [CODEX_DELIVERY_HANDOFF.md](CODEX_DELIVERY_HANDOFF.md).

## 1. Mục tiêu của chủ dự án

Người không rành kỹ thuật phải tự thêm dự án, kết nối tài khoản, quản lý nhiều tác tử, giao việc bằng lời, theo dõi thực thi, xử lý ngoại lệ và nhận kết quả. Không bắt nhập JSON, sửa file cấu hình hoặc hiểu các thuật ngữ nội bộ để hoàn thành luồng thông thường. Giao diện đẹp chỉ có giá trị khi các thao tác thực sự chạy và dữ liệu được lưu bền vững.

Hướng ưu tiên: **hoàn thành một luồng thật đầu-cuối → mở rộng quản lý/điều phối nhiều tác tử → làm rõ tiến trình và các việc bị chặn → sơ đồ nâng cao và tùy biến giao diện**. Sửa đúng phần đang làm ở #225/#226 trước; không mở một đợt viết lại cạnh tranh.

The goal is broad automation of supported engineering workflows within configured permissions. It is not an assertion that every provider, website, external approval, deployment or irreversible operation can be automated. Ordinary authorized steps should proceed without repeated prompts; genuinely missing credentials, decisions and unsupported operations must appear as actionable exceptions.

This is a product specification and dated audit, not a mutable execution tracker. Live ownership, status and dependencies remain in GitHub Issues/PRs. Requirements below are proposed delivery criteria, not claims of implementation.

## 2. Evidence boundary and current baseline

Source reviewed at [main 15cfbcd82312f6d27cb56096d22daa589cafbbf8](https://github.com/thanhtuyen662002/Agent-Forge/tree/15cfbcd82312f6d27cb56096d22daa589cafbbf8). At 2026-10-17 approximately 16:50 UTC:

- [#225](https://github.com/thanhtuyen662002/Agent-Forge/issues/225) already specified guided desktop management, quota, runtime and recovery work.
- [#226](https://github.com/thanhtuyen662002/Agent-Forge/pull/226) was Draft, head `12a47e56df725cc2672d059a7907a2c3ee666a88`, with **zero changed files** against the base. Its checks were green, but that does not verify absent feature changes. Unpublished local work may exist; do not assume it is lost or overwrite it.
- #222/#223 concern dependencies; #224 concerns watchdog truth; [#195](https://github.com/thanhtuyen662002/Agent-Forge/issues/195) concerns external production readiness. Keep these scopes separate.
- This audit inspected source and official reference documentation. It did not launch the installed Windows app, authenticate live providers, run tests or validate the owner's exact installed binary.
- Browser preview and Electron are distinct: a missing Electron bridge can yield demo/disabled behavior. Record the actual build, mode and profile when reproducing a report.

### Source-grounded gap matrix

| Owner need | Evidence in audited main | Required change | Order |
|---|---|---|---|
| Start autonomous work from desktop | Header transitions project state; ProjectService records state/event. Supervisor construction and continuous queue are in autonomyCli. | Connect a real application-owned bounded runtime to desktop lifecycle controls; show actual dispatch/process/stage evidence. | A |
| Add, edit and remove agents | AgentCenter displays existing roles; IPC exposes agents:list; repository has creation primitives without a full management surface. Reviewer list is computed but not rendered. | Guided persistent management, all supported roles, model/account binding, retire/archive, active-work explanations. | A |
| Understand fresh installation | Bootstrap seeds Manual Bridge resources and two fixed agents; absent seeded records are recreated. | Intentional onboarding and starter templates; no false appearance of connected/running workers; persistent retirement behavior. | A |
| Connect accounts and see automatic quota | Capacity supports manual resource snapshots; ManualBridge and LocalCliAdapterBase return UNKNOWN/null numeric quotas. | Supported provider telemetry with account scope, freshness and reset; truthful unsupported states. | A/B |
| Remove old/test projects and work | No complete delete/archive flow in ProjectsView/preload/ProjectService. | Transactional trash/restore, active selection reconciliation, preserved repository files/history, stale-action rejection. | A |
| Work without JSON | Project contract import uses JSON.parse; Manager/Coder relay exposes protocols. Task creation is already a form; Settings already has plain test/lint/build inputs. Native capability approval exposes JSON details. | Guided contract and readable approval forms; reuse existing task/settings fields; JSON advanced-only. | A |
| Know what requires attention | Many technical views and raw states; no unified novice journey. | Actionable inbox and concise project-level running/waiting/failed/results summaries. | A/B |
| Use several agents reliably | Separate identity/lease/routing primitives and bounded pilot exist. README limits local self-host workers to one or two. | Many saved agents; tested, explicitly bounded concurrency and fair scheduling. Do not claim unlimited execution. | B |
| Understand task dependencies | Task/authority infrastructure exists; referenced screenshots show a richer graph than audited UI. | Validate dependency logic first; add list/Kanban/graph projections over one authoritative task model. | B/C |
| Trust results | Verification/recovery/evidence primitives exist; README still labels product AUTONOMY_BOOTSTRAP_PILOT. | End-to-end installed-app proof, readable results, truthful partial/failed/not-run states. | Every stage |

Source entry points (all pinned):
- [README](https://github.com/thanhtuyen662002/Agent-Forge/blob/15cfbcd82312f6d27cb56096d22daa589cafbbf8/README.md)
- [Header](https://github.com/thanhtuyen662002/Agent-Forge/blob/15cfbcd82312f6d27cb56096d22daa589cafbbf8/src/ui/components/Header.tsx), [ProjectService](https://github.com/thanhtuyen662002/Agent-Forge/blob/15cfbcd82312f6d27cb56096d22daa589cafbbf8/src/core/services/ProjectService.ts), [autonomyCli](https://github.com/thanhtuyen662002/Agent-Forge/blob/15cfbcd82312f6d27cb56096d22daa589cafbbf8/src/electron/autonomyCli.ts)
- [BootstrapService](https://github.com/thanhtuyen662002/Agent-Forge/blob/15cfbcd82312f6d27cb56096d22daa589cafbbf8/src/core/services/BootstrapService.ts), [preload](https://github.com/thanhtuyen662002/Agent-Forge/blob/15cfbcd82312f6d27cb56096d22daa589cafbbf8/src/electron/preload.ts), [ipcHandlers](https://github.com/thanhtuyen662002/Agent-Forge/blob/15cfbcd82312f6d27cb56096d22daa589cafbbf8/src/electron/ipcHandlers.ts)
- [UI views](https://github.com/thanhtuyen662002/Agent-Forge/tree/15cfbcd82312f6d27cb56096d22daa589cafbbf8/src/ui/views), [LocalCliAdapterBase](https://github.com/thanhtuyen662002/Agent-Forge/blob/15cfbcd82312f6d27cb56096d22daa589cafbbf8/src/core/adapters/LocalCliAdapterBase.ts), [ManualBridgeAdapter](https://github.com/thanhtuyen662002/Agent-Forge/blob/15cfbcd82312f6d27cb56096d22daa589cafbbf8/src/core/adapters/ManualBridgeAdapter.ts)

## 3. Lessons from reference products and three supplied images

Reference documentation was read on 2026-10-17. These are documented patterns, not installed-product benchmarks, a license to copy source/art, or a guarantee that their integrations fit Agent-Forge.

| Reference | Useful pattern | Agent-Forge application |
|---|---|---|
| [Orca usage](https://www.onorca.dev/docs/agents/usage-tracking) | Account/provider usage windows, reset, unavailable/loading states | Compact account capacity summary and detailed source/freshness/reset view. Keep quota, usage and estimated cost distinct. |
| [Orca worktrees](https://www.onorca.dev/docs/model/worktrees) | Searchable project/host selection, background creation and retry | Guided project/run setup; visible cancellation and failure recovery. |
| [Orca automations](https://www.onorca.dev/docs/cli/automations) | Manageable enabled/paused tasks, run history and manual runs | Readable automation list with next execution, target and history. |
| [Herdr agents](https://herdr.dev/docs/agents/) | Agent attention rolls up to project/workspace | Inbox and project badges for needs-input, failures and unread results. Idle is not completion. |
| [Paseo parallel work](https://paseo.sh/docs/parallel-development), [orchestration](https://paseo.sh/docs/orchestration) | Project + isolated workspace + agent/model + ordinary task prompt | Reusable agent profiles and a simple new-work flow. |
| [Paseo lifecycle](https://paseo.sh/docs/mcp), [CLI](https://paseo.sh/docs/cli) | Cancel, archive, terminate and remove registration have different effects | Explain lifecycle consequences; removing a project registration must not silently delete source files. |
| [AionUi](https://github.com/iOfficeAI/AionUi) | Natural-language tasks, scheduling and multi-agent controls | Friendly instructions, inspectable schedule preview, accessible teammate management. |

Orca here means [stablyai/orca](https://github.com/stablyai/orca), linked from onorca.dev. Herdr is [herdrdev/herdr](https://github.com/herdrdev/herdr); Paseo is [getpaseo/paseo](https://github.com/getpaseo/paseo); AionUi upstream is iOfficeAI/AionUi. Similar names/forks must not be substituted silently.

### Image 1: AUTOPILOT stage pipeline and run ledger

Observed: Start → Plan/Plan review → You → Implement/Code review → Local QA/Fix → Draft PR. Cards show iterations, durations and costs. A ledger below records revision/review/QA outcomes and a legend distinguishes done/running/waiting/stopped/not-started/not-automated. One QA item explicitly says it is not automatable.

Adopt a compact run-stage overview with expandable attempts and artifacts. Highlight current stage and next action, not every number. Distinguish approval, skipped/not-needed, unsupported, partial and failed outcomes. Show test failure and repair loops rather than hiding them behind a green total. Draft PR creation is separate from merge and release. Never fabricate costs, progress or test results.

Do not repeat identical information in every card and ledger. Avoid tiny text and wrapped PR identifiers. Screenshots do not establish that the depicted orchestration or PR creation actually works.

### Image 2: wave-based dependency board

Observed: filters, status counters, wave columns, connected tasks and highlighted dependency paths. Selected paths remain bright while other cards are dimmed; a critical-path legend is present.

Adopt dependency drill-down: “Waiting for task X”, “Unblocks N tasks”, Ready now, searchable list and focus path. A cycle, missing prerequisite or failed dependency must produce an actionable explanation. Dependency correctness precedes graph visualization. Waves are computed from the task graph, not a second mutable scheduling database. Only label a path “critical” if the scheduling assumptions/estimates support it; otherwise use “dependency path”.

Do not make a huge horizontal graph the only interface. Keep names readable, avoid over-dimming, and provide list/Kanban alternatives, keyboard access and a small-screen dependency list. No assumption that pictured links prove working dependency scheduling.

### Image 3: navigation, themes and Ready now

Observed: Home/Board/Projects/Inbox/Agents/Health/Settings navigation, inbox count, a Ready now list, theme previews and separate Auto/Light/Dark controls.

Adopt project-scoped context, actionable inbox and ready-work list before decorative themes. Start with accessible light/dark/system tokens. Later theme palettes must preserve status meanings and contrast. Selection, critical links and warnings should not compete in neon. This screenshot does not prove theme persistence or live synchronization.

Images were supplied privately by the owner. They are described here without redistributing screenshots or attributing them to an unverified product.

## 4. Default user journeys and information architecture

### First useful result

1. Welcome: “Bạn muốn làm gì?” with Add existing project / Create project and a short example.
2. Pick a folder/repository using a picker. Detect tools and explain missing requirements with supported setup actions. Never require the owner to type internal paths/IDs.
3. Connect a supported provider through its supported sign-in method; show signed-in, expired, unavailable and unsupported states. Keep credentials in the existing native credential boundary.
4. Choose an agent template and optionally a model. Explain capability and expected limitations in plain language.
5. Enter a goal, constraints and success examples as ordinary text. Suggest an editable plan and tests; show assumptions before execution.
6. Choose the permitted automation scope and resource/time limits. Routine authorized actions continue; exceptional decisions enter the inbox.
7. Start the real run. Show who is working, current stage, meaningful recent activity and the next expected outcome.
8. Review a concise result with changed files, preview/artifacts, tests, unresolved issues and an optional PR link. Technical evidence is expandable.

No compulsory JSON, YAML, terminal command, environment-variable editing or protocol copy/paste in this ordinary journey. Existing verification command text inputs remain available under Advanced and can be populated by detection. Proposed commands must still pass the existing authorization policy.

### Main navigation

- **Home / Trang chủ:** running work, needs-you inbox, ready work and recent results; clear empty state.
- **Projects / Dự án:** search, active/archive/trash, add/import, restore. Project detail tabs: Overview, Work, Runs, Results, Settings.
- **Agents / Tác tử:** reusable configurations, role/capability, linked account/model, enabled state and current assignments.
- **Accounts / Tài khoản:** provider identity, connection health, supported quota/reset and refresh.
- **Automations / Tự động hóa:** one-off and scheduled runs, enabled/paused state, next run/timezone and history.
- **Settings / Cài đặt:** language, appearance, resources, advanced configuration and diagnostics.

Within Work: List and Kanban first; Dependencies as another view over the same data. Within a run: pipeline, task events, changes, tests/review, output. Combine overlapping technical Timeline/Decisions/Evidence surfaces into contextual drill-downs rather than demanding novice navigation across them.

## 5. Functional contracts

### A. Persistent agent and workspace management

- Keep role, profile, provider, model, account and worker-slot identities distinct internally. UI can guide them through a short form without requiring those terms.
- Add, inspect, edit, duplicate, disable and archive agents. Show reviewers and tools as well as planners/coders. A template is not a live running process.
- An edit to a profile must not silently change an in-flight immutable run. New runs use the new revision; old runs retain their recorded configuration.
- An agent with active work offers “stop accepting new work” and a readable active-run list. Removal must not orphan execution/history.
- Seed behavior must respect user retirement intent and never resurrect archived agents unintentionally.
- Project/task trash and restore are transactional, preserve evidence and repository files, invalidate stale dispatch authority and reconcile selected UI records. Restoring a task does not automatically execute old authorization.
- “Remove from app”, “archive run” and “delete managed worktree/files” are separate actions. Destructive filesystem deletion is not implied by this roadmap or ordinary trash.

### B. Real automation and recovery

- One authoritative product lifecycle; typed desktop commands must call the same durable task, authorization, lease and execution boundaries. Do not bolt a second competing queue onto the UI.
- Start is idempotent: repeated clicks/replayed requests cannot dispatch twice. A RUNNING project flag alone is not process evidence.
- Pause stops new dispatch; explicitly show whether an existing run is finishing or paused. Cancel requests termination and waits for verified settlement; do not label a live process stopped based only on intent.
- Resume rechecks current ownership, account availability and policy. Restart reconciles unfinished attempts before new work; uncertain termination remains visible and fenced.
- Automatic retries use bounded policy and distinguish provider capacity/network failure from code repair attempts. Preserve partial work, exact input and attempt history; no infinite loops or silently broadened permissions.
- User-facing blocker messages contain cause, impact and next step. Examples: “Tài khoản cần đăng nhập lại”, “Đang chờ tác tử kiểm tra”, “Kiểm thử thất bại: xem lỗi và chạy sửa”.
- Scheduling is optional after a successful on-demand run. Natural-language schedules resolve to an editable timezone/next-run preview. Handle overlapping triggers, missed runs, pause/delete and exactly-once logical task creation/idempotent dispatch. Do not resume paused external ChatGPT schedules.

### C. Multiple agents and projects

- Many saved agent configurations do not imply unlimited parallel workers. Expose the tested execution cap and account limits. Current pilot cap is one/two; lifting it requires separately scoped proof.
- Queue independent tasks concurrently within limits. Serialize conflicting repository writes or isolate worktrees, with explicit integration ownership.
- Avoid duplicate claims/dispatch. Allocate fairly across projects; dependency failure, starvation, stalled workers and exhausted accounts need visible states and bounded recovery.
- Failover must preserve task context/artifacts and require compatible capability and supported authority transfer. Do not start a replacement writer while the original might still mutate files.
- Validate role separation where independent review is required; a single worker cannot manufacture independent approval by renaming itself.
- Persist per-run agent/account/model/configuration provenance and sanitized activity. Provider output remains a claim until verification.

### D. Account quota, health, usage and costs

These are four different concepts: remaining provider quota, connection/execution health, run token usage, and estimated/billed cost. Keep their meaning and units explicit.

Use only supported official telemetry available for that provider/account. Show source, last refresh, window/reset and freshness. Use bounded polling with backoff and cancellation; merge concurrent refreshes. Model unsupported, signed-out, loading, stale, error and available states. Never turn UNKNOWN into zero or healthy. Manual snapshots are visibly manual and cannot overwrite measured data without clear intent.

An automatic read-only quota refresh must not silently clear auth failures/cooldowns, mutate account identity or grant execution. New-account qualification is a separate verified flow. Cost estimates must show basis/currency and must not be presented as provider invoices. Missing quota must not hide otherwise useful health information or fabricate capacity.

### E. Plan, run pipeline and actionable inbox

Suggested projection: Setup → Plan → Plan review → Approval when required → Implement → Code review → QA → Repair if needed → Result/Draft PR. Preserve the existing domain state machines; UI labels are projections, not replacement authority.

Each stage references actual persisted events/artifacts with attempt number, timestamps, outcome and responsible actor. Validate exact code revision for test/review evidence. “Not run”, “Not supported”, “Not needed”, “Cancelled” and “Failed” are distinct. A repaired task retains the failure history. No fake percentage based on elapsed animation.

Inbox items are deduplicated, scoped to project/run and resolve against current state. Approving an obsolete plan must fail clearly. Show decision preview and consequences; do not force technical JSON approval. Results require a human-readable summary, artifacts, test/review status and outstanding work; no success from model prose alone.

### F. Shared understandable UI

Use shared PageHeader, compact toolbar, status badge, empty/error/loading surface, form field, confirmation dialog, toast, run pipeline, agent/account selector and result panel. Names are conceptual; reuse current components rather than adding duplicate libraries.

Readable Vietnamese and English; consistent terminology. Primary labels describe actions: “Thêm tác tử”, “Chạy”, “Tạm dừng”, “Thử lại”, “Khôi phục”. IDs, hashes, protocol enums and full logs belong in expandable details. Do not hide errors behind toast alone: actionable failures remain in context/inbox.

Keyboard operation, visible focus, modal focus return, screen-reader labels, status icon/text as well as color, responsive narrow layouts, readable contrast and reduced motion. Keep entered forms on recoverable error; prevent accidental duplicate submission. Persist theme/density choices; verify both themes rather than adding decorative variants first.

## 6. Priority and ownership plan

Priority labels below are product order, not automatic creation of new GitHub tasks. Each successor needs an executable issue and conflict check under AGENTS.

| Stage | Deliverable and gate | Ownership/dependency |
|---|---|---|
| A: usable core (first) | Guided project/agent/account setup, trash/restore, reachable plan approval, typed action replies, real desktop run/pause/recovery, truthful quota states, minimal inbox and results. Complete one supported provider journey. | Resume #225/#226; do not write its owned paths from another claim. Supported quota integration can proceed in its already coordinated sub-scope. |
| B: dependable multi-agent automation | Many configurations with bounded concurrency, fair multi-project scheduling, isolated work, dependency validation, stall/failover recovery, verified run pipeline and per-account limits. | Build on accepted A; retain existing concurrency/authority primitives. Expand beyond pilot capacity only with explicit acceptance and tests. |
| C: operational visibility | Dependency graph, wave/group views, focused path, Ready now, richer inbox and scheduling controls. | Depends on reliable B data/semantics. Minimal actionable blockers are required already in A. |
| D: polish and scale | Additional theme palettes, advanced views, larger queues, usability/performance refinements. | After novice journey passes. Shared design tokens/components start in A, not postponed until D. |
| Release gate | Installed Windows, real-provider proofs, restart/upgrade recovery and documented limits. | Coordinate #195; source/CI acceptance is not a signed release or runtime trial. |

Do not add broad cosmetic scope to #226 merely because this roadmap exists. Deliver its bounded acceptance first; split remaining requirements into non-overlapping successor issues. Keep useful local work and existing history. Current source has valuable database, authorization, routing, verification and recovery foundations; wholesale replacement is not justified by the usability gaps.

## 7. Acceptance scenarios and evidence

The following are requirements, all **NOT RUN by this audit**. Use isolated disposable repositories/profiles and sanitized evidence; never test deletion on real user projects.

| ID | Scenario | Observable pass condition |
|---|---|---|
| U01 | New nontechnical user, clean installed profile | Adds project/account/agent, enters goal and starts supported work without JSON/config editing/terminal; setup errors contain recovery actions. |
| U02 | Agent lifecycle | Create/edit/disable/archive survives restart; all supported roles visible; busy agent cannot be orphaned; no seeded resurrection. |
| U03 | Project/task trash | Removed from active lists and selection, restored correctly after restart; repository files unchanged; prior audit history preserved with trash/restore events appended; stale dispatch rejected. |
| U04 | Real execution | Desktop action creates exactly one authorized run, isolated real file change, actual verification and review evidence, readable output. Project flag alone fails this gate. |
| U05 | Pause/cancel/restart | No new dispatch after pause; actual active-process outcome is reported; abrupt app restart reconciles without duplicate writer or lost evidence. |
| U06 | Quota failures | Signed-out/unsupported/stale/error are distinguishable; measured reset/source shown when supported; polling never clears security failures. |
| U07 | Multiple agents/projects | At least two supported workers on independent tasks within tested cap; same-file conflict prevented; waiting tasks eventually receive capacity; no duplicate dispatch. |
| U08 | Dependency failure | Downstream remains blocked with explanation/link; repair resumes only eligible tasks; cycles and missing prerequisites are rejected visibly. |
| U09 | Input/reply race | Double-click, malformed IPC acknowledgement, project switch, stale dialog approval and late process reply cannot misapply a mutation. |
| U10 | Verification honesty | Test failure produces repair/blocked result, never success; exact revision recorded; unsupported QA labeled; independent review is genuinely independent where required. |
| U11 | Scheduling | Timezone/next run visible; pause prevents future runs; overlap/missed-trigger policy works; cancel/delete preserves history. |
| U12 | Accessible UI | Keyboard and focus flows work; screen-reader status understandable; 200% zoom/narrow window usable; readable light/dark; errors remain actionable. |
| U13 | Existing profile upgrade | Migrates real-shaped prior data without deleting history, agents, account references or pending custody; rollback/recovery documented. |

For each gate record build SHA, installed/runtime mode, profile/setup, provider/model where relevant, reproducible steps, observed outcomes, screenshots/video, sanitized logs and limitations. Separate deterministic test doubles, real process integration, live provider execution and novice-user observation. A developer demonstration does not equal a novice usability study. Target zero required JSON/config editing and no unexplained dead ends; record time-to-first-result and assistance needed rather than inventing a success percentage.

## 8. Definition of completion

The owner can manage projects and agents, configure permitted automation, receive independently checked results, recover from failure and safely clean up without knowing internal protocols. Product behavior must survive restart. Limits are visible, actionable and tested.

A polished screen, many test files, a green baseline CI, a configured agent, a RUNNING flag or a Draft PR alone does not meet that definition. Implemented code, installed-app evidence and external-provider qualification remain separate until the corresponding gates pass.
