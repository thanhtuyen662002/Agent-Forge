# Real Windows Installed Application Update Integration Test Harness
# Architecture: Isolated Test-Only Packaging with Dedicated Minimal Entrypoint
# Production Invariants: Zero modifications to production source or entrypoints.

param(
  [switch]$Headless = $false
)

$ErrorActionPreference = "Stop"

# Paths and Constants
$projectRoot = Split-Path -Parent $PSScriptRoot
$diagDir = Join-Path $projectRoot "release\installed-update-test\diagnostics"
$testPort = 39871
$testAppId = "com.agentforge.desktop.update-integration"
$testProductName = "AgentForge Update Integration"
$feedUrl = "http://127.0.0.1:$testPort/"

# Prepare stable diagnostic directory
if (Test-Path $diagDir) {
  Remove-Item -Path $diagDir -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $diagDir -Force | Out-Null

$diagLogPath = Join-Path $diagDir "diagnostics.log"

function Log-Diag([string]$msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ')] $msg"
  Write-Host $line
  Add-Content -Path $diagLogPath -Value $line -Encoding utf8
}

# Structured Diagnostics Data Container
$diagData = [ordered]@{
  stage = "INITIALIZATION"
  testConfig = @{
    port = $testPort
    appId = $testAppId
    productName = $testProductName
    feedUrl = $feedUrl
    platform = "win32"
  }
  installerVaPath = $null
  installerVbPath = $null
  installerVaSha256 = $null
  installerVbSha256 = $null
  installerCommand = $null
  installerExitCode = $null
  requestedInstallPath = $null
  discoveredInstallPath = $null
  installedDirListing = @()
  registryInfo = $null
  installedExePath = $null
  installedAppUpdateYmlContent = $null
  installedAppUpdateYmlSha256 = $null
  feedUrl = $feedUrl
  latestYmlProbeStatus = $null
  installerFeedProbeStatus = $null
  installerFeedContentLength = $null
  blockmapProbeStatus = $null
  feedSha512Valid = $false
  electronExitCode = $null
  updateEventSequence = @()
  updateResult = $null
  failure = $null
  timestamp = (Get-Date -Format "o")
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Save-Diagnostics {
  try {
    $diagJsonPath = Join-Path $diagDir "diagnostics.json"
    $diagData.timestamp = (Get-Date -Format "o")
    $jsonContent = ConvertTo-Json -InputObject $diagData -Depth 5
    [System.IO.File]::WriteAllText($diagJsonPath, $jsonContent, $utf8NoBom)
  } catch {
    try {
      $fallback = "{`"stage`":`"$($diagData.stage)`",`"timestamp`":`"$((Get-Date -Format 'o'))`",`"failure`":`"$($diagData.failure)`"}"
      [System.IO.File]::WriteAllText($diagJsonPath, $fallback, $utf8NoBom)
    } catch {}
  }
}

function Get-Sha256Hex {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      $bytes = $sha256.ComputeHash($stream)
    }
    finally {
      $stream.Dispose()
    }
  }
  finally {
    $sha256.Dispose()
  }

  return ([System.BitConverter]::ToString($bytes)).Replace('-', '')
}

$tempRoot = $null
$feedServerProc = $null
$feedServerScript = $null

