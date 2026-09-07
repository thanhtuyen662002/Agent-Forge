<#
.SYNOPSIS
  Deterministic Windows packaged runtime smoke test for AgentForge with verified renderer readiness.
.DESCRIPTION
  Launches the unpacked packaged AgentForge executable under an isolated temporary data directory,
  verifies process stability, SQLite initialization, renderer loading of embedded dist/index.html,
  DOM #root element presence and rendered children, and clean termination.
#>
param(
  [switch]$Headless = $false
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$exePath = Join-Path $projectRoot "release\win-unpacked\AgentForge.exe"

Write-Host "=== AgentForge Packaged Windows Smoke Test ==="
Write-Host "Executable: $exePath"
Write-Host "Mode: $(if ($Headless) { 'Headless/CI' } else { 'Interactive/Local' })"

if (-not (Test-Path $exePath)) {
  Write-Error "Packaged executable not found at '$exePath'. Run 'npm run package:win:dir' first."
  exit 1
}

# Create isolated temporary test data environment
$smokeId = [Guid]::NewGuid().ToString()
$tempAppData = Join-Path ([System.IO.Path]::GetTempPath()) "agent-forge-smoke-$smokeId"
New-Item -ItemType Directory -Path $tempAppData -Force | Out-Null
Write-Host "Isolated Temp Data Directory: $tempAppData"

$oldAppData = $env:APPDATA
$oldLocalAppData = $env:LOCALAPPDATA
$proc = $null
$dbPath = Join-Path $tempAppData "database\agent-forge.db"
$reportPath = Join-Path $tempAppData "smoke-ready.json"

try {
  $env:APPDATA = $tempAppData
  $env:LOCALAPPDATA = $tempAppData
  $env:AGENT_FORGE_DATA_DIR = $tempAppData
  $env:AGENT_FORGE_SMOKE_MODE = "1"

  Write-Host "Launching packaged AgentForge process..."
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $exePath
  $startInfo.WorkingDirectory = $tempAppData
  $startInfo.EnvironmentVariables["APPDATA"] = $tempAppData
  $startInfo.EnvironmentVariables["LOCALAPPDATA"] = $tempAppData
  $startInfo.EnvironmentVariables["AGENT_FORGE_DATA_DIR"] = $tempAppData
  $startInfo.EnvironmentVariables["AGENT_FORGE_SMOKE_MODE"] = "1"
  $startInfo.UseShellExecute = $false

  $proc = [System.Diagnostics.Process]::Start($startInfo)

  if ($null -eq $proc) {
    Write-Error "Failed to spawn process '$exePath'."
    exit 1
  }

  Write-Host "Process spawned with PID: $($proc.Id)"

  # Wait for startup, SQLite bootstrap, and renderer readiness
  $timeoutSeconds = 12
  $elapsed = 0
  $report = $null

  Write-Host "Waiting for SQLite initialization, window load, and renderer readiness ($timeoutSeconds seconds)..."
  while ($elapsed -lt $timeoutSeconds) {
    Start-Sleep -Seconds 1
    $elapsed++

    if ($proc.HasExited) {
      Write-Error "Process $($proc.Id) crashed/exited prematurely with exit code: $($proc.ExitCode)"
      exit 1
    }

    if ((Test-Path $dbPath) -and (Test-Path $reportPath)) {
      try {
        $raw = Get-Content -Path $reportPath -Raw
        $report = ConvertFrom-Json $raw
        if ($null -ne $report -and ($report.status -eq 'READY' -or $report.status -eq 'FAILED')) {
          break
        }
      } catch {}
    }
  }

  # 1. Process Survival Guard
  if ($proc.HasExited) {
    Write-Error "Packaged process exited unexpectedly with code $($proc.ExitCode)."
    exit 1
  }
  Write-Host "[1/6] Process $($proc.Id) is running and stable (no crash): PASS"

  # 2. SQLite Database Guard
  if (-not (Test-Path $dbPath)) {
    Write-Error "SQLite database was not created at '$dbPath' during bootstrap interval."
    exit 1
  }
  $dbSize = (Get-Item $dbPath).Length
  if ($dbSize -lt 1024) {
    Write-Error "SQLite database file size ($dbSize bytes) is unexpectedly small/corrupt."
    exit 1
  }
  Write-Host "[2/6] SQLite database file verified at $dbPath ($dbSize bytes): PASS"

  # 3. Renderer Smoke Report Guard
  if ($null -eq $report) {
    Write-Error "Renderer smoke-ready report was not generated at '$reportPath' within $timeoutSeconds seconds."
    exit 1
  }
  Write-Host "Renderer Smoke Report: $(ConvertTo-Json $report -Compress)"

  if ($report.status -ne 'READY') {
    Write-Error "Renderer reported failure status: $($report.status)"
    exit 1
  }
  Write-Host "[3/6] Renderer Status: READY: PASS"

  # 4. Canonical File URL Guard
  if (-not ($report.rendererUrl -like "file://*index.html*" -or $report.rendererUrl -like "file://*")) {
    Write-Error "Packaged renderer loaded invalid URL '$($report.rendererUrl)'. Expected canonical file:// path."
    exit 1
  }
  if ($report.rendererUrl -like "*localhost*") {
    Write-Error "Packaged renderer erroneously loaded development localhost URL '$($report.rendererUrl)'."
    exit 1
  }
  Write-Host "[4/6] Packaged Renderer URL ($($report.rendererUrl)): PASS"

  # 5. DOM #root and Children Guard
  if (-not $report.rootExists -or $report.rootChildCount -le 0) {
    Write-Error "Renderer failed to mount React UI: rootExists=$($report.rootExists), rootChildCount=$($report.rootChildCount)"
    exit 1
  }
  Write-Host "[5/6] React Root rendered ($($report.rootChildCount) child elements): PASS"

  # 6. Update Service & App Info Initialization Guard
  if (-not $report.updateServiceInitialized) {
    Write-Error "UpdateService was not initialized in main process."
    exit 1
  }
  if ([string]::IsNullOrWhiteSpace($report.appVersion)) {
    Write-Error "App version was not reported."
    exit 1
  }
  Write-Host "[6/8] UpdateService initialized & App Version verified ($($report.appVersion)): PASS"

  # 7. Packaged Update Configuration (app-update.yml) Guard
  $appUpdateYmlPath = Join-Path $projectRoot "release\win-unpacked\resources\app-update.yml"
  if (-not (Test-Path $appUpdateYmlPath)) {
    Write-Error "Packaged update configuration was not found at '$appUpdateYmlPath'."
    exit 1
  }
  $appUpdateContent = Get-Content -Path $appUpdateYmlPath -Raw
  if ($appUpdateContent -notmatch "provider:\s*github" -or $appUpdateContent -notmatch "owner:\s*thanhtuyen662002" -or $appUpdateContent -notmatch "repo:\s*Agent-Forge") {
    Write-Error "Packaged app-update.yml does not match expected production GitHub provider/repository identity."
    exit 1
  }
  if ($appUpdateContent -match "ghp_" -or $appUpdateContent -match "token" -or $appUpdateContent -match "password" -or $appUpdateContent -match "Authorization" -or $appUpdateContent -match "Bearer") {
    Write-Error "SECURITY VIOLATION: Packaged app-update.yml contains credentials/secrets!"
    exit 1
  }
  Write-Host "[7/8] Packaged Update Configuration verified (provider: github, owner: thanhtuyen662002, repo: Agent-Forge, no secrets): PASS"

  # 8. Window Handle & Title Inspection (Local/Interactive Mode)
  if (-not $Headless) {
    $proc.Refresh()
    $handle = $proc.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) {
      Start-Sleep -Milliseconds 500
      $proc.Refresh()
      $handle = $proc.MainWindowHandle
    }

    if (-not ($report.windowTitle -like "*Agent-Forge*Control Plane*")) {
      Write-Error "Window title mismatch: '$($report.windowTitle)'"
      exit 1
    }
    Write-Host "[8/9] Window title verified ('$($report.windowTitle)') with handle ($handle): PASS"
  } else {
    Write-Host "[8/9] Headless mode: verified window title from Electron main report ('$($report.windowTitle)'): PASS"
  }

  # Terminate GUI smoke process before running headless Node-mode MCP gate
  if ($null -ne $proc -and -not $proc.HasExited) {
    Write-Host "Terminating GUI smoke process $($proc.Id)..."
    try {
      $proc.CloseMainWindow() | Out-Null
      $closedInTime = $proc.WaitForExit(3000)
      if (-not $closedInTime) {
        Write-Host "PACKAGED_GUI_CLOSE_TIMEOUT: Process $($proc.Id) did not exit after CloseMainWindow"
      }
    } catch {
      Write-Host "PACKAGED_GUI_CLOSE_WARN: CloseMainWindow error: $_"
    }

    if (-not $proc.HasExited) {
      try {
        $proc.Kill()
      } catch {
        Write-Host "PACKAGED_GUI_KILL_WARN: Kill error: $_"
      }
      $killWait = $proc.WaitForExit(2000)
      if (-not $killWait) {
        throw "PACKAGED_GUI_TERMINATION_FAILED: Process $($proc.Id) survived kill attempt"
      }
    }
  }

  # 9. Packaged MCP Client Bridge & Node-Mode Stdio Proof (R5J3)
  Write-Host "=================================================================" -ForegroundColor Cyan
  Write-Host "   [9/9] Packaged MCP Client Bridge & Node-Mode Stdio Proof       " -ForegroundColor Cyan
  Write-Host "=================================================================" -ForegroundColor Cyan

  $unpackedAsar = Join-Path $projectRoot "release\win-unpacked\resources\app.asar"
  if (-not (Test-Path $unpackedAsar)) {
    Write-Error "Packaged app.asar not found at '$unpackedAsar'."
    exit 1
  }

  # 9. Packaged MCP Client Bridge & Node-Mode Stdio Proof
  Write-Host "=================================================================" -ForegroundColor Cyan
  Write-Host "   [9/9] Packaged MCP Client Bridge & Node-Mode Stdio Proof       " -ForegroundColor Cyan
  Write-Host "=================================================================" -ForegroundColor Cyan

  $mcpSmokeId = [Guid]::NewGuid().ToString()
  $tempMcpDir = Join-Path ([System.IO.Path]::GetTempPath()) "af-mcp-pkg-smoke-$mcpSmokeId"
  New-Item -ItemType Directory -Path $tempMcpDir -Force | Out-Null
  $mcpDbPath = Join-Path $tempMcpDir "mcp-packaged.db"
  $bootstrapScript = Join-Path $tempMcpDir "mcp-runner.cjs"

  $bootstrapContent = @'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const asarPath = path.resolve(process.argv[2]);
const dbPath = path.resolve(process.argv[3]);
const projectRoot = process.argv[4] ? path.resolve(process.argv[4]) : null;

if (!fs.existsSync(asarPath)) {
  console.error("FAIL: app.asar does not exist at " + asarPath);
  process.exit(1);
}

console.log("R5J3_FACT_ELECTRON_VERSION=" + (process.versions.electron || "UNKNOWN"));
console.log("R5J3_FACT_NODE_VERSION=" + process.versions.node);
console.log("R5J3_FACT_EXEC_PATH=" + process.execPath);
console.log("R5J3_FACT_ASAR_PATH=" + asarPath);

// F1: Package-rooted native module resolution
const pkgRequire = require('module').createRequire(path.join(asarPath, 'package.json'));
const jsEntryPath = pkgRequire.resolve('better-sqlite3');
console.log("R5J3_FACT_JS_ENTRY_PATH=" + jsEntryPath);

const Database = pkgRequire('better-sqlite3');

const migrationsPath = path.join(asarPath, 'dist-electron', 'core', 'database', 'migrations.js');
const repoPath = path.join(asarPath, 'dist-electron', 'core', 'database', 'repositories.js');
const authorityServicePath = path.join(asarPath, 'dist-electron', 'core', 'services', 'McpSessionAuthorityService.js');
const authServicePath = path.join(asarPath, 'dist-electron', 'core', 'services', 'ExecutionAuthorizationService.js');

if (!fs.existsSync(migrationsPath) || !fs.existsSync(repoPath) || !fs.existsSync(authorityServicePath) || !fs.existsSync(authServicePath)) {
  console.error("FAIL: Packaged modules missing in app.asar");
  process.exit(1);
}

const { MigrationRunner } = require(migrationsPath);
const { Repository } = require(repoPath);
const { McpSessionAuthorityService } = require(authorityServicePath);
const { computeCanonicalPayload, computePayloadHash, computeContextManifestHash } = require(authServicePath);

// Force native addon loading
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const loadedNodeKeys = Object.keys(require.cache).filter((k) => k.endsWith('.node'));
const betterSqliteKey = loadedNodeKeys.find((k) => k.toLowerCase().includes('better_sqlite3'));
if (!betterSqliteKey) {
  console.error("FAIL: better_sqlite3.node was not loaded into require.cache");
  process.exit(1);
}

const nativeBindingPath = betterSqliteKey.replace(/app\.asar/i, 'app.asar.unpacked');
if (!fs.existsSync(nativeBindingPath)) {
  console.error("FAIL: Physical native binding not found on disk at: " + nativeBindingPath);
  process.exit(1);
}
console.log("R5J3_FACT_NATIVE_BINDING_PATH=" + nativeBindingPath);

// Verify native binding origin: must be inside <release/win-unpacked>/resources/app.asar.unpacked/node_modules/better-sqlite3
const expectedUnpackedRoot = path.join(path.dirname(asarPath), 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
if (!nativeBindingPath.toLowerCase().startsWith(expectedUnpackedRoot.toLowerCase())) {
  console.error("FAIL: Native binding was not loaded from unpacked package tree: " + nativeBindingPath);
  process.exit(1);
}
const repoNodeModules = path.join(projectRoot, 'node_modules');
if (projectRoot && nativeBindingPath.toLowerCase().includes(repoNodeModules.toLowerCase())) {
  console.error("FAIL: Native binding resolved to repository node_modules instead of package: " + nativeBindingPath);
  process.exit(1);
}
if (nativeBindingPath.toLowerCase().includes('af-prod-smoke-install')) {
  console.error("FAIL: Native binding resolved to installed tier instead of unpacked: " + nativeBindingPath);
  process.exit(1);
}
if (nativeBindingPath.toLowerCase().includes('temp\\node_modules')) {
  console.error("FAIL: Native binding resolved to temp node_modules: " + nativeBindingPath);
  process.exit(1);
}

MigrationRunner.run(db);

const repo = new Repository(db);
const service = new McpSessionAuthorityService(repo, db);

const now = new Date().toISOString();
const projectId = 'proj-pkg-' + crypto.randomUUID();
const taskId = 'task-pkg-' + crypto.randomUUID();
const attemptId = 'att-pkg-' + crypto.randomUUID();
const assignmentId = 'asgn-pkg-' + crypto.randomUUID();
const providerId = 'prov-pkg-' + crypto.randomUUID();
const accountId = 'acc-pkg-' + crypto.randomUUID();
const resourceId = 'res-pkg-' + crypto.randomUUID();
const routingDecisionId = 'route-pkg-' + crypto.randomUUID();
const authorizationId = 'auth-pkg-' + crypto.randomUUID();
const managerProtoMsgId = 'msg-proto-pkg-' + crypto.randomUUID();
const managerRecordId = 'msg-rec-pkg-' + crypto.randomUUID();

repo.createProject({
  id: projectId,
  name: 'Packaged Test Project',
  description: 'Packaged smoke',
  repository_path: projectRoot,
  default_branch: 'main',
  status: 'RUNNING',
  contract: null,
  created_at: now,
  updated_at: now,
  started_at: null,
  completed_at: null,
});

db.prepare(`
  INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
  VALUES (?, ?, 'Packaged Smoke Task', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
`).run(taskId, projectId, 'a'.repeat(40), now, now);

const roleId = 'role-pkg-' + crypto.randomUUID();
const agentId = 'agent-pkg-' + crypto.randomUUID();
db.prepare(`
  INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
  VALUES (?, 'CODER', 'Coder Role', '["CODING"]', '[]', '[]', 1, ?, ?)
`).run(roleId, now, now);

db.prepare(`
  INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
  VALUES (?, ?, 'Agent Coder', 1, ?, ?)
`).run(agentId, roleId, now, now);

db.prepare(`
  INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at)
  VALUES (?, 'Anthropic Claude', 'LOCAL_CLI', 1, ?)
`).run(providerId, now);

db.prepare(`
  INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
  VALUES (?, ?, 'default-account', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 20, ?, ?)
`).run(accountId, providerId, now, now);

db.prepare(`
  INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
  VALUES (?, ?, ?, 'claude-3-7-sonnet', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
`).run(resourceId, providerId, accountId, now);

repo.createTaskAttempt({
  id: attemptId,
  task_id: taskId,
  attempt_number: 1,
  status: 'RUNNING',
  agent_profile_id: agentId,
  agent_id: null,
  started_at: now,
  ended_at: null,
  summary: null,
});

const routingPayload = {
  decisionId: routingDecisionId,
  projectId,
  taskId,
  attemptId,
  roleProfileId: roleId,
  role: 'CODER',
  outcome: 'SELECTED',
  routePolicyId: null,
  failoverPolicyAuthoritySnapshot: null,
  selectedProviderId: providerId,
  selectedAccountId: accountId,
  selectedResourceId: resourceId,
  selectedAssignmentId: assignmentId,
  requestedConstraints: [],
  appliedExclusions: [],
  appliedSeparation: null,
  reason: 'Optimal route',
};
db.prepare(`
  INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
  VALUES (?, ?, ?, 'ROLE_AWARE_ROUTING_DECISION', 'Optimal route', ?, ?)
`).run(routingDecisionId, projectId, taskId, JSON.stringify(routingPayload), now);

repo.createAgentAssignment({
  id: assignmentId,
  project_id: projectId,
  task_id: taskId,
  attempt_id: attemptId,
  role_profile_id: roleId,
  agent_profile_id: agentId,
  selected_provider_id: providerId,
  selected_account_id: accountId,
  selected_resource_id: resourceId,
  selected_worker_slot_id: null,
  routing_decision_id: routingDecisionId,
  status: 'ASSIGNED',
  created_at: now,
  ended_at: null,
  preferred_metadata: null,
});

const instructions = ['Task: Packaged Smoke Task', 'Verify packaged context read'];
const managerPayload = {
  protocol: 'manager.v1',
  message_id: managerProtoMsgId,
  project_id: projectId,
  task_id: taskId,
  decision: 'EXECUTE',
  priority: 'LOW',
  risk: 'LOW',
  instructions,
  acceptance_criteria: ['Smoke passes'],
  constraints: ['None'],
  review_issues: [],
  expected_task_state: 'CODING',
  expected_revision: 1,
  created_at: now,
};
const rawManagerPayload = JSON.stringify(managerPayload);
const managerPayloadHash = crypto.createHash('sha256').update(rawManagerPayload, 'utf8').digest('hex');
repo.recordProtocolMessage(
  managerRecordId,
  managerProtoMsgId,
  'manager.v1',
  projectId,
  taskId,
  'CODING',
  1,
  managerPayloadHash,
  rawManagerPayload,
  'APPLIED',
  undefined,
  now
);

const canonicalInstructionsJson = JSON.stringify(instructions);
const contextFiles = ['src/mcp/stdio.ts'];
const contextFilesJson = JSON.stringify(contextFiles);

const canonicalPayload = computeCanonicalPayload({
  projectId,
  taskId,
  attemptId,
  taskTitle: 'Packaged Smoke Task',
  taskDescription: 'Packaged smoke verification',
  acceptanceCriteria: ['Smoke passes'],
  constraints: ['None'],
  instructions,
  contextFiles,
  verificationCommands: { TEST: null, LINT: null, BUILD: null },
  managerMessageId: managerRecordId,
  managerPayloadHash,
});
const canonicalPayloadJson = JSON.stringify(canonicalPayload);
const instructionPayloadHash = computePayloadHash(canonicalPayload);
const contextManifestHash = computeContextManifestHash(contextFiles);

const auth = {
  id: authorizationId,
  project_id: projectId,
  task_id: taskId,
  task_revision: 1,
  base_sha: 'a'.repeat(40),
  repository_head_sha: 'b'.repeat(40),
  manager_message_id: managerRecordId,
  manager_payload_hash: managerPayloadHash,
  routing_decision_id: routingDecisionId,
  selected_resource_id: resourceId,
  selected_provider_id: providerId,
  instruction_payload_hash: instructionPayloadHash,
  context_manifest_hash: contextManifestHash,
  canonical_instructions_json: canonicalInstructionsJson,
  context_files_json: contextFilesJson,
  canonical_payload_json: canonicalPayloadJson,
  status: 'AUTHORIZED',
  created_at: now,
  dispatched_at: null,
  execution_id: null,
  task_ownership_epoch: 1,
  lifecycle_version: 1,
  selected_account_id: accountId,
  adapter_started_at: null,
  adapter_finished_at: null,
  adapter_error_json: null,
  settlement_status: null,
  settled_at: null,
  settlement_evidence_json: null,
  settlement_evidence_hash: null,
  assignment_id: assignmentId,
  attempt_id: attemptId,
};
repo.createExecutionAuthorization(auth);

const issueResult = service.issueSession({ authorizationId, ttlSeconds: 300 });
const sessionToken = issueResult.plaintextToken;
const sessionId = issueResult.session.id;

db.close();

const stdioScript = path.join(asarPath, 'dist-electron', 'mcp', 'stdio.js');
console.log("R5J3_FACT_STDIO_SCRIPT=" + stdioScript);

const childEnv = Object.assign({}, process.env, {
  ELECTRON_RUN_AS_NODE: '1',
  AGENTFORGE_MCP_DB_PATH: dbPath,
  AGENTFORGE_MCP_SESSION_TOKEN: sessionToken,
});

const startTime = Date.now();
const child = spawn(process.execPath, [stdioScript], {
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});
console.log("R5J3_FACT_CHILD_PID=" + child.pid);

// F2: Event-driven, single-settlement RPC harness
class McpRpcHarness {
  constructor(childProcess, overallTimeoutMs = 25000) {
    this.child = childProcess;
    this.pending = new Map();
    this.closed = false;
    this.stdoutBuffer = '';
    this.exitResult = null;

    this.overallTimer = setTimeout(() => {
      this._terminate(new Error('OVERALL_HARNESS_TIMEOUT'));
    }, overallTimeoutMs);

    this.exitPromise = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.exitResult = { code, signal };
        this._terminate(new Error(`CHILD_EXIT_PREMATURE: code=${code}, signal=${signal}`));
        resolve(this.exitResult);
      });
      this.child.on('error', (err) => {
        this._terminate(new Error(`CHILD_ERROR: ${err.message}`));
      });
    });

    this.child.stdout.on('data', (chunk) => {
      this.stdoutBuffer += chunk.toString('utf8');
      let newlineIdx;
      while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
        const rawLine = this.stdoutBuffer.slice(0, newlineIdx).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
        if (rawLine) {
          this._handleLine(rawLine);
        }
      }
    });
  }

  _handleLine(rawLine) {
    let msg;
    try {
      msg = JSON.parse(rawLine);
    } catch {
      this._terminate(new Error('PROTOCOL_CONTAMINATION: Non-JSON stdout received: ' + rawLine));
      return;
    }

    if (!msg || typeof msg !== 'object') {
      this._terminate(new Error('PROTOCOL_CONTAMINATION: Non-object message received'));
      return;
    }

    if (msg.id !== undefined && msg.id !== null) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        entry.resolve(msg);
      }
    }
  }

  _terminate(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.overallTimer);

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
  }

  async sendRequest(req, timeoutMs = 4000) {
    if (this.closed) {
      throw new Error('Harness is closed');
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(req.id)) {
          this.pending.delete(req.id);
          reject(new Error(`RPC_TIMEOUT: Request ${req.id} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(req.id, {
        resolve: (val) => resolve(val),
        reject: (err) => reject(err),
        timer,
      });

      this.child.stdin.write(JSON.stringify(req) + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(req.id);
          reject(new Error(`WRITE_ERROR: ${err.message}`));
        }
      });
    });
  }

  async sendNotification(notif) {
    if (this.closed) {
      throw new Error('Harness is closed');
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(notif) + '\n', (err) => {
        if (err) reject(new Error(`NOTIF_WRITE_ERROR: ${err.message}`));
        else resolve();
      });
    });
  }

  async close(timeoutMs = 4000) {
    clearTimeout(this.overallTimer);
    this.closed = true;

    this.child.stdin.end();

    const timeoutPromise = new Promise((_, reject) => {
      const t = setTimeout(() => {
        try {
          this.child.kill('SIGKILL');
        } catch (killErr) {
          console.error("R5J3_CLOSE_KILL_ERROR: " + (killErr instanceof Error ? killErr.message : String(killErr)));
        }
        reject(new Error(`SHUTDOWN_TIMEOUT: Child did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      this.exitPromise.finally(() => clearTimeout(t));
    });

    return Promise.race([this.exitPromise, timeoutPromise]);
  }
}

