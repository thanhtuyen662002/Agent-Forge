# =============================================================================
# scripts/smoke-installed-production-win.ps1
# Deterministic Real Windows Production Installed Smoke Gate (PR #10)
# =============================================================================

[CmdletBinding()]
param (
  [string]$ProjectRoot = "",
  [string]$InstallerPath = "",
  [switch]$Headless = $false
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $pkgPath = Join-Path $ProjectRoot "package.json"
  $ver = if (Test-Path $pkgPath) { (Get-Content $pkgPath -Raw | ConvertFrom-Json).version.Trim() } else { "0.1.0" }
  $candidates = @(
    (Join-Path $ProjectRoot "release\AgentForge Setup $ver.exe"),
    (Join-Path $ProjectRoot "release\AgentForge-Setup-$ver.exe"),
    (Join-Path $ProjectRoot "release\publish-assets\AgentForge-Setup-$ver.exe"),
    (Join-Path $ProjectRoot "release\publish-assets\AgentForge Setup $ver.exe")
  )
  foreach ($cand in $candidates) {
    if (Test-Path $cand) {
      $InstallerPath = $cand
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    $InstallerPath = Join-Path $ProjectRoot "release\AgentForge Setup $ver.exe"
  }
}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "   AgentForge Real Production Installed Windows Smoke Test       " -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "Installer: $InstallerPath"
Write-Host "Mode:      $(if ($Headless) { 'Headless/CI' } else { 'Interactive/Local' })"

if (-not (Test-Path $InstallerPath)) {
  Write-Error "Production installer not found at '$InstallerPath'. Run 'npm run package:win' first."
  exit 1
}

$smokeGuid = [Guid]::NewGuid().ToString()
$tempInstallDir = Join-Path ([System.IO.Path]::GetTempPath()) "af-prod-smoke-install-$smokeGuid"
$tempUserDataDir = Join-Path ([System.IO.Path]::GetTempPath()) "af-prod-smoke-data-$smokeGuid"

New-Item -ItemType Directory -Path $tempInstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $tempUserDataDir -Force | Out-Null

$dbPath = Join-Path $tempUserDataDir "database\agent-forge.db"
$reportPath = Join-Path $tempUserDataDir "smoke-ready.json"
$proc = $null

$oldAppData = $env:APPDATA
$oldLocalAppData = $env:LOCALAPPDATA

try {
  # 1. Real Silent NSIS Installation
  Write-Host "[1/7] Installing production NSIS installer to isolated directory..." -ForegroundColor Green
  $installProc = Start-Process -FilePath $InstallerPath -ArgumentList "/S", "/D=$tempInstallDir" -Wait -PassThru
  if ($installProc.ExitCode -ne 0) {
    throw "PRODUCTION_NSIS_INSTALL_FAILED: Installer exited with code $($installProc.ExitCode)"
  }
  Write-Host "PRODUCTION_NSIS_INSTALL=PASS" -ForegroundColor Green

  # 2. Discover Installed Executable
  $installedExe = Join-Path $tempInstallDir "AgentForge.exe"
  if (-not (Test-Path $installedExe)) {
    throw "INSTALLED_EXE_MISSING: AgentForge.exe was not found at '$installedExe'"
  }
  Write-Host "INSTALLED_EXE_PATH=$installedExe" -ForegroundColor Green

  # 3. Inspect Installed resources/app-update.yml
  $installedAppUpdate = Join-Path $tempInstallDir "resources\app-update.yml"
  if (-not (Test-Path $installedAppUpdate)) {
    throw "INSTALLED_APP_UPDATE_YML_MISSING: resources\app-update.yml not found at '$installedAppUpdate'"
  }
  $ymlContent = Get-Content $installedAppUpdate -Raw
  $hasGithub = $ymlContent -match "(?m)^\s*provider:\s*github"
  $hasOwner = $ymlContent -match "(?m)^\s*owner:\s*thanhtuyen662002"
  $hasRepo = $ymlContent -match "(?m)^\s*repo:\s*Agent-Forge"
  $credRegex = "(?i)(token:|password:|Authorization:|Bearer\s|ghp_|github_pat_)"
  $hasCreds = $ymlContent -match $credRegex

  if (-not ($hasGithub -and $hasOwner -and $hasRepo)) {
    throw "INSTALLED_APP_UPDATE_CONFIG_INVALID: Installed app-update.yml does not match github/thanhtuyen662002/Agent-Forge"
  }
  if ($hasCreds) {
    throw "INSTALLED_APP_UPDATE_CREDENTIALS_FOUND: Installed app-update.yml contains credentials/secrets"
  }
  Write-Host "INSTALLED_UPDATE_PROVIDER=github" -ForegroundColor Green
  Write-Host "INSTALLED_UPDATE_OWNER=thanhtuyen662002" -ForegroundColor Green
  Write-Host "INSTALLED_UPDATE_REPO=Agent-Forge" -ForegroundColor Green
  Write-Host "INSTALLED_UPDATE_CREDENTIALS=NONE" -ForegroundColor Green

  # 4. Launch Installed Production Application (NO --no-sandbox flag)
  Write-Host "[4/7] Launching installed production process with isolated environment..." -ForegroundColor Green
  $env:APPDATA = $tempUserDataDir
  $env:LOCALAPPDATA = $tempUserDataDir
  $env:AGENT_FORGE_DATA_DIR = $tempUserDataDir
  $env:AGENT_FORGE_SMOKE_MODE = "1"

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $installedExe
  $startInfo.WorkingDirectory = $tempInstallDir
  $startInfo.EnvironmentVariables["APPDATA"] = $tempUserDataDir
  $startInfo.EnvironmentVariables["LOCALAPPDATA"] = $tempUserDataDir
  $startInfo.EnvironmentVariables["AGENT_FORGE_DATA_DIR"] = $tempUserDataDir
  $startInfo.EnvironmentVariables["AGENT_FORGE_SMOKE_MODE"] = "1"
  $startInfo.UseShellExecute = $false

  $proc = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $proc) {
    throw "INSTALLED_APP_SPAWN_FAILED: Failed to start process '$installedExe'"
  }

  $procPid = $proc.Id
  Write-Host "Process spawned with PID: $procPid"
  Write-Host "INSTALLED_APP_LAUNCH=PASS" -ForegroundColor Green

  # 5. Wait for SQLite Database and Smoke Ready Report
  $timeoutSeconds = 15
  $elapsed = 0
  $report = $null

  Write-Host "[5/7] Waiting for SQLite bootstrap and renderer readiness ($timeoutSeconds seconds)..." -ForegroundColor Green
  while ($elapsed -lt $timeoutSeconds) {
    Start-Sleep -Seconds 1
    $elapsed++

    if ($proc.HasExited) {
      throw "INSTALLED_APP_CRASHED: Process $procPid exited prematurely with exit code: $($proc.ExitCode)"
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

  # 6. Verify Process Survival & Smoke Report
  if ($proc.HasExited) {
    throw "INSTALLED_APP_CRASHED: Process exited unexpectedly with code $($proc.ExitCode)"
  }

  if ($null -eq $report) {
    throw "SMOKE_READY_REPORT_MISSING: smoke-ready.json was not generated at '$reportPath' within $timeoutSeconds seconds"
  }

  Write-Host "SMOKE_READY_REPORT_PATH=$reportPath" -ForegroundColor Green
  Write-Host "SMOKE_READY_STATUS=$($report.status)" -ForegroundColor Green

  if ($report.status -ne 'READY') {
    throw "INSTALLED_RENDERER_FAILED: Renderer reported status '$($report.status)'"
  }
  Write-Host "INSTALLED_RENDERER_READY=PASS" -ForegroundColor Green

  if (-not $report.isPackaged) {
    throw "INSTALLED_IS_PACKAGED_MISMATCH: isPackaged is false in installed production build"
  }
  Write-Host "INSTALLED_IS_PACKAGED=YES" -ForegroundColor Green

  if ($report.appVersion -ne "0.1.0") {
    throw "INSTALLED_APP_VERSION_MISMATCH: Expected 0.1.0, got '$($report.appVersion)'"
  }
  Write-Host "INSTALLED_APP_VERSION=$($report.appVersion)" -ForegroundColor Green

  if (-not $report.sqliteInitialized) {
    throw "INSTALLED_SQLITE_INIT_REPORT_FAILED: sqliteInitialized is false in smoke report"
  }

  if (-not $report.updateServiceInitialized) {
    throw "INSTALLED_UPDATE_SERVICE_INIT_FAILED: updateServiceInitialized is false in smoke report"
  }
  Write-Host "INSTALLED_UPDATE_SERVICE_INIT=PASS" -ForegroundColor Green

  if (-not $report.rootExists -or $report.rootChildCount -le 0) {
    throw "INSTALLED_DOM_MOUNT_FAILED: React #root element missing or empty (rootChildCount=$($report.rootChildCount))"
  }

  if (-not ($report.rendererUrl -like "file://*")) {
    throw "INSTALLED_RENDERER_URL_INVALID: Expected file:// URL, got '$($report.rendererUrl)'"
  }
  if ($report.rendererUrl -like "*localhost*") {
    throw "INSTALLED_RENDERER_URL_DEV_LEAK: Renderer loaded development localhost URL '$($report.rendererUrl)'"
  }
  Write-Host "INSTALLED_RENDERER_URL=$($report.rendererUrl)" -ForegroundColor Green

  # 7. Authoritative SQLite Database Verification
  if (-not (Test-Path $dbPath)) {
    throw "INSTALLED_SQLITE_FILE_MISSING: agent-forge.db not found at '$dbPath'"
  }
  $dbSize = (Get-Item $dbPath).Length
  if ($dbSize -lt 1024) {
    throw "INSTALLED_SQLITE_FILE_CORRUPT: agent-forge.db file size ($dbSize bytes) is less than 1024 bytes"
  }
  Write-Host "INSTALLED_SQLITE_INIT=PASS" -ForegroundColor Green
  Write-Host "INSTALLED_SQLITE_PATH=$dbPath" -ForegroundColor Green
  Write-Host "INSTALLED_SQLITE_SIZE_BYTES=$dbSize" -ForegroundColor Green

  # 8. Installed MCP Client Bridge & Node-Mode Stdio Proof
  Write-Host "[8/8] Testing installed MCP client bridge and stdio server..." -ForegroundColor Green
  $installedAsar = Join-Path $tempInstallDir "resources\app.asar"
  if (-not (Test-Path $installedAsar)) {
    throw "INSTALLED_ASAR_MISSING: resources\app.asar not found at '$installedAsar'"
  }
  Write-Host "INSTALLED_ASAR_PATH=$installedAsar" -ForegroundColor Green

  # Terminate GUI application cleanly before MCP proof to verify isolation
  if ($null -ne $proc -and -not $proc.HasExited) {
    Write-Host "Closing installed GUI process $($proc.Id)..." -ForegroundColor Green
    try {
      $proc.CloseMainWindow() | Out-Null
      $proc.WaitForExit(4000)
    } catch {}
    if (-not $proc.HasExited) {
      $proc.Kill()
      $proc.WaitForExit(2000)
    }
    Write-Host "INSTALLED_GUI_TERMINATED=PASS" -ForegroundColor Green
  }

  $tempMcpDir = Join-Path ([System.IO.Path]::GetTempPath()) "af-installed-mcp-smoke-$smokeGuid"
  New-Item -ItemType Directory -Path $tempMcpDir -Force | Out-Null
  $mcpDbPath = Join-Path $tempMcpDir "mcp-installed.db"
  $bootstrapScript = Join-Path $tempMcpDir "installed-mcp-proof.js"

  $bootstrapContent = @'
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const asarPath = process.argv[2];
const dbPath = process.argv[3];
const projectRoot = process.argv[4];

console.log("R5J3_FACT_EXEC_PATH=" + process.execPath);
console.log("R5J3_FACT_ELECTRON_VERSION=" + (process.versions.electron || "UNKNOWN"));
console.log("R5J3_FACT_NODE_VERSION=" + process.versions.node);
console.log("R5J3_FACT_ASAR_PATH=" + asarPath);

if (!process.env.ELECTRON_RUN_AS_NODE) {
  console.error("R5J3_FAIL: ELECTRON_RUN_AS_NODE is not set");
  process.exit(1);
}

const migrationsPath = path.join(asarPath, 'dist-electron', 'core', 'database', 'migrations.js');
const repoPath = path.join(asarPath, 'dist-electron', 'core', 'database', 'repositories.js');
const authorityServicePath = path.join(asarPath, 'dist-electron', 'core', 'services', 'McpSessionAuthorityService.js');
const authServicePath = path.join(asarPath, 'dist-electron', 'core', 'services', 'ExecutionAuthorizationService.js');

if (!fs.existsSync(migrationsPath) || !fs.existsSync(repoPath) || !fs.existsSync(authorityServicePath)) {
  console.error("FAIL: Packaged modules missing in app.asar");
  process.exit(1);
}

// Ensure no fallback to repository source files or win-unpacked
const repoResolved = require.resolve(repoPath);
if (projectRoot && repoResolved.toLowerCase().includes(path.normalize(projectRoot).toLowerCase())) {
  console.error("R5J3_FAIL: Resolved repository source files instead of installed app.asar: " + repoResolved);
  process.exit(1);
}
if (repoResolved.toLowerCase().includes('win-unpacked')) {
  console.error("R5J3_FAIL: Resolved win-unpacked files instead of installed app.asar: " + repoResolved);
  process.exit(1);
}

const nativeSqlitePath = require.resolve(path.join(asarPath, 'node_modules', 'better-sqlite3'));
console.log("R5J3_FACT_NATIVE_MODULE_PATH=" + nativeSqlitePath);

const Database = require(path.join(asarPath, 'node_modules', 'better-sqlite3'));
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
const projectId = 'proj-inst-' + crypto.randomUUID();
const taskId = 'task-inst-' + crypto.randomUUID();
const attemptId = 'att-inst-' + crypto.randomUUID();
const assignmentId = 'asgn-inst-' + crypto.randomUUID();
const authorizationId = 'auth-inst-' + crypto.randomUUID();
const managerRecordId = 'mgr-rec-inst-' + crypto.randomUUID();
const managerProtoMsgId = 'proto-msg-inst-' + crypto.randomUUID();
const routingDecisionId = 'route-inst-' + crypto.randomUUID();
const providerId = 'prov-inst-' + crypto.randomUUID();
const accountId = 'acc-inst-' + crypto.randomUUID();
const resourceId = 'res-inst-' + crypto.randomUUID();

repo.createProject({
  id: projectId,
  name: 'Installed Smoke Project',
  description: 'Installed smoke',
  repository_path: 'D:/fake/installed',
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
  VALUES (?, ?, 'Installed Smoke Task', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
`).run(taskId, projectId, 'a'.repeat(40), now, now);

const roleId = 'role-inst-' + crypto.randomUUID();
const agentId = 'agent-inst-' + crypto.randomUUID();
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

const instructions = ['Task: Installed Smoke Task', 'Verify installed context read'];
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
  taskTitle: 'Installed Smoke Task',
  taskDescription: 'Installed smoke verification',
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
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'installed-smoke-test', version: '1.0.0' } }
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
    if (toolPayload.execution_payload?.taskTitle !== 'Installed Smoke Task') {
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

    console.log("R5J3_INSTALLED_MCP_BRIDGE_PROOF=PASS");
    process.exit(0);
  } catch (err) {
    console.error("R5J3_INSTALLED_MCP_BRIDGE_PROOF_ERROR: " + (err instanceof Error ? err.stack : String(err)));
    try { child.kill('SIGKILL'); } catch {}
    process.exit(1);
  }
})();
'@

  Set-Content -Path $bootstrapScript -Value $bootstrapContent -Encoding UTF8

  $mcpStartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $mcpStartInfo.FileName = $installedExe
  $mcpStartInfo.Arguments = "`"$bootstrapScript`" `"$installedAsar`" `"$mcpDbPath`" `"$ProjectRoot`""
  $mcpStartInfo.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1"
  $mcpStartInfo.UseShellExecute = $false
  $mcpStartInfo.RedirectStandardOutput = $true
  $mcpStartInfo.RedirectStandardError = $true

  $mcpProc = [System.Diagnostics.Process]::Start($mcpStartInfo)
  $mcpStdout = $mcpProc.StandardOutput.ReadToEnd()
  $mcpStderr = $mcpProc.StandardError.ReadToEnd()
  $mcpProc.WaitForExit(30000)

  Write-Host "Installed MCP Proof Output:"
  Write-Host $mcpStdout

  if ($mcpProc.ExitCode -ne 0 -or -not ($mcpStdout -match "R5J3_INSTALLED_MCP_BRIDGE_PROOF=PASS")) {
    throw "Installed MCP bridge verification failed (exit code $($mcpProc.ExitCode)): $mcpStderr"
  }

  Write-Host "[8/8] Installed MCP Client Bridge & Node-Mode Stdio Proof: PASS" -ForegroundColor Green

  # Verify no surviving processes in install dir
  $surviving = Get-Process -Name "AgentForge" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -like "$tempInstallDir*" } catch { $false }
  }
  if ($surviving) {
    throw "SURVIVING_PROCESS_DETECTED: AgentForge process remained active in $tempInstallDir"
  }
  Write-Host "INSTALLED_NO_SURVIVING_PROCESSES=PASS" -ForegroundColor Green

  # Prove database handle released and clean up MCP DB
  if (Test-Path $mcpDbPath) {
    Remove-Item -Force $mcpDbPath
    if (Test-Path $mcpDbPath) {
      throw "MCP_DB_CLEANUP_FAILED: Database handle remained locked after child exit"
    }
    Write-Host "INSTALLED_MCP_DB_RELEASE=PASS" -ForegroundColor Green
  }

  Write-Host "=================================================================" -ForegroundColor Cyan
  Write-Host "   Real Production Installed Smoke Test: PASS (All 8 Gates Passed) " -ForegroundColor Green
  Write-Host "=================================================================" -ForegroundColor Cyan

} catch {
  Write-Host "=================================================================" -ForegroundColor Red
  Write-Host "   Real Production Installed Smoke Test: FAILED                  " -ForegroundColor Red
  Write-Host "   Error: $_" -ForegroundColor Red
  Write-Host "=================================================================" -ForegroundColor Red
  exit 1
} finally {
  # Clean termination of test process
  if ($null -ne $proc -and -not $proc.HasExited) {
    Write-Host "Terminating installed test process $($proc.Id)..."
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

  # Cleanup temporary installation and data
  $uninstaller = Join-Path $tempInstallDir "Uninstall AgentForge.exe"
  if (Test-Path $uninstaller) {
    try {
      Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue
    } catch {}
  }
  if (Test-Path $tempInstallDir) {
    try {
      Remove-Item -Recurse -Force $tempInstallDir -ErrorAction SilentlyContinue
    } catch {}
  }
  if (Test-Path $tempUserDataDir) {
    try {
      Remove-Item -Recurse -Force $tempUserDataDir -ErrorAction SilentlyContinue
    } catch {}
  }
  if ($tempMcpDir -and (Test-Path $tempMcpDir)) {
    try {
      Remove-Item -Recurse -Force $tempMcpDir -ErrorAction SilentlyContinue
    } catch {}
  }
}

exit 0
