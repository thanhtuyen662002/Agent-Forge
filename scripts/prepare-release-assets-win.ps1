<#
.SYNOPSIS
  Deterministic Release Asset Staging & Verification for AgentForge Windows Releases.

.DESCRIPTION
  Freezes and stages the exact locally built Windows NSIS installer, updater blockmap,
  and latest.yml into a staging directory (e.g. release\publish-assets) for draft publication.
  Guarantees byte-identity, SHA-256 equivalence, SHA-512 updater verification, and credential-free configuration.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ExpectedVersion,

  [Parameter(Mandatory = $false)]
  [string]$ReleaseDir = "release",

  [Parameter(Mandatory = $false)]
  [string]$StagingDir = "release\publish-assets",

  [Parameter(Mandatory = $false)]
  [string]$ReleaseTag,

  [Parameter(Mandatory = $false)]
  [string]$SourceSha
)

$ErrorActionPreference = "Stop"

function Get-Sha256Hex {
  param([string]$Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      $bytes = $sha256.ComputeHash($stream)
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }
  return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-Sha512Base64 {
  param([string]$Path)
  $sha512 = [System.Security.Cryptography.SHA512]::Create()
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    return [Convert]::ToBase64String($sha512.ComputeHash($bytes))
  } finally {
    $sha512.Dispose()
  }
}

Write-Host "================================================================="
Write-Host "   AgentForge Windows Release Asset Staging & Verification       "
Write-Host "================================================================="

# 1. Resolve project root and package version
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

$pkgJsonPath = Join-Path $projectRoot "package.json"
if (-not (Test-Path $pkgJsonPath)) {
  throw "package.json not found at $pkgJsonPath"
}
$pkg = Get-Content -Path $pkgJsonPath -Raw | ConvertFrom-Json
$appVersion = $pkg.version.Trim()

if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
  $ExpectedVersion = $appVersion
} elseif ($ExpectedVersion.TrimStart('v') -ne $appVersion) {
  throw "VERSION MISMATCH FAIL-CLOSED: package.json version ($appVersion) does not match expected version ($ExpectedVersion)."
}

if ([string]::IsNullOrWhiteSpace($ReleaseTag)) {
  $ReleaseTag = "v$appVersion"
}

if ([string]::IsNullOrWhiteSpace($SourceSha)) {
  try {
    $SourceSha = (& git -C $projectRoot rev-parse HEAD).Trim()
  } catch {
    $SourceSha = "UNKNOWN"
  }
}

try {
  $sourceTree = (& git -C $projectRoot rev-parse "$SourceSha^{tree}").Trim()
} catch {
  $sourceTree = "UNKNOWN"
}

Write-Host "[1/6] Validating package version and release tag..."
Write-Host "  -> App Version:  $appVersion"
Write-Host "  -> Release Tag:  $ReleaseTag"
Write-Host "  -> Source SHA:   $SourceSha"
Write-Host "  -> Source Tree:  $sourceTree"

# 2. Inspect latest.yml
$resolvedReleaseDir = if ([System.IO.Path]::IsPathRooted($ReleaseDir)) { $ReleaseDir } else { Join-Path $projectRoot $ReleaseDir }
$latestYmlPath = Join-Path $resolvedReleaseDir "latest.yml"
if (-not (Test-Path $latestYmlPath)) {
  throw "latest.yml not found in release directory ($latestYmlPath). Run 'npm run package:win' first."
}

$latestYmlContent = Get-Content -Path $latestYmlPath -Raw

if ($latestYmlContent -notmatch 'version:\s*([^\r\n]+)') {
  throw "latest.yml does not contain version field!"
}
$latestVersion = $Matches[1].Trim()
if ($latestVersion -ne $appVersion) {
  throw "latest.yml version ($latestVersion) does not match package.json version ($appVersion)!"
}

if ($latestYmlContent -notmatch 'path:\s*([^\r\n]+)') {
  throw "latest.yml does not contain path field!"
}
$publishedInstallerFilename = $Matches[1].Trim()

