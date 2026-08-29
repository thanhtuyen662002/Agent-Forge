import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { performance } from 'perf_hooks';
import { spawnSync } from 'child_process';

describe('PR #19 — Production Release Pipeline Hardening Contract Tests', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const releaseWorkflowPath = path.join(projectRoot, '.github/workflows/release-windows.yml');
  const electronBuilderPath = path.join(projectRoot, 'electron-builder.yml');
  const prepareAssetsPath = path.join(projectRoot, 'scripts/prepare-release-assets-win.ps1');
  const verifyRcPath = path.join(projectRoot, 'scripts/verify-demo-rc-win.ps1');
  const smokeInstalledPath = path.join(projectRoot, 'scripts/smoke-installed-production-win.ps1');
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageLockJsonPath = path.join(projectRoot, 'package-lock.json');

  it('1. package.json and package-lock.json preserve current production version 0.1.0', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const pkgLock = JSON.parse(fs.readFileSync(packageLockJsonPath, 'utf8'));
    expect(pkg.version).toBe('0.1.0');
    expect(pkgLock.version).toBe('0.1.0');
  });

  it('2. electron-builder.yml explicitly configures draft release policy and correct repo target', () => {
    const builderContent = fs.readFileSync(electronBuilderPath, 'utf8');
    expect(builderContent).toMatch(/provider:\s*github/);
    expect(builderContent).toMatch(/owner:\s*thanhtuyen662002/);
    expect(builderContent).toMatch(/repo:\s*Agent-Forge/);
    expect(builderContent).toMatch(/releaseType:\s*draft/);
  });

  it('3. release-windows.yml is strictly manual workflow_dispatch only with write permissions', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).not.toMatch(/push:/);
    expect(workflow).not.toMatch(/pull_request:/);
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*write/);
  });

  it('4. release-windows.yml enforces canonical tag normalization (vX.Y.Z)', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).toMatch(/\$normalizedVersion\s*=\s*\$rawTag\.TrimStart\(['"]v['"]\)/);
    expect(workflow).toMatch(/\$canonicalTag\s*=\s*["']v\$normalizedVersion["']/);
    expect(workflow).toMatch(/gh release create \$canonicalTag/);

    // Test canonical tag normalization logic contract
    const normalize = (input: string) => `v${input.trim().replace(/^v/, '')}`;
    expect(normalize('0.1.0')).toBe('v0.1.0');
    expect(normalize('v0.1.0')).toBe('v0.1.0');
    expect(normalize('0.1.1')).toBe('v0.1.1');
    expect(normalize('v0.1.1')).toBe('v0.1.1');
  });

  it('5. release-windows.yml enforces exhaustive draft-aware release collision guard with pagination, slurp, and fail-closed semantics', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    // Checks both canonical and unprefixed remote git tags
    expect(workflow).toMatch(/git ls-remote --tags origin/);
    expect(workflow).toMatch(/refs\/tags\/\$canonicalTag/);
    expect(workflow).toMatch(/refs\/tags\/\$normalizedVersion/);
    // Queries paginated releases list with --slurp capable of inspecting drafts
    expect(workflow).toMatch(/gh api --paginate --slurp ["']\/repos\/\$\{\{\s*github\.repository\s*\}\}\/releases["']/);
    expect(workflow).toMatch(/ConvertFrom-Json.*-NoEnumerate/);
    expect(workflow).toMatch(/RELEASE_PAGE_COUNT/);
    expect(workflow).toMatch(/RELEASE_RECORD_COUNT/);
    expect(workflow).toMatch(/\$matchingReleases\.Count -gt 0/);
    expect(workflow).toMatch(/COLLISION GUARD FAIL-CLOSED/);
    expect(workflow).toMatch(/COLLISION GUARD LOOKUP FAILURE FAIL-CLOSED/);
    expect(workflow).toMatch(/COLLISION GUARD PARSE FAILURE FAIL-CLOSED/);
    expect(workflow).toMatch(/COLLISION GUARD SHAPE FAILURE FAIL-CLOSED/);

    // Forbids regression to naive if ($null -eq $releases) that fails on valid empty collections
    expect(workflow).not.toMatch(/if\s*\(\$null\s*-eq\s*\$releases\)\s*\{\s*Write-Error\s*["'].*Releases API returned null response/);
  });

  it('6. release-windows.yml executes ALL release gates and asserts strict execution ordering', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');

    const posNpmTest = workflow.indexOf('npm test');
    const posBuild = workflow.indexOf('npm run build');
    const posPackage = workflow.indexOf('npm run package:win');
    const posStage = workflow.indexOf('prepare-release-assets-win.ps1');
    const posPackagedSmoke = workflow.indexOf('npm run smoke:packaged:win');
    const posInstalledTest = workflow.indexOf('npm run test:installed:win');
    const posProdSmoke = workflow.indexOf('smoke-installed-production-win.ps1');
    const posVerifyRc = workflow.indexOf('verify-demo-rc-win.ps1');
    const posFinalizeRc = workflow.indexOf('-FinalizeRcStatus');
    const posVerifyOnly = workflow.indexOf('-VerifyOnly');
    const posReleaseCreate = workflow.indexOf('gh release create');

    expect(posNpmTest).toBeGreaterThan(0);
    expect(posBuild).toBeGreaterThan(posNpmTest);
    expect(posPackage).toBeGreaterThan(posBuild);
    expect(posStage).toBeGreaterThan(posPackage);
    expect(posPackagedSmoke).toBeGreaterThan(posStage);
    expect(posInstalledTest).toBeGreaterThan(posPackagedSmoke);
    expect(posProdSmoke).toBeGreaterThan(posInstalledTest);
    expect(posVerifyRc).toBeGreaterThan(posProdSmoke);
    expect(posFinalizeRc).toBeGreaterThan(posVerifyRc);
    expect(posVerifyOnly).toBeGreaterThan(posFinalizeRc);
    expect(posReleaseCreate).toBeGreaterThan(posVerifyOnly);

    // Exactly one release creation command in workflow
    const releaseCreateMatches = workflow.match(/gh release create/g);
    expect(releaseCreateMatches).toHaveLength(1);
  });

  it('7. release-windows.yml eliminates second-build publish and never calls electron-builder --publish always', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).not.toMatch(/electron-builder.*--publish always/);
    expect(workflow).not.toMatch(/--publish always/);
  });

  it('8. release-windows.yml creates GitHub release explicitly as DRAFT and verifies all 5 uploaded asset sizes and digests strictly fail-closed', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).toMatch(/gh release create \$canonicalTag/);
    expect(workflow).toMatch(/--draft/);
    expect(workflow).toMatch(/--target \$sha/);
    expect(workflow).toMatch(/--notes-file \$metadataPath/);
    expect(workflow).toMatch(/release\\publish-assets/);
    expect(workflow).toMatch(/gh release view \$canonicalTag --json id,databaseId,isDraft,isPrerelease,tagName,targetCommitish,assets/);
    expect(workflow).toMatch(/gh api --paginate ["']\/repos\/\$\{\{\s*github\.repository\s*\}\}\/releases\/\$releaseId\/assets["']/);

    // Verifies all 5 assets are explicitly listed
    expect(workflow).toMatch(/PUBLISHED_INSTALLER_FILENAME/);
    expect(workflow).toMatch(/BLOCKMAP_FILENAME/);
    expect(workflow).toMatch(/"latest\.yml"/);
    expect(workflow).toMatch(/"release-metadata\.txt"/);
    expect(workflow).toMatch(/"demo-rc-receipt\.txt"/);
    expect(workflow).toMatch(/POST_DRAFT_EXPECTED_ASSET_COUNT=5/);

    // Fail-closed checks for size and digest
    expect(workflow).toMatch(/ASSET SIZE MISMATCH/);
    expect(workflow).toMatch(/REMOTE ASSET DIGEST MISSING FAIL-CLOSED/);
    expect(workflow).toMatch(/UNSUPPORTED REMOTE ASSET DIGEST FAIL-CLOSED/);
    expect(workflow).toMatch(/ASSET DIGEST MISMATCH FAIL-CLOSED/);
    expect(workflow).toMatch(/\$expectedDigest\s*=\s*["']sha256:\$localSha256["']/);
    expect(workflow).toMatch(/\$remoteDigest\.StartsWith\(["']sha256:["']\)/);
    expect(workflow).toMatch(/\$remoteDigest\.ToLowerInvariant\(\)\s*-ne\s*\$expectedDigest\.ToLowerInvariant\(\)/);

    // Proves size-only fallback is completely absent
    expect(workflow).not.toMatch(/digest.*absent.*size verified/i);
    expect(workflow).not.toMatch(/Note: Remote asset digest field absent/i);

    // Position check: POST_DRAFT_ALL_ASSET_DIGEST_MATCH=YES occurs strictly after the foreach loop and digest check
    const posDigestCheck = workflow.indexOf('ASSET DIGEST MISMATCH FAIL-CLOSED');
    const posDigestMatchOutput = workflow.indexOf('POST_DRAFT_ALL_ASSET_DIGEST_MATCH=YES');
    expect(posDigestCheck).toBeGreaterThan(0);
    expect(posDigestMatchOutput).toBeGreaterThan(posDigestCheck);
    expect(workflow).toMatch(/POST_DRAFT_ALL_ASSET_SIZE_MATCH=YES/);
  });

  it('9. scripts/prepare-release-assets-win.ps1 supports -VerifyOnly, -FinalizeRcStatus, and verifies all hash/byte invariants', () => {
    const script = fs.readFileSync(prepareAssetsPath, 'utf8');
    expect(script).toMatch(/\[switch\]\$VerifyOnly/);
    expect(script).toMatch(/\[switch\]\$FinalizeRcStatus/);
    expect(script).toMatch(/FINAL_FROZEN_ASSET_VERIFICATION = PASS/);
    expect(script).toMatch(/INSTALLER SIZE MISMATCH/);
    expect(script).toMatch(/INSTALLER SHA256 MISMATCH/);
    expect(script).toMatch(/BLOCKMAP SIZE MISMATCH/);
    expect(script).toMatch(/BLOCKMAP SHA256 MISMATCH/);
    expect(script).toMatch(/UPDATER SHA-512 MISMATCH/);
    expect(script).toMatch(/OWNER_UNSIGNED_PUBLICATION_APPROVAL_REQUIRED=YES/);
    expect(script).toMatch(/RC_VERIFICATION_STATUS/);
  });

  it('10. scripts/verify-demo-rc-win.ps1 and scripts/smoke-installed-production-win.ps1 accept explicit -InstallerPath', () => {
    const verifyScript = fs.readFileSync(verifyRcPath, 'utf8');
    const smokeScript = fs.readFileSync(smokeInstalledPath, 'utf8');
    expect(verifyScript).toMatch(/\[string\]\$InstallerPath/);
    expect(smokeScript).toMatch(/\[string\]\$InstallerPath/);
  });

  it('11. release collision guard uses PowerShell-safe exit-code interpolation', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');

    // Regression guard: invalid unparenthesized $LASTEXITCODE: followed by colon is strictly forbidden
    expect(workflow).not.toMatch(/\$LASTEXITCODE:/);

    // Safely delimited exit-code check in collision guard
    expect(workflow).toMatch(/gh api --paginate --slurp ["']\/repos\/\$\{\{\s*github\.repository\s*\}\}\/releases["']/);
    expect(workflow).toMatch(/if\s*\(\$LASTEXITCODE\s*-ne\s*0\)/);
    expect(workflow).toMatch(/Write-Error ["'].*COLLISION GUARD LOOKUP FAILURE FAIL-CLOSED.*\$(\(\$LASTEXITCODE\)|\{LASTEXITCODE\}).*\$releasesJson["']/);
  });

  it('12. release collision guard handles empty and multi-page JSON collections with page flattening and strict record shape validation', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');

    // Asserts page flattening loop and validation
    expect(workflow).toMatch(/foreach\s*\(\$page in \$pages\)/);
    expect(workflow).toMatch(/foreach\s*\(\$item in \$page\)/);
    expect(workflow).toMatch(/\$releases\.Add\(\$item\)/);

    // Fail-closed on null page (no continue)
    expect(workflow).not.toMatch(/if\s*\(\$null\s*-eq\s*\$page\)\s*\{\s*continue\s*\}/);
    expect(workflow).toMatch(/COLLISION GUARD SHAPE FAILURE FAIL-CLOSED: Page \$pageIndex is null\./);

    // Fail-closed on null record and non-object record
    expect(workflow).toMatch(/COLLISION GUARD SHAPE FAILURE FAIL-CLOSED: Page \$pageIndex record \$itemIndex is null\./);
    expect(workflow).toMatch(/COLLISION GUARD SHAPE FAILURE FAIL-CLOSED: Page \$pageIndex record \$itemIndex is not a valid object\./);

    // Fail-closed on missing or empty tag_name
    expect(workflow).toMatch(/COLLISION GUARD SHAPE FAILURE FAIL-CLOSED: Page \$pageIndex record \$itemIndex is missing required property 'tag_name'\./);
    expect(workflow).toMatch(/COLLISION GUARD SHAPE FAILURE FAIL-CLOSED: Page \$pageIndex record \$itemIndex 'tag_name' must be a non-empty string\./);

    // Ordering requirement: tag_name validation must occur strictly before $releases.Add($item)
    const posTagNameCheck = workflow.indexOf("tag_name' must be a non-empty string");
    const posAddRelease = workflow.indexOf("$releases.Add($item)");
    expect(posTagNameCheck).toBeGreaterThan(0);
    expect(posAddRelease).toBeGreaterThan(posTagNameCheck);
  });

  it(
    '13. semantic release collision fixture test suite executes and passes all 15 cases',
    () => {
      const fixtureScriptPath = path.join(projectRoot, 'tests/fixtures/test-release-collision-fixtures.ps1');
      expect(fs.existsSync(fixtureScriptPath)).toBe(true);

      const psExe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
      const fixtureTimeoutMs = process.platform === 'win32' ? 60000 : 20000;

      const diagEnabled = process.platform === 'win32' && process.env.R5I5_DIAG === '1';
      const getR5i5DiagRunContext = (): 'github_actions' | 'local' =>
        process.env.GITHUB_ACTIONS === 'true' ? 'github_actions' : 'local';
      let spawnStart = 0;
      let cpuBefore: NodeJS.CpuUsage | null = null;
      let rssBefore = 0;
      let heapBefore = 0;
      let freeMemBefore = 0;

      if (diagEnabled) {
        spawnStart = performance.now();
        cpuBefore = process.cpuUsage();
        rssBefore = process.memoryUsage().rss;
        heapBefore = process.memoryUsage().heapUsed;
        freeMemBefore = os.freemem();

        const record = {
          marker: 'R5I5_DIAG',
          schema_version: '1.0',
          run_context: getR5i5DiagRunContext(),
          scope: 'releaseWorkflowContract',
          phase: 'spawnSync',
          event: 'SPAWN_BEGIN',
          wall_clock_utc: new Date().toISOString(),
          platform: process.platform,
          fixture_timeout_ms: fixtureTimeoutMs,
          worker_rss_bytes: rssBefore,
          worker_heap_used_bytes: heapBefore,
          system_free_memory_bytes: freeMemBefore,
        };
        console.log('R5I5_DIAG ' + JSON.stringify(record));
      }

      const result = spawnSync(
        psExe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixtureScriptPath],
        { encoding: 'utf8', timeout: fixtureTimeoutMs, windowsHide: true }
      );

      if (diagEnabled) {
        const elapsed = performance.now() - spawnStart;
        const cpuDelta = cpuBefore ? process.cpuUsage(cpuBefore) : null;
        const record = {
          marker: 'R5I5_DIAG',
          schema_version: '1.0',
          run_context: getR5i5DiagRunContext(),
          scope: 'releaseWorkflowContract',
          phase: 'spawnSync',
          event: 'SPAWN_END',
          wall_clock_utc: new Date().toISOString(),
          elapsed_ms: elapsed,
          exit_status: result.status,
          error_code: (result.error as any)?.code ?? null,
          signal: result.signal ?? null,
          worker_rss_bytes: process.memoryUsage().rss,
          worker_heap_used_bytes: process.memoryUsage().heapUsed,
          system_free_memory_bytes: os.freemem(),
          cpu_user_us_delta: cpuDelta ? cpuDelta.user : null,
          cpu_system_us_delta: cpuDelta ? cpuDelta.system : null,
        };
        console.log('R5I5_DIAG ' + JSON.stringify(record));
      }

      if (result.error) {
        throw result.error;
      }
      expect(result.status).toBe(0);
      const output = result.stdout || '';
      expect(output).toMatch(/COLLISION_FIXTURE_TEST_COUNT:\s*15/);
      expect(output).toMatch(/COLLISION_FIXTURE_TEST_PASS_COUNT:\s*15/);
      expect(output).toMatch(/PASS:\s*CASE A - ZERO RELEASES/);
      expect(output).toMatch(/PASS:\s*CASE J - NULL PAGE/);
      expect(output).toMatch(/PASS:\s*CASE K - NULL RELEASE RECORD/);
      expect(output).toMatch(/PASS:\s*CASE L - SCALAR RELEASE RECORD/);
      expect(output).toMatch(/PASS:\s*CASE M - RECORD MISSING TAG_NAME/);
      expect(output).toMatch(/PASS:\s*CASE N - EMPTY TAG_NAME/);
      expect(output).toMatch(/PASS:\s*CASE O - NULL NAME IS VALID/);
    },
    process.platform === 'win32' ? 75000 : 30000
  );
});