try {
  $env:NODE_OPTIONS = "--max-old-space-size=4096"
  Log-Diag "=== Phase 1: Initializing Windows Installed Update Integration Harness ==="
  $diagData.stage = "SETUP_TEST_CONTEXT"
  Save-Diagnostics

  # Create isolated scratch working directories on the same drive/volume as project root
  $tempRoot = Join-Path $projectRoot ("release\installed-update-test\temp-" + [Guid]::NewGuid().ToString())
  $tempAppDirA = Join-Path $tempRoot "app-vA"
  $tempOutDirA = Join-Path $tempRoot "out-vA"
  $tempAppDirB = Join-Path $tempRoot "app-vB"
  $testFeedDir = Join-Path $tempRoot "feed"
  $testInstallDir = Join-Path $tempRoot "installed-vA"
  $testDataDir = Join-Path $tempRoot "data"

  New-Item -ItemType Directory -Path $tempAppDirA -Force | Out-Null
  New-Item -ItemType Directory -Path $tempOutDirA -Force | Out-Null
  New-Item -ItemType Directory -Path $tempAppDirB -Force | Out-Null
  New-Item -ItemType Directory -Path $testFeedDir -Force | Out-Null
  New-Item -ItemType Directory -Path $testInstallDir -Force | Out-Null
  New-Item -ItemType Directory -Path $testDataDir -Force | Out-Null

  $diagData.requestedInstallPath = $testInstallDir

  # -------------------------------------------------------------------------
  # Phase 2 & 3: Generate Dedicated Test Entrypoint in Isolated Context vA
  # -------------------------------------------------------------------------
  Log-Diag "[1/6] Preparing isolated packaging context for TEST Artifact vA..."
  $diagData.stage = "BUILD_TEST_VA"

  Copy-Item -Path "$projectRoot\package.json" -Destination "$tempAppDirA\package.json"
  if (Test-Path "$projectRoot\package-lock.json") {
    Copy-Item -Path "$projectRoot\package-lock.json" -Destination "$tempAppDirA\package-lock.json"
  }
  Copy-Item -Path "$projectRoot\dist" -Destination "$tempAppDirA\dist" -Recurse
  Copy-Item -Path "$projectRoot\dist-electron" -Destination "$tempAppDirA\dist-electron" -Recurse
  cmd /c mklink /J "$tempAppDirA\node_modules" "$projectRoot\node_modules" | Out-Null

  # Write dedicated test-only Electron entrypoint
  $dedicatedEntryPath = Join-Path $tempAppDirA "dist-electron\electron\updateIntegrationMain.cjs"
  $dedicatedEntryCode = @"
const fs = require('fs');
const path = require('path');

const dataDir = process.env.AGENT_FORGE_DATA_DIR || process.cwd();

try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch (e) {}

const resultPath = path.join(dataDir, 'update-test-result.json');
const debugLogPath = path.join(dataDir, 'update-test-debug.log');

const eventLog = [];

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(debugLogPath, line + '\n', 'utf-8');
  } catch (e) {}
}

function writeResult(result) {
  try {
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');
  } catch (e) {
    log('Failed to write result file: ' + String(e));
  }
}

