import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizePortableRelativePath,
  ContextPathError,
  PORTABLE_CONTEXT_PATH_MAX_COMPONENTS,
  PORTABLE_CONTEXT_PATH_MAX_LENGTH,
  sanitizeContextFiles,
} from '../src/core/context/ContextIntegrity';

function expectRejected(rawPath: unknown, code: string): void {
  try {
    canonicalizePortableRelativePath(rawPath);
    throw new Error('expected canonicalizer to reject the path');
  } catch (error) {
    expect(error).toBeInstanceOf(ContextPathError);
    expect((error as ContextPathError).code).toBe(code);
  }
}

describe('portable context path canonicalization', () => {
  it('preserves ordinary relative files and canonicalizes one separator style', () => {
    expect(canonicalizePortableRelativePath('src/index.ts')).toBe('src/index.ts');
    expect(canonicalizePortableRelativePath('src\\index.ts')).toBe('src/index.ts');
    expect(canonicalizePortableRelativePath('./src/index.ts')).toBe('src/index.ts');
    expect(canonicalizePortableRelativePath('.\\src\\index.ts')).toBe('src/index.ts');
    expect(canonicalizePortableRelativePath('README.md')).toBe('README.md');
  });

  it.each([
    ['src/file.ts:secret', 'CONTEXT_PATH_INVALID'],
    ['src/file.ts:secret:more', 'CONTEXT_PATH_INVALID'],
    ['C:file.ts', 'CONTEXT_PATH_INVALID'],
    ['C:/file.ts', 'CONTEXT_PATH_INVALID'],
    ['/absolute/file.ts', 'CONTEXT_PATH_INVALID'],
    ['\\\\server\\share\\file.ts', 'CONTEXT_PATH_INVALID'],
    ['\\\\?\\C:\\file.ts', 'CONTEXT_PATH_INVALID'],
    ['//?/C:/file.ts', 'CONTEXT_PATH_INVALID'],
    ['//./PIPE/file', 'CONTEXT_PATH_INVALID'],
  ])('rejects absolute, drive, UNC, extended-length, and ADS forms: %s', (rawPath, code) => {
    expectRejected(rawPath, code);
  });

  it.each([
    ['src/file.', 'CONTEXT_PATH_ALIAS'],
    ['src/file ', 'CONTEXT_PATH_ALIAS'],
    ['src/dir. /file.ts', 'CONTEXT_PATH_ALIAS'],
    ['src//file.ts', 'CONTEXT_PATH_AMBIGUOUS'],
    ['src/./file.ts', 'CONTEXT_PATH_AMBIGUOUS'],
    ['src/../file.ts', 'CONTEXT_PATH_TRAVERSAL'],
    ['../file.ts', 'CONTEXT_PATH_TRAVERSAL'],
    ['src/file.ts\\other.ts', 'CONTEXT_PATH_AMBIGUOUS'],
    ['src/file.ts\u0000', 'CONTEXT_PATH_INVALID'],
    [' src/file.ts', 'CONTEXT_PATH_AMBIGUOUS'],
    ['src/file.ts ', 'CONTEXT_PATH_ALIAS'],
  ])('rejects ambiguous or traversal forms: %s', (rawPath, code) => {
    expectRejected(rawPath, code);
  });

  it.each([
    'CON', 'CON.txt', 'PRN', 'AUX.log', 'NUL', 'COM1', 'COM9.txt', 'COM¹', 'LPT1', 'LPT³',
    'CONIN$', 'CONOUT$', 'CLOCK$',
  ])('rejects reserved device component %s', (component) => {
    expectRejected(`src/${component}`, 'CONTEXT_PATH_RESERVED');
  });

  it('rejects non-canonical Unicode aliases and bounded path abuse', () => {
    expectRejected('src/e\u0301.txt', 'CONTEXT_PATH_ALIAS');
    expectRejected('a'.repeat(PORTABLE_CONTEXT_PATH_MAX_LENGTH + 1), 'CONTEXT_PATH_LIMIT_EXCEEDED');
    expectRejected(
      Array.from({ length: PORTABLE_CONTEXT_PATH_MAX_COMPONENTS + 1 }, () => 'a').join('/'),
      'CONTEXT_PATH_LIMIT_EXCEEDED',
    );
  });

  it('performs no filesystem lookup while rejecting portable-invalid paths', () => {
    const originalLstat = fs.lstatSync;
    let calls = 0;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      calls += 1;
      return originalLstat(...args);
    }) as typeof fs.lstatSync);
    try {
      expectRejected('src/file.ts:secret', 'CONTEXT_PATH_INVALID');
      expect(calls).toBe(0);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('sanitizes before policy/realpath checks and retains valid files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-portable-context-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}\n', 'utf8');
      expect(sanitizeContextFiles(['src\\index.ts', 'src/index.ts'], root)).toEqual({
        validFiles: ['src/index.ts'],
      });
      expect(sanitizeContextFiles(['src/index.ts:secret'], root)).toEqual({
        validFiles: [],
        error: expect.stringContaining('CONTEXT_PATH_INVALID'),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects case-colliding aliases on case-insensitive target platforms', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-portable-context-case-'));
    try {
      const result = sanitizeContextFiles(['src/Foo.ts', 'src/foo.ts'], root);
      if (process.platform === 'win32' || process.platform === 'darwin') {
        expect(result.validFiles).toEqual([]);
        expect(result.error).toContain('CONTEXT_PATH_ALIAS');
      } else {
        expect(result.validFiles).toEqual(['src/Foo.ts', 'src/foo.ts']);
        expect(result.error).toBeUndefined();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
