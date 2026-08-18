<#
.SYNOPSIS
  Deterministic Windows packaged runtime smoke test for AgentForge.
.DESCRIPTION
  Launches the unpacked packaged AgentForge executable under an isolated temporary data directory,
  verifies process stability, SQLite initialization under Electron, and clean termination.
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

try {
  $env:APPDATA = $tempAppData
  $env:LOCALAPPDATA = $tempAppData
  $env:AGENT_FORGE_DATA_DIR = $tempAppData

  Write-Host "Launching packaged AgentForge process..."
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $exePath
  $startInfo.WorkingDirectory = $tempAppData
  $startInfo.EnvironmentVariables["APPDATA"] = $tempAppData
  $startInfo.EnvironmentVariables["LOCALAPPDATA"] = $tempAppData
  $startInfo.EnvironmentVariables["AGENT_FORGE_DATA_DIR"] = $tempAppData
  $startInfo.UseShellExecute = $false

  $proc = [System.Diagnostics.Process]::Start($startInfo)

  if ($null -eq $proc) {
    Write-Error "Failed to spawn process '$exePath'."
    exit 1
  }

  Write-Host "Process spawned with PID: $($proc.Id)"

  # Wait for startup and SQLite bootstrap
  $timeoutSeconds = 8
  $elapsed = 0

  Write-Host "Waiting for SQLite initialization and window startup ($timeoutSeconds seconds)..."
  while ($elapsed -lt $timeoutSeconds) {
    Start-Sleep -Seconds 1
    $elapsed++

    if ($proc.HasExited) {
      Write-Error "Process $($proc.Id) crashed/exited prematurely with exit code: $($proc.ExitCode)"
      exit 1
    }

    if (Test-Path $dbPath) {
      Write-Host "Durable SQLite database detected at: $dbPath"
      break
    }
  }

  # Verify process is still alive
  if ($proc.HasExited) {
    Write-Error "Packaged process exited unexpectedly with code $($proc.ExitCode)."
    exit 1
  }
  Write-Host "Process $($proc.Id) is running and stable (no crash)."

  # Verify SQLite database was created
  if (-not (Test-Path $dbPath)) {
    Write-Error "SQLite database was not created at '$dbPath' during bootstrap interval."
    exit 1
  }

  $dbSize = (Get-Item $dbPath).Length
  Write-Host "SQLite database file verified (size: $dbSize bytes)."

  # Verify window title if in interactive mode
  if (-not $Headless -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $windowTitle = $proc.MainWindowTitle
    Write-Host "Main Window Title: '$windowTitle'"
  }

  Write-Host "Packaged runtime smoke test: SUCCESS."

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

  # Clean temporary smoke data
  if (Test-Path $tempAppData) {
    try {
      Remove-Item -Recurse -Force $tempAppData -ErrorAction SilentlyContinue
    } catch {}
  }
}

exit 0