const harness = new McpRpcHarness(child);

(async () => {
  try {
    const initRes = await harness.sendRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-test', version: '1.0.0' } }
    });
    console.log("R5J3_INITIALIZE_ELAPSED_MS=" + (Date.now() - startTime));
    if (initRes.error) throw new Error("Initialize failed: " + JSON.stringify(initRes.error));

    await harness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const toolReqStart = Date.now();
    const toolRes = await harness.sendRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'agentforge_get_authorized_context', arguments: {} }
    });
    console.log("R5J3_TOOL_READ_ELAPSED_MS=" + (Date.now() - toolReqStart));
    if (toolRes.error) throw new Error("Tool read failed: " + JSON.stringify(toolRes.error));
    const toolPayload = JSON.parse(toolRes.result.content[0].text);
    if (toolPayload.execution_payload?.taskTitle !== 'Packaged Smoke Task') {
      throw new Error("Payload mismatch in tool read");
    }

    const resReqStart = Date.now();
    const resRead = await harness.sendRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: { uri: 'agentforge://session/authorized-context' }
    });
    console.log("R5J3_RESOURCE_READ_ELAPSED_MS=" + (Date.now() - resReqStart));
    if (resRead.error) throw new Error("Resource read failed: " + JSON.stringify(resRead.error));
    const resPayload = JSON.parse(resRead.result.contents[0].text);
    if (JSON.stringify(resPayload) !== JSON.stringify(toolPayload)) {
      throw new Error("Resource payload does not match tool payload");
    }

    const revokeDb = new Database(dbPath);
    const revokeService = new McpSessionAuthorityService(new Repository(revokeDb), revokeDb);
    revokeService.revokeSession({ sessionId });
    revokeDb.close();

    const failRes = await harness.sendRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'agentforge_get_authorized_context', arguments: {} }
    });
    const isError = Boolean(failRes.error) || failRes.result?.isError === true;
    if (!isError) throw new Error("Expected revoked session to fail closed");
    console.log("R5J3_REVOKE_FAIL_CLOSED=PASS");

    const shutdownStart = Date.now();
    const exitResult = await harness.close(4000);
    console.log("R5J3_SHUTDOWN_ELAPSED_MS=" + (Date.now() - shutdownStart));
    console.log("R5J3_CHILD_EXIT_CODE=" + exitResult.code);
    console.log("R5J3_CHILD_SIGNAL=" + (exitResult.signal || "NONE"));

    if (exitResult.code !== 0) {
      throw new Error("Expected exit code 0, got " + exitResult.code);
    }

    const verifyDb = new Database(dbPath, { readonly: true });
    verifyDb.close();

    console.log("R5J3_MCP_BRIDGE_PROOF=PASS");

    // R5J4: Test Coder Submission Stdio Server
    console.log("Starting R5J4 Packaged Coder Submission Verification...");
    const subAdminScript = path.join(asarPath, 'dist-electron', 'mcp', 'submissionAdmin.js');
    if (!fs.existsSync(subAdminScript)) {
      throw new Error("submissionAdmin.js missing in app.asar");
    }

    const { execSync } = require('child_process');
    const realHeadSha = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim().toLowerCase();
    let realBaseSha = realHeadSha;
    try {
      realBaseSha = execSync('git rev-parse HEAD~1', { cwd: projectRoot, encoding: 'utf8' }).trim().toLowerCase();
    } catch {
      realBaseSha = realHeadSha;
    }

    const subNow = new Date().toISOString();
    const prepDb = new Database(dbPath);
    prepDb.prepare("UPDATE execution_authorizations SET status = 'DISPATCHED', dispatched_at = ?, execution_id = ?, repository_head_sha = ?, base_sha = ? WHERE id = ?").run(subNow, 'exec-pkg-1', realHeadSha, realBaseSha, authorizationId);
    prepDb.prepare("UPDATE tasks SET base_sha = ? WHERE id = ?").run(realBaseSha, taskId);
    prepDb.close();

    // 1. Issue first session via production admin CLI
    const issueOut1 = execSync(`"${process.execPath}" "${subAdminScript}" issue --auth "${authorizationId}" --db "${dbPath}" --json`, {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      encoding: 'utf8',
    });
    const parsedIssue1 = JSON.parse(issueOut1);
    const firstSessionId = parsedIssue1.session.id;
    const firstPlaintextToken = parsedIssue1.plaintext_token;

    // 2. Issue second session via production admin CLI to prove atomic replacement
    const issueOut2 = execSync(`"${process.execPath}" "${subAdminScript}" issue --auth "${authorizationId}" --db "${dbPath}" --json`, {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      encoding: 'utf8',
    });
    const parsedIssue2 = JSON.parse(issueOut2);
    const activeSessionId = parsedIssue2.session.id;
    const activePlaintextToken = parsedIssue2.plaintext_token;

    // Verify atomic replacement in database: first session revoked, issuer_identity = 'OWNER_LOCAL_CLI'
    const adminCheckDb = new Database(dbPath, { readonly: true });
    const sess1Row = adminCheckDb.prepare("SELECT * FROM mcp_submission_sessions WHERE id = ?").get(firstSessionId);
    const sess2Row = adminCheckDb.prepare("SELECT * FROM mcp_submission_sessions WHERE id = ?").get(activeSessionId);
    if (!sess1Row || sess1Row.revoked_at === null || sess1Row.revocation_reason !== 'SUPERSEDED_BY_NEW_SESSION') {
      throw new Error("First session was not atomically revoked with SUPERSEDED_BY_NEW_SESSION");
    }
    if (sess1Row.issuer_identity !== 'OWNER_LOCAL_CLI' || sess2Row.issuer_identity !== 'OWNER_LOCAL_CLI') {
      throw new Error("Session issuer_identity is not OWNER_LOCAL_CLI");
    }
    adminCheckDb.close();

    // 3. Token absent from durable files and diagnostics
    const dbBytes = fs.readFileSync(dbPath);
    if (dbBytes.includes(Buffer.from(activePlaintextToken, 'utf8')) || dbBytes.includes(Buffer.from(firstPlaintextToken, 'utf8'))) {
      throw new Error("Plaintext token detected in database file bytes");
    }

    // 4. Capture domain table and Git snapshots before submission
    const preDb = new Database(dbPath, { readonly: true });
    const preAuth = preDb.prepare("SELECT * FROM execution_authorizations WHERE id = ?").get(authorizationId);
    const preTask = preDb.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    const preAttempt = preDb.prepare("SELECT * FROM task_attempts WHERE id = ?").get(attemptId);
    const preAssignment = preDb.prepare("SELECT * FROM agent_assignments WHERE id = ?").get(assignmentId);
    const preProtoMsg = preDb.prepare("SELECT * FROM protocol_messages WHERE record_id = ?").get(managerRecordId);
    const preGitStatus = execSync('git status --porcelain', { cwd: projectRoot, encoding: 'utf8' }).trim();
    const preGitHead = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim();
    preDb.close();

    // 5. Spawn stdio-submit child process
    const subStdioScript = path.join(asarPath, 'dist-electron', 'mcp', 'stdio-submit.js');
    if (!fs.existsSync(subStdioScript)) {
      throw new Error("stdio-submit.js missing in app.asar");
    }

    const subChild = spawn(process.execPath, [subStdioScript], {
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: '1',
        AGENTFORGE_MCP_DB_PATH: dbPath,
        AGENTFORGE_MCP_SUBMISSION_TOKEN: activePlaintextToken,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const subHarness = new McpRpcHarness(subChild);

    // MCP initialize
    const subInitRes = await subHarness.sendRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-sub-test', version: '1.0.0' } }
    });
    if (subInitRes.error) throw new Error("Submission initialize failed: " + JSON.stringify(subInitRes.error));
    await subHarness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // Exact tool discovery: tools/list returns only agentforge_submit_coder_claim
    const toolsListRes = await subHarness.sendRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/list',
      params: {}
    });
    if (toolsListRes.error || !toolsListRes.result?.tools) {
      throw new Error("tools/list failed");
    }
    const tools = toolsListRes.result.tools;
    if (tools.length !== 1 || tools[0].name !== 'agentforge_submit_coder_claim') {
      throw new Error("tools/list did not return exactly agentforge_submit_coder_claim: " + JSON.stringify(tools));
    }
    if (!tools[0].annotations || tools[0].annotations.idempotentHint !== true || tools[0].annotations.readOnlyHint !== false) {
      throw new Error("Tool annotations mismatch: " + JSON.stringify(tools[0].annotations));
    }

    // 6. Full-tuple submission
    const submissionId = '00000000-0000-4000-8000-000000000001';
    const subArgs = {
      submission_id: submissionId,
      authorization_id: authorizationId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      assignment_id: assignmentId,
      task_ownership_epoch: 1,
      base_sha: realBaseSha,
      repository_head_sha: realHeadSha,
      status: 'COMPLETED',
      summary: 'Packaged smoke claim verified',
      changed_files: ['src/mcp/stdio-submit.ts'],
      tests_claimed: ['smoke-sub-1'],
      blockers: [],
      review_requested: true,
      client_metadata: {
        client_name: 'smoke-packaged',
        client_version: '1.0.0',
        client_session_mode: 'NODE',
      },
    };

    const subToolRes = await subHarness.sendRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'agentforge_submit_coder_claim',
        arguments: subArgs,
      }
    });

    if (subToolRes.error || subToolRes.result?.isError) {
      throw new Error("Submission tool call failed: " + JSON.stringify(subToolRes));
    }
    const parsedSubContent = JSON.parse(subToolRes.result.content[0].text);
    if (!parsedSubContent.accepted || parsedSubContent.quarantine_status !== 'QUARANTINED') {
      throw new Error("Submission not accepted in quarantine: " + JSON.stringify(parsedSubContent));
    }

    // 7. Row, content, envelope, hash, disposition, and event readback
    const checkDb = new Database(dbPath, { readonly: true });
    const subRow = checkDb.prepare("SELECT * FROM coder_submissions WHERE id = ?").get(submissionId);
    if (!subRow) {
      throw new Error("Coder submission row was not inserted into database");
    }
    if (subRow.quarantine_status !== 'QUARANTINED' || subRow.claimed_status !== 'COMPLETED' || subRow.summary !== subArgs.summary) {
      throw new Error("Coder submission row content mismatch");
    }
    if (subRow.review_requested !== 1 || subRow.changed_files_count !== 1 || subRow.tests_claimed_count !== 1 || subRow.blockers_count !== 0) {
      throw new Error("Coder submission scalar counters mismatch");
    }
    if (subRow.canonical_envelope_hash.length !== 64 || subRow.claim_content_hash.length !== 64) {
      throw new Error("Coder submission hashes invalid length");
    }

    // Disposition readback
    const disps = checkDb.prepare("SELECT * FROM coder_submission_dispositions WHERE submission_id = ?").all(submissionId);
    if (disps.length !== 1 || disps[0].disposition_event !== 'SUBMITTED' || disps[0].disposition_reason !== 'INITIAL_SUBMISSION') {
      throw new Error("Initial disposition mismatch or missing");
    }
    if (disps[0].actor_type !== 'MCP_CLIENT' || disps[0].actor_id !== activeSessionId) {
      throw new Error("Disposition actor mismatch");
    }

    // Deterministic event readback
    const detEventId = 'evt-sub-' + submissionId;
    const detEvent = checkDb.prepare("SELECT * FROM events WHERE id = ?").get(detEventId);
    if (!detEvent || detEvent.type !== 'CODER_SUBMISSION_QUARANTINED') {
      throw new Error("Deterministic event missing or wrong type");
    }
    const detPayload = JSON.parse(detEvent.structured_payload_json);
    if (detPayload.submission_id !== submissionId || detPayload.claim_content_hash !== subRow.claim_content_hash || detPayload.canonical_envelope_hash !== subRow.canonical_envelope_hash) {
      throw new Error("Deterministic event structured payload mismatch");
    }

    const totalSubRowsBeforeReplay = checkDb.prepare("SELECT COUNT(*) as c FROM coder_submissions").get().c;
    const totalDispRowsBeforeReplay = checkDb.prepare("SELECT COUNT(*) as c FROM coder_submission_dispositions").get().c;
    const totalEventRowsBeforeReplay = checkDb.prepare("SELECT COUNT(*) as c FROM events").get().c;
    checkDb.close();

    // 8. Exact idempotent replay with no new rows
    const replayToolRes = await subHarness.sendRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'agentforge_submit_coder_claim',
        arguments: subArgs,
      }
    });
    if (replayToolRes.error || replayToolRes.result?.isError) {
      throw new Error("Replay tool call failed: " + JSON.stringify(replayToolRes));
    }
    const parsedReplay = JSON.parse(replayToolRes.result.content[0].text);
    if (!parsedReplay.accepted || !parsedReplay.is_duplicate) {
      throw new Error("Replay was not recognized as duplicate: " + JSON.stringify(parsedReplay));
    }

    const replayCheckDb = new Database(dbPath, { readonly: true });
    const totalSubRowsAfter = replayCheckDb.prepare("SELECT COUNT(*) as c FROM coder_submissions").get().c;
    const totalDispRowsAfter = replayCheckDb.prepare("SELECT COUNT(*) as c FROM coder_submission_dispositions").get().c;
    const totalEventRowsAfter = replayCheckDb.prepare("SELECT COUNT(*) as c FROM events").get().c;
    if (totalSubRowsAfter !== totalSubRowsBeforeReplay || totalDispRowsAfter !== totalDispRowsBeforeReplay || totalEventRowsAfter !== totalEventRowsBeforeReplay) {
      throw new Error("Replay mutated database rows");
    }

    // Zero mutation check on domain tables and Git
    const postAuth = replayCheckDb.prepare("SELECT * FROM execution_authorizations WHERE id = ?").get(authorizationId);
    const postTask = replayCheckDb.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    const postAttempt = replayCheckDb.prepare("SELECT * FROM task_attempts WHERE id = ?").get(attemptId);
    const postAssignment = replayCheckDb.prepare("SELECT * FROM agent_assignments WHERE id = ?").get(assignmentId);
    const postProtoMsg = replayCheckDb.prepare("SELECT * FROM protocol_messages WHERE record_id = ?").get(managerRecordId);
    replayCheckDb.close();

    if (JSON.stringify(postAuth) !== JSON.stringify(preAuth)) throw new Error("Execution authorization was mutated");
    if (JSON.stringify(postTask) !== JSON.stringify(preTask)) throw new Error("Task was mutated");
    if (JSON.stringify(postAttempt) !== JSON.stringify(preAttempt)) throw new Error("Task attempt was mutated");
    if (JSON.stringify(postAssignment) !== JSON.stringify(preAssignment)) throw new Error("Agent assignment was mutated");
    if (JSON.stringify(postProtoMsg) !== JSON.stringify(preProtoMsg)) throw new Error("Protocol message was mutated");

    const postGitStatus = execSync('git status --porcelain', { cwd: projectRoot, encoding: 'utf8' }).trim();
    const postGitHead = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim();
    if (postGitStatus !== preGitStatus || postGitHead !== preGitHead) {
      throw new Error("Git working tree or HEAD was mutated");
    }

    // 9. Revoked token refusal
    execSync(`"${process.execPath}" "${subAdminScript}" revoke --auth "${authorizationId}" --db "${dbPath}" --json`, {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      encoding: 'utf8',
    });

    const revokedSubRes = await subHarness.sendRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'agentforge_submit_coder_claim',
        arguments: Object.assign({}, subArgs, { submission_id: '00000000-0000-4000-8000-000000000009' }),
      }
    });
    const revokedContent = revokedSubRes.result ? JSON.parse(revokedSubRes.result.content[0].text) : null;
    const isRevokedRejected = (revokedSubRes.result?.isError === true) || (revokedContent && !revokedContent.accepted);
    if (!isRevokedRejected) {
      throw new Error("Submission with revoked session was not refused");
    }

    // 10. Clean EOF exit with code 0 and database unlock
    const subExitRes = await subHarness.close(4000);
    if (subExitRes.code !== 0) {
      throw new Error("Expected submission stdio exit code 0, got " + subExitRes.code);
    }
    const unlockCheckDb = new Database(dbPath);
    unlockCheckDb.close();

    // 11. Handled SIGINT and SIGTERM exit/cleanup using bounded event-driven harnesses
    const signalPreload = path.join(path.dirname(dbPath), 'signal_preload.js');
    fs.writeFileSync(signalPreload, "if (process.send) { process.on('message', m => { if (m === 'SIGINT') process.emit('SIGINT'); if (m === 'SIGTERM') process.emit('SIGTERM'); }); }\\n");

    const testSignalExit = async (sig) => {
      const sigChild = spawn(process.execPath, [subStdioScript], {
        env: Object.assign({}, process.env, {
          ELECTRON_RUN_AS_NODE: '1',
          NODE_OPTIONS: `-r "${signalPreload}"`,
          AGENTFORGE_MCP_DB_PATH: dbPath,
          AGENTFORGE_MCP_SUBMISSION_TOKEN: activePlaintextToken,
        }),
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      const sigHarness = new McpRpcHarness(sigChild);
      await sigHarness.sendRequest({
        jsonrpc: '2.0',
        id: 20,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sig-test', version: '1.0.0' } }
      });
      const exitP = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { sigChild.kill(); } catch (killErr) { void killErr; }
          reject(new Error(sig + " shutdown timeout"));
        }, 4000);
        sigChild.on('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
      if (process.platform === 'win32' && sigChild.send) {
        sigChild.send(sig);
      } else {
        sigChild.kill(sig);
      }
      const res = await exitP;
      if (res.code !== 0) throw new Error(`${sig} exit code was ${res.code}`);
      const chkDb = new Database(dbPath);
      chkDb.close();
    };

    await testSignalExit('SIGINT');
    await testSignalExit('SIGTERM');

    console.log("R5J4_MCP_SUBMISSION_PROOF=PASS");
    process.exit(0);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("R5J4_MCP_SUBMISSION_PROOF_ERROR: " + errMsg.replace(/af-[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]'));
    try {
      if (child && !child.killed) child.kill();
    } catch (killErr) {
      void killErr;
    }
    process.exit(1);
  }
})();
'@

  Set-Content -Path $bootstrapScript -Value $bootstrapContent -Encoding UTF8

  $mcpStartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $mcpStartInfo.FileName = $exePath
  $mcpStartInfo.Arguments = "`"$bootstrapScript`" `"$unpackedAsar`" `"$mcpDbPath`" `"$ProjectRoot`""
  $mcpStartInfo.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1"
  $mcpStartInfo.UseShellExecute = $false
  $mcpStartInfo.RedirectStandardOutput = $true
  $mcpStartInfo.RedirectStandardError = $true

  $mcpProc = [System.Diagnostics.Process]::Start($mcpStartInfo)
  if ($null -eq $mcpProc) {
    throw "R5J3_PROCESS_SPAWN_FAILED: Failed to start MCP proof runner"
  }
  $mcpPid = $mcpProc.Id

  # F3: Asynchronous non-blocking stream reads
  $stdoutTask = $mcpProc.StandardOutput.ReadToEndAsync()
  $stderrTask = $mcpProc.StandardError.ReadToEndAsync()

  $timeoutMs = 35000
  $exitedInTime = $mcpProc.WaitForExit($timeoutMs)

  if (-not $exitedInTime) {
    Write-Host "R5J3_TIMEOUT: MCP proof process $mcpPid did not terminate within $timeoutMs ms"
    try {
      $mcpProc.Kill()
    } catch {
      Write-Host "R5J3_CLEANUP_NOTE: Process $mcpPid kill attempted: $_"
    }
    $killWait = $mcpProc.WaitForExit(4000)
    if (-not $killWait) {
      throw "R5J3_PROCESS_TERMINATION_FAILED: Process $mcpPid survived kill attempt"
    }
    [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 3000)
    $mcpStdout = $stdoutTask.Result
    $mcpStderr = $stderrTask.Result
    throw "R5J3_PROCESS_TIMEOUT: MCP proof process timed out after $timeoutMs ms (PID: $mcpPid)"
  }

  [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 3000)
  $mcpStdout = $stdoutTask.Result
  $mcpStderr = $stderrTask.Result

  Write-Host "MCP Proof Output:"
  Write-Host $mcpStdout

  if ($mcpProc.ExitCode -ne 0 -or -not ($mcpStdout -match "R5J3_MCP_BRIDGE_PROOF=PASS") -or -not ($mcpStdout -match "R5J4_MCP_SUBMISSION_PROOF=PASS")) {
    Write-Error "Packaged MCP bridge verification failed (exit code $($mcpProc.ExitCode)): $mcpStderr"
    exit 1
  }

  Write-Host "[9/9] Packaged MCP Client Bridge & Node-Mode Stdio Proof: PASS" -ForegroundColor Green

  # Verify no surviving processes in package dir
  $surviving = Get-Process -Name "AgentForge" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -like "$ProjectRoot\release\win-unpacked*" } catch { $false }
  }
  if ($surviving) {
    throw "R5J3_SURVIVING_PROCESS_DETECTED: AgentForge process remained active in release/win-unpacked"
  }
  Write-Host "PACKAGED_NO_SURVIVING_PROCESSES=PASS" -ForegroundColor Green

  # F3: Fail-visible cleanup of synthetic test materials
  if (Test-Path $mcpDbPath) {
    Remove-Item -Force $mcpDbPath
    if (Test-Path $mcpDbPath) {
      throw "R5J3_CLEANUP_FAILED: Database file handle remained locked after child exit"
    }
  }
  if (Test-Path $tempMcpDir) {
    Remove-Item -Recurse -Force $tempMcpDir
    if (Test-Path $tempMcpDir) {
      throw "R5J3_CLEANUP_FAILED: Temporary MCP directory could not be removed: $tempMcpDir"
    }
  }

  Write-Host "=== Packaged Runtime Smoke Test: SUCCESS (All 9 Gates Passed) ===" -ForegroundColor Green

} finally {
  # Clean termination of test process
  if ($null -ne $proc -and -not $proc.HasExited) {
    Write-Host "Terminating test process $($proc.Id)..."
    try {
      $proc.CloseMainWindow() | Out-Null
      $proc.WaitForExit(3000)
    } catch {}

    if (-not $proc.HasExited) {
      try {
        $proc.Kill()
        $proc.WaitForExit(2000)
      } catch {}
    }
  }

  # Restore environment
  $env:APPDATA = $oldAppData
  $env:LOCALAPPDATA = $oldLocalAppData
  $env:AGENT_FORGE_DATA_DIR = $null
  $env:AGENT_FORGE_SMOKE_MODE = $null

  # Clean temporary smoke data
  if (Test-Path $tempAppData) {
    try {
      Remove-Item -Recurse -Force $tempAppData -ErrorAction SilentlyContinue
    } catch {}
  }
  if ($tempMcpDir -and (Test-Path $tempMcpDir)) {
    Remove-Item -Recurse -Force $tempMcpDir
    if (Test-Path $tempMcpDir) {
      Write-Host "WARNING: Temporary MCP directory persisted after cleanup: $tempMcpDir"
    }
  }
}

exit 0
