import { describe, it, expect, beforeEach } from 'vitest';
import { RepositorySelectionService } from '../src/core/services/RepositorySelectionService';
import { CreateProjectIpcSchema } from '../src/core/types/ipc';

describe('Repository Selection Capability & Opaque Tokens', () => {
  beforeEach(() => {
    RepositorySelectionService.clearTokens();
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
    const testPath = 'd:/Projects/Agent-Forge';
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
    const testPath = 'd:/Projects/Agent-Forge';
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
});
