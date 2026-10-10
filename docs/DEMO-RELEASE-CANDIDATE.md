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
   - Default desktop User Data & SQLite DB: `%APPDATA%\agent-forge\database\agent-forge.db` (the current application name is `agent-forge`; `AgentForge` is the installer product name).
   - `AGENT_FORGE_DATA_DIR`, when explicitly set for the desktop process, overrides the profile root. Its database is `<profile-root>\database\agent-forge.db`.

4. **Uninstall / Reinstall Behavior**:
   - Run `%LOCALAPPDATA%\Programs\AgentForge\Uninstall AgentForge.exe /S` to remove binary files.
   - The default user profile in `%APPDATA%\agent-forge\` persists across reinstalls (`deleteAppDataOnUninstall: false`). Installing binaries in another folder, including a custom drive, still opens that same profile for the same Windows user.
   - A genuinely unused profile starts with **zero projects and zero tasks**. The two initial Manual Bridge agent/resource configurations do not start provider work. The header counts **configured agents**; a configuration is not a running project or evidence of provider execution.
   - If old projects appear, inspect the profile you are opening: they are preserved user data. Close the application and back up the complete profile before any intentional reset. To test a separate empty profile without altering existing data, launch with an explicit unused profile root:

     ```powershell
     $env:AGENT_FORGE_DATA_DIR = Join-Path $env:LOCALAPPDATA ('AgentForge-Test-' + [guid]::NewGuid().ToString('N'))
     Start-Process -FilePath '<install-dir>\AgentForge.exe'
     Remove-Item Env:AGENT_FORGE_DATA_DIR
     ```

     Replace `<install-dir>` with the binary directory. This creates a separate test profile and keeps the existing profile intact. Remove the override from the launching shell to return to the default profile on the next launch.

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

## 4. Owner Demo Workflow & Authorized Manual Bridge Handoff

The core Owner workflow exercises full cryptographic and durable authority without shortcuts:

```
Launch AgentForge
       ↓
Create / Open Project (Select local Git repository)
       ↓
Create Task (Objective & Description)
       ↓
Apply Manager Decision (EXECUTE) -> Task moves to CODING
       ↓
Owner Selects Candidate Resource (e.g. Gemini Coder / Manual Bridge)
       ↓
Execution Authorization Created (Status: AUTHORIZED, Revision-bound, Manager-bound)
       ↓
One-Time Dispatch -> Manual Bridge returns provider result AWAITING_OWNER
                    -> Durable task state remains CODING or HANDOFF_REQUIRED
                    -> Authorization durable status in SQLite becomes DISPATCHED
       ↓
Generate Cryptographic Authorized WorkOrder (PackageGenerator.generateAuthorizedManualWorkOrder)
       ↓
Owner copies WorkOrder to Clipboard and relays to Gemini in Browser / External Window
       ↓
Gemini completes coding & returns coder.v1 protocol JSON
       ↓
Owner pastes coder.v1 into Coder Inbox
       ↓
Protocol Validation & State Transition (Task moves to VALIDATING)
       ↓
Automated Verification Tests executed via ProcessRunner against real Git diff
       ↓
Review Ready (Task moves to REVIEW_READY) -> Generate Review Package with authoritative diff evidence
```

---

## 5. Emergency Stop Verification

- **Location**: Emergency Stop button is permanently accessible in the top-right navigation bar.
- **Behavior**:
  - Immediately halts all active child processes, dispatches `EMERGENCY_STOP` event to SQLite ledger, and pauses running task workflows.
  - Fail-closed: Cannot be overridden by background task runners.

---

## 6. Restart Recovery Verification

1. With a dispatched Manual Bridge authorization (`AWAITING_OWNER`) bound to a task in `CODING` or `HANDOFF_REQUIRED`, or with a task in `REVIEW_READY`, close the application.
2. Relaunch `AgentForge.exe`.
3. Verify:
   - SQLite state is preserved (Project, Task, Protocol Messages, Events, Authorizations).
   - Consumed authorization remains `DISPATCHED` in SQLite and cannot be dispatched twice.
   - Language selection persists across restarts.
   - Task resumes in exact durable state.

---

## 7. Updater Check & Production Truth

- **Production Updater Backend**:
  - Configured to official GitHub Releases repository: `thanhtuyen662002/Agent-Forge`.
  - Production `app-update.yml` contains zero embedded credentials.
- **Policy Invariants**:
  - `autoDownload=false` (Owner must explicitly click Download).
  - `autoInstallOnAppQuit=false` (Owner must explicitly choose when to restart).
- **Test vs Production Separation**:
  - Localhost/generic HTTP feed belongs **ONLY** to the isolated automated updater integration test harness (`scripts/test-installed-update-win.ps1`).
  - The installed production application (`AgentForge.exe`) strictly connects to GitHub Releases (`thanhtuyen662002/Agent-Forge`).
- **Update Final Gate Evaluation**:
  - Download and SHA-512 blockmap verification are automated and verified.
  - The installed-update test uses isolated test NSIS artifacts and a local generic feed to verify discovery/download and the `DOWNLOADED` (`canInstall=true`) gate. This does not represent a published or signed production release.
  - Final Windows binary replacement and elevation restart requires interactive elevation approval (`FULL_UPDATE_INSTALL_RESTART_TEST=MANUAL_FINAL_GATE_REQUIRED`).

---

## 8. Diagnostic Evidence Collection

To collect diagnostics for support or verification:
1. **Desktop User Database**: `%APPDATA%\agent-forge\database\agent-forge.db` by default, or `<AGENT_FORGE_DATA_DIR>\database\agent-forge.db` when the desktop profile override is set. This desktop default does not replace explicit MCP database configuration.
2. **Packaged Verification Receipt**: Run `scripts/verify-demo-rc-win.ps1` to produce `release/demo-rc-receipt.txt`.
3. **Production Installed Smoke**: Run `scripts/smoke-installed-production-win.ps1` to perform isolated NSIS installation and startup verification.
