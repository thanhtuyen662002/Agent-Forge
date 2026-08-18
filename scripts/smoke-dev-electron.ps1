<#
.SYNOPSIS
  Development Electron window smoke test against Vite dev server with verified renderer readiness.
.DESCRIPTION
  Builds Electron main/preload, rebuilds better-sqlite3 for Electron, launches Vite dev server
  and local Electron binary under isolated test APPDATA, verifies SQLite bootstrap,
  renderer loading at http://localhost:5173, and DOM #root rendering, then cleanly shuts down
  and restores host Node native ABI bindings.
#>
param(
  [switch]$Headless = $false
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$electronExe = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"

Write-Host "=== AgentForge Development Electron Smoke Test ==="
Write-Host "Electron Binary: $electronExe"

if (-not (Test-Path $electronExe)) {
  Write-Error "Local Electron binary not found at '$electronExe'. Run 'npm ci' first."
  exit 1
}

# Step 1: Detect installed Electron version dynamically
$packageLockPath = Join-Path $projectRoot "package-lock.json"
$electronVersion = $null
if (Test-Path $packageLockPath) {
  try {
    $lock = Get-Content $packageLockPath -Raw | ConvertFrom-Json
    $electronPkg = $lock.packages."node_modules/electron"
    if ($null -ne $electronPkg) {
      $electronVersion = $electronPkg.version
    }
  } catch {}
}
if ([string]::IsNullOrWhiteSpace($electronVersion)) {
  $electronVersion = "34.5.8"
}
Write-Host "Authoritative Installed Electron Version: $electronVersion"

# Step 2: Build Electron main & preload
Write-Host "Building Electron main & preload scripts..."
& npm run build
if ($LASTEXITCODE -ne 0) {
  Write-Error "Build failed during dev smoke preparation."
  exit 1
}

# Step 3: Rebuild native dependencies for Electron
Write-Host "Rebuilding native dependencies for Electron runtime ($electronVersion)..."
& npx @electron/rebuild -f -w better-sqlite3 -v $electronVersion
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to rebuild better-sqlite3 for Electron $electronVersion."
  exit 1
}

# Step 4: Start Vite Dev Server in background
Write-Host "Starting Vite dev server..."
$viteProcInfo = New-Object System.Diagnostics.ProcessStartInfo
$viteProcInfo.FileName = "cmd.exe"
$viteProcInfo.Arguments = "/c npm run dev"
$viteProcInfo.WorkingDirectory = $projectRoot
$viteProcInfo.UseShellExecute = $false

$viteProc = [System.Diagnostics.Process]::Start($viteProcInfo)

# Step 5: Create isolated temp data directory
$smokeId = [Guid]::NewGuid().ToString()
$tempAppData = Join-Path ([System.IO.Path]::GetTempPath()) "agent-forge-dev-smoke-$smokeId"
New-Item -ItemType Directory -Path $tempAppData -Force | Out-Null

$dbPath = Join-Path $tempAppData "database\agent-forge.db"
$reportPath = Join-Path $tempAppData "smoke-ready.json"
$electronProc = $null
$report = $null

