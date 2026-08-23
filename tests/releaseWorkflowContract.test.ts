import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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

  it('5. release-windows.yml enforces exhaustive collision guards with exact-tag fail-closed lookup', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    // Checks both canonical and unprefixed remote git tags
    expect(workflow).toMatch(/git ls-remote --tags origin/);
    expect(workflow).toMatch(/refs\/tags\/\$canonicalTag/);
    expect(workflow).toMatch(/refs\/tags\/\$normalizedVersion/);
    // Queries exact release endpoint
    expect(workflow).toMatch(/\/repos\/\$\{\{\s*github\.repository\s*\}\}\/releases\/tags\/\$tagToCheck/);
    // Confirms only 404 / Not Found is acceptable absent condition
    expect(workflow).toMatch(/COLLISION GUARD LOOKUP FAILURE FAIL-CLOSED/);
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

  it('8. release-windows.yml creates GitHub release explicitly as DRAFT with post-creation size verification', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).toMatch(/gh release create \$canonicalTag/);
    expect(workflow).toMatch(/--draft/);
    expect(workflow).toMatch(/--target \$sha/);
    expect(workflow).toMatch(/--notes-file \$metadataPath/);
    expect(workflow).toMatch(/release\\publish-assets/);
    expect(workflow).toMatch(/gh release view \$canonicalTag --json isDraft,isPrerelease,tagName,targetCommitish,assets/);
    expect(workflow).toMatch(/assetDict\[\$expectedInstaller\]\.size/);
    expect(workflow).toMatch(/assetDict\[\$expectedBlockmap\]\.size/);
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
});