if ($latestYmlContent -notmatch 'sha512:\s*([A-Za-z0-9+/=]+)') {
  throw "latest.yml does not contain sha512 field!"
}
$expectedSha512 = $Matches[1].Trim()

Write-Host "[2/6] latest.yml verified (version: $latestVersion, published path: $publishedInstallerFilename)"

# 3. Locate local built installer
$possibleInstallerNames = @(
  $publishedInstallerFilename,
  "AgentForge Setup $appVersion.exe",
  "AgentForge-Setup-$appVersion.exe",
  "AgentForge Setup.exe"
)

$localBuiltInstallerPath = $null
foreach ($name in $possibleInstallerNames) {
  $candidate = Join-Path $resolvedReleaseDir $name
  if (Test-Path $candidate) {
    $localBuiltInstallerPath = $candidate
    break
  }
}

if ($null -eq $localBuiltInstallerPath) {
  throw "Could not find built NSIS installer in $resolvedReleaseDir matching candidate names: $($possibleInstallerNames -join ', ')"
}

$localBuiltFilename = Split-Path -Leaf $localBuiltInstallerPath
$localBuiltSize = (Get-Item $localBuiltInstallerPath).Length
$localBuiltSha256 = Get-Sha256Hex -Path $localBuiltInstallerPath

Write-Host "[3/6] Located built installer:"
Write-Host "  -> Local File:   $localBuiltFilename"
Write-Host "  -> Size:         $localBuiltSize bytes"
Write-Host "  -> SHA-256:      $localBuiltSha256"

# 4. Prepare Staging Directory and Freeze Assets
$resolvedStagingDir = if ([System.IO.Path]::IsPathRooted($StagingDir)) { $StagingDir } else { Join-Path $projectRoot $StagingDir }
if (Test-Path $resolvedStagingDir) {
  Remove-Item -Path $resolvedStagingDir -Recurse -Force
}
New-Item -ItemType Directory -Path $resolvedStagingDir -Force | Out-Null

$stagedInstallerPath = Join-Path $resolvedStagingDir $publishedInstallerFilename
Copy-Item -Path $localBuiltInstallerPath -Destination $stagedInstallerPath -Force

$stagedInstallerSize = (Get-Item $stagedInstallerPath).Length
$stagedInstallerSha256 = Get-Sha256Hex -Path $stagedInstallerPath

if ($stagedInstallerSize -ne $localBuiltSize) {
  throw "STAGING BYTE CORRUPTION: Staged installer size ($stagedInstallerSize) does not match original ($localBuiltSize)!"
}
if ($stagedInstallerSha256 -ne $localBuiltSha256) {
  throw "STAGING HASH CORRUPTION: Staged installer SHA256 ($stagedInstallerSha256) does not match original ($localBuiltSha256)!"
}

# Locate and stage matching blockmap
$possibleBlockmapNames = @(
  "$publishedInstallerFilename.blockmap",
  "$localBuiltFilename.blockmap",
  "AgentForge Setup $appVersion.exe.blockmap",
  "AgentForge-Setup-$appVersion.exe.blockmap"
)

$localBlockmapPath = $null
foreach ($bmName in $possibleBlockmapNames) {
  $candidateBm = Join-Path $resolvedReleaseDir $bmName
  if (Test-Path $candidateBm) {
    $localBlockmapPath = $candidateBm
    break
  }
}

if ($null -eq $localBlockmapPath) {
  throw "Could not find installer blockmap in $resolvedReleaseDir!"
}

$stagedBlockmapFilename = "$publishedInstallerFilename.blockmap"
$stagedBlockmapPath = Join-Path $resolvedStagingDir $stagedBlockmapFilename
Copy-Item -Path $localBlockmapPath -Destination $stagedBlockmapPath -Force

$stagedBlockmapSize = (Get-Item $stagedBlockmapPath).Length
$stagedBlockmapSha256 = Get-Sha256Hex -Path $stagedBlockmapPath

