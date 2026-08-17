import crypto from 'crypto';
import path from 'path';

export interface RepositorySelectionToken {
  selectionId: string;
  canonicalPath: string;
  displayPath: string;
  createdAt: number;
  consumed: boolean;
}

export class RepositorySelectionService {
  private static tokens = new Map<string, RepositorySelectionToken>();
  private static TTL_MS = 10 * 60 * 1000; // 10 minutes

  public static issueToken(rawPath: string): { selectionId: string; displayPath: string } {
    const canonicalPath = path.normalize(path.resolve(rawPath));
    const selectionId = crypto.randomUUID();

    this.tokens.set(selectionId, {
      selectionId,
      canonicalPath,
      displayPath: canonicalPath,
      createdAt: Date.now(),
      consumed: false,
    });

    return {
      selectionId,
      displayPath: canonicalPath,
    };
  }

  public static consumeToken(selectionId: string): { success: boolean; canonicalPath?: string; error?: string } {
    const token = this.tokens.get(selectionId);

    if (!token) {
      return { success: false, error: 'Invalid or fabricated repository selection token.' };
    }

    if (token.consumed) {
      return { success: false, error: 'Repository selection token has already been consumed.' };
    }

    if (Date.now() - token.createdAt > this.TTL_MS) {
      this.tokens.delete(selectionId);
      return { success: false, error: 'Repository selection token has expired.' };
    }

    token.consumed = true;
    return { success: true, canonicalPath: token.canonicalPath };
  }

  public static clearTokens(): void {
    this.tokens.clear();
  }
}
