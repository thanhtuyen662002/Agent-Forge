import { describe, it, expect } from 'vitest';
import { GitService } from '../src/core/services/GitService';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('GitService Fail-Closed Behavior', () => {
  it('should return status ERROR for non-existent directory', async () => {
    const res = await GitService.getStatus('d:/non-existent-directory-12345');
    expect(res.status).toBe('ERROR');
    expect(res.isClean).toBe(false);
    expect(res.errorMessage).toBeDefined();
  });

  it('should return status ERROR for non-git directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-dir-'));
    try {
      const statusRes = await GitService.getStatus(tmp);
      expect(statusRes.status).toBe('ERROR');
      expect(statusRes.isClean).toBe(false);

      const diffRes = await GitService.getDiff(tmp);
      expect(diffRes.status).toBe('ERROR');

      const shaRes = await GitService.getHeadSha(tmp);
      expect(shaRes.status).toBe('ERROR');
      expect(shaRes.sha).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
