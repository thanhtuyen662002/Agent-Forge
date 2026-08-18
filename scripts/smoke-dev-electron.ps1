<#
.SYNOPSIS
  Development Electron window smoke test against Vite dev server.
#>
param(
  [switch]$Headless = $false
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

Write-Host "=== AgentForge Development Electron Smoke Test ==="

# Step 1: Build Electron main & preload
Write-Host "Building Electron main & preload..."
& npm run build
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to build Electron scripts"
  exit 1
}

# Step 2: Rebuild better-sqlite3 for Electron
Write-Host "Configuring native dependencies for Electron..."
& npx @electron/rebuild -f -w better-sqlite3 -v 34.5.8
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to rebuild better-sqlite3 for Electron"
  exit 1
}

# Step 3: Start Vite Dev Server in background
Write-Host "Starting Vite dev server..."
$viteProcInfo = New-Object System.Diagnostics.ProcessStartInfo
$viteProcInfo.FileName = "cmd.exe"
$viteProcInfo.Arguments = "/c npm run dev"
$viteProcInfo.WorkingDirectory = $projectRoot
$viteProcInfo.UseShellExecute = $false

$viteProc = [System.Diagnostics.Process]::Start($viteProcInfo)

# Step 4: Create isolated temp data directory
$smokeId = [Guid]::NewGuid().ToString()
$tempAppData = Join-Path ([System.IO.Path]::GetTempPath()) "agent-forge-dev-smoke-$smokeId"
New-Item -ItemType Directory -Path $tempAppData -Force | Out-Null

$electronProc = $null

try {
  # Wait for Vite dev server
  Start-Sleep -Seconds 4

  Write-Host "Launching Development Electron..."
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = "cmd.exe"
  $startInfo.Arguments = "/c npx electron ."
  $startInfo.WorkingDirectory = $projectRoot
  $startInfo.EnvironmentVariables["AGENT_FORGE_DATA_DIR"] = $tempAppData
  $startInfo.EnvironmentVariables["VITE_DEV_SERVER_URL"] = "http://localhost:5173"
  $startInfo.UseShellExecute = $false

  $electronProc = [System.Diagnostics.Process]::Start($startInfo)

  Start-Sleep -Seconds 6

  $dbPath = Join-Path $tempAppData "database\agent-forge.db"
  if (-not (Test-Path $dbPath)) {
    Write-Error "Dev Electron failed to initialize database at $dbPath"
    exit 1
  }

  Write-Host "Dev Electron verified: SQLite initialized at $dbPath"
  Write-Host "Dev Electron window smoke test: SUCCESS."

} finally {
  # Clean up Electron
  if ($null -ne $electronProc -and -not $electronProc.HasExited) {
    try {
      & taskkill /F /T /PID $electronProc.Id | Out-Null
    } catch {}
  }
  # Clean up Vite
  if ($null -ne $viteProc -and -not $viteProc.HasExited) {
    try {
      & taskkill /F /T /PID $viteProc.Id | Out-Null
    } catch {}
  }
  # Clean temp data
  if (Test-Path $tempAppData) {
    try {
      Remove-Item -Recurse -Force $tempAppData -ErrorAction SilentlyContinue
    } catch {}
  }
  # Rebuild native modules back for Node/Vitest
  Write-Host "Restoring native dependencies for Node..."
  & npm rebuild better-sqlite3
}

exit 0
