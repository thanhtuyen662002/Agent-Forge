# AgentForge Demo & Release Candidate Runbook

This document is the operator runbook for evaluating the AgentForge MVP Windows Release Candidate (`v0.1.0`).

---

## 1. Prerequisites & Environment

- **Operating System**: Windows 10 / Windows 11 (x64)
- **Runtime Dependencies**: Bundled standalone Electron application (no global Node.js or Electron required for installed binary).
- **Git**: Local Git binary accessible in `PATH` (for repository management and verification flow).
- **Architecture**: 64-bit Windows (`x64`).

---

## 2. Installation & Setup

1. **Build Installer (from source)**:
   ```powershell
   npm run package:win
   ```
   Outputs the production NSIS installer to `release/AgentForge Setup 0.1.0.exe`.

2. **Run Installer**:
   - Double-click `release\AgentForge Setup 0.1.0.exe` or execute silent installation:
     ```powershell
     Start-Process -FilePath "release\AgentForge Setup 0.1.0.exe" -ArgumentList "/S", "/D=C:\Users\<User>\AppData\Local\Programs\AgentForge" -Wait
     ```
   - *Note*: As this is an internal/demo RC build, Windows SmartScreen will display an *Unrecognized App* prompt because the binary is unsigned (`AUTHENTICODE_STATUS=NotSigned`). Click **More info** -> **Run anyway**.

3. **Installed App Location**:
   - Default install path: `%LOCALAPPDATA%\Programs\AgentForge\`
   - Executable: `%LOCALAPPDATA%\Programs\AgentForge\AgentForge.exe`
   - User Data & SQLite DB: `%APPDATA%\AgentForge\` (`agent-forge.db`)

4. **Uninstall / Reinstall Behavior**:
   - Run `%LOCALAPPDATA%\Programs\AgentForge\Uninstall AgentForge.exe /S` to remove binary files.
   - User database in `%APPDATA%\AgentForge\` persists across reinstalls unless manually purged.

---

## 3. First Launch & Language Selection

1. **Launch**: Start `AgentForge.exe`.
2. **Language Toggle**:
   - The top header navigation contains the language switcher (`Tiếng Việt` / `English`).
   - Click `Tiếng Việt` to switch the entire UI to Vietnamese (`vi-VN`).
   - Click `English` to switch to US English (`en-US`).
   - **Persistence**: The chosen language is persisted in `localStorage` and restored automatically on next launch.
3. **About / Settings**:
   - View the current application version (displays `0.1.0`), build identity, and database migration version (7 migrations active).

---

## 4. Owner Demo Workflow & Manual Bridge Handoff

The core Owner workflow exercises full cryptographic and durable authority without shortcuts:

```
Launch AgentForge
       ↓
Create / Open Project (Select local Git repository)
       ↓
Create Task (Objective & Description)
       ↓
Apply Manager Decision (EXECUTE)
       ↓
Owner Selects Candidate Resource (e.g. Gemini Coder / Manual Bridge)
       ↓
Execution Authorization Created (Revision-bound, Manager-bound)
       ↓
One-Time Dispatch -> Task moves to AWAITING_OWNER (Status: CONSUMED)
       ↓
Generate Cryptographic WorkOrder -> Copy to Clipboard
       ↓
Owner sends WorkOrder to Gemini in Browser / External Window
       ↓
Gemini completes coding & returns coder.v1 protocol JSON
       ↓
Owner pastes coder.v1 into Coder Inbox
       ↓
Protocol Validation & State Transition (moves to VALIDATING)
       ↓
Automated Verification Tests executed via ProcessRunner against real Git diff
       ↓
Review Ready -> Generate Review Package with authoritative diff evidence
```

---

## 5. Emergency Stop Verification

- **Location**: Emergency Stop button is permanently accessible in the top-right navigation bar.
- **Behavior**:
  - Immediately halts all active child processes, dispatches `EMERGENCY_STOP` event to SQLite ledger, and pauses running task workflows.
  - Fail-closed: Cannot be overridden by background task runners.

---

## 6. Restart Recovery Verification

1. With a task in `AWAITING_OWNER` or `REVIEW_READY`, close the application.
2. Relaunch `AgentForge.exe`.
3. Verify:
   - SQLite state is preserved (Project, Task, Protocol Messages, Events, Authorizations).
   - Consumed authorization remains `DISPATCHED` / `CONSUMED` and cannot be replayed.
   - Language selection persists.
   - Task resumes in exact durable state.

---

## 7. Updater Check & Download Truth

- **Updater Backend**: Configured to GitHub Releases repository `thanhtuyen662002/Agent-Forge`.
- **Policy Invariants**:
  - `autoDownload=false` (Owner must explicitly click Download).
  - `autoInstallOnAppQuit=false` (Owner must explicitly choose when to restart).
- **Current Truth**:
  - Production `app-update.yml` contains zero embedded credentials.
  - Updates are checked and downloaded into isolated temp feed storage with SHA-512 blockmap verification.
  - Final Windows replacement and restart requires elevation approval (`MANUAL_FINAL_GATE_REQUIRED`).

---

## 8. Diagnostic Evidence Collection

To collect diagnostics for support or verification:
1. **Application Logs**: `%APPDATA%\AgentForge\logs\`
2. **Database**: `%APPDATA%\AgentForge\agent-forge.db`
3. **Automated RC Verification Receipt**: Run `scripts/verify-demo-rc-win.ps1` to produce `release/demo-rc-receipt.txt`.
