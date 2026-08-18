# Agent-Forge: Local AI Engineering Orchestrator

**Agent-Forge** is a local desktop control plane and orchestration system for coordinating multiple AI managers, coding agents, reviewers, test runners, Git repositories, quota-aware model routing, checkpoints, handoffs, evidence, and human owner supervision.

---

## Core Philosophy

> **Models are disposable workers. Project state is not.**

LLM conversations are transient and prone to rate limits, quota exhaustion, context truncation, process crashes, and unexpected provider outages. 

Agent-Forge guarantees that the durable source of truth resides entirely in:
- **SQLite Database** (with strict foreign keys, WAL mode, migrations, and transactional task leasing)
- **Git Repositories** (for code ground truth, diffs, commits, and worktree isolation)
- **Local Filesystem & ArtifactStore** (SHA-256 verified payload storage for large evidence)
- **Immutable Event Logs & Audit Trails**
- **Durable Checkpoints & Handoff Packages**

---

## Current Status: `DEMO_READINESS_I18N_AUTO_UPDATE`

- **Core Foundation & Database Migrations (PR #1)**: **IMPLEMENTED & VERIFIED** (SQLite WAL mode, strict foreign keys, state machine, Git ground truth).
- **Continuous Integration Pipeline (PR #2)**: **IMPLEMENTED & VERIFIED** (Multi-platform Windows & Ubuntu CI with diff hygiene).
- **Desktop Runtime & Windows Packaging (PR #3 / PR #4)**: **IMPLEMENTED & VERIFIED** (Electron desktop runtime, unpacked `better-sqlite3` native ABI bindings, NSIS installer).
- **Provider Integration Foundation (PR #5)**: **IMPLEMENTED & VERIFIED** (Manual Bridge truthful adapter, process runner isolation, Codex CLI contract fail-closed boundary, Antigravity manual-only).
- **Deterministic Quota-Aware Routing (PR #6)**: **IMPLEMENTED & VERIFIED** (Pre-dispatch failover, tier-based eligibility, AUTH_ERROR hard stop, durable routing decision events).
- **Durable Execution Authorization (PR #7)**: **IMPLEMENTED & VERIFIED** (Immutable `ExecutionAuthorization` binding exact approved work payloads, canonical payload hashes, context manifest containment, and atomic one-time dispatch claims).
- **Owner Routing & Manual Bridge UI Loop (PR #8)**: **IMPLEMENTED & VERIFIED** (Human-in-the-Loop routing controller, explicit candidate reordering, truthful UNKNOWN quota rendering, typed single-argument dispatch IPC, 1-click WorkOrder copy, and durable restart reconstruction).
- **Demo Readiness, Bilingual i18n & Installed-App Updates (PR #9)**: **IMPLEMENTED & VERIFIED** (Vietnamese `vi-VN` and English `en-US` typed translation dictionaries with 100% key parity, durable locale persistence, visible versioning, installed-app update foundation with `electron-updater`, live progress, Owner-controlled restart/install, and safe restart guards).
- **Automated Production Providers**: Production Codex CLI remains `OFFLINE` (`capabilities=[]`, fails closed without spawning processes) on hosts without verified contracts. System operates reliably via the **Owner Manual Bridge**.
- **Code Signing Status**: **UNSIGNED DESKTOP FOUNDATION** (`CODE_SIGNED=NO`; Windows executable is unsigned; explicitly noted in About and Update UI).

---

## Supported Languages (i18n)

Agent-Forge features complete bilingual support:
- 🇻🇳 **Tiếng Việt (`vi-VN`)**: Full Vietnamese user interface with accurate technical terminology.
- 🇺🇸 **English (`en-US`)**: Default international English interface.

Language selection is preserved across reloads and application restarts. Protocol messages (`manager.v1`, `coder.v1`), database storage, and state machine enums remain invariant in English.

---

## Installed-App Update Architecture

Agent-Forge incorporates a secure, human-in-the-loop update foundation:
- **Zero Stealth Installs**: `autoDownload` and `autoInstallOnAppQuit` are disabled. The Owner decides when to check, download, and install.
- **Active Work Guard**: The update service verifies SQLite state and blocks restart if any task is actively running (`CODING`, `VALIDATING`, `DISPATCHED`).
- **Strict IPC Security**: No renderer-supplied URLs, executable paths, authorization tokens, or shell commands.
- **Secret Redaction**: Error logs sanitize GitHub tokens and credentials before presentation.

---

## Operating Modes

### Human-in-the-Loop Operating Mode (Owner Manual Relay)
In the current release, the human owner operates the manual routing and handoff loop from the desktop UI:
1. Owner pastes **ChatGPT Manager** responses into the **Manager Inbox** to record and apply `EXECUTE` / `FIX_REQUIRED` protocol decisions.
2. In the **Owner Routing / Handoff** view, the Owner reviews task authority, explicitly selects and orders candidate `ProviderResource` instances (starts empty; no implicit provider auto-selection), and explicitly opts into Manual Bridge fallback.
3. The Owner triggers deterministic routing (`ProviderRoutingService.route`) and generates an immutable `ExecutionAuthorization` bound to durable Manager authority and Git repository HEAD.
4. The Owner dispatches the execution, consuming the authorization (`DISPATCHED`) with atomic replay protection.
5. If the outcome is `MANUAL_HANDOFF_REQUIRED`, the task enters `AWAITING_OWNER`. The Owner clicks **Generate Authorized WorkOrder** to construct the canonical prompt derived strictly from the immutable execution authorization instructions, then clicks **1-Click Copy WorkOrder** to copy the prompt to clipboard.
6. The Owner manually pastes the prompt into **Gemini Coder**.
7. The Owner pastes Gemini's `coder.v1` response into the **Coder Inbox** to execute verification tests and capture authoritative Git diff evidence.

> **Zero Automation & Zero Scraping Policy**: Agent-Forge does **NOT** automate ChatGPT Web, Gemini Web, or Antigravity GUI, extract session cookies, or run background clipboard polling. All automated adapters in future phases will use official, supported provider APIs and CLI tools.

---

## System Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                 React 19 Owner Control Center               │
│         (Dashboard, Manual Bridge, Kanban, Timeline)        │
└──────────────────────────────┬──────────────────────────────┘
                               │ Typed IPC API (contextIsolation=true)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Electron Main Process Core                  │
│                                                             │
│   ProjectService      TaskService         EventService      │
│   StateMachine        GitService          PolicyService     │
│   ProgressService     ArtifactStore       Verification      │
│   ProcessRunner       CrashRecovery       EmergencyStop     │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
               ▼                               ▼
┌──────────────────────────────┐ ┌────────────────────────────┐
│   better-sqlite3 (WAL mode)  │ │ Git CLI / Controlled Spawn │
│   + Migrations + Leases      │ │ + ArtifactStore (SHA-256)  │
└──────────────────────────────┘ └────────────────────────────┘
```

---

## Prerequisites & Development Setup

### System Requirements
- **Node.js**: `v22.x` (LTS `>=22.12.0` required by packaging toolchain)
- **npm**: `v10.x` or higher
- **Git**: `v2.40+`
- **C/C++ Build Tools**: Required for compiling `better-sqlite3` native binaries (`node-gyp`, Visual Studio C++ Build Tools on Windows).

### Commands & Scripts
```powershell
# Install dependencies
npm ci

# Start Vite dev server (browser preview)
npm run dev

# Run development Electron window smoke test against Vite dev server
npm run smoke:dev:electron

# Run full automated test suite (22 test suites, 85 tests)
npm test

# Build production bundle (frontend + electron main & preload)
npm run build

# Generate unpacked Windows application directory (release/win-unpacked)
npm run package:win:dir

# Run deterministic isolated packaged runtime smoke test
npm run smoke:packaged:win

# Generate Windows NSIS installer (release/AgentForge Setup 0.1.0.exe)
npm run package:win
```

### Native Modules & ABI Handling
- In unit and integration tests (`npm test`), `better-sqlite3` runs on the local Node runtime (`NODE_MODULE_VERSION 131` / `127`).
- During Windows packaging (`npm run package:win:dir` / `npm run package:win`), `electron-builder` automatically rebuilds `better-sqlite3` native binaries for the Electron runtime (`NODE_MODULE_VERSION 132` / Electron 34) and places them in `release/win-unpacked/resources/app.asar.unpacked/`.
- If switching between dev Electron and local Node test runs, `npm rebuild better-sqlite3` restores Node runtime ABI.

### Packaging Limitations & Code Signing
- **Code Signing**: `CODE_SIGNED=NO`. The generated NSIS installer is unsigned in this milestone foundation. Standard Windows SmartScreen / unknown publisher prompts are expected.
- **Application Icon**: The default Electron executable icon is currently used pending custom asset design.
- **Auto-Update**: Intentionally deferred; not enabled in this packaging milestone.

---

## Documentation Index

- [Architecture & Module Design](docs/ARCHITECTURE.md)
- [State Machines & Transition Graphs](docs/STATE_MACHINES.md)
- [Durable Data Model & Schema](docs/DATA_MODEL.md)
- [Protocols & Idempotent Messaging](docs/PROTOCOLS.md)
- [Threat Model & Security Boundary](docs/THREAT_MODEL.md)
- [Security & Process Execution Policy](docs/SECURITY.md)
