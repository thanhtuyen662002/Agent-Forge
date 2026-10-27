import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_LIVE_TARGET, ANTIGRAVITY_STASH_TARGET, AntigravityCredentialSlots, antigravitySlotTarget,
} from '../src/core/credentials/AntigravityCredentialSlots';
import { WindowsCredentialVault, type CredentialRecord, type CredentialVault } from '../src/core/credentials/WindowsCredentialVault';

class FakeVault implements CredentialVault {
  readonly entries = new Map<string, CredentialRecord>();
  read(target: string) { const e = this.entries.get(target); return e ? { ...e, blob: Buffer.from(e.blob) } : null; }
  write(target: string, record: CredentialRecord) { this.entries.set(target, { ...record, blob: Buffer.from(record.blob) }); }
  remove(target: string) { this.entries.delete(target); }
  live() { return this.entries.get(ANTIGRAVITY_LIVE_TARGET)?.blob.toString() ?? null; }
}
const cred = (secret: string): CredentialRecord => ({ userName: 'antigravity', comment: null, persist: 2, blob: Buffer.from(secret) });

/** #304: several Antigravity accounts although agy keeps one machine-wide sign-in. */
describe('Antigravity credential slots', () => {
  it('runs with the account sign-in, keeps a refreshed token and restores the live entry', async () => {
    const vault = new FakeVault();
    vault.write(ANTIGRAVITY_LIVE_TARGET, cred('owner'));
    vault.write(antigravitySlotTarget('acct-b'), cred('b-token'));
    const slots = new AntigravityCredentialSlots(vault);

    const seen = await slots.withAccount('acct-b', async () => {
      const during = vault.live();
      vault.write(ANTIGRAVITY_LIVE_TARGET, cred('b-refreshed')); // agy refreshes during the run.
      return during;
    });

    expect(seen).toBe('b-token');
    expect(vault.read(antigravitySlotTarget('acct-b'))!.blob.toString()).toBe('b-refreshed');
    expect(vault.live()).toBe('owner');
    expect(vault.read(ANTIGRAVITY_STASH_TARGET)).toBeNull();
  });

  it('restores the live entry when the run throws', async () => {
    const vault = new FakeVault();
    vault.write(ANTIGRAVITY_LIVE_TARGET, cred('owner'));
    vault.write(antigravitySlotTarget('acct-b'), cred('b-token'));
    await expect(new AntigravityCredentialSlots(vault).withAccount('acct-b', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(vault.live()).toBe('owner');
  });

  it('uses the live entry unchanged for an account without a slot', async () => {
    const vault = new FakeVault();
    vault.write(ANTIGRAVITY_LIVE_TARGET, cred('owner'));
    expect(await new AntigravityCredentialSlots(vault).withAccount('acct-new', async () => vault.live())).toBe('owner');
    expect(vault.entries.size).toBe(1);
  });

  it('never lets two runs overlap', async () => {
    const vault = new FakeVault();
    vault.write(antigravitySlotTarget('a'), cred('a'));
    vault.write(antigravitySlotTarget('b'), cred('b'));
    const slots = new AntigravityCredentialSlots(vault);
    const order: string[] = [];
    let release!: () => void;
    const first = slots.withAccount('a', () => new Promise<void>((resolve) => { order.push(`start ${vault.live()}`); release = () => { order.push('end a'); resolve(); }; }));
    const second = slots.withAccount('b', async () => { order.push(`start ${vault.live()}`); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['start a']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['start a', 'end a', 'start b']);
  });

  it('signs in an account on a cleared live entry, keeps it as its slot, and leaves other slots alone', async () => {
    const vault = new FakeVault();
    vault.write(ANTIGRAVITY_LIVE_TARGET, cred('owner'));
    vault.write(antigravitySlotTarget('acct-a'), cred('a-token'));
    const slots = new AntigravityCredentialSlots(vault);

    await slots.prepareSignIn('acct-b');
    expect(vault.live()).toBeNull(); // agy now asks for a fresh sign-in.
    vault.write(ANTIGRAVITY_LIVE_TARGET, cred('b-new')); // The owner signs in with account B.

    const result = await slots.checkSignIn('acct-b', async () => (vault.live() === 'b-new' ? 'VERIFIED' : 'NOT_SIGNED_IN'), (r) => r === 'VERIFIED');
    expect(result).toBe('VERIFIED');
    expect(vault.read(antigravitySlotTarget('acct-b'))!.blob.toString()).toBe('b-new');
    expect(vault.read(antigravitySlotTarget('acct-a'))!.blob.toString()).toBe('a-token');
    expect(vault.live()).toBe('owner');
  });

  it('keeps an in-progress sign-in intact while another account runs', async () => {
    const vault = new FakeVault();
    vault.write(ANTIGRAVITY_LIVE_TARGET, cred('owner'));
    vault.write(antigravitySlotTarget('acct-a'), cred('a-token'));
    const slots = new AntigravityCredentialSlots(vault);
    await slots.prepareSignIn('acct-b');
    vault.write(ANTIGRAVITY_LIVE_TARGET, cred('b-new'));

    expect(await slots.withAccount('acct-a', async () => vault.live())).toBe('a-token');
    expect(vault.live()).toBe('b-new'); // B's fresh sign-in is still there to be captured.

    await slots.checkSignIn('acct-b', async () => 'VERIFIED', (r) => r === 'VERIFIED');
    expect(vault.read(antigravitySlotTarget('acct-b'))!.blob.toString()).toBe('b-new');
    expect(vault.live()).toBe('owner');
  });

  it('checks an already signed-in account on its own slot', async () => {
    const vault = new FakeVault();
    vault.write(ANTIGRAVITY_LIVE_TARGET, cred('owner'));
    vault.write(antigravitySlotTarget('acct-a'), cred('a-token'));
    const seen = await new AntigravityCredentialSlots(vault).checkSignIn('acct-a', async () => vault.live(), () => true);
    expect(seen).toBe('a-token');
    expect(vault.live()).toBe('owner');
  });

  it('restores a stash left by a crash on startup', () => {
    const vault = new FakeVault();
    vault.write(ANTIGRAVITY_STASH_TARGET, cred('owner'));
    vault.write(ANTIGRAVITY_LIVE_TARGET, cred('b-token'));
    new AntigravityCredentialSlots(vault).recover();
    expect(vault.live()).toBe('owner');
    expect(vault.read(ANTIGRAVITY_STASH_TARGET)).toBeNull();
  });

  it('refuses account ids that could address another entry', () => {
    expect(() => antigravitySlotTarget('../gemini:antigravity')).toThrow('INVALID_ACCOUNT_ID');
    expect(() => antigravitySlotTarget('__stash/x')).toThrow('INVALID_ACCOUNT_ID');
  });
});

describe.runIf(process.platform === 'win32')('Windows Credential Manager vault (#304)', () => {
  it('writes, reads and deletes a generic credential on a dedicated test target', () => {
    const vault = new WindowsCredentialVault();
    const target = `AgentForgeTest/vault-roundtrip-${crypto.randomUUID()}`;
    try {
      expect(vault.read(target)).toBeNull();
      const blob = crypto.randomBytes(48);
      vault.write(target, { userName: 'agent-forge-test', comment: null, persist: 1, blob });
      const read = vault.read(target)!;
      expect(read.blob.equals(blob)).toBe(true);
      expect(read.userName).toBe('agent-forge-test');
    } finally {
      vault.remove(target);
    }
    expect(vault.read(target)).toBeNull();
  });
});
