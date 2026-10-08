import crypto from 'crypto';
import { assertRepositoryRootIdentity, captureRepositoryRoot, RepositoryRootError, RepositoryRootErrorCode, RepositoryRootIdentity } from './RepositoryRootIdentity';

export interface RepositorySelectionToken {
  selectionId: string;
  canonicalPath: string;
  displayPath: string;
  createdAt: number;
  consumed: boolean;
  rootIdentity: RepositoryRootIdentity;
}

export class RepositorySelectionService {
  private static tokens = new Map<string, RepositorySelectionToken>();
  private static TTL_MS = 10 * 60 * 1000; // 10 minutes

  public static issueToken(rawPath: string, expectedIdentity?: RepositoryRootIdentity): { selectionId: string; displayPath: string } {
    const rootIdentity = expectedIdentity ?? captureRepositoryRoot(rawPath);
    assertRepositoryRootIdentity(rootIdentity);
    const canonicalPath = rootIdentity.canonicalPath;
    if (captureRepositoryRoot(rawPath).canonicalPath !== canonicalPath) throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED');
    const selectionId = crypto.randomUUID();

    this.tokens.set(selectionId, {
      selectionId,
      canonicalPath,
      displayPath: rawPath,
      createdAt: Date.now(),
      consumed: false,
      rootIdentity,
    });

    return {
      selectionId,
      displayPath: rawPath,
    };
  }

  public static consumeToken(selectionId: string): { success: boolean; canonicalPath?: string; rootIdentity?: RepositoryRootIdentity; error?: string; errorCode?: RepositoryRootErrorCode } {
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
    try { assertRepositoryRootIdentity(token.rootIdentity); }
    catch (error) {
      const failure = error instanceof RepositoryRootError ? error : new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
      return { success: false, error: failure.message, errorCode: failure.code };
    }
    return { success: true, canonicalPath: token.canonicalPath, rootIdentity: token.rootIdentity };
  }

  public static clearTokens(): void {
    this.tokens.clear();
  }
}
