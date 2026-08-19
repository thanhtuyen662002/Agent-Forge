<#
.SYNOPSIS
  Real Windows Installed-App Update Integration Test Harness.
.DESCRIPTION
  Builds a dedicated temporary TEST artifact vA with build-time generic localhost feed configuration,
  builds real electron-builder generated vB (0.1.1) artifacts (latest.yml, blockmap, NSIS installer),
  serves the update feed over a local HTTP server,
  silently installs real TEST vA (without post-install configuration rewriting),
  launches the installed vA application, and asserts:
  - Installed app-update.yml contains generic localhost feed from build time
  - Real electron-updater / ElectronUpdaterAdapter detects vB (0.1.1)
  - Real download occurs and verifies SHA-512
  - State reaches DOWNLOADED with canInstall = true
  - Truthful classification: PARTIALLY_AUTOMATED_WITH_MANUAL_FINAL_GATE
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
$tempAppDirA = Join-Path $tempRoot "app-vA"
$tempAppDirB = Join-Path $tempRoot "app-vB"
$tempOutDirA = Join-Path $tempRoot "out-vA"
$testInstallDir = Join-Path $tempRoot "installed-vA"
$testDataDir = Join-Path $tempRoot "data"

New-Item -ItemType Directory -Path $testFeedDir -Force | Out-Null
New-Item -ItemType Directory -Path $tempAppDirA -Force | Out-Null
New-Item -ItemType Directory -Path $tempAppDirB -Force | Out-Null
New-Item -ItemType Directory -Path $tempOutDirA -Force | Out-Null
New-Item -ItemType Directory -Path $testInstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $testDataDir -Force | Out-Null

$httpServerScript = Join-Path $tempRoot "serve.cjs"
$serverProc = $null
$appProc = $null