# Stage latest.yml
$stagedLatestYmlPath = Join-Path $resolvedStagingDir "latest.yml"
Copy-Item -Path $latestYmlPath -Destination $stagedLatestYmlPath -Force
$stagedLatestYmlSha256 = Get-Sha256Hex -Path $stagedLatestYmlPath

Write-Host "[4/6] Assets staged and frozen in $resolvedStagingDir..."
Write-Host "  -> Staged Installer: $publishedInstallerFilename ($stagedInstallerSize bytes, SHA256: $stagedInstallerSha256)"
Write-Host "  -> Staged Blockmap:  $stagedBlockmapFilename ($stagedBlockmapSize bytes, SHA256: $stagedBlockmapSha256)"
Write-Host "  -> Staged latest.yml: latest.yml (SHA256: $stagedLatestYmlSha256)"

# 5. Verify SHA-512 of Staged Installer against latest.yml
Write-Host "[5/6] Verifying updater SHA-512 integrity..."
$stagedSha512 = Get-Sha512Base64 -Path $stagedInstallerPath
if ($stagedSha512 -ne $expectedSha512) {
  throw "UPDATER SHA512 MISMATCH: Staged installer SHA-512 ($stagedSha512) does not match latest.yml ($expectedSha512)!"
}
Write-Host "  -> SHA-512 Match: VERIFIED ($stagedSha512)"

# Check app-update.yml for credential leaks
$unpackedUpdateYml = Join-Path $resolvedReleaseDir "win-unpacked\resources\app-update.yml"
if (Test-Path $unpackedUpdateYml) {
  $updateYmlContent = Get-Content -Path $unpackedUpdateYml -Raw
  if ($updateYmlContent -match "token|secret|password|bearer|authorization") {
    throw "SECURITY LEAK: app-update.yml contains sensitive credential patterns!"
  }
}

# 6. Authenticode Inspection & Metadata Generation
$sig = Get-AuthenticodeSignature -FilePath $stagedInstallerPath
$sigStatus = $sig.Status.ToString()
$codeSigned = if ($sig.Status -eq "Valid") { "YES" } else { "NO" }

Write-Host "[6/6] Authenticode Status: $sigStatus (Code Signed: $codeSigned)"

$metadataContent = @"
SOURCE_SHA=$SourceSha
SOURCE_TREE=$sourceTree
RELEASE_TAG=$ReleaseTag
APP_VERSION=$appVersion

LOCAL_BUILT_INSTALLER_FILENAME=$localBuiltFilename
LOCAL_BUILT_INSTALLER_SIZE=$localBuiltSize
LOCAL_BUILT_INSTALLER_SHA256=$localBuiltSha256

PUBLISHED_INSTALLER_FILENAME=$publishedInstallerFilename
PUBLISHED_INSTALLER_SIZE=$stagedInstallerSize
PUBLISHED_INSTALLER_SHA256=$stagedInstallerSha256

LATEST_YML_FILENAME=latest.yml
LATEST_YML_SHA256=$stagedLatestYmlSha256

BLOCKMAP_FILENAME=$stagedBlockmapFilename
BLOCKMAP_SIZE=$stagedBlockmapSize
BLOCKMAP_SHA256=$stagedBlockmapSha256

AUTHENTICODE_STATUS=$sigStatus
CODE_SIGNED=$codeSigned
OWNER_UNSIGNED_PUBLICATION_APPROVAL_REQUIRED=YES

BUILD_OS=windows-latest
STAGED_TIMESTAMP=$((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))
"@

$metadataPath = Join-Path $resolvedStagingDir "release-metadata.txt"
[System.IO.File]::WriteAllText($metadataPath, $metadataContent, [System.Text.UTF8Encoding]::new($false))

Write-Host "================================================================="
Write-Host "   Release Assets Successfully Staged & Verified                 "
Write-Host "   Metadata: $metadataPath"
Write-Host "================================================================="
