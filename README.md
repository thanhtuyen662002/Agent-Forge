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

## Current Status: `MVP_CORE_HARDENING`

- **Automated Provider Adapters**: **NOT YET IMPLEMENTED** (Intentionally deferred; system operates via the **Owner Manual Bridge**).
- **Desktop Packaging**: **NOT YET IMPLEMENTED** (Windows `.exe` installer packaging is deferred; production bundle compilation via `npm run build` is fully verified).

---

## Operating Modes

### MVP Operating Mode (Manual Bridge)
In the initial release, the human owner serves as the manual transport bridge:
1. Owner pastes **ChatGPT Manager** responses into the **Manager Inbox**.
2. Agent-Forge validates the structured `manager.v1` protocol, records it in the idempotent message ledger, updates the task state machine, and produces a **Work Order**.
3. Owner copies the **Work Order** into **Gemini Coder** (or another coding model).
4. Owner pastes the resulting **Coder Report** into the **Coder Inbox**.
5. Agent-Forge validates `coder.v1`, gathers real Git diffs, runs configured verification commands (test, lint, build), stores evidence in the `ArtifactStore`, and generates a **Review Package**.
6. Owner copies the **Review Package** back to **ChatGPT Manager** for evaluation.

> **Zero Scraping Policy**: Agent-Forge does **NOT** automate ChatGPT Web, extract session cookies, or bypass provider rate limits. All automated adapters in future phases will use official, supported provider APIs and CLI tools.

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
- **Node.js**: `v20.x` or higher (Active LTS / `v23.x` supported)
- **npm**: `v10.x` or higher
- **Git**: `v2.40+`
- **C/C++ Build Tools**: Required for compiling `better-sqlite3` native binaries (`node-gyp`, Visual Studio C++ Build Tools on Windows).

### Commands & Scripts
```powershell
# Install dependencies
npm install

# Start Vite dev server (browser preview)
npm run dev

# Start Electron desktop application
npm run dev:electron

# Run automated tests
npm test

# Build production bundle (frontend + electron main)
npm run build
```

---

## Documentation Index

- [Architecture & Module Design](docs/ARCHITECTURE.md)
- [State Machines & Transition Graphs](docs/STATE_MACHINES.md)
- [Durable Data Model & Schema](docs/DATA_MODEL.md)
- [Protocols & Idempotent Messaging](docs/PROTOCOLS.md)
- [Threat Model & Security Boundary](docs/THREAT_MODEL.md)
- [Security & Process Execution Policy](docs/SECURITY.md)
