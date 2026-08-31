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

### 2.6 Cross-Provider Handoff, Provenance Spoofing & Crash Recovery (R5I)
- **Threat (T-R5I1: Stale Epoch / Split-Brain Ownership)**: A relinquished predecessor agent attempts to continue writing or claiming start after handoff to a successor provider.
  - **Mitigation**: Monotonic `tasks.ownership_epoch` increments upon relinquishment. Predecessor execution claims fail closed on epoch check.
- **Threat (T-R5I2: Provenance Spoofing & Provider Impersonation)**: An untrusted adapter attempts to falsify its returned execution metadata to impersonate an authorized provider or account.
  - **Mitigation**: `ProviderDispatchService` sanitizes and strips all returned provenance fields, binding results exclusively to durable authorized provider, account, and resource IDs.
- **Threat (T-R5I3: Mid-Transfer Concurrency & Replay Races)**: Two concurrent dispatch triggers attempt to invoke the adapter concurrently across multiple processes or threads.
  - **Mitigation**: `Repository.claimAdapterExecutionStart` performs an atomic CAS check on `worker_slots` (`current_execution_id` stamping) and `execution_authorizations` (`DISPATCHED` status and `execution_id` check), guaranteeing exactly one adapter call.
- **Threat (T-R5I4: Context Tampering & Manifest Mutation)**: Successor context files or memory items are modified in SQLite prior to dispatch.
  - **Mitigation**: Canonical payload hashing and live manifest verification assert that the active context exactly matches the frozen authorization digest before dispatch proceeds.
- **Threat (T-R5I5: Crash Inconsistency & Zombie Replays)**: The orchestrator process crashes after adapter dispatch or mid-settlement.
  - **Mitigation**: `ExecutionRecoveryScanner` detects in-flight or incomplete authorizations, enforces `UNRESOLVED_FENCED` status to block replay without re-authorization, and deterministically reconciles terminal state.