process.on('uncaughtException', (err) => {
  log('Uncaught Exception: ' + (err && err.stack ? err.stack : String(err)));
  writeResult({
    state: 'ERROR',
    error: (err && err.stack ? err.stack : String(err)),
    eventLog,
    stage: 'UNCAUGHT_EXCEPTION',
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('Unhandled Rejection: ' + (reason && reason.stack ? reason.stack : String(reason)));
  writeResult({
    state: 'ERROR',
    error: (reason && reason.stack ? reason.stack : String(reason)),
    eventLog,
    stage: 'UNHANDLED_REJECTION',
  });
  process.exit(1);
});

log('Dedicated update integration main process loaded. dataDir: ' + dataDir);

const { app } = require('electron');
log('Electron module loaded. app.isPackaged: ' + app.isPackaged);

const { UpdateService } = require('../core/services/UpdateService');
log('UpdateService module loaded.');

const { ElectronUpdaterAdapter } = require('./updaterAdapter');
log('ElectronUpdaterAdapter module loaded.');

app.whenReady().then(async () => {
  log('app.whenReady resolved.');

  const timeoutTimer = setTimeout(() => {
    log('Dedicated integration runner timeout reached (45s).');
    writeResult({
      state: 'ERROR',
      error: 'TIMEOUT_IN_DEDICATED_RUNNER',
      eventLog,
      stage: 'RUNNER_TIMEOUT',
    });
    app.exit(1);
  }, 45000);

  try {
    const adapter = new ElectronUpdaterAdapter();
    const service = new UpdateService({
      currentVersion: typeof app.getVersion === 'function' ? app.getVersion() : '0.1.0',
      isPackaged: app.isPackaged,
      isCodeSigned: false,
      adapter: adapter,
    });

    service.on('state-changed', async (summary) => {
      const entry = {
        state: summary.state,
        canInstall: summary.canInstall,
        progress: summary.progress ? summary.progress.percent : null,
        error: summary.error,
        timestamp: new Date().toISOString(),
      };
      eventLog.push(entry);
      log('State changed: ' + JSON.stringify(summary));

      writeResult({
        ...summary,
        eventLog,
      });

      if (summary.state === 'UPDATE_AVAILABLE') {
        log('State is UPDATE_AVAILABLE. Triggering explicit downloadUpdate()...');
        try {
          await service.downloadUpdate();
        } catch (err) {
          log('downloadUpdate threw error: ' + String(err));
          writeResult({
            state: 'ERROR',
            error: String(err),
            eventLog,
            stage: 'DOWNLOAD_UPDATE',
          });
          clearTimeout(timeoutTimer);
          app.exit(1);
        }
      } else if (summary.state === 'DOWNLOADED') {
        log('State is DOWNLOADED (canInstall=' + summary.canInstall + '). Final update state reached!');
        writeResult({
          state: 'DOWNLOADED',
          currentVersion: summary.currentVersion,
          updateInfo: summary.updateInfo,
          canInstall: summary.canInstall,
          progress: summary.progress,
          eventLog,
          success: true,
        });
        clearTimeout(timeoutTimer);
        setTimeout(() => {
          app.exit(0);
        }, 100);
      } else if (summary.state === 'ERROR') {
        log('State is ERROR: ' + summary.error);
        clearTimeout(timeoutTimer);
        app.exit(1);
      }
    });

    log('Triggering initial checkForUpdates()...');
    writeResult({ state: 'CHECKING', eventLog });
    await service.checkForUpdates();
  } catch (err) {
    log('Exception in initialization flow: ' + (err && err.stack ? err.stack : String(err)));
    clearTimeout(timeoutTimer);
    writeResult({
      state: 'ERROR',
      error: String(err),
      eventLog,
      stage: 'INIT_EXCEPTION',
    });
    app.exit(1);
  }
});
"@
  [System.IO.File]::WriteAllText($dedicatedEntryPath, $dedicatedEntryCode, $utf8NoBom)

  # Point ONLY the isolated temporary package.json to the dedicated entrypoint
  $pkgA = Get-Content -Path "$tempAppDirA\package.json" -Raw | ConvertFrom-Json
  $pkgA.main = "dist-electron/electron/updateIntegrationMain.cjs"
  [System.IO.File]::WriteAllText("$tempAppDirA\package.json", ($pkgA | ConvertTo-Json -Depth 10), $utf8NoBom)

  # Ensure native bindings are prepared
  Log-Diag "Ensuring native bindings for Electron..."
  & cmd.exe /c "npx @electron/rebuild -f -w better-sqlite3 2>&1" | Out-Null

  $configPathA = Join-Path $tempRoot "builder-vA.yml"
  $builderConfigA = @"
appId: $testAppId
productName: $testProductName
npmRebuild: false
publish:
  provider: generic
  url: $feedUrl
directories:
  output: "$($tempOutDirA -replace '\\', '/')"
files:
  - dist/**
  - dist-electron/**
  - package.json
  - node_modules/**
asar: true
asarUnpack:
  - node_modules/better-sqlite3/**
win:
  target:
    - target: nsis
      arch:
        - x64
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  runAfterFinish: false
"@
  [System.IO.File]::WriteAllText($configPathA, $builderConfigA, $utf8NoBom)

  Log-Diag "Building real NSIS installer for TEST Artifact vA..."
  $buildOutA = & cmd.exe /c "npx electron-builder --win -c `"$configPathA`" --project `"$tempAppDirA`" --publish never 2>&1"
  if ($LASTEXITCODE -ne 0) {
    throw "electron-builder vA failed with exit code $($LASTEXITCODE): $buildOutA"
  }

  $installerA = Join-Path $tempOutDirA "$testProductName Setup 0.1.0.exe"
  if (-not (Test-Path $installerA)) {
    throw "Failed to generate TEST vA installer at $installerA"
  }
  $diagData.installerVaPath = $installerA
  $diagData.installerVaSha256 = Get-Sha256Hex -Path $installerA
  Log-Diag "[1/6] Real TEST vA NSIS Installer generated ($($diagData.installerVaSha256)): PASS"
  Save-Diagnostics

  # -------------------------------------------------------------------------
  # Phase 3: Build Real TEST Artifact vB (0.1.1) in Isolated Context
  # -------------------------------------------------------------------------
  Log-Diag "[2/6] Generating real vB (0.1.1) electron-builder artifacts..."
  $diagData.stage = "BUILD_TEST_VB"

  Copy-Item -Path "$projectRoot\package.json" -Destination "$tempAppDirB\package.json"
  if (Test-Path "$projectRoot\package-lock.json") {
    Copy-Item -Path "$projectRoot\package-lock.json" -Destination "$tempAppDirB\package-lock.json"
  }
  Copy-Item -Path "$projectRoot\dist" -Destination "$tempAppDirB\dist" -Recurse
  Copy-Item -Path "$projectRoot\dist-electron" -Destination "$tempAppDirB\dist-electron" -Recurse
  cmd /c mklink /J "$tempAppDirB\node_modules" "$projectRoot\node_modules" | Out-Null

  $configPathB = Join-Path $tempRoot "builder-vB.yml"
  $builderConfigB = @"
appId: $testAppId
productName: $testProductName
npmRebuild: false
extraMetadata:
  version: 0.1.1
publish:
  provider: generic
  url: $feedUrl
directories:
  output: "$($testFeedDir -replace '\\', '/')"
files:
  - dist/**
  - dist-electron/**
  - package.json
  - node_modules/**
asar: true
asarUnpack:
  - node_modules/better-sqlite3/**
win:
  target:
    - target: nsis
      arch:
        - x64
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  runAfterFinish: false
"@
  [System.IO.File]::WriteAllText($configPathB, $builderConfigB, $utf8NoBom)

  $buildOutB = & cmd.exe /c "npx electron-builder --win -c `"$configPathB`" --project `"$tempAppDirB`" --publish never 2>&1"
  if ($LASTEXITCODE -ne 0) {
    throw "electron-builder vB failed with exit code $($LASTEXITCODE): $buildOutB"
  }

  $latestYmlPath = Join-Path $testFeedDir "latest.yml"
  $installerB = Join-Path $testFeedDir "$testProductName Setup 0.1.1.exe"
  $blockmapB = Join-Path $testFeedDir "$testProductName Setup 0.1.1.exe.blockmap"

  if (-not (Test-Path $latestYmlPath) -or -not (Test-Path $installerB) -or -not (Test-Path $blockmapB)) {
    throw "Failed to generate full vB update artifacts in $testFeedDir"
  }

  $diagData.installerVbPath = $installerB
  $diagData.installerVbSha256 = Get-Sha256Hex -Path $installerB
  Copy-Item -Path $latestYmlPath -Destination (Join-Path $diagDir "feed-latest.yml") -Force
  Log-Diag "[2/6] Real vB update metadata (latest.yml), NSIS binary, and blockmap generated: PASS"
  Save-Diagnostics

  # -------------------------------------------------------------------------
  # Phase 5: Start Local HTTP Update Feed Server and Execute Preflight Probes
  # -------------------------------------------------------------------------
  Log-Diag "[3/6] Starting local HTTP update feed server and preflighting probes..."
  $diagData.stage = "FEED_PREFLIGHT"

  # Clean up any lingering process on testPort
  $netstat = netstat -ano | Select-String ":$testPort\s+.*LISTENING\s+(\d+)"
  if ($netstat) {
    foreach ($line in $netstat) {
      if ($line -match ":$testPort\s+.*LISTENING\s+(\d+)") {
        $pidToKill = [int]$Matches[1]
        Log-Diag "Terminating previous listener PID $pidToKill on port $testPort..."
        Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Seconds 1
  }

  $encodedFeedDir = $testFeedDir -replace '\\', '/'
  $feedServerScript = Join-Path $tempRoot "feed-server.cjs"
  $feedServerCode = @"
const http = require('http');
const fs = require('fs');
const path = require('path');

const FEED_DIR = path.resolve('$encodedFeedDir');
const PORT = $testPort;

const MIME_TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.blockmap': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const cleanUrl = decodeURIComponent(req.url.split('?')[0]);
  const relativePath = cleanUrl.replace(/^\/+/, '');
  const filePath = path.resolve(FEED_DIR, relativePath);

  if (!filePath.startsWith(FEED_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not Found: ' + cleanUrl);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Accept-Ranges': 'bytes'
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Update feed server listening on port ' + PORT);
});
"@
  [System.IO.File]::WriteAllText($feedServerScript, $feedServerCode, $utf8NoBom)

  $feedServerProc = Start-Process -FilePath "node" -ArgumentList "`"$feedServerScript`"" -PassThru
  Start-Sleep -Seconds 2

  # Probe 1: latest.yml (with cache-busting)
  $cacheBust = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $probeLatest = Invoke-WebRequest -Uri "http://127.0.0.1:$testPort/latest.yml?_cb=$cacheBust" -UseBasicParsing -TimeoutSec 10
  $diagData.latestYmlProbeStatus = [int]$probeLatest.StatusCode
  if ($probeLatest.StatusCode -ne 200) {
    throw "Feed preflight failed: latest.yml returned status $($probeLatest.StatusCode)"
  }

  # Parse latest.yml
  $latestContent = if ($probeLatest.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($probeLatest.Content) } else { [string]$probeLatest.Content }
  if ($latestContent -notmatch "version:\s*([0-9\.]+)") {
    throw "Feed preflight failed: unable to parse version from latest.yml"
  }
  $feedVersion = $Matches[1]
  if ($feedVersion -ne "0.1.1") {
    throw "Feed preflight failed: unexpected version $feedVersion in latest.yml"
  }

  # Probe 2: Real vB Installer (HEAD probe for fast byte-accurate metadata)
  $vBFilename = [System.Uri]::EscapeDataString("$testProductName Setup 0.1.1.exe")
  $probeExe = Invoke-WebRequest -Uri "http://127.0.0.1:$testPort/$vBFilename" -Method Head -UseBasicParsing -TimeoutSec 10
  $diagData.installerFeedProbeStatus = [int]$probeExe.StatusCode
  $installerLength = if ($probeExe.Headers["Content-Length"]) { [int64]$probeExe.Headers["Content-Length"] } else { $probeExe.RawContentLength }
  $diagData.installerFeedContentLength = $installerLength
  if ($probeExe.StatusCode -ne 200 -or $installerLength -le 0) {
    throw "Feed preflight failed: vB installer probe returned status $($probeExe.StatusCode) length $installerLength"
  }

  # Probe 3: Blockmap
  $blockmapFilename = [System.Uri]::EscapeDataString("$testProductName Setup 0.1.1.exe.blockmap")
  $probeBlockmap = Invoke-WebRequest -Uri "http://127.0.0.1:$testPort/$blockmapFilename" -UseBasicParsing -TimeoutSec 10
  $diagData.blockmapProbeStatus = [int]$probeBlockmap.StatusCode
  if ($probeBlockmap.StatusCode -ne 200) {
    throw "Feed preflight failed: blockmap probe returned status $($probeBlockmap.StatusCode)"
  }

  # Verify SHA-512 match against latest.yml
  $hasher = [System.Security.Cryptography.SHA512]::Create()
  $fileBytes = [System.IO.File]::ReadAllBytes($installerB)
  $expectedSha512Base64 = [Convert]::ToBase64String($hasher.ComputeHash($fileBytes))
  $hasher.Dispose()

  if ($latestContent -notmatch "sha512:\s*([A-Za-z0-9+/=]+)") {
    throw "Feed preflight failed: sha512 not found in latest.yml"
  }
  $latestSha512 = $Matches[1]
  if ($latestSha512 -ne $expectedSha512Base64) {
    throw "Feed preflight failed: SHA512 mismatch (latest.yml=$latestSha512, actual=$expectedSha512Base64)"
  }
  $diagData.feedSha512Valid = $true
  Log-Diag "[3/6] Feed preflight passed: latest.yml (200), vB installer (200), blockmap (200), SHA-512 verified: PASS"
  Save-Diagnostics

  # -------------------------------------------------------------------------
  # Phase 4: Deterministic App Discovery and Verification
  # -------------------------------------------------------------------------
  Log-Diag "[4/6] Installing real TEST vA application silently and discovering install..."
  $diagData.stage = "INSTALL_TEST_VA"

  # Clean any previous installation from requested location
  if (Test-Path $testInstallDir) {
    Remove-Item -Path $testInstallDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Path $testInstallDir -Force | Out-Null

  # Execute NSIS installer silently targeting $testInstallDir (/D MUST be the last parameter without quotes)
  $installerCmd = "`"$installerA`" /S /D=$testInstallDir"
  $diagData.installerCommand = $installerCmd
  Log-Diag "Executing installer command: $installerCmd"

  $installProc = Start-Process -FilePath $installerA -ArgumentList "/S /D=$testInstallDir" -PassThru -Wait
  $diagData.installerExitCode = $installProc.ExitCode
  Log-Diag "Installer finished with exit code: $($installProc.ExitCode)"

  if ($installProc.ExitCode -ne 0) {
    throw "TEST vA NSIS installer failed with non-zero exit code: $($installProc.ExitCode)"
  }

  # Deterministic discovery across requested /D path and per-user default directory
  $possibleLocations = @(
    $testInstallDir,
    (Join-Path $env:LOCALAPPDATA "Programs\$testProductName"),
    (Join-Path $env:ProgramFiles "$testProductName"),
    (Join-Path ${env:ProgramFiles(x86)} "$testProductName")
  )

  $discoveredDir = $null
  $discoveredExe = $null

  foreach ($loc in $possibleLocations) {
    if ($null -ne $loc -and (Test-Path $loc)) {
      $candidateExe = Join-Path $loc "$testProductName.exe"
      $candidateAsar = Join-Path $loc "resources\app.asar"
      if ((Test-Path $candidateExe) -and (Test-Path $candidateAsar)) {
        $discoveredDir = $loc
        $discoveredExe = $candidateExe
        break
      }
    }
  }

  if ($null -eq $discoveredExe) {
    throw "Failed to discover installed TEST vA application with valid resources\app.asar in known paths."
  }

  $diagData.discoveredInstallPath = $discoveredDir
  $diagData.installedExePath = $discoveredExe
  $diagData.installedDirListing = @(Get-ChildItem -Path $discoveredDir -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })

  Log-Diag "[4/6] Real TEST vA installed and discovered at $($discoveredExe): PASS"
  Save-Diagnostics

  # -------------------------------------------------------------------------
  # Phase 4.5: Verify Installed app-update.yml (No Post-Install Rewriting)
  # -------------------------------------------------------------------------
  Log-Diag "[5/6] Verifying installed app-update.yml configuration..."
  $diagData.stage = "VERIFY_APP_UPDATE_YML"

  $installedUpdateYml = Join-Path $discoveredDir "resources\app-update.yml"
  if (-not (Test-Path $installedUpdateYml)) {
    throw "resources\app-update.yml not found in discovered installation at $installedUpdateYml"
  }

  $appUpdateContent = Get-Content -Path $installedUpdateYml -Raw
  $diagData.installedAppUpdateYmlContent = $appUpdateContent
  $diagData.installedAppUpdateYmlSha256 = Get-Sha256Hex -Path $installedUpdateYml
  Copy-Item -Path $installedUpdateYml -Destination (Join-Path $diagDir "installed-app-update.yml") -Force

  if ($appUpdateContent -notmatch "provider:\s*generic" -or $appUpdateContent -notmatch "url:\s*http://127\.0\.0\.1:$testPort/?") {
    throw "Installed app-update.yml does not match build-time generic localhost feed configuration!"
  }

  Log-Diag "[5/6] Installed app-update.yml verified (provider: generic, url: $feedUrl, UNMODIFIED): PASS"
  Save-Diagnostics

  # -------------------------------------------------------------------------
  # Phase 2 & 6: Launch Installed Test vA and Await Event-Driven Completion
  # -------------------------------------------------------------------------
  Log-Diag "[6/6] Launching installed TEST vA and awaiting update download & SHA-512 verification..."
  $diagData.stage = "RUN_UPDATE_INTEGRATION"

  $env:APPDATA = $testDataDir
  $env:LOCALAPPDATA = $testDataDir
  $env:AGENT_FORGE_DATA_DIR = $testDataDir

  $resultFile = Join-Path $testDataDir "update-test-result.json"
  $debugLogFile = Join-Path $testDataDir "update-test-debug.log"

  # Launch installed application
  Log-Diag "Executing installed application: $discoveredExe"
  $proc = Start-Process -FilePath $discoveredExe -ArgumentList "--no-sandbox" -WorkingDirectory $testDataDir -PassThru

  # Await result
  $timeoutSec = 30
  $elapsed = 0
  $finalResult = $null
  $lastState = ""

  while ($elapsed -lt $timeoutSec) {
    if (Test-Path $resultFile) {
      try {
        $raw = Get-Content -Path $resultFile -Raw
        $json = ConvertFrom-Json $raw
        if ($json.state -ne $lastState) {
          $lastState = $json.state
          Log-Diag "  -> Update state transition: $lastState (${elapsed}s elapsed)"
        }
        if ($json.state -eq 'DOWNLOADED' -or $json.state -eq 'ERROR') {
          $finalResult = $json
          break
        }
      } catch {}
    }
    Start-Sleep -Seconds 1
    $elapsed++
  }

  Log-Diag "Installed application execution completed."

  if (Test-Path $resultFile) {
    Copy-Item -Path $resultFile -Destination (Join-Path $diagDir "update-test-result.json") -Force
    $rawFinal = Get-Content -Path $resultFile -Raw
    $finalResult = ConvertFrom-Json $rawFinal
    $diagData.updateResult = $finalResult
    if ($null -ne $finalResult.eventLog) {
      $diagData.updateEventSequence = $finalResult.eventLog
    }
  }

  if (Test-Path $debugLogFile) {
    Copy-Item -Path $debugLogFile -Destination (Join-Path $diagDir "update-test-debug.log") -Force
  }

  if ($null -eq $finalResult -or $finalResult.state -ne 'DOWNLOADED') {
    throw "Update integration test failed to reach DOWNLOADED state (last state: '$lastState', final: '$($finalResult.state)')."
  }

  $diagData.stage = "COMPLETE"
  Log-Diag "=== [6/6] Real Windows Installed Application Update Integration Test PASSED ==="
  Save-Diagnostics
}
catch {
  $errMsg = $_.Exception.Message
  $diagData.failure = $errMsg
  Log-Diag "FATAL ERROR in Update Integration Harness: $errMsg"
  Save-Diagnostics
  throw
}
finally {
  # Cleanup test background processes
  Get-Process -Name "*AgentForge Update Integration*" -ErrorAction SilentlyContinue | Stop-Process -Force
  if ($null -ne $feedServerProc -and -not $feedServerProc.HasExited) {
    Stop-Process -Id $feedServerProc.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
  # Remove temporary build root safely
  if ($null -ne $tempRoot -and (Test-Path $tempRoot)) {
    try {
      [System.GC]::Collect()
      [System.GC]::WaitForPendingFinalizers()
      $juncA = Join-Path $tempRoot "app-vA\node_modules"
      $juncB = Join-Path $tempRoot "app-vB\node_modules"
      if (Test-Path $juncA) { cmd /c rmdir "$juncA" 2>$null | Out-Null }
      if (Test-Path $juncB) { cmd /c rmdir "$juncB" 2>$null | Out-Null }
      Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    } catch {}
  }
}
