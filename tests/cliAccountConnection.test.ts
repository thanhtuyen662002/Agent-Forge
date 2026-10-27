import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';
import { CliAccountConnectionService, type CliRunner, type CliRunResult } from '../src/core/services/CliAccountConnectionService';
import { ANTIGRAVITY_LIVE_TARGET, AntigravityCredentialSlots, antigravitySlotTarget } from '../src/core/credentials/AntigravityCredentialSlots';
import type { CredentialRecord, CredentialVault } from '../src/core/credentials/WindowsCredentialVault';

/** #242: Claude Code and Gemini sign-in through the CLI's own flow and check. */
describe('Claude Code and Gemini account sign-in (#242)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let repo: Repository;
  let resolver: NativeProfileResolver;
  let calls: Array<{ kind: 'run' | 'open'; executable: string; args: string[]; env: Record<string, string>; cwd: string }>;
  let tools: string;
  let nextRun: CliRunResult;
  const runner: CliRunner = {
    async run(executable, args, env, cwd) { calls.push({ kind: 'run', executable, args, env, cwd }); return nextRun; },
    openTerminal(executable, args, env, cwd) { calls.push({ kind: 'open', executable, args, env, cwd }); },
  };
  const service = (onVerified?: () => void) => new CliAccountConnectionService(repo, {
    runner, executableFor: (providerId) => path.join(tools, `${providerId}.exe`), profileResolver: resolver, onVerified,
  });
  const addAgent = (connection: 'CLAUDE_CODE_CLI' | 'GEMINI_CLI' | 'CODEX_CLI' | 'ANTIGRAVITY_CLI') => {
    const created = new WorkspaceManagementService(repo).createAgent({ displayName: `${connection} coder`, role: 'CODER', connection, modelName: 'model', workerSlots: 1 });
    if (!created.success) throw new Error('agent not created');
    return repo.getProviderResource(created.agent.provider_resource_id!)!.provider_account_id!;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-sign-in-'));
    tools = path.join(tmpDir, 'tools');
    fs.mkdirSync(tools);
    for (const id of ['prov-claude-code-cli', 'prov-gemini-cli', 'prov-antigravity-cli']) fs.writeFileSync(path.join(tools, `${id}.exe`), '');
    resolver = new NativeProfileResolver({ baseProfilesDir: path.join(tmpDir, 'profiles') });
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    calls = [];
    nextRun = { exitCode: 0, stdout: '' };
  });
  afterEach(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('opens Claude sign-in with the account’s own CLAUDE_CONFIG_DIR and verifies it through the single health writer', async () => {
    const accountId = addAgent('CLAUDE_CODE_CLI');
    const account = repo.getProviderAccount(accountId)!;
    const profileDir = resolver.resolve(account.profile_ref!).profileDirectory;
    let verifiedCallbacks = 0;
    const cli = service(() => { verifiedCallbacks += 1; });

    expect(await cli.startSignIn(accountId)).toEqual({ success: true, cli: 'Claude Code' });
    expect(calls[0]).toMatchObject({ kind: 'open', args: ['auth', 'login'] });
    expect(calls[0].env).toEqual({ CLAUDE_CONFIG_DIR: profileDir }); // Only the profile variable is added.
    expect(calls[0].executable).toBe(path.join(tools, 'prov-claude-code-cli.exe'));
    expect(fs.existsSync(profileDir)).toBe(true);

    nextRun = { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) };
    expect(await cli.verify(accountId)).toEqual({ success: true, verified: true, reasonCode: 'VERIFIED' });
    expect(calls[1].args).toEqual(['auth', 'status']);
    expect(calls[1].cwd).not.toBe(profileDir);
    expect(fs.existsSync(calls[1].cwd)).toBe(false); // The private check directory is removed.
    expect(repo.getProviderAccount(accountId)!.health_status).toBe('AVAILABLE');
    expect(verifiedCallbacks).toBe(1);
  });

  it.each([
    ['not signed in (exit 1)', { exitCode: 1, stdout: '' }, 'NOT_SIGNED_IN'],
    ['authMethod none', { exitCode: 0, stdout: JSON.stringify({ authMethod: 'none' }) }, 'NOT_SIGNED_IN'],
    ['an API key instead of a subscription', { exitCode: 0, stdout: JSON.stringify({ authMethod: 'api_key' }) }, 'NOT_A_SUBSCRIPTION_LOGIN'],
    ['unparseable output', { exitCode: 0, stdout: 'Logged in' }, 'VERIFY_FAILED'],
    ['a timeout', { exitCode: null, stdout: '' }, 'VERIFY_FAILED'],
  ])('never marks a Claude account usable for %s', async (_name, result, reasonCode) => {
    const accountId = addAgent('CLAUDE_CODE_CLI');
    nextRun = result;
    expect(await service().verify(accountId)).toEqual({ success: true, verified: false, reasonCode });
    expect(repo.getProviderAccount(accountId)!.health_status).toBe('UNKNOWN');
  });

  it('verifies Gemini only with a cached login and a successful read-only run', async () => {
    const accountId = addAgent('GEMINI_CLI');
    const profileDir = resolver.resolve(repo.getProviderAccount(accountId)!.profile_ref!).profileDirectory;
    const cli = service();
    expect(await cli.startSignIn(accountId)).toEqual({ success: true, cli: 'Gemini' });
    expect(calls[0].env).toEqual({ GEMINI_CLI_HOME: profileDir });

    expect(await cli.verify(accountId)).toEqual({ success: true, verified: false, reasonCode: 'NOT_SIGNED_IN' });
    expect(calls).toHaveLength(1); // No credential cache: the CLI is not even run.

    fs.mkdirSync(path.join(profileDir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, '.gemini', 'oauth_creds.json'), '{}', 'utf8');
    nextRun = { exitCode: 41, stdout: '' };
    expect(await cli.verify(accountId)).toMatchObject({ verified: false, reasonCode: 'NOT_SIGNED_IN' });
    nextRun = { exitCode: 0, stdout: '{"response":"OK"}' };
    expect(await cli.verify(accountId)).toMatchObject({ verified: true, reasonCode: 'VERIFIED' });
    expect(calls.at(-1)!.args).toEqual(expect.arrayContaining(['--approval-mode', 'plan']));
    expect(repo.getProviderAccount(accountId)!.health_status).toBe('AVAILABLE');
  });

  it('gives each Antigravity account its own sign-in although agy keeps one machine-wide (#304)', async () => {
    const entries = new Map<string, CredentialRecord>();
    const vault: CredentialVault = {
      read: (t) => entries.get(t) ?? null, write: (t, r) => { entries.set(t, r); }, remove: (t) => { entries.delete(t); },
    };
    const cred = (s: string): CredentialRecord => ({ userName: 'antigravity', comment: null, persist: 2, blob: Buffer.from(s) });
    entries.set(ANTIGRAVITY_LIVE_TARGET, cred('owner'));
    const antigravitySlots = new AntigravityCredentialSlots(vault);
    const cli = new CliAccountConnectionService(repo, { runner, executableFor: (id) => path.join(tools, `${id}.exe`), profileResolver: resolver, antigravitySlots });
    const first = addAgent('ANTIGRAVITY_CLI');
    const second = addAgent('ANTIGRAVITY_CLI');

    for (const [accountId, secret] of [[first, 'first'], [second, 'second']] as const) {
      expect(await cli.startSignIn(accountId)).toEqual({ success: true, cli: 'Antigravity' });
      expect(entries.has(ANTIGRAVITY_LIVE_TARGET)).toBe(false); // agy asks for a fresh sign-in.
      entries.set(ANTIGRAVITY_LIVE_TARGET, cred(secret)); // The owner signs in with this account.
      nextRun = { exitCode: 0, stdout: '{"status":"OK"}' };
      expect(await cli.verify(accountId)).toMatchObject({ verified: true });
    }
    expect(entries.get(antigravitySlotTarget(first))!.blob.toString()).toBe('first');
    expect(entries.get(antigravitySlotTarget(second))!.blob.toString()).toBe('second');
    expect(entries.get(ANTIGRAVITY_LIVE_TARGET)!.blob.toString()).toBe('owner');
  });

  it('signs Antigravity in through agy itself and verifies with a read-only prompt; a quota error still proves the sign-in (#265)', async () => {
    const accountId = addAgent('ANTIGRAVITY_CLI');
    const profileDir = resolver.resolve(repo.getProviderAccount(accountId)!.profile_ref!).profileDirectory;
    const cli = service();
    expect(await cli.startSignIn(accountId)).toEqual({ success: true, cli: 'Antigravity' });
    expect(calls[0]).toMatchObject({ kind: 'open', args: [] });
    expect(calls[0].env).toEqual({ USERPROFILE: profileDir, HOME: profileDir });

    nextRun = { exitCode: 3, stdout: '{"status":"ERROR","error":"Individual quota reached. Resets in 117h59m19s."}',
      stderr: 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429,"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached."}' };
    expect(await cli.verify(accountId)).toEqual({ success: true, verified: true, reasonCode: 'VERIFIED' });
    expect(calls[1].args).toEqual(expect.arrayContaining(['--mode', 'plan', '-p']));
    expect(calls[1].args.join(' ')).not.toMatch(/dangerously|accept-edits/);

    const other = addAgent('ANTIGRAVITY_CLI');
    nextRun = { exitCode: 1, stdout: '', stderr: 'AGY_ERROR: {"status":"UNAUTHENTICATED","error_code":401,"short_error":"not signed in"}' };
    expect(await cli.verify(other)).toEqual({ success: true, verified: false, reasonCode: 'NOT_SIGNED_IN' });
    nextRun = { exitCode: 1, stdout: '', stderr: 'boom' };
    expect(await cli.verify(other)).toEqual({ success: true, verified: false, reasonCode: 'VERIFY_FAILED' });
  });

  it('refuses Codex accounts (they use device-code sign-in) and missing CLIs', async () => {
    expect(await service().startSignIn(addAgent('CODEX_CLI'))).toEqual({ success: false, errorCode: 'NOT_A_SUPPORTED_CLI_ACCOUNT' });
    const claude = addAgent('CLAUDE_CODE_CLI');
    const noCli = new CliAccountConnectionService(repo, { runner, executableFor: () => path.join(tools, 'missing.exe'), profileResolver: resolver });
    expect(await noCli.startSignIn(claude)).toEqual({ success: false, errorCode: 'CLI_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });

  it('does not clear other recorded failures such as an exhausted quota', async () => {
    const accountId = addAgent('CLAUDE_CODE_CLI');
    db.prepare("UPDATE provider_accounts SET health_status = 'QUOTA_EXHAUSTED' WHERE id = ?").run(accountId);
    nextRun = { exitCode: 0, stdout: JSON.stringify({ authMethod: 'claude.ai' }) };
    expect(await service().verify(accountId)).toEqual({ success: true, verified: false, reasonCode: 'ALREADY_IN_USE' });
    expect(repo.getProviderAccount(accountId)!.health_status).toBe('QUOTA_EXHAUSTED');
  });

  it('recovers an expired login once the CLI proves the profile is signed in again (#247)', async () => {
    const accountId = addAgent('CLAUDE_CODE_CLI');
    db.prepare("UPDATE provider_accounts SET health_status = 'AUTH_ERROR', last_failure_code = 'AUTH_ERROR' WHERE id = ?").run(accountId);
    nextRun = { exitCode: 1, stdout: '' };
    expect(await service().verify(accountId)).toMatchObject({ verified: false, reasonCode: 'NOT_SIGNED_IN' });
    expect(repo.getProviderAccount(accountId)!.health_status).toBe('AUTH_ERROR');
    nextRun = { exitCode: 0, stdout: JSON.stringify({ authMethod: 'claude.ai' }) };
    expect(await service().verify(accountId)).toEqual({ success: true, verified: true, reasonCode: 'VERIFIED' });
    expect(repo.getProviderAccount(accountId)).toMatchObject({ health_status: 'AVAILABLE', last_failure_code: null });
  });
});
