# =============================================================================
# scripts/verify-demo-rc-win.ps1
# AgentForge Windows Release Candidate Verification Gate (Fail-Closed)
# =============================================================================

[CmdletBinding()]
param (
  [string]$ProjectRoot = "",
  [string]$ReceiptOutput = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($ReceiptOutput)) {
  $ReceiptOutput = Join-Path $ProjectRoot "release\demo-rc-receipt.txt"
}

function Get-Sha256Hex {
  param([Parameter(Mandatory=$true)][string]$FilePath)
  if (-not (Test-Path -LiteralPath $FilePath)) {
    throw "Get-Sha256Hex: file not found at path: '$FilePath'"
  }
  $stream = [System.IO.File]::OpenRead($FilePath)
  try {
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $hasher.ComputeHash($stream)
      return [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
    } finally {
      $hasher.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "   AgentForge Windows Release Candidate Verification Gate       " -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan

$receiptLines = [System.Collections.Generic.List[string]]::new()
$receiptLines.Add("AGENTFORGE_DEMO_RC_RECEIPT")
$receiptLines.Add("TIMESTAMP=$(Get-Date -Format 'o')")

$failures = [System.Collections.Generic.List[string]]::new()

# Assertion A: package.json version is exactly 0.1.0
$packageJsonPath = Join-Path $ProjectRoot "package.json"
if (-not (Test-Path $packageJsonPath)) {
  $failures.Add("A_PACKAGE_JSON_MISSING: package.json not found at $packageJsonPath")
  $expectedVersion = "UNKNOWN"
} else {
  try {
    $packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
    $expectedVersion = $packageJson.version
    if ($expectedVersion -ne "0.1.0") {
      $failures.Add("A_VERSION_MISMATCH: Expected package version 0.1.0, got $expectedVersion")
    }
  } catch {
    $failures.Add("A_PACKAGE_JSON_PARSE_ERROR: Failed to parse package.json: $_")
    $expectedVersion = "PARSE_ERROR"
  }
}
$receiptLines.Add("PRODUCTION_VERSION=$expectedVersion")
Write-Host "[A] Production Version ($expectedVersion): $(if ($expectedVersion -eq '0.1.0') {'PASS'} else {'FAIL'})"

# Assertion B: Database migration count == 7
$migrationsPath = Join-Path $ProjectRoot "src\core\database\migrations.ts"
$migrationCount = 0
if (-not (Test-Path $migrationsPath)) {
  $failures.Add("B_MIGRATIONS_FILE_MISSING: migrations.ts not found at $migrationsPath")
} else {
  $migrationMatches = Select-String -Path $migrationsPath -Pattern "version:\s*(\d+)"
  $migrationCount = $migrationMatches.Count
  if ($migrationCount -ne 7) {
    $failures.Add("B_MIGRATION_COUNT_INVALID: Expected exactly 7 migrations, found $migrationCount")
  }
}
$receiptLines.Add("MIGRATION_COUNT=$migrationCount")
Write-Host "[B] Database Migration Count ($migrationCount): $(if ($migrationCount -eq 7) {'PASS'} else {'FAIL'})"

# Assertion C & D: electron-builder.yml provider & credentials check
$builderConfigPath = Join-Path $ProjectRoot "electron-builder.yml"
$hasGithubProvider = $false
$hasOwner = $false
$hasRepo = $false
$hasBuilderCreds = $false

if (-not (Test-Path $builderConfigPath)) {
  $failures.Add("C_BUILDER_CONFIG_MISSING: electron-builder.yml not found at $builderConfigPath")
} else {
  $builderConfig = Get-Content $builderConfigPath -Raw
  $hasGithubProvider = $builderConfig -match "(?m)^\s*provider:\s*github"
  $hasOwner = $builderConfig -match "(?m)^\s*owner:\s*thanhtuyen662002"
  $hasRepo = $builderConfig -match "(?m)^\s*repo:\s*Agent-Forge"
  if (-not ($hasGithubProvider -and $hasOwner -and $hasRepo)) {
    $failures.Add("C_BUILDER_CONFIG_PROVIDER_INVALID: electron-builder.yml must specify github / thanhtuyen662002 / Agent-Forge")
  }

  $credRegex = "(?i)(token:|password:|Authorization:|Bearer\s|ghp_|github_pat_)"
  if ($builderConfig -match $credRegex) {
    $hasBuilderCreds = $true
    $failures.Add("D_BUILDER_CONFIG_CREDENTIALS_FOUND: electron-builder.yml contains embedded credentials")
  }
}
$receiptLines.Add("UPDATER_PROVIDER_GITHUB=$hasGithubProvider")
$receiptLines.Add("UPDATER_OWNER=thanhtuyen662002")
$receiptLines.Add("UPDATER_REPO=Agent-Forge")
$receiptLines.Add("BUILDER_CONFIG_CREDENTIALS_FOUND=$hasBuilderCreds")
Write-Host "[C] Production Builder Provider (github/thanhtuyen662002/Agent-Forge): $(if ($hasGithubProvider -and $hasOwner -and $hasRepo) {'PASS'} else {'FAIL'})"
Write-Host "[D] Builder Config Credentials Check: $(if (-not $hasBuilderCreds) {'PASS (No credentials)'} else {'FAIL (Found credentials)'})"

# Assertion E: release/win-unpacked/AgentForge.exe exists
$unpackedExe = Join-Path $ProjectRoot "release\win-unpacked\AgentForge.exe"
$unpackedExists = Test-Path $unpackedExe
if (-not $unpackedExists) {
  $failures.Add("E_UNPACKED_EXE_MISSING: Packaged executable not found at $unpackedExe")
}
$receiptLines.Add("PACKAGED_UNPACKED_EXE_EXISTS=$unpackedExists")
Write-Host "[E] Packaged Executable ($unpackedExe): $(if ($unpackedExists) {'PASS'} else {'FAIL'})"

# Assertion F, G, H: Production installer existence, size > 0, SHA256
$installerName = "AgentForge Setup $expectedVersion.exe"
$installerPath = Join-Path $ProjectRoot "release\$installerName"
$installerExists = Test-Path $installerPath
$installerSize = 0
$installerSha256 = "N/A"
$authenticodeStatus = "Unknown"

if (-not $installerExists) {
  $failures.Add("F_INSTALLER_MISSING: Production installer not found at $installerPath")
} else {
  try {
    $installerItem = Get-Item $installerPath
    $installerSize = $installerItem.Length
    if ($installerSize -le 0) {
      $failures.Add("G_INSTALLER_EMPTY: Installer file size is 0 bytes")
    }
    $installerSha256 = Get-Sha256Hex -FilePath $installerPath
    if ([string]::IsNullOrWhiteSpace($installerSha256) -or $installerSha256.Length -ne 64) {
      $failures.Add("H_INSTALLER_SHA256_INVALID: Failed to compute valid 64-char SHA256 for installer")
    }
    $sig = Get-AuthenticodeSignature -FilePath $installerPath
    $authenticodeStatus = $sig.Status.ToString()
  } catch {
    $failures.Add("H_INSTALLER_INSPECT_ERROR: Error inspecting installer: $_")
  }
}
$receiptLines.Add("INSTALLER_NAME=$installerName")
$receiptLines.Add("INSTALLER_EXISTS=$installerExists")
$receiptLines.Add("INSTALLER_SIZE_BYTES=$installerSize")
$receiptLines.Add("INSTALLER_SHA256=$installerSha256")
$receiptLines.Add("AUTHENTICODE_STATUS=$authenticodeStatus")
Write-Host "[F] Production Installer Exists: $(if ($installerExists) {'PASS'} else {'FAIL'})"
Write-Host "[G] Production Installer Size ($installerSize bytes): $(if ($installerSize -gt 0) {'PASS'} else {'FAIL'})"
Write-Host "[H] Production Installer SHA-256 ($installerSha256): $(if ($installerSha256.Length -eq 64) {'PASS'} else {'FAIL'})"

# Assertion I, J, K: Packaged resources/app-update.yml exists, correct config, NO credentials
$packagedAppUpdate = Join-Path $ProjectRoot "release\win-unpacked\resources\app-update.yml"
$packagedAppUpdateExists = Test-Path $packagedAppUpdate
$packagedUpdateProviderOk = $false
$packagedUpdateCredsFound = $false

if (-not $packagedAppUpdateExists) {
  $failures.Add("I_PACKAGED_APP_UPDATE_YML_MISSING: resources\app-update.yml not found in win-unpacked")
} else {
  $appUpdateContent = Get-Content $packagedAppUpdate -Raw
  $hasPkgProvider = $appUpdateContent -match "(?m)^\s*provider:\s*github"
  $hasPkgOwner = $appUpdateContent -match "(?m)^\s*owner:\s*thanhtuyen662002"
  $hasPkgRepo = $appUpdateContent -match "(?m)^\s*repo:\s*Agent-Forge"

  if ($hasPkgProvider -and $hasPkgOwner -and $hasPkgRepo) {
    $packagedUpdateProviderOk = $true
  } else {
    $failures.Add("J_PACKAGED_APP_UPDATE_YML_INVALID: app-update.yml must specify provider: github, owner: thanhtuyen662002, repo: Agent-Forge")
  }

  $credRegex = "(?i)(token:|password:|Authorization:|Bearer\s|ghp_|github_pat_)"
  if ($appUpdateContent -match $credRegex) {
    $packagedUpdateCredsFound = $true
    $failures.Add("K_PACKAGED_APP_UPDATE_YML_CREDENTIALS_FOUND: resources\app-update.yml contains credentials")
  }
}
$receiptLines.Add("PACKAGED_APP_UPDATE_YML_EXISTS=$packagedAppUpdateExists")
$receiptLines.Add("PACKAGED_APP_UPDATE_CONFIG_VALID=$packagedUpdateProviderOk")
$receiptLines.Add("PACKAGED_APP_UPDATE_CREDENTIALS_FOUND=$packagedUpdateCredsFound")

Write-Host "[I] Packaged app-update.yml Exists: $(if ($packagedAppUpdateExists) {'PASS'} else {'FAIL'})"
Write-Host "[J] Packaged app-update.yml Configuration: $(if ($packagedUpdateProviderOk) {'PASS'} else {'FAIL'})"
Write-Host "[K] Packaged app-update.yml No Credentials: $(if (-not $packagedUpdateCredsFound) {'PASS'} else {'FAIL'})"

# Final Gate Evaluation
$receiptDir = [System.IO.Path]::GetDirectoryName($ReceiptOutput)
if (-not (Test-Path $receiptDir)) {
  New-Item -ItemType Directory -Path $receiptDir -Force | Out-Null
}

if ($failures.Count -eq 0) {
  $receiptLines.Add("RC_VERIFICATION_STATUS=PASS")
  [System.IO.File]::WriteAllLines($ReceiptOutput, $receiptLines)
  Write-Host "=================================================================" -ForegroundColor Cyan
  Write-Host "   AgentForge Windows RC Verification: PASS (All Gates Passed)  " -ForegroundColor Green
  Write-Host "   Receipt written to $ReceiptOutput                             " -ForegroundColor Green
  Write-Host "=================================================================" -ForegroundColor Cyan
  exit 0
} else {
  $receiptLines.Add("RC_VERIFICATION_STATUS=FAIL")
  $receiptLines.Add("FAILURE_COUNT=$($failures.Count)")
  foreach ($fail in $failures) {
    $receiptLines.Add("FAILURE_REASON=$fail")
  }
  [System.IO.File]::WriteAllLines($ReceiptOutput, $receiptLines)
  Write-Host "=================================================================" -ForegroundColor Red
  Write-Host "   AgentForge Windows RC Verification: FAILED ($($failures.Count) failures) " -ForegroundColor Red
  foreach ($fail in $failures) {
    Write-Host "   - $fail" -ForegroundColor Red
  }
  Write-Host "   Receipt written to $ReceiptOutput                             " -ForegroundColor Yellow
  Write-Host "=================================================================" -ForegroundColor Red
  exit 1
}
