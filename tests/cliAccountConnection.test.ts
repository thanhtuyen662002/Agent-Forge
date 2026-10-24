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

/** #242: Claude Code and Gemini sign-in through the CLI's own flow and check. */
describe('Claude Code and Gemini account sign-in (#242)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let repo: Repository;
  let resolver: NativeProfileResolver;
  let calls: Array<{ kind: 'run' | 'open'; executable: string; args: string[]; env: NodeJS.ProcessEnv }>;
  let nextRun: CliRunResult;
  const runner: CliRunner = {
    async run(executable, args, env) { calls.push({ kind: 'run', executable, args, env }); return nextRun; },
    openTerminal(executable, args, env) { calls.push({ kind: 'open', executable, args, env }); },
  };
  const service = (onVerified?: () => void) => new CliAccountConnectionService(repo, {
    runner, resolveExecutable: (name) => `C:\\Tools\\${name}.exe`, profileResolver: resolver, onVerified,
  });
  const addAgent = (connection: 'CLAUDE_CODE_CLI' | 'GEMINI_CLI' | 'CODEX_CLI') => {
    const created = new WorkspaceManagementService(repo).createAgent({ displayName: `${connection} coder`, role: 'CODER', connection, modelName: 'model', workerSlots: 1 });
    if (!created.success) throw new Error('agent not created');
    return repo.getProviderResource(created.agent.provider_resource_id!)!.provider_account_id!;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-sign-in-'));
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

    expect(cli.startSignIn(accountId)).toEqual({ success: true, cli: 'Claude Code' });
    expect(calls[0]).toMatchObject({ kind: 'open', args: ['auth', 'login'] });
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(profileDir);
    expect(fs.existsSync(profileDir)).toBe(true);
    expect(calls[0].env.ANTHROPIC_API_KEY).toBeUndefined();

    nextRun = { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) };
    expect(await cli.verify(accountId)).toEqual({ success: true, verified: true, reasonCode: 'VERIFIED' });
    expect(calls[1].args).toEqual(['auth', 'status']);
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
    expect(cli.startSignIn(accountId)).toEqual({ success: true, cli: 'Gemini' });
    expect(calls[0].env.GEMINI_CLI_HOME).toBe(profileDir);

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

  it('refuses Codex accounts (they use device-code sign-in) and missing CLIs', async () => {
    expect(service().startSignIn(addAgent('CODEX_CLI'))).toEqual({ success: false, errorCode: 'NOT_A_SUPPORTED_CLI_ACCOUNT' });
    const claude = addAgent('CLAUDE_CODE_CLI');
    const noCli = new CliAccountConnectionService(repo, { runner, resolveExecutable: () => null, profileResolver: resolver });
    expect(noCli.startSignIn(claude)).toEqual({ success: false, errorCode: 'CLI_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });
});
