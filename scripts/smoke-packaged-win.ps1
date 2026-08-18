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
  Write-Host "[6/7] UpdateService initialized & App Version verified ($($report.appVersion)): PASS"

  # 7. Window Handle & Title Inspection (Local/Interactive Mode)
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
    Write-Host "[7/7] Window title verified ('$($report.windowTitle)') with handle ($handle): PASS"
  } else {
    Write-Host "[7/7] Headless mode: verified window title from Electron main report ('$($report.windowTitle)'): PASS"
  }

  Write-Host "=== Packaged Runtime Smoke Test: SUCCESS (All 7 Gates Passed) ==="

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
}

exit 0
