import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildTrustedEnvironment,
  isProtectedExecutableName,
  resolveTrustedExecutable,
} from '../src/core/services/ExecutableResolver';
import { ProcessRunner } from '../src/core/services/ProcessRunner';

describe('trusted executable resolution', () => {
  it('resolves the installed Git binary without selecting a PATH-prepended lookalike', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-executable-resolver-'));
    try {
      const fake = path.join(root, process.platform === 'win32' ? 'git.exe' : 'git');
      fs.writeFileSync(fake, process.platform === 'win32' ? 'not an executable' : '#!/bin/sh\necho HIJACKED\n', 'utf8');
      if (process.platform !== 'win32') fs.chmodSync(fake, 0o755);

      const resolved = resolveTrustedExecutable('git', 'git', {
        env: { ...process.env, ProgramFiles: process.env.ProgramFiles, 'ProgramFiles(x86)': process.env['ProgramFiles(x86)'], SystemRoot: process.env.SystemRoot, PATH: root, Path: root },
      });

      expect(resolved).toBeTruthy();
      expect(path.resolve(resolved!)).not.toBe(path.resolve(fake));
      expect(path.basename(resolved!).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '')).toBe('git');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a known Windows installation root while rejecting a user-writable PATH directory', () => {
    const fakePath = 'C:\\Users\\owner\\AppData\\Local\\Temp\\git.exe';
    const trustedPath = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const files = new Set([fakePath, trustedPath]);
    const options = {
      platform: 'win32' as const,
      env: {
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        Path: 'C:\\Users\\owner\\AppData\\Local\\Temp',
      },
      fileExists: (candidate: string) => files.has(candidate),
      fileIsRegularFile: (candidate: string) => files.has(candidate),
    };

    expect(resolveTrustedExecutable('git', 'git', options)).toBe(trustedPath);
    expect(resolveTrustedExecutable(fakePath, 'git', options)).toBeNull();
  });

  it('keeps explicit custom provider paths opt-in without weakening Git boundary checks', () => {
    const customProvider = 'C:\\agent-tools\\agy.exe';
    const options = {
      platform: 'win32' as const,
      env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      fileExists: (candidate: string) => candidate === customProvider,
      fileIsRegularFile: (candidate: string) => candidate === customProvider,
    };

    expect(resolveTrustedExecutable(customProvider, 'agy', options)).toBeNull();
    expect(resolveTrustedExecutable(customProvider, 'agy', { ...options, allowExplicitAbsoluteForProtected: true })).toBe(customProvider);
    expect(resolveTrustedExecutable('C:\\agent-tools\\git.exe', 'git', { ...options, allowExplicitAbsoluteForProtected: true })).toBeNull();
  });

  it('builds a minimal environment and drops PATH/control-shell overrides by default', () => {
    const env = buildTrustedEnvironment({
      env: {
        PATH: 'C:\\attacker',
        Path: 'C:\\attacker',
        COMSPEC: 'C:\\attacker\\cmd.exe',
        API_TOKEN: 'allowed-secret',
        SystemRoot: 'C:\\Windows',
      },
      platform: 'win32',
      allowedEnvKeys: ['PATH', 'COMSPEC', 'API_TOKEN'],
      fileExists: (candidate: string) => candidate.toLowerCase().endsWith('\\cmd.exe'),
      fileIsRegularFile: (candidate: string) => candidate.toLowerCase().endsWith('\\cmd.exe'),
    });

    expect(env.API_TOKEN).toBe('allowed-secret');
    expect(env.PATH?.toLowerCase()).not.toContain('attacker');
    expect(env.COMSPEC?.toLowerCase()).not.toContain('attacker');
  });

  it('does not let caller environment overrides replace trusted installation roots', () => {
    const env = buildTrustedEnvironment({
      platform: 'win32',
      env: {
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
      },
      customEnv: {
        ProgramFiles: 'C:\\attacker',
        SystemRoot: 'C:\\attacker',
        API_TOKEN: 'allowed-secret',
      },
      allowedEnvKeys: ['ProgramFiles', 'SystemRoot', 'API_TOKEN'],
      fileExists: (candidate: string) => candidate.toLowerCase().endsWith('\\cmd.exe'),
      fileIsRegularFile: (candidate: string) => candidate.toLowerCase().endsWith('\\cmd.exe'),
    });

    expect(env.ProgramFiles).toBe('C:\\Program Files');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.API_TOKEN).toBe('allowed-secret');
  });

  it('classifies protected names independently of their extension or absolute spelling', () => {
    expect(isProtectedExecutableName('git')).toBe('git');
    expect(isProtectedExecutableName('git.exe')).toBe('git');
    expect(isProtectedExecutableName(path.join('C:\\Program Files', 'Git', 'cmd', 'git.exe'))).toBe('git');
    expect(isProtectedExecutableName('unknown-provider')).toBeNull();
  });

  it('ProcessRunner ignores a caller PATH hijack for Git', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-process-resolver-'));
    try {
      const fake = path.join(root, process.platform === 'win32' ? 'git.exe' : 'git');
      fs.writeFileSync(fake, process.platform === 'win32' ? 'not an executable' : '#!/bin/sh\necho HIJACKED\n', 'utf8');
      if (process.platform !== 'win32') fs.chmodSync(fake, 0o755);
      const result = await ProcessRunner.execute({
        executable: 'git',
        args: ['--version'],
        cwd: root,
        env: { PATH: root },
        allowedEnvKeys: ['PATH'],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('HIJACKED');
      expect(result.stderr).not.toContain('TRUSTED_EXECUTABLE_NOT_FOUND');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
