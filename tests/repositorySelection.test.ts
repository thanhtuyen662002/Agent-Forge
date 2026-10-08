import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RepositorySelectionService } from '../src/core/services/RepositorySelectionService';
import { CreateProjectIpcSchema } from '../src/core/types/ipc';

describe('Repository Selection Capability & Opaque Tokens', () => {
  let fixture: string;
  let testPath: string;
  beforeEach(() => {
    RepositorySelectionService.clearTokens();
    fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-repository-selection-')));
    testPath = path.join(fixture, 'Agent-Forge');
    fs.mkdirSync(testPath);
  });

  afterEach(() => {
    RepositorySelectionService.clearTokens();
    if (fs.realpathSync.native(fixture) !== fixture || !path.basename(fixture).startsWith('af-repository-selection-')) {
      throw new Error('FIXTURE_BOUNDARY_CHANGED');
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('should reject arbitrary raw paths in CreateProjectIpcSchema', () => {
    const rawPayload = {
      name: 'Evil Project',
      repositoryPath: 'c:/Windows/System32',
    };
    const parsed = CreateProjectIpcSchema.safeParse(rawPayload);
    expect(parsed.success).toBe(false);
  });

  it('should issue a valid selection token and allow one-time consumption', () => {
    const token = RepositorySelectionService.issueToken(testPath);
    expect(token.selectionId).toBeDefined();
    expect(token.displayPath).toBeDefined();

    // Verify token can be consumed
    const res = RepositorySelectionService.consumeToken(token.selectionId);
    expect(res.success).toBe(true);
    expect(res.canonicalPath).toContain('Agent-Forge');

    // Verify token CANNOT be reused (single-use proof)
    const reuseRes = RepositorySelectionService.consumeToken(token.selectionId);
    expect(reuseRes.success).toBe(false);
    expect(reuseRes.error).toContain('already been consumed');
  });

  it('should reject fabricated selection tokens', () => {
    const fakeToken = '00000000-0000-0000-0000-000000000000';
    const res = RepositorySelectionService.consumeToken(fakeToken);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Invalid or fabricated');
  });

  it('should reject expired selection tokens', () => {
    const token = RepositorySelectionService.issueToken(testPath);

    // Manually backdate token creation time to simulate expiry
    const internalMap = (RepositorySelectionService as any).tokens;
    const item = internalMap.get(token.selectionId);
    if (item) {
      item.createdAt = Date.now() - 15 * 60 * 1000; // 15 minutes old (TTL is 10 min)
    }

    const res = RepositorySelectionService.consumeToken(token.selectionId);
    expect(res.success).toBe(false);
    expect(res.error).toContain('expired');
  });

  it.each(['leaf', 'parent'])('rejects a real %s symlink or junction before issuing authority', (variant) => {
    const outside = path.join(fixture, 'unrelated');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel'), 'unrelated-owner');
    let alias = path.join(fixture, 'alias');
    if (variant === 'parent') {
      fs.mkdirSync(path.join(outside, 'repo'));
      fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
      alias = path.join(alias, 'repo');
    } else {
      fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    }
    expect(() => RepositorySelectionService.issueToken(alias)).toThrow('REPOSITORY_ROOT_ALIAS');
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('unrelated-owner');
  });

  it('rejects missing, non-directory and portable/device roots without issuing tokens', () => {
    const file = path.join(fixture, 'ordinary-file');
    fs.writeFileSync(file, 'ordinary-data');
    expect(() => RepositorySelectionService.issueToken(file)).toThrow('REPOSITORY_ROOT_NOT_DIRECTORY');
    expect(() => RepositorySelectionService.issueToken(path.join(fixture, 'missing'))).toThrow('REPOSITORY_ROOT_MISSING');
    for (const candidate of ['relative/repo', '//server/share/repo', '\\\\server\\share\\repo', '\\\\?\\C:\\repo', 'C:repo', 'bad\0root']) {
      expect(() => RepositorySelectionService.issueToken(candidate)).toThrow('REPOSITORY_ROOT_INVALID_PATH');
    }
  });

  it('burns a selected capability when an ordinary root is replaced before consumption', () => {
    fs.writeFileSync(path.join(testPath, 'sentinel'), 'selected-owner');
    const token = RepositorySelectionService.issueToken(testPath);
    const original = testPath + '-original';
    fs.renameSync(testPath, original);
    fs.mkdirSync(testPath);
    fs.writeFileSync(path.join(testPath, 'sentinel'), 'replacement-owner');
    expect(RepositorySelectionService.consumeToken(token.selectionId)).toMatchObject({ success: false, errorCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED' });
    fs.rmSync(testPath, { recursive: true });
    fs.renameSync(original, testPath);
    expect(RepositorySelectionService.consumeToken(token.selectionId).success).toBe(false);
    expect(fs.readFileSync(path.join(testPath, 'sentinel'), 'utf8')).toBe('selected-owner');
  });

  it('detects a changed parent even when the selected leaf directory identity is preserved', () => {
    const parent = path.join(fixture, 'parent');
    fs.mkdirSync(parent);
    const leaf = path.join(parent, 'repo');
    fs.mkdirSync(leaf);
    const token = RepositorySelectionService.issueToken(leaf);
    const leafId = fs.lstatSync(leaf, { bigint: true }).ino;
    fs.renameSync(parent, parent + '-original');
    fs.mkdirSync(parent);
    fs.renameSync(path.join(parent + '-original', 'repo'), leaf);
    expect(fs.lstatSync(leaf, { bigint: true }).ino).toBe(leafId);
    expect(RepositorySelectionService.consumeToken(token.selectionId)).toMatchObject({ success: false, errorCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED' });
  });
});
