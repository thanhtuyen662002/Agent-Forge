import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureProjectDependencies, MAX_VERIFICATION_ENV_ENTRIES, validateVerificationEnv } from '../src/core/services/ProjectVerificationEnvironment';

/** #336: owner-set verification variables and locked dependencies beside the worktrees. */
describe('project verification environment', () => {
  it('accepts plain tool variables and refuses steering, profile and credential names', () => {
    expect(validateVerificationEnv({ VIDFLOW_FFMPEG: 'C:\\Tools\\ffmpeg.exe', PLAYWRIGHT_BROWSERS_PATH: 'C:\\Cache\\ms-playwright' }))
      .toEqual({ VIDFLOW_FFMPEG: 'C:\\Tools\\ffmpeg.exe', PLAYWRIGHT_BROWSERS_PATH: 'C:\\Cache\\ms-playwright' });
    for (const name of ['PATH', 'NODE_OPTIONS', 'USERPROFILE', 'APPDATA', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'DB_PASSWORD', 'NPM_CONFIG_REGISTRY', 'lower', 'X']) {
      expect(() => validateVerificationEnv({ [name]: 'value' })).toThrow('VERIFICATION_ENV_INVALID');
    }
    expect(() => validateVerificationEnv({ TOOL: 'line\nbreak' })).toThrow('VERIFICATION_ENV_INVALID');
    expect(() => validateVerificationEnv({ TOOL: 'sk-' + 'AF_TEST_ONLY_'.repeat(4) })).toThrow('VERIFICATION_ENV_INVALID');
    expect(() => validateVerificationEnv({ TOOL: '' })).toThrow('VERIFICATION_ENV_INVALID');
    expect(() => validateVerificationEnv(Object.fromEntries(Array.from({ length: MAX_VERIFICATION_ENV_ENTRIES + 1 }, (_, i) => [`TOOL_${i}`, 'x']))))
      .toThrow('VERIFICATION_ENV_INVALID');
    expect(() => validateVerificationEnv(['TOOL=x'])).toThrow('VERIFICATION_ENV_INVALID');
  });

  describe('locked dependencies', () => {
    let managedRoot: string;
    let worktree: string;
    let installer: string;
    let runs: number;
    const install = (failing = false) => {
      runs += 1;
      return ensureProjectDependencies(worktree, { MARK: 'from-env' }, {
        executable: process.execPath, args: [installer, failing ? 'fail' : 'ok'], timeoutMs: 30_000,
      });
    };

    beforeEach(() => {
      managedRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-deps-')));
      worktree = path.join(managedRoot, 'afw-one');
      fs.mkdirSync(worktree);
      fs.writeFileSync(path.join(worktree, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
      fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
      // Stand-in for npm ci: installs one module that records the environment it saw.
      installer = path.join(managedRoot, 'installer.cjs');
      fs.writeFileSync(installer, "const fs=require('fs');if(process.argv[2]==='fail'){process.exit(2)}" +
        "fs.mkdirSync('node_modules/dep',{recursive:true});fs.writeFileSync('node_modules/dep/index.js','module.exports='+JSON.stringify(process.env.MARK||null));");
      runs = 0;
    });
    afterEach(() => fs.rmSync(managedRoot, { recursive: true, force: true }));

    it('retries a move Windows briefly refuses, and reports a lasting refusal as a failed install (#370)', async () => {
      const realRename = fs.renameSync.bind(fs);
      let refusals = 0;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
        if (String(to).endsWith('node_modules') && refusals < 2) { refusals += 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
        return realRename(from, to);
      }) as typeof fs.renameSync);
      expect(await install()).toMatchObject({ status: 'INSTALLED' });
      expect(refusals).toBe(2);

      spy.mockImplementation((() => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }) as typeof fs.renameSync);
      fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');
      expect(await install()).toMatchObject({ status: 'FAILED', reasonCode: 'DEPENDENCY_INSTALL_EBUSY' });
      spy.mockRestore();
    }, 30_000);

    it('installs once per lockfile beside the worktrees, where a worktree resolves it', async () => {
      expect(await install()).toMatchObject({ status: 'INSTALLED' });
      expect(fs.readFileSync(path.join(managedRoot, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports="from-env"');
      expect(fs.existsSync(path.join(worktree, 'node_modules'))).toBe(false); // The worktree stays the coder's work only.
      expect(fs.readdirSync(managedRoot).filter((entry) => entry.startsWith('.agent-forge-deps-'))).toEqual([]);
      expect(await install()).toMatchObject({ status: 'CURRENT' });

      fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');
      expect(await install()).toMatchObject({ status: 'INSTALLED' });
      expect(runs).toBe(3);
    });

    it('keeps the previous tree when an install fails, and skips a project without a lockfile', async () => {
      expect(await install()).toMatchObject({ status: 'INSTALLED' });
      fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"x":{}}}');
      expect(await install(true)).toMatchObject({ status: 'FAILED', reasonCode: 'DEPENDENCY_INSTALL_FAILED' });
      expect(fs.existsSync(path.join(managedRoot, 'node_modules', 'dep', 'index.js'))).toBe(true);
      fs.rmSync(path.join(worktree, 'package-lock.json'));
      expect(await install()).toEqual({ status: 'NO_LOCKFILE' });
    });

    it('runs parallel installs of one project one at a time', async () => {
      const results = await Promise.all([install(), install()]);
      expect(results.map((result) => result.status).sort()).toEqual(['CURRENT', 'INSTALLED']);
    });
  });
});
