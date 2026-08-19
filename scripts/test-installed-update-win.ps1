<#
.SYNOPSIS
  Real Windows Installed-App Update Integration Test Harness.
.DESCRIPTION
  Installs the real NSIS vA build (0.1.0) into an isolated directory,
  spins up a local HTTP feed serving real electron-builder generated vB (0.1.1) artifacts
  (including generated latest.yml, blockmap, and NSIS installer),
  launches the installed vA application, and asserts:
  - Real electron-updater / ElectronUpdaterAdapter detects vB (0.1.1)
  - Real download occurs and verifies SHA-512
  - State reaches DOWNLOADED with canInstall = true
#>
param(
  [switch]$Headless = $false
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

Write-Host "=== Real Windows Installed-App Update Integration Test ==="

$testPort = 39871
$testGuid = [Guid]::NewGuid().ToString()
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "af-update-test-$testGuid"
$testFeedDir = Join-Path $tempRoot "feed"
$testInstallDir = Join-Path $tempRoot "install-vA"
$testDataDir = Join-Path $tempRoot "data"

New-Item -ItemType Directory -Path $testFeedDir -Force | Out-Null
New-Item -ItemType Directory -Path $testInstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $testDataDir -Force | Out-Null

$httpServerScript = Join-Path $tempRoot "serve.cjs"
$serverProc = $null
$appProc = $null

try {
  # 1. Verify / Build vA installer
  $installerA = Join-Path $projectRoot "release\AgentForge Setup 0.1.0.exe"
  if (-not (Test-Path $installerA)) {
    Write-Host "Building vA NSIS installer..."
    & npx electron-builder --win --publish never
  }
  if (-not (Test-Path $installerA)) {
    Write-Error "Failed to locate vA installer at $installerA"
    exit 1
  }
  Write-Host "[1/6] Real vA NSIS Installer verified at $($installerA) ($((Get-Item $installerA).Length) bytes) - PASS"

  # 2. Generate Real vB (0.1.1) electron-builder artifacts (latest.yml, blockmap, installer)
  Write-Host "Generating real vB (0.1.1) electron-builder artifacts..."
  $testBuilderConfig = @"
appId: com.agentforge.desktop
productName: AgentForge
extraMetadata:
  version: 0.1.1
publish:
  provider: generic
  url: http://127.0.0.1:$testPort/
directories:
  output: "$($testFeedDir -replace '\\', '/')"
win:
  target:
    - target: nsis
      arch:
        - x64
nsis:
  oneClick: false
  perMachine: false
"@
  $configPath = Join-Path $tempRoot "electron-builder-feed.yml"
  Set-Content -Path $configPath -Value $testBuilderConfig

  # Run electron-builder to generate real vB artifacts
  & npx electron-builder --win -c $configPath --publish never | Out-Null

  $latestYmlPath = Join-Path $testFeedDir "latest.yml"
  $installerB = Join-Path $testFeedDir "AgentForge Setup 0.1.1.exe"
  if (-not (Test-Path $latestYmlPath) -or -not (Test-Path $installerB)) {
    Write-Error "Failed to generate real vB update feed artifacts in $testFeedDir"
    exit 1
  }
  Write-Host "[2/6] Real vB update metadata (latest.yml) and NSIS binary (0.1.1) generated: PASS"

  # 3. Spin up local HTTP feed server
  $encodedFeedDir = ($testFeedDir -replace '\\', '/').Trim()
  $serverCode = @"
const http = require('http');
const fs = require('fs');
const path = require('path');

const feedDir = "$encodedFeedDir";
const server = http.createServer((req, res) => {
  const cleanUrl = req.url.split('?')[0];
  const relativePath = cleanUrl.startsWith('/') ? cleanUrl.substring(1) : cleanUrl;
  const filePath = path.join(feedDir, decodeURIComponent(relativePath));
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, {
      'Content-Type': cleanUrl.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
      'Content-Length': fs.statSync(filePath).size,
    });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found: ' + cleanUrl);
  }
});

