# AgentForge MCP External-Client Setup Guide

This document describes the operator setup, configuration generation, session lifecycle, security requirements, and troubleshooting procedures for connecting external AI developer clients (**Google Antigravity**, **Cursor**, and **Claude Desktop**) to the AgentForge Model Context Protocol (MCP) server on Windows.

---

## 1. Preconditions & Execution Tiers

### System Preconditions
- **AgentForge Version**: `0.1.0` or higher (capability schema version 2).
- **Database**: SQLite database initialized with migrations up to version 21 (`verifyMigration21SchemaAuthority`).
- **Authorization State**: An existing, valid `ExecutionAuthorization` record with status `AUTHORIZED` bound to a specific project, task, and task attempt.
- **Session Authority**: Short-lived, cryptographic session token issued through `sessionAdmin.js issue` or `McpSessionAuthorityService`.

### Supported Windows Execution Tiers
1. **Developer Tier (Host Node.js)**
   - Used during AgentForge core development.
   - Executable is the host Node binary (`process.execPath`, e.g., `node.exe`).
   - Sibling script is located at `<checkout-root>/dist-electron/mcp/stdio.js`.
   - `ELECTRON_RUN_AS_NODE` is **omitted**.
2. **Unpacked Package Tier (`release/win-unpacked`)**
   - Packaged distribution prior to or without NSIS installation.
   - Executable is `release/win-unpacked/AgentForge.exe`.
   - Script entrypoint is inside the package ASAR archive: `release/win-unpacked/resources/app.asar/dist-electron/mcp/stdio.js`.
   - `ELECTRON_RUN_AS_NODE=1` is **required**.
3. **NSIS-Installed Production Tier**
   - Standard end-user desktop installation.
   - Executable is `<install-dir>/AgentForge.exe` (e.g., `%LOCALAPPDATA%\Programs\AgentForge\AgentForge.exe`).
   - Script entrypoint is `<install-dir>/resources/app.asar/dist-electron/mcp/stdio.js`.
   - `ELECTRON_RUN_AS_NODE=1` is **required**.

> [!NOTE]
> **GUI Launch Isolation**: Running `AgentForge.exe` with `ELECTRON_RUN_AS_NODE=1` instructs Electron to act strictly as a headless Node.js runtime, bypassing `src/electron/main.ts`, Chromium window creation, GPU processes, and renderer initialization. Normal double-click GUI launch of AgentForge is completely unaffected because `ELECTRON_RUN_AS_NODE=1` is set exclusively in the environment of the spawned MCP server child process.

---

## 2. Launch Models & Configurations

### Single Installed Launch Model
The external client starts the executable and entrypoint script directly via stdio. AgentForge does **not** use batch file (`.cmd`) wrappers, PowerShell shims, or GUI main-entrypoint routing.

```
Command: <install-dir>\AgentForge.exe
Args:    ["<install-dir>\\resources\\app.asar\\dist-electron\\mcp\\stdio.js"]
Env:
  ELECTRON_RUN_AS_NODE: "1"
  AGENTFORGE_MCP_DB_PATH: "<absolute-database-path>"
  AGENTFORGE_MCP_SESSION_TOKEN: "<OPERATOR_SESSION_TOKEN_REQUIRED>"
```

### Developer Launch Model
```
Command: C:\Program Files\nodejs\node.exe
Args:    ["d:\\Projects\\Agent-Forge\\dist-electron\\mcp\\stdio.js"]
Env:
  AGENTFORGE_MCP_DB_PATH: "d:\\Projects\\Agent-Forge\\database\\agent-forge.db"
  AGENTFORGE_MCP_SESSION_TOKEN: "<OPERATOR_SESSION_TOKEN_REQUIRED>"
```

---

## 3. Generating Client Configurations

The CLI tool `sessionAdmin.js configure-client` generates deterministic configuration templates without opening SQLite, modifying the schema, or issuing credentials.

### Syntax
```powershell
# Developer checkout
node dist-electron/mcp/sessionAdmin.js configure-client --client <antigravity|cursor|claude> [--db <absolute-path>] [--json]

# Packaged / Installed executable
$env:ELECTRON_RUN_AS_NODE = "1"
& "C:\Path\To\AgentForge.exe" "C:\Path\To\resources\app.asar\dist-electron\mcp\sessionAdmin.js" configure-client --client cursor --json
$env:ELECTRON_RUN_AS_NODE = $null
```

### Flags
- `--client <name>` (**Required**): One of `antigravity`, `cursor`, or `claude` (case-insensitive).
- `--db <absolute-path>` (**Optional**): Absolute path to the SQLite database. If omitted, derives the platform default (`%APPDATA%\AgentForge\database\agent-forge.db` on Windows) without opening it.
- `--json` (**Optional**): Emits a canonical envelope object instead of the raw configuration template.

### Example Outputs

