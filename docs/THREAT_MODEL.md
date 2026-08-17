# Threat Model & Security Boundaries

This document defines the threat landscape, trust boundaries, and defensive countermeasures for Agent-Forge.

---

## 1. Trust Boundaries

```text
┌─────────────────────────────────────────────────────────────┐
│                    UNTRUSTED / ADVERSARIAL                  │
│                                                             │
│   • External LLM Outputs (Hallucinations, Jailbreaks)       │
│   • Untrusted Repository Code & Dependencies                │
│   • Renderer UI / Webview (DOM, Third-party React libs)     │
│   • Network Payloads & Clipboard Data                       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                       STRICT POLICY GATE
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                    TRUSTED CORE ENGINE                      │
│                                                             │
│   • Electron Main Process (Node.js)                         │
│   • SQLite Database (Local encrypted/file-backed)           │
│   • Controlled Process Runner (shell=false, PID tracking)   │
│   • Policy Engine & Emergency Stop                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Threat Scenarios & Mitigations

### 2.1 Adversarial / Hallucinating LLM
- **Threat**: An LLM attempts to issue destructive system commands (e.g. `rm -rf /`, `format C:`) or access sensitive directories (`~/.ssh`, `~/.aws`, `%USERPROFILE%`).
- **Mitigation**:
  - Structured process runner (`shell: false`). Commands are parsed into explicit executable and argument arrays.
  - LLM-generated shell strings are **never directly executed**.
  - `PolicyService` enforces strict path whitelists restricted solely to the project directory.

### 2.2 Malicious Repository Payload (Indirect Prompt Injection)
- **Threat**: Code in the repository contains adversarial comments designed to trick the LLM into generating malicious commands or exfiltrating data.
- **Mitigation**:
  - All outputs and instructions pass through typed Zod validators.
  - Git operations are strictly read-only by default (`git status`, `git diff`, `git log`).
  - Force-pushing to remote branches and direct pushes to `main` are denied by policy.

### 2.3 Renderer Cross-Site Scripting (XSS) / Webview Escape
- **Threat**: Malicious code diffs or commit messages attempt to execute scripts in the desktop UI to access OS APIs.
- **Mitigation**:
  - `contextIsolation = true`, `nodeIntegration = false`, `sandbox = true`.
  - Strict Content Security Policy (CSP) blocking external scripts, fonts, and inline execution.
  - Navigation handlers block arbitrary popups and external URL opening.

### 2.4 Infinite AI Retry Ping-Pong (Resource Exhaustion)
- **Threat**: Manager and Coder get stuck in an endless loop of minor fix requests, burning time and quota.
- **Mitigation**:
  - Hard limit on revisions (`max_revisions = 3`).
  - Revisions only increment for `BLOCKER` and `REQUIRED` issues.
  - Automatically transitions to `NEEDS_HUMAN` upon reaching the threshold.

### 2.5 State Corruption / Concurrent Race Conditions
- **Threat**: Two agents or simultaneous pastes attempt to mutate the same task, corrupting state.
- **Mitigation**:
  - Transactional `task_leases` ensure only one agent slot holds the active execution lease.
  - `protocol_messages` ensures message idempotency and rejects stale states.
  - SQLite runs in WAL mode with transactions and foreign key integrity.