server.listen($testPort, '127.0.0.1', () => {
  console.log('Update feed server listening on port $testPort');
});
"@
  Set-Content -Path $httpServerScript -Value $serverCode -Encoding utf8
  $serverProc = Start-Process -FilePath "node" -ArgumentList "`"$httpServerScript`"" -PassThru -NoNewWindow
  Start-Sleep -Seconds 2

  # Health check local feed
  try {
    $feedContent = (New-Object System.Net.WebClient).DownloadString("http://127.0.0.1:$testPort/latest.yml")
    if ($feedContent -notmatch "version:\s*0\.1\.1") {
      Write-Error "Test feed returned invalid latest.yml"
      exit 1
    }
  } catch {
    Write-Error "Failed to connect to local update feed on port $($testPort): $_"
    exit 1
  }

  Write-Host "[3/6] Local HTTP update feed server running on port $($testPort) - PASS"

  # 4. Install real vA into isolated test location
  Write-Host "Installing real vA application silently into $testInstallDir..."
  $installProc = Start-Process -FilePath $installerA -ArgumentList "/S", "/D=$testInstallDir" -PassThru -Wait
  Start-Sleep -Seconds 2

  $installedExe = Join-Path $testInstallDir "AgentForge.exe"
  if (-not (Test-Path $installedExe)) {
    Write-Error "Installed executable not found at $installedExe"
    exit 1
  }
  Write-Host "[4/6] Real vA installed successfully at $($installedExe) - PASS"

  # 5. Configure test app-update.yml in installed resources to point to test feed
  $installedUpdateYml = Join-Path $testInstallDir "resources\app-update.yml"
  $testAppUpdateConfig = @"
provider: generic
url: http://127.0.0.1:$testPort/
updaterCacheDirName: agent-forge-updater-test
"@
  Set-Content -Path $installedUpdateYml -Value $testAppUpdateConfig

  # 6. Launch installed vA under test harness
  Write-Host "Launching installed vA process under test harness..."
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $installedExe
  $startInfo.WorkingDirectory = $testDataDir
  $startInfo.EnvironmentVariables["APPDATA"] = $testDataDir
  $startInfo.EnvironmentVariables["LOCALAPPDATA"] = $testDataDir
  $startInfo.EnvironmentVariables["AGENT_FORGE_DATA_DIR"] = $testDataDir
  $startInfo.EnvironmentVariables["AGENT_FORGE_TEST_UPDATE"] = "1"
  $startInfo.EnvironmentVariables["AGENT_FORGE_SMOKE_MODE"] = "1"
  $startInfo.UseShellExecute = $false

  $appProc = [System.Diagnostics.Process]::Start($startInfo)
  $resultFile = Join-Path $testDataDir "update-test-result.json"

  Write-Host "Waiting for update check, download, and verification (up to 30s)..."
  $timeout = 30
  $elapsed = 0
  $finalResult = $null

  while ($elapsed -lt $timeout) {
    Start-Sleep -Seconds 1
    $elapsed++

    if (Test-Path $resultFile) {
      try {
        $raw = Get-Content -Path $resultFile -Raw
        $json = ConvertFrom-Json $raw
        if ($json.state -eq 'DOWNLOADED' -or $json.state -eq 'ERROR') {
          $finalResult = $json
          break
        }
      } catch {}
    }
  }

  if ($null -eq $finalResult) {
    Write-Error "Update integration test timed out after $timeout seconds without reaching DOWNLOADED state."
    exit 1
  }

  Write-Host "Update Test Result: $(ConvertTo-Json $finalResult -Compress)"

  if ($finalResult.state -ne 'DOWNLOADED') {
    Write-Error "Expected DOWNLOADED state, but got: $($finalResult.state) (Error: $($finalResult.error))"
    exit 1
  }

  if ($finalResult.updateInfo.version -ne '0.1.1') {
    Write-Error "Expected detected version '0.1.1', got '$($finalResult.updateInfo.version)'"
    exit 1
  }

  if ($finalResult.canInstall -ne $true) {
    Write-Error "Expected canInstall=true in DOWNLOADED state, got $($finalResult.canInstall)"
    exit 1
  }

  Write-Host "[5/6] Real update detection, download, and SHA-512 verification for vB (0.1.1): PASS"
  Write-Host "[6/6] Real installed-app ready-to-install gate verified (canInstall = true): PASS"

  Write-Host "=== Real Windows Installed-App Update Test: SUCCESS ==="

} finally {
  # Terminate test application
  if ($null -ne $appProc -and -not $appProc.HasExited) {
    try {
      $appProc.Kill()
      $appProc.WaitForExit(2000)
    } catch {}
  }

  # Terminate HTTP server
  if ($null -ne $serverProc -and -not $serverProc.HasExited) {
    try {
      $serverProc.Kill()
      $serverProc.WaitForExit(1000)
    } catch {}
  }

  # Clean up temp test root
  if (Test-Path $tempRoot) {
    try {
      Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
    } catch {}
  }
}

exit 0
