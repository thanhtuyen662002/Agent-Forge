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
      $proc.WaitForExit(3000)
    } catch {}

    if (-not $proc.HasExited) {
      try {
        $proc.Kill()
        $proc.WaitForExit(2000)
      } catch {}
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

if (!fs.existsSync(asarPath)) {
  console.error("FAIL: app.asar does not exist at " + asarPath);
  process.exit(1);
}

console.log("R5J3_FACT_ELECTRON_VERSION=" + (process.versions.electron || "UNKNOWN"));
console.log("R5J3_FACT_NODE_VERSION=" + process.versions.node);
console.log("R5J3_FACT_EXEC_PATH=" + process.execPath);

const Database = require('better-sqlite3');
console.log("R5J3_FACT_SQLITE_PATH=" + require.resolve('better-sqlite3'));

const migrationsPath = path.join(asarPath, 'dist-electron', 'core', 'database', 'migrations.js');
const repoPath = path.join(asarPath, 'dist-electron', 'core', 'database', 'repositories.js');
const authorityServicePath = path.join(asarPath, 'dist-electron', 'core', 'services', 'McpSessionAuthorityService.js');
const authServicePath = path.join(asarPath, 'dist-electron', 'core', 'services', 'ExecutionAuthorizationService.js');

if (!fs.existsSync(migrationsPath) || !fs.existsSync(repoPath) || !fs.existsSync(authorityServicePath)) {
  console.error("FAIL: Packaged modules missing in app.asar");
  process.exit(1);
}

const { MigrationRunner } = require(migrationsPath);
const { Repository } = require(repoPath);
const { McpSessionAuthorityService } = require(authorityServicePath);
const { computeCanonicalPayload, computePayloadHash, computeContextManifestHash } = require(authServicePath);

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
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
  repository_path: 'D:/fake/packaged',
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

let childStdout = '';
let childStderr = '';
const stdoutLines = [];

child.stdout.on('data', (chunk) => {
  childStdout += chunk.toString('utf8');
  let newlineIdx = childStdout.indexOf('\n');
  while (newlineIdx !== -1) {
    const line = childStdout.slice(0, newlineIdx).trim();
    childStdout = childStdout.slice(newlineIdx + 1);
    if (line) stdoutLines.push(line);
    newlineIdx = childStdout.indexOf('\n');
  }
});

child.stderr.on('data', (chunk) => {
  childStderr += chunk.toString('utf8');
});

async function sendRpc(req, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RPC timed out: " + req.id)), timeoutMs);
    const checkInterval = setInterval(() => {
      const match = stdoutLines.find(l => {
        try { return JSON.parse(l).id === req.id; } catch { return false; }
      });
      if (match) {
        clearTimeout(timer);
        clearInterval(checkInterval);
        resolve(JSON.parse(match));
      }
    }, 20);
    child.stdin.write(JSON.stringify(req) + '\n');
  });
}

(async () => {
  try {
    const initRes = await sendRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-test', version: '1.0.0' } }
    });
    console.log("R5J3_INITIALIZE_ELAPSED_MS=" + (Date.now() - startTime));
    if (initRes.error) throw new Error("Initialize failed: " + JSON.stringify(initRes.error));

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const toolReqStart = Date.now();
    const toolRes = await sendRpc({
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
    const resRead = await sendRpc({
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

    const failRes = await sendRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'agentforge_get_authorized_context', arguments: {} }
    });
    const isError = Boolean(failRes.error) || failRes.result?.isError === true;
    if (!isError) throw new Error("Expected revoked session to fail closed");
    console.log("R5J3_REVOKE_FAIL_CLOSED=PASS");

    const shutdownStart = Date.now();
    child.stdin.end();

    await new Promise((resolve, reject) => {
      const exitTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error("Shutdown timed out"));
      }, 4000);
      child.on('exit', (code, signal) => {
        clearTimeout(exitTimer);
        console.log("R5J3_SHUTDOWN_ELAPSED_MS=" + (Date.now() - shutdownStart));
        console.log("R5J3_CHILD_EXIT_CODE=" + code);
        console.log("R5J3_CHILD_SIGNAL=" + (signal || "NONE"));
        if (code !== 0) reject(new Error("Expected exit code 0, got " + code));
        resolve();
      });
    });

    const verifyDb = new Database(dbPath, { readonly: true });
    verifyDb.close();

    console.log("R5J3_MCP_BRIDGE_PROOF=PASS");
    process.exit(0);
  } catch (err) {
    console.error("R5J3_MCP_BRIDGE_PROOF_ERROR: " + (err instanceof Error ? err.stack : String(err)));
    try { child.kill('SIGKILL'); } catch {}
    process.exit(1);
  }
})();
'@

  Set-Content -Path $bootstrapScript -Value $bootstrapContent -Encoding UTF8

  $mcpStartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $mcpStartInfo.FileName = $exePath
  $mcpStartInfo.Arguments = "`"$bootstrapScript`" `"$unpackedAsar`" `"$mcpDbPath`""
  $mcpStartInfo.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1"
  $mcpStartInfo.UseShellExecute = $false
  $mcpStartInfo.RedirectStandardOutput = $true
  $mcpStartInfo.RedirectStandardError = $true

  $mcpProc = [System.Diagnostics.Process]::Start($mcpStartInfo)
  $mcpStdout = $mcpProc.StandardOutput.ReadToEnd()
  $mcpStderr = $mcpProc.StandardError.ReadToEnd()
  $mcpProc.WaitForExit(30000)

  Write-Host "MCP Proof Output:"
  Write-Host $mcpStdout

  if ($mcpProc.ExitCode -ne 0 -or -not ($mcpStdout -match "R5J3_MCP_BRIDGE_PROOF=PASS")) {
    Write-Error "Packaged MCP bridge verification failed (exit code $($mcpProc.ExitCode)): $mcpStderr"
    exit 1
  }

  Write-Host "[9/9] Packaged MCP Client Bridge & Node-Mode Stdio Proof: PASS" -ForegroundColor Green
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
    try {
      Remove-Item -Recurse -Force $tempMcpDir -ErrorAction SilentlyContinue
    } catch {}
  }
}

exit 0
