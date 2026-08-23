import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('PR #19 — Production Release Pipeline Hardening Contract Tests', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const releaseWorkflowPath = path.join(projectRoot, '.github/workflows/release-windows.yml');
  const ciWorkflowPath = path.join(projectRoot, '.github/workflows/ci.yml');
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

  it('4. release-windows.yml enforces origin/main and tag-version guards', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).toMatch(/git fetch origin main/);
    expect(workflow).toMatch(/MAIN_SHA.*origin\/main/);
    expect(workflow).toMatch(/CURRENT_SHA.*HEAD/);
    expect(workflow).toMatch(/package\.json.*version/);
    expect(workflow).toMatch(/VERSION MISMATCH FAIL-CLOSED/);
  });

  it('5. release-windows.yml enforces collision guards before any build or release mutation', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).toMatch(/git ls-remote --tags origin/);
    expect(workflow).toMatch(/gh api \/repos\/\$\{\{ github\.repository \}\}\/releases/);
    expect(workflow).toMatch(/RELEASE COLLISION GUARD FAIL-CLOSED/);
  });

  it('6. release-windows.yml executes ALL release gates before release creation', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');

    // Test suite
    expect(workflow).toMatch(/npm test/);
    // Build
    expect(workflow).toMatch(/npm run build/);
    // Relative asset base verification
    expect(workflow).toMatch(/dist\\index\.html/);
    // Package once
    expect(workflow).toMatch(/npm run package:win/);
    // Staging script
    expect(workflow).toMatch(/prepare-release-assets-win\.ps1/);
    // Packaged smoke
    expect(workflow).toMatch(/smoke:packaged:win/);
    // Installed update integration test
    expect(workflow).toMatch(/test:installed:win/);
    // Real production installed smoke with staged installer
    expect(workflow).toMatch(/smoke-installed-production-win\.ps1[\s\S]*?-InstallerPath/);
    // RC verification with staged installer
    expect(workflow).toMatch(/verify-demo-rc-win\.ps1[\s\S]*?-InstallerPath/);
  });

  it('7. release-windows.yml eliminates second-build publish and never calls electron-builder --publish always', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).not.toMatch(/electron-builder.*--publish always/);
    expect(workflow).not.toMatch(/--publish always/);
  });

  it('8. release-windows.yml creates GitHub release explicitly as DRAFT from frozen assets', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).toMatch(/gh release create \$tag/);
    expect(workflow).toMatch(/--draft/);
    expect(workflow).toMatch(/--target \$sha/);
    expect(workflow).toMatch(/--notes-file \$metadataPath/);
    expect(workflow).toMatch(/release\\publish-assets/);
  });

  it('9. release-windows.yml performs post-creation verification that release is DRAFT with all assets', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).toMatch(/gh release view \$tag --json isDraft,isPrerelease,tagName,targetCommitish,assets/);
    expect(workflow).toMatch(/releaseInfo\.isDraft -ne \$true/);
    expect(workflow).toMatch(/releaseInfo\.targetCommitish -ne \$sha/);
    expect(workflow).toMatch(/Post-creation draft verification: PASS/);
  });

  it('10. scripts/prepare-release-assets-win.ps1 verifies SHA512, byte equality, and credential safety', () => {
    const script = fs.readFileSync(prepareAssetsPath, 'utf8');
    expect(script).toMatch(/latest\.yml/);
    expect(script).toMatch(/Get-Sha512Base64/);
    expect(script).toMatch(/STAGING BYTE CORRUPTION/);
    expect(script).toMatch(/STAGING HASH CORRUPTION/);
    expect(script).toMatch(/UPDATER SHA512 MISMATCH/);
    expect(script).toMatch(/OWNER_UNSIGNED_PUBLICATION_APPROVAL_REQUIRED=YES/);
    expect(script).toMatch(/release-metadata\.txt/);
  });

  it('11. scripts/verify-demo-rc-win.ps1 and scripts/smoke-installed-production-win.ps1 accept explicit -InstallerPath', () => {
    const verifyScript = fs.readFileSync(verifyRcPath, 'utf8');
    const smokeScript = fs.readFileSync(smokeInstalledPath, 'utf8');
    expect(verifyScript).toMatch(/\[string\]\$InstallerPath/);
    expect(smokeScript).toMatch(/\[string\]\$InstallerPath/);
  });
});