try {
  # 0. Ensure project build is up to date
  if (-not (Test-Path "$projectRoot\dist\index.html") -or -not (Test-Path "$projectRoot\dist-electron\electron\main.js")) {
    Write-Host "Compiling application build..."
    & npm run build --prefix "$projectRoot"
  }

  # 1. Build TEST Artifact vA with build-time generic local feed configuration
  Write-Host "[1/6] Preparing isolated build context for TEST Artifact vA..."
  Copy-Item -Path "$projectRoot\package.json" -Destination "$tempAppDirA\package.json"
  Copy-Item -Path "$projectRoot\dist" -Destination "$tempAppDirA\dist" -Recurse
  Copy-Item -Path "$projectRoot\dist-electron" -Destination "$tempAppDirA\dist-electron" -Recurse

  # Create junction for node_modules
  cmd /c mklink /J "$tempAppDirA\node_modules" "$projectRoot\node_modules" | Out-Null

  # Inject temporary test-only instrumentation into the isolated TEST copy of main.js
  $testObserverSnippet = @"

// --- TEST-ONLY HARNESS INSTRUMENTATION (ISOLATED IN TEMP TEST ARTIFACT) ---
(function() {
  const electron = require('electron');
  const path = require('path');
  const fs = require('fs');
  electron.app.whenReady().then(() => {
    setTimeout(() => {
      try {
        if (typeof updateServiceInstance !== 'undefined' && updateServiceInstance) {
          const svc = updateServiceInstance;
          const ud = process.env.AGENT_FORGE_DATA_DIR || electron.app.getPath('userData');
          const rPath = path.join(ud, 'update-test-result.json');
          svc.on('state-changed', (st) => {
            try {
              fs.writeFileSync(rPath, JSON.stringify(st, null, 2), 'utf-8');
            } catch (e) {}
            if (st.state === 'UPDATE_AVAILABLE') {
              svc.downloadUpdate().catch((err) => {
                try {
                  fs.writeFileSync(rPath, JSON.stringify({ state: 'ERROR', error: String(err) }, null, 2), 'utf-8');
                } catch (e) {}
              });
            }
          });
          svc.checkForUpdates().catch((err) => {
            try {
              fs.writeFileSync(rPath, JSON.stringify({ state: 'ERROR', error: String(err) }, null, 2), 'utf-8');
            } catch (e) {}
          });
        }
      } catch (err) {
        console.error('[TestInstrumentation] Error:', err);
      }
    }, 1000);
  });
})();
"@
  Add-Content -Path "$tempAppDirA\dist-electron\electron\main.js" -Value $testObserverSnippet -Encoding utf8

  $configPathA = Join-Path $tempRoot "builder-vA.yml"
  $builderConfigA = @"
appId: com.agentforge.desktop
productName: AgentForge
publish:
  provider: generic
  url: http://127.0.0.1:$testPort/
directories:
  output: "$($tempOutDirA -replace '\\', '/')"
files:
  - dist/**
  - dist-electron/**
  - package.json
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
"@
  Set-Content -Path $configPathA -Value $builderConfigA -Encoding utf8

  Write-Host "Building real NSIS installer for TEST Artifact vA..."
  cmd.exe /c "npx electron-builder --win -c `"$configPathA`" --project `"$tempAppDirA`" --publish never" | Out-Null

  $installerA = Join-Path $tempOutDirA "AgentForge Setup 0.1.0.exe"
  if (-not (Test-Path $installerA)) {
    Write-Error "Failed to generate TEST vA installer at $installerA"
    exit 1
  }
  Write-Host "[1/6] Real TEST vA NSIS Installer generated at $($installerA) ($((Get-Item $installerA).Length) bytes): PASS"

  # 2. Generate Real vB (0.1.1) electron-builder artifacts in isolated build context
  Write-Host "[2/6] Generating real vB (0.1.1) electron-builder artifacts..."
  Copy-Item -Path "$projectRoot\package.json" -Destination "$tempAppDirB\package.json"
  Copy-Item -Path "$projectRoot\dist" -Destination "$tempAppDirB\dist" -Recurse
  Copy-Item -Path "$projectRoot\dist-electron" -Destination "$tempAppDirB\dist-electron" -Recurse
  cmd /c mklink /J "$tempAppDirB\node_modules" "$projectRoot\node_modules" | Out-Null

  $configPathB = Join-Path $tempRoot "builder-vB.yml"
  $builderConfigB = @"
appId: com.agentforge.desktop
productName: AgentForge
extraMetadata:
  version: 0.1.1
publish:
  provider: generic
  url: http://127.0.0.1:$testPort/
directories:
  output: "$($testFeedDir -replace '\\', '/')"
files:
  - dist/**
  - dist-electron/**
  - package.json
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
"@
  Set-Content -Path $configPathB -Value $builderConfigB -Encoding utf8

  # Run electron-builder to generate real vB artifacts
  cmd.exe /c "npx electron-builder --win -c `"$configPathB`" --project `"$tempAppDirB`" --publish never" | Out-Null

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

  Write-Host "[3/6] Local HTTP update feed server running on port $($testPort): PASS"

  # 4. Install real TEST vA into isolated test location
  Write-Host "Installing real TEST vA application silently into $testInstallDir..."
  $installProc = Start-Process -FilePath $installerA -ArgumentList "/S", "/D=$testInstallDir" -PassThru -Wait
  Start-Sleep -Seconds 2

  $installedExe = Join-Path $testInstallDir "AgentForge.exe"
  if (-not (Test-Path $installedExe)) {
    Write-Error "Installed executable not found at $installedExe"
    exit 1
  }
  Write-Host "[4/6] Real TEST vA installed successfully at $($installedExe): PASS"

  # 5. Verify installed app-update.yml (NO POST-INSTALL REWRITING)
  $installedUpdateYml = Join-Path $testInstallDir "resources\app-update.yml"
  if (-not (Test-Path $installedUpdateYml)) {
    Write-Error "app-update.yml not found in installed TEST vA resources at $installedUpdateYml"
    exit 1
  }
  $installedUpdateContent = Get-Content -Path $installedUpdateYml -Raw
  if ($installedUpdateContent -notmatch "provider:\s*generic" -or $installedUpdateContent -notmatch "url:\s*http://127\.0\.0\.1:$testPort/?") {
    Write-Error "Installed app-update.yml does not match build-time generic test feed configuration!"
    exit 1
  }
  Write-Host "[5/6] Installed app-update.yml verified (provider: generic, url: http://127.0.0.1:$testPort/, UNMODIFIED after install): PASS"

  # 6. Launch installed vA under test harness
  Write-Host "Launching installed TEST vA process..."
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $installedExe
  $startInfo.WorkingDirectory = $testDataDir
  $startInfo.EnvironmentVariables["APPDATA"] = $testDataDir
  $startInfo.EnvironmentVariables["LOCALAPPDATA"] = $testDataDir
  $startInfo.EnvironmentVariables["AGENT_FORGE_DATA_DIR"] = $testDataDir
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

  Write-Host "[6/6] Real update detection, download, and SHA-512 verification for vB (0.1.1): PASS"

  Write-Host ""
  Write-Host "=== Real Windows Installed-App Update Test Classification ==="
  Write-Host "INSTALLED_UPDATE_TEST=PARTIALLY_AUTOMATED_WITH_MANUAL_FINAL_GATE"
  Write-Host "UPDATE_DETECTED=YES"
  Write-Host "UPDATE_DOWNLOADED=YES"
  Write-Host "UPDATE_INSTALL_REQUEST_PROVEN=NO"
  Write-Host "POST_UPDATE_VERSION_PROVEN=NO"
  Write-Host "MANUAL_FINAL_GATE_REMAINING=explicit install/restart/post-update-version verification"
  Write-Host "=============================================================="

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
    # Remove junctions first to avoid deleting source node_modules
    if (Test-Path "$tempAppDirA\node_modules") {
      cmd /c rmdir "$tempAppDirA\node_modules" 2>$null | Out-Null
    }
    if (Test-Path "$tempAppDirB\node_modules") {
      cmd /c rmdir "$tempAppDirB\node_modules" 2>$null | Out-Null
    }
    try {
      Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
    } catch {}
  }
}

exit 0