try {
  # Wait for Vite dev server initialization
  Start-Sleep -Seconds 3

  Write-Host "Launching Development Electron binary..."
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $electronExe
  $startInfo.Arguments = "."
  $startInfo.WorkingDirectory = $projectRoot
  $startInfo.EnvironmentVariables["AGENT_FORGE_DATA_DIR"] = $tempAppData
  $startInfo.EnvironmentVariables["AGENT_FORGE_SMOKE_MODE"] = "1"
  $startInfo.EnvironmentVariables["VITE_DEV_SERVER_URL"] = "http://localhost:5173"
  $startInfo.UseShellExecute = $false

  $electronProc = [System.Diagnostics.Process]::Start($startInfo)

  if ($null -eq $electronProc) {
    Write-Error "Failed to spawn Development Electron process."
    exit 1
  }
  Write-Host "Dev Electron process spawned with PID: $($electronProc.Id)"

  # Wait for SQLite bootstrap and renderer readiness
  $timeoutSeconds = 12
  $elapsed = 0

  Write-Host "Waiting for Dev Electron SQLite initialization and renderer readiness ($timeoutSeconds seconds)..."
  while ($elapsed -lt $timeoutSeconds) {
    Start-Sleep -Seconds 1
    $elapsed++

    if ($electronProc.HasExited) {
      Write-Error "Dev Electron process $($electronProc.Id) exited prematurely with exit code: $($electronProc.ExitCode)"
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
  if ($electronProc.HasExited) {
    Write-Error "Dev Electron process exited unexpectedly with code $($electronProc.ExitCode)."
    exit 1
  }
  Write-Host "[1/5] Dev Electron process $($electronProc.Id) is running: PASS"

  # 2. SQLite Database Guard
  if (-not (Test-Path $dbPath)) {
    Write-Error "Dev Electron failed to initialize database at $dbPath"
    exit 1
  }
  $dbSize = (Get-Item $dbPath).Length
  Write-Host "[2/5] SQLite database verified at $dbPath ($dbSize bytes): PASS"

  # 3. Renderer Smoke Report Guard
  if ($null -eq $report) {
    Write-Error "Dev Electron renderer smoke-ready report was not generated at '$reportPath' within $timeoutSeconds seconds."
    exit 1
  }
  Write-Host "Dev Renderer Smoke Report: $(ConvertTo-Json $report -Compress)"

  if ($report.status -ne 'READY') {
    Write-Error "Dev renderer reported failure status: $($report.status)"
    exit 1
  }
  Write-Host "[3/5] Dev Renderer Status: READY: PASS"

  # 4. Dev URL Guard
  if (-not $report.rendererUrl.StartsWith("http://localhost:5173")) {
    Write-Error "Dev renderer loaded unexpected URL '$($report.rendererUrl)'. Expected http://localhost:5173."
    exit 1
  }
  Write-Host "[4/5] Dev Renderer URL ($($report.rendererUrl)): PASS"

  # 5. DOM #root and Children Guard
  if (-not $report.rootExists -or $report.rootChildCount -le 0) {
    Write-Error "Dev renderer failed to mount React UI: rootExists=$($report.rootExists), rootChildCount=$($report.rootChildCount)"
    exit 1
  }
  Write-Host "[5/5] Dev React Root rendered ($($report.rootChildCount) child elements): PASS"

  Write-Host "=== Development Electron Window Smoke Test: SUCCESS ==="

} finally {
  # Clean up Electron process
  if ($null -ne $electronProc -and -not $electronProc.HasExited) {
    Write-Host "Terminating Dev Electron process $($electronProc.Id)..."
    try {
      $electronProc.CloseMainWindow() | Out-Null
      $electronProc.WaitForExit(3000)
    } catch {}

    if (-not $electronProc.HasExited) {
      try {
        $electronProc.Kill()
        $electronProc.WaitForExit(2000)
      } catch {}
    }
  }

  # Clean up Vite dev server
  if ($null -ne $viteProc -and -not $viteProc.HasExited) {
    Write-Host "Terminating Vite dev server process tree ($($viteProc.Id))..."
    try {
      & taskkill /F /T /PID $viteProc.Id | Out-Null
    } catch {}
  }

  # Clean temporary smoke data
  if (Test-Path $tempAppData) {
    try {
      Remove-Item -Recurse -Force $tempAppData -ErrorAction SilentlyContinue
    } catch {}
  }

  # Step 6: Restore native dependencies for host Node / Vitest
  Write-Host "Restoring native dependencies for host Node runtime..."
  & npm rebuild better-sqlite3
  if ($LASTEXITCODE -ne 0) {
    Write-Error "FATAL: Failed to restore native dependencies for host Node runtime (exit code: $LASTEXITCODE)."
    exit 1
  }
  Write-Host "Host Node native dependency ABI successfully restored: PASS"
}

exit 0
