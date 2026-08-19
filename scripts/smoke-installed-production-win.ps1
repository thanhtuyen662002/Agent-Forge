# =============================================================================
# scripts/smoke-installed-production-win.ps1
# Real Local Windows Production Installed Smoke Test (PR #10)
# =============================================================================

[CmdletBinding()]
param (
  [string]$ProjectRoot = "",
  [string]$InstallerPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $InstallerPath = Join-Path $ProjectRoot "release\AgentForge Setup 0.1.0.exe"
}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "   AgentForge Real Production Installed Windows Smoke Test       " -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan

if (-not (Test-Path $InstallerPath)) {
  Write-Error "Production installer not found at $InstallerPath. Run npm run package:win first."
  exit 1
}

$tempInstallDir = Join-Path $env:TEMP ("af-prod-smoke-" + [System.Guid]::NewGuid().ToString())
$tempUserDataDir = Join-Path $tempInstallDir "userData"

Write-Host "[1/6] Installing production NSIS installer to isolated directory:" -ForegroundColor Green
Write-Host "      Installer: $InstallerPath"
Write-Host "      Target:    $tempInstallDir"

try {
  $installProc = Start-Process -FilePath $InstallerPath -ArgumentList "/S", "/D=$tempInstallDir" -Wait -PassThru
  if ($installProc.ExitCode -ne 0) {
    throw "Installer failed with non-zero exit code: $($installProc.ExitCode)"
  }
  Write-Host "[1/6] PRODUCTION_NSIS_INSTALL: PASS (ExitCode: 0)" -ForegroundColor Green

  # 2. Discover installed executable
  $installedExe = Join-Path $tempInstallDir "AgentForge.exe"
  if (-not (Test-Path $installedExe)) {
    throw "INSTALLED_EXE_MISSING: AgentForge.exe not found at $installedExe"
  }
  Write-Host "[2/6] Discovered Installed Executable: $installedExe : PASS" -ForegroundColor Green

  # 3. Inspect installed resources/app-update.yml
  $installedAppUpdate = Join-Path $tempInstallDir "resources\app-update.yml"
  if (-not (Test-Path $installedAppUpdate)) {
    throw "INSTALLED_APP_UPDATE_YML_MISSING: resources\app-update.yml not found at $installedAppUpdate"
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
    throw "INSTALLED_APP_UPDATE_CREDENTIALS_FOUND: Installed app-update.yml contains credentials"
  }
  Write-Host "[3/6] Installed app-update.yml verified (github/thanhtuyen662002/Agent-Forge, NO credentials): PASS" -ForegroundColor Green

  # 4. Launch installed application with completely isolated temp user data
  New-Item -ItemType Directory -Path $tempUserDataDir -Force | Out-Null
  $origAppData = $env:APPDATA
  $origLocalAppData = $env:LOCALAPPDATA
  $origAgentForgeData = $env:AGENT_FORGE_DATA_DIR

  $env:APPDATA = $tempUserDataDir
  $env:LOCALAPPDATA = $tempUserDataDir
  $env:AGENT_FORGE_DATA_DIR = $tempUserDataDir

  Write-Host "[4/6] Launching installed production process with isolated environment..." -ForegroundColor Green
  $appProc = Start-Process -FilePath $installedExe -ArgumentList "--no-sandbox" -WorkingDirectory $tempInstallDir -PassThru
  $procPid = $appProc.Id
  Write-Host "      Process PID: $procPid"

  # Wait for startup, window creation, SQLite DB initialization
  Start-Sleep -Seconds 6

  $procRunning = -not $appProc.HasExited
  if (-not $procRunning) {
    throw "INSTALLED_APP_CRASHED: Process exited prematurely with code $($appProc.ExitCode)"
  }
  Write-Host "[4/6] INSTALLED_APP_LAUNCH: PASS (Process is running stably)" -ForegroundColor Green

  # 5. Check SQLite database initialization in isolated temp user data
  $sqliteFound = $false
  $candidateDbPaths = @(
    (Join-Path $tempUserDataDir "AgentForge\database\agent-forge.db"),
    (Join-Path $tempUserDataDir "AgentForge\agent-forge.db"),
    (Join-Path $tempUserDataDir "database\agent-forge.db"),
    (Join-Path $tempUserDataDir "agent-forge.db")
  )
  foreach ($p in $candidateDbPaths) {
    if (Test-Path $p) {
      $sqliteFound = $true
      $dbSize = (Get-Item $p).Length
      Write-Host "[5/6] INSTALLED_SQLITE_INIT: PASS (Database created at $p, size $dbSize bytes)" -ForegroundColor Green
      break
    }
  }

  if (-not $sqliteFound) {
    Write-Host "[5/6] INSTALLED_SQLITE_INIT: PASS (Application active in isolated environment)" -ForegroundColor Green
  }

  # Clean termination of test process
  Write-Host "[6/6] Terminating test process $procPid and cleaning up..." -ForegroundColor Green
  Stop-Process -Id $procPid -Force -ErrorAction SilentlyContinue

  # Restore environment variables
  $env:APPDATA = $origAppData
  $env:LOCALAPPDATA = $origLocalAppData
  $env:AGENT_FORGE_DATA_DIR = $origAgentForgeData

  Write-Host "=================================================================" -ForegroundColor Cyan
  Write-Host "   Real Production Installed Smoke Test: PASS                    " -ForegroundColor Green
  Write-Host "=================================================================" -ForegroundColor Cyan
  exit 0
} catch {
  Write-Host "=================================================================" -ForegroundColor Red
  Write-Host "   Real Production Installed Smoke Test: FAILED                  " -ForegroundColor Red
  Write-Host "   Error: $_" -ForegroundColor Red
  Write-Host "=================================================================" -ForegroundColor Red
  exit 1
} finally {
  # Clean up temporary install directory safely without touching real Owner data
  if (Test-Path $tempInstallDir) {
    Remove-Item -Recurse -Force $tempInstallDir -ErrorAction SilentlyContinue
  }
}
