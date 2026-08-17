import { describe, it, expect } from 'vitest';
import { defaultDb } from '../src/core/database/db';
import { defaultArtifactStore } from '../src/core/services/ArtifactStore';

describe('Zero Import-Time Working Directory Side-Effects', () => {
  it('should not create .agent-forge directory in process.cwd() on module import or instantiation without path', () => {
    expect(defaultDb.getDatabasePath()).toBeNull();
    expect(() => defaultDb.init()).toThrow();
    expect(() => defaultArtifactStore.getBaseDir()).toThrow();
  });
});
