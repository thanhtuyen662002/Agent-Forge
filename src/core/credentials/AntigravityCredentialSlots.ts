import type { CredentialVault } from './WindowsCredentialVault';

/** The single, machine-wide entry where agy keeps its Google sign-in (agy 1.4.8). */
export const ANTIGRAVITY_LIVE_TARGET = 'gemini:antigravity';
const SLOT_PREFIX = 'AgentForge/antigravity/';
/** The live entry as it was before Agent Forge swapped it, kept until restored. */
export const ANTIGRAVITY_STASH_TARGET = `${SLOT_PREFIX}__stash`;

export const antigravitySlotTarget = (accountId: string): string => {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(accountId)) throw new Error('INVALID_ACCOUNT_ID');
  return `${SLOT_PREFIX}${accountId}`;
};

/**
 * Several Antigravity accounts on one Windows user (#304).
 *
 * agy keeps exactly one sign-in, in the shared Credential Manager entry
 * `gemini:antigravity`; a per-account profile directory does not isolate it.
 * Each account therefore gets its own Credential Manager slot. A run swaps the
 * account's slot into the live entry, then saves the (possibly refreshed) live
 * entry back to the slot and restores what was live before. Every operation on
 * the live entry is serialized, because it is shared. Credentials are copied as
 * opaque blobs and never leave the Credential Manager.
 */
export class AntigravityCredentialSlots {
  private tail: Promise<unknown> = Promise.resolve();
  private pendingSignIn: string | null = null;

  constructor(private readonly vault: CredentialVault) {}

  /** Runs `work` with the account's sign-in live. Without a slot, the live entry is used as is. */
  public withAccount<T>(accountId: string | null | undefined, work: () => Promise<T>): Promise<T> {
    return this.serialize(() => (accountId ? this.runWithSlot(accountId, work) : work()));
  }

  /** Before an account's sign-in: keep the current live entry aside and clear it, so agy asks for a fresh sign-in. */
  public prepareSignIn(accountId: string): Promise<void> {
    antigravitySlotTarget(accountId);
    return this.serialize(async () => {
      this.stashLive();
      this.vault.remove(ANTIGRAVITY_LIVE_TARGET);
      this.pendingSignIn = accountId;
    });
  }

  /**
   * The sign-in check of an account. Right after its sign-in, the check runs on
   * the new live entry, which becomes the account's slot when it passes; the
   * previous live entry then returns. Otherwise the check runs on the account's slot.
   */
  public checkSignIn<T>(accountId: string, check: () => Promise<T>, passed: (result: T) => boolean): Promise<T> {
    return this.serialize(async () => {
      if (this.pendingSignIn !== accountId) return this.runWithSlot(accountId, check);
      const result = await check();
      if (passed(result)) {
        const live = this.vault.read(ANTIGRAVITY_LIVE_TARGET);
        if (live) this.vault.write(antigravitySlotTarget(accountId), live);
        this.pendingSignIn = null;
        this.restoreStash();
      }
      return result;
    });
  }

  /** Startup recovery: a stash left by an interrupted run or sign-in is put back. */
  public recover(): void {
    this.restoreStash();
  }

  private async runWithSlot<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const target = antigravitySlotTarget(accountId);
    const slot = this.vault.read(target);
    if (!slot) return work();
    // While another account signs in, the live entry may already hold that new
    // sign-in: it is put back exactly, and the owner's stash stays untouched.
    const signingIn = this.pendingSignIn !== null;
    const current = signingIn ? this.vault.read(ANTIGRAVITY_LIVE_TARGET) : null;
    if (!signingIn) this.stashLive();
    this.vault.write(ANTIGRAVITY_LIVE_TARGET, slot);
    try {
      return await work();
    } finally {
      // agy may have refreshed the token during the run: keep it for this account.
      const after = this.vault.read(ANTIGRAVITY_LIVE_TARGET);
      if (after) this.vault.write(target, after);
      if (!signingIn) this.restoreStash();
      else if (current) this.vault.write(ANTIGRAVITY_LIVE_TARGET, current);
      else this.vault.remove(ANTIGRAVITY_LIVE_TARGET);
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Never overwrites an existing stash: that one holds the owner's original entry. */
  private stashLive(): void {
    if (this.vault.read(ANTIGRAVITY_STASH_TARGET)) return;
    const live = this.vault.read(ANTIGRAVITY_LIVE_TARGET);
    if (live) this.vault.write(ANTIGRAVITY_STASH_TARGET, live);
  }

  private restoreStash(): void {
    const stash = this.vault.read(ANTIGRAVITY_STASH_TARGET);
    if (!stash) return;
    this.vault.write(ANTIGRAVITY_LIVE_TARGET, stash);
    this.vault.remove(ANTIGRAVITY_STASH_TARGET);
  }
}
