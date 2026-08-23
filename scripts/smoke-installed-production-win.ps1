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

  Write-Host "=================================================================" -ForegroundColor Cyan
  Write-Host "   Real Production Installed Smoke Test: PASS (All Gates Passed) " -ForegroundColor Green
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
}

exit 0