#### Raw Configuration (`--client antigravity`)
```json
{
  "mcpServers": {
    "agentforge": {
      "command": "C:\\Program Files\\AgentForge\\AgentForge.exe",
      "args": [
        "C:\\Program Files\\AgentForge\\resources\\app.asar\\dist-electron\\mcp\\stdio.js"
      ],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "AGENTFORGE_MCP_DB_PATH": "C:\\Users\\Operator\\AppData\\Roaming\\AgentForge\\database\\agent-forge.db",
        "AGENTFORGE_MCP_SESSION_TOKEN": "<OPERATOR_SESSION_TOKEN_REQUIRED>"
      }
    }
  }
}
```

#### Envelope Output (`--client cursor --json`)
```json
{
  "status": "TEMPLATE_GENERATED",
  "client": "cursor",
  "incomplete": true,
  "secret_delivery": "MANUAL_OPERATOR_INPUT",
  "config": {
    "mcpServers": {
      "agentforge": {
        "command": "C:\\Program Files\\AgentForge\\AgentForge.exe",
        "args": [
          "C:\\Program Files\\AgentForge\\resources\\app.asar\\dist-electron\\mcp\\stdio.js"
        ],
        "env": {
          "ELECTRON_RUN_AS_NODE": "1",
          "AGENTFORGE_MCP_DB_PATH": "C:\\Users\\Operator\\AppData\\Roaming\\AgentForge\\database\\agent-forge.db",
          "AGENTFORGE_MCP_SESSION_TOKEN": "<OPERATOR_SESSION_TOKEN_REQUIRED>"
        }
      }
    }
  }
}
```

---

## 4. Client Settings Locations & Guidance

> [!IMPORTANT]
> The paths below are documented configuration locations for third-party tools. Client interoperability is proven via the standardized MCP SDK stdio protocol; proprietary GUI interoperability is categorized as **documented template only**.

