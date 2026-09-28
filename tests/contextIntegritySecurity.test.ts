import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sanitizeContextFiles } from '../src/core/context/ContextIntegrity';

describe('context file trust boundary', () => {
  it.each(['.env.local', '.env.production', '.npmrc', '.git/config', 'credentials.json', 'src/private.pem'])
    ('rejects sensitive context filename variants: %s', (contextFile) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-context-root-'));
      try {
        const result = sanitizeContextFiles([contextFile], root);
        expect(result.validFiles).toEqual([]);
        expect(result.error).toContain('CONTEXT_PATH_DENIED');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

  it('rejects an in-repository junction or symlink that resolves outside the repository', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-context-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-context-outside-'));
    const link = path.join(root, 'linked');
    fs.writeFileSync(path.join(outside, 'payload.txt'), 'outside', 'utf8');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    try {
      const result = sanitizeContextFiles(['linked/payload.txt'], root);
      expect(result.validFiles).toEqual([]);
      expect(result.error).toContain('CONTEXT_PATH_DENIED');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('retains deterministic metadata behavior for a missing, non-sensitive in-root file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-context-root-'));
    try {
      expect(sanitizeContextFiles(['src/a.ts', 'src\\b.ts', 'src/a.ts'], root)).toEqual({
        validFiles: ['src/a.ts', 'src/b.ts'],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
