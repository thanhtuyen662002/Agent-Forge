import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PolicyService } from '../src/core/services/PolicyService';

const classify = PolicyService.classifyVerificationCommandCandidate;

describe('verification command candidate preparation', () => {
  it.each(['bash', '/bin/sh', '/usr/bin/env', 'busybox', 'CMD.EXE', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'pwsh.cmd.exe'])(
    'denies shell/environment host %s on every platform', (executable) => {
      expect(classify(executable, ['version'])).toEqual({ decision: 'DENY', reasonCode: 'SHELL_OR_ENV_INDIRECTION' });
    },
  );

  it.each(['npm', 'NPM.CMD', '/usr/bin/npx', 'C:\\bin\\npm.cmd.exe', 'pnpm', 'corepack', 'yarnpkg', 'pip3', 'uv'])(
    'denies package indirection %s', (executable) => {
      expect(classify(executable, ['test'])).toEqual({ decision: 'DENY', reasonCode: 'PACKAGE_MANAGER_INDIRECTION' });
    },
  );

  it.each(['mshta', 'wscript.exe', 'CSCRIPT.EXE', 'rundll32', 'regsvr32.exe', 'check.ps1', 'check.vbs', 'check.wsf'])(
    'denies script/system host %s', (executable) => {
      expect(classify(executable, [])).toEqual({ decision: 'DENY', reasonCode: 'SCRIPT_HOST_INDIRECTION' });
    },
  );

  it.each(['node', '/usr/bin/node', 'C:\\Program Files\\nodejs\\NODE.EXE', 'node.cmd', 'python', 'python3.12', 'pythonw.exe', 'py.exe', 'bun', 'deno'])(
    'requires a capability for file interpreter %s without granting execution', (executable) => {
      expect(classify(executable, ['tests/check.js'])).toEqual({ decision: 'CAPABILITY_REQUIRED', reasonCode: 'INTERPRETER_IDENTITY_REQUIRED' });
    },
  );

  it.each([
    ['node', '-e'], ['node', '-econsole.log(1)'], ['node', '--eval=code'], ['node', '-p'], ['python3', '-c'], ['python3', '-cprint(1)'], ['deno', 'eval'],
  ])('denies inline evaluation %s %s', (executable, argument) => {
    expect(classify(executable, [argument])).toEqual({ decision: 'DENY', reasonCode: 'INLINE_EVALUATION' });
  });

  it.each(['-r', '-rmodule', '--require=x', '--import=x', '--loader=x', '--experimental-loader=x'])('denies runtime hook %s', (argument) => {
    expect(classify('node', [argument])).toEqual({ decision: 'DENY', reasonCode: 'RUNTIME_HOOK' });
  });

  it.each(['echo;hidden', 'echo|hidden', 'echo&&hidden', '$(hidden)', '`hidden`', 'out>file'])('denies shell syntax in literal argument %s', (argument) => {
    expect(classify('git', [argument])).toEqual({ decision: 'DENY', reasonCode: 'SHELL_SYNTAX' });
  });

  it('requires canonical executable authority even for harmless-looking binaries', () => {
    for (const executable of ['git', '/usr/bin/git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'custom-tool']) {
      const result = classify(executable, ['--version']);
      expect(result).toEqual({ decision: 'CAPABILITY_REQUIRED', reasonCode: 'CANONICAL_IDENTITY_REQUIRED' });
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it('rejects traversal, network executable paths, quotes and explicit shell requests', () => {
    expect(classify('../tool', []).reasonCode).toBe('PATH_TRAVERSAL');
    expect(classify('C:\\bin\\..\\tool.exe', []).reasonCode).toBe('PATH_TRAVERSAL');
    expect(classify('\\\\server\\share\\tool.exe', []).reasonCode).toBe('NETWORK_EXECUTABLE');
    expect(classify('"git"', []).reasonCode).toBe('SHELL_SYNTAX');
    expect(classify('git', [], true).reasonCode).toBe('SHELL_OR_ENV_INDIRECTION');
  });

  it('rejects malformed and control-bearing values without echoing input', () => {
    const diagnosticSecret = 'private-candidate-value';
    for (const [executable, args, shell] of [
      [null, [], false], ['', [], false], [' git', [], false], ['git', null, false],
      ['git', [0], false], ['git', [diagnosticSecret + '\n'], false], ['git\0', [], false],
      ['git', [], 'true'], ['git', ['line\u2028split'], false],
    ]) {
      const result = classify(executable, args, shell);
      expect(result).toEqual({ decision: 'DENY', reasonCode: 'INVALID_CANDIDATE' });
      expect(JSON.stringify(result)).not.toContain(diagnosticSecret);
    }
    const malicious = new Proxy([], { get() { throw new Error(diagnosticSecret); } });
    expect(classify('git', malicious)).toEqual({ decision: 'DENY', reasonCode: 'INVALID_CANDIDATE' });
  });

  it('bounds path, argument count, each argument and total argument input', () => {
    for (const [executable, args] of [
      ['x'.repeat(4097), []], ['git', Array(129).fill('x')],
      ['git', ['x'.repeat(4097)]], ['git', Array(5).fill('x'.repeat(4096))],
    ]) expect(classify(executable, args)).toEqual({ decision: 'DENY', reasonCode: 'CANDIDATE_LIMIT_EXCEEDED' });
    expect(classify('git', Array(128).fill('x')).decision).toBe('CAPABILITY_REQUIRED');
  });

  it('does no filesystem lookup and leaves the general npm test policy unchanged', () => {
    const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(() => { throw new Error('unexpected filesystem lookup'); });
    const realpath = vi.spyOn(fs, 'realpathSync').mockImplementation(() => { throw new Error('unexpected filesystem lookup'); });
    try {
      expect(classify('node', ['tests/check.js']).decision).toBe('CAPABILITY_REQUIRED');
      expect(classify('npm', ['test']).decision).toBe('DENY');
      expect(lstat).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
      expect(PolicyService.evaluateProcessExecution('npm', ['test']).allowed).toBe(true);
    } finally {
      lstat.mockRestore();
      realpath.mockRestore();
    }
  });
});