### 1. Google Antigravity
- **Location**: Workspace root `.gemini/mcp_config.json` or user global `~/.gemini/config/mcp_config.json`.
- **Reference**: [Antigravity MCP Documentation](https://antigravity.google/docs/mcp/)
- Merge the `mcpServers.agentforge` block into your existing `mcp_config.json`.

### 2. Cursor
- **Location**: Cursor Settings > Features > MCP, or `.cursor/mcp.json` in workspace root.
- **Reference**: [Cursor MCP Documentation](https://cursor.com/docs/mcp)
- Add the server configuration under `mcpServers.agentforge`.

### 3. Claude Desktop
- **Location**: `%APPDATA%\Claude\claude_desktop_config.json`.
- **Reference**: [Claude MCP Documentation](https://code.claude.com/docs/en/mcp)
- Merge the server configuration under the top-level `mcpServers` property.

---

## 5. Session Issuance, Insertion & Rotation Sequence

The client bridge enforces a strict separation of concerns: configuration generation does not handle secrets, and secret issuance does not modify client settings.

### Step 1: Generate Configuration Template
```powershell
node dist-electron/mcp/sessionAdmin.js configure-client --client cursor --db "C:\AgentForge\database\agent-forge.db" > cursor_snippet.json
```

### Step 2: Issue a Short-Lived Session Token
Run the session administration tool with the target authorization ID and a bounded time-to-live (TTL, e.g., 3600 seconds = 1 hour):
```powershell
node dist-electron/mcp/sessionAdmin.js issue --db "C:\AgentForge\database\agent-forge.db" --auth "auth-12345" --ttl 3600 --json
```
Output:
```json
{
  "status": "ISSUED",
  "session": {
    "id": "sess-67890",
    "authorization_id": "auth-12345",
    "scope": "AUTHORIZED_CONTEXT_READ",
    "issued_at": "2026-09-05T12:00:00.000Z",
    "expires_at": "2026-09-05T13:00:00.000Z"
  },
  "plaintext_token": "<OPERATOR_SESSION_TOKEN_REQUIRED>"
}
```

### Step 3: Insert Token into Local Client Settings
Replace the literal placeholder `<OPERATOR_SESSION_TOKEN_REQUIRED>` in your client configuration file with the issued `plaintext_token`:
```json
"AGENTFORGE_MCP_SESSION_TOKEN": "<OPERATOR_SESSION_TOKEN_REQUIRED>"
```

### Step 4: Verify Connection
Launch your client or trigger a tool discovery request. The client will discover:
- Tools: `agentforge_get_capabilities`, `agentforge_get_authorized_context`
- Resources: `agentforge://server/capabilities`, `agentforge://session/authorized-context`

### Step 5: Session Revocation & Rotation
When a task finishes, changes scope, or a session token is retired:
```powershell
# Revoke by session ID
node dist-electron/mcp/sessionAdmin.js revoke --db "C:\AgentForge\database\agent-forge.db" --session "sess-67890"

# Or revoke all active sessions for an authorization ID
node dist-electron/mcp/sessionAdmin.js revoke --db "C:\AgentForge\database\agent-forge.db" --auth "auth-12345"
```
Once revoked, all subsequent context read requests by that client immediately fail closed with `MCP_SESSION_UNAUTHORIZED`.

---

## 6. Security Contract & Plaintext Risk Notice

> [!CAUTION]
> **Plaintext Local-Settings Risk**: The MCP protocol requires the parent client process to pass environment variables to spawned child servers. As a result, the issued session token resides as plaintext in the client's local configuration file on disk.

Operators must observe the following immutable security rules:
1. **Short-Lived TTL**: Always issue tokens with the shortest practical TTL for the planned work.
2. **Access Controls**: Store configuration files only on local filesystems protected by operating system user access controls (ACLs / permissions).
3. **No Commits or Transmissions**: Never commit client configuration files containing session tokens to source control, paste tokens into chat logs or issue trackers, or attach them to work orders.
4. **Immediate Revocation**: Revoke sessions immediately if a token is suspected exposed, shared, or when task assignment changes.
5. **No Secret Backdoors**: AgentForge implements no unauthenticated backdoor, environment substitution fallback, or automatic client-file mutation.

---

## 7. Support Classifications

| Capability | Status | Verification Method |
| :--- | :--- | :--- |
| **Client Template Generation** | Implemented | Pure deterministic unit & CLI suite |
| **Standardized MCP SDK stdio** | Automated | Automated end-to-end integration suite |
| **Unpacked Package Runtime** | Automated | Required Windows CI gate (`smoke-packaged-win.ps1`); verified upon Package Windows job success |
| **NSIS-Installed Package Runtime** | Automated | Required Windows CI gate (`smoke-installed-production-win.ps1`); verified upon Package Windows job success |
| **Proprietary Client GUI Interop** | Documented Template Only | Pinned SDK process contract verified; third-party GUI desktop integration is documented template guidance |

---

## 8. Troubleshooting

### 1. Missing Executable or Stdio Script
- **Symptom**: CLI exits with `ERROR: [MCP_CONFIGURATION_INVALID] Invalid configuration or CLI arguments`.
- **Cause**: The application was moved, or `npm run build` has not been executed in developer mode.
- **Remedy**: Verify that the executable path exists and points to `AgentForge.exe` or `node.exe`. In dev mode, run `npm run build` to compile TypeScript to `dist-electron`.

### 2. Relative Database Path Rejected
- **Symptom**: CLI exits with `ERROR: [MCP_CONFIGURATION_INVALID] Invalid configuration or CLI arguments`.
- **Cause**: A relative path (e.g. `./agent-forge.db`) was passed to `--db`.
- **Remedy**: Pass a fully-qualified absolute path (e.g., `D:\Projects\Agent-Forge\database\agent-forge.db`).

### 3. Session Unauthorized (`MCP_SESSION_UNAUTHORIZED`)
- **Symptom**: Client tool call fails with `MCP_SESSION_UNAUTHORIZED: Session authentication failed`.
- **Cause**: Token is missing, malformed, expired, revoked, or bound to a different authorization graph.
- **Remedy**: Re-issue a session token using `sessionAdmin.js issue` and verify task authorization state.

### 4. Module Resolution vs. Native Addon Incompatibility
- **Symptom A (`MODULE_NOT_FOUND`)**: Child process reports `Error: Cannot find module 'better-sqlite3'`.
  - **Cause**: The execution environment cannot locate the module because package-scoped resolution was bypassed or files are missing from `resources/app.asar`.
  - **Remedy**: External clients must launch the packaged `AgentForge.exe` pointing directly to `<package-root>\resources\app.asar\dist-electron\mcp\stdio.js`.
- **Symptom B (`NODE_MODULE_VERSION` mismatch)**: Child process reports `The module 'better_sqlite3.node' was compiled against a different Node.js version`.
  - **Cause**: The MCP stdio server was launched with an incompatible host Node runtime instead of the packaged runtime matching the compiled binary ABI.
  - **Remedy**: For packaged/installed tiers, always use `AgentForge.exe` with `ELECTRON_RUN_AS_NODE=1`. For developer checkouts, ensure native dependencies are compiled for host Node via `npm rebuild better-sqlite3`. (Note: Packaged and installed distributions contain pre-compiled native bindings and must never be rebuilt by an operator).

### 5. Protocol Contamination
- **Symptom**: Client reports JSON-RPC parsing error on initialization or tool calls.
- **Cause**: Spurious stdout output (such as `console.log` or shell echo) written to the stdout stream.
- **Remedy**: AgentForge MCP stdio server reserves stdout strictly for JSON-RPC messages. All diagnostics and logs are scrubbed and emitted strictly to stderr.

### 6. Database Lock / Cleanup Failure
- **Symptom**: File is locked after client shutdown.
- **Cause**: Child process did not receive clean EOF or SIGINT/SIGTERM.
- **Remedy**: Terminate lingering child processes. AgentForge stdio server performs clean SQLite close upon EOF (`stdin.end()`) or `SIGINT`/`SIGTERM`.
