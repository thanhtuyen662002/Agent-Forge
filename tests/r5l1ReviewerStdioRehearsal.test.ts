import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { setupSyntheticRehearsalEnv, issueSubmissionSession, performSafeCleanup, type SyntheticRehearsalEnv } from './helpers/r5l1SyntheticFixture';
import { REVIEWER_TOOL_NAME } from '../src/mcp/reviewerProtocol';

const root = path.resolve(__dirname, '..');
let compiled: string;
let entry: string;
let probe: string;

beforeAll(() => {
  // Isolated output avoids racing other suites that compile dist-electron.
  compiled = fs.mkdtempSync(path.join(root, '.r5l1-stdio-'));
  try {
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p',
      path.join(root, 'tsconfig.node.json'), '--outDir', compiled], { cwd: root, stdio: 'pipe', timeout: 120000 });
    fs.writeFileSync(path.join(compiled, 'package.json'), '{"type":"commonjs"}');
    entry = path.join(compiled, 'mcp/stdio-review.js');
    probe = path.join(compiled, 'read-observer.cjs');
    // Test-only observer in the actual server process, no MCP endpoint or runtime changes.
    // Parent-connection total_changes() cannot measure writes by another connection.
    fs.writeFileSync(probe, `
const fs = require('node:fs');
const { ReviewerAuthorityService } = require('./mcp/reviewerAuthority.js');
const original = ReviewerAuthorityService.prototype.authenticateAndGetReviewPackage;
ReviewerAuthorityService.prototype.authenticateAndGetReviewPackage = function (...args) {
  const db = require('./mcp/stdio-review.js').getActiveReviewerDatabase();
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  try { return original.apply(this, args); }
  finally {
    const after = db.prepare('SELECT total_changes() AS n').get().n;
    fs.appendFileSync(process.env.R5L1_READ_RECEIPTS, JSON.stringify({before, after}) + '\\n');
  }
};
const write = process.stdout.write;
process.stdout.write = function (chunk, ...args) {
  fs.appendFileSync(process.env.R5L1_STDOUT_CAPTURE, chunk);
  return write.call(this, chunk, ...args);
};
`);
  } catch (error) {
    fs.rmSync(compiled, { recursive: true, force: true });
    throw error;
  }
}, 150000);

afterAll(() => { if (compiled) fs.rmSync(compiled, { recursive: true, force: true }); });

function claim(env: SyntheticRehearsalEnv, marker: string) {
  const session = issueSubmissionSession(env.repo, env.authorizationId);
  const submissionId = crypto.randomUUID();
  const result = env.mcpService.submitCoderClaim({
    submission_id: submissionId, authorization_id: env.authorizationId, project_id: env.projectId,
    task_id: env.taskId, attempt_id: env.attemptId, assignment_id: env.assignmentId,
    task_ownership_epoch: 1, base_sha: env.baseSha, repository_head_sha: env.repoHeadSha,
    status: 'COMPLETED', summary: marker, changed_files: ['README.md'], tests_claimed: ['local-node'],
    blockers: [], review_requested: true,
    client_metadata: { client_name: 'stdio-rehearsal', client_version: '1', client_session_mode: 'CLI_EXTERNAL' },
  }, session.plaintextToken);
  expect(result.accepted).toBe(true);
  return submissionId;
}

function assertExited(pid: number) {
  let error: NodeJS.ErrnoException | undefined;
  try { process.kill(pid, 0); } catch (caught) { error = caught as NodeJS.ErrnoException; }
  expect(error?.code).toBe('ESRCH'); // EPERM is not evidence of process death.
}

describe('R5L1 reviewer over real stdio subprocess', () => {
  it('reads frozen packages and rejects foreign, stale and revoked access with child-connection zero writes', async () => {
    const marker = 'STDIO_PRIVATE_' + crypto.randomUUID();
    const env = setupSyntheticRehearsalEnv({ taskTitleMarker: marker });
    let client: Client | undefined;
    let transport: StdioClientTransport | undefined;
    let pid: number | null = null;
    let stderr = '';
    let token = '';
    const receipts = path.join(env.tempDir, 'reads.jsonl');
    const stdout = path.join(env.tempDir, 'stdout.log');
    let receiptCount = 0;
    try {
      const admitted = await env.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(), submissionId: claim(env, marker),
      });
      expect(admitted.status).toBe('VERIFIED');
      const id = admitted.adjudication.id;
      const issued = env.reviewerService.issueReviewerSession({ adjudication_id: id,
        reviewer_agent_id: env.agentIdReviewer, reviewer_provider_id: env.providerId,
        reviewer_account_id: env.reviewerAccountId, reviewer_resource_id: env.reviewerResourceId });
      token = issued.raw_token;
      const childEnv: Record<string, string> = {
        AGENTFORGE_MCP_DB_PATH: env.dbPath, AGENTFORGE_MCP_REVIEWER_TOKEN: token,
        R5L1_READ_RECEIPTS: receipts, R5L1_STDOUT_CAPTURE: stdout,
        HOME: env.tempDir, USERPROFILE: env.tempDir, TMP: env.tempDir, TEMP: env.tempDir,
      };
      if (process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;
      transport = new StdioClientTransport({ command: process.execPath,
        args: ['--require', probe, entry], cwd: env.tempDir, env: childEnv, stderr: 'pipe' });
      transport.stderr?.on('data', chunk => { stderr += String(chunk); });
      client = new Client({ name: 'real-stdio-rehearsal', version: '1.0.0' });
      await client.connect(transport);
      pid = transport.pid;
      expect(pid).toBeGreaterThan(0);
      expect(pid).not.toBe(process.pid);
      expect((await client.listTools()).tools.map(t => t.name)).toEqual([REVIEWER_TOOL_NAME]);
      expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(1);

      const assertReceipt = () => {
        const rows = fs.readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(rows).toHaveLength(++receiptCount);
        expect(rows.at(-1).after).toBe(rows.at(-1).before);
      };
      const readPair = async (target: string, errorCode?: string) => {
        const tool = await client!.callTool({ name: REVIEWER_TOOL_NAME, arguments: { adjudication_id: target } });
        assertReceipt();
        const toolText = (tool.content[0] as { text: string }).text;
        const resource = await client!.readResource({ uri: `agentforge://reviews/packages/${target}` });
        assertReceipt();
        const resourceText = (resource.contents[0] as { text: string }).text;
        for (const text of [toolText, resourceText]) {
          expect(text.includes(token)).toBe(false);
          if (errorCode) {
            expect(text).toContain(`[${errorCode}]`);
            expect(text.includes(marker)).toBe(false);
            expect(text.includes(issued.session.projection_json)).toBe(false);
          } else {
            expect(text).toContain(marker);
            expect(text).toBe(issued.session.projection_json);
            expect(crypto.createHash('sha256').update(text).digest('hex')).toBe(issued.session.projection_hash);
          }
        }
        if (errorCode) {
          expect(tool.isError).toBe(true);
          expect(JSON.parse(resourceText).isError).toBe(true);
        } else expect(tool.isError).toBeFalsy();
      };
      await readPair(id);
      await readPair(crypto.randomUUID(), 'PERMISSION_DENIED');
      env.db.prepare("UPDATE tasks SET state = 'CODING' WHERE id = ?").run(env.taskId);
      await readPair(id, 'TASK_STATE_INVALID');
      env.db.prepare("UPDATE tasks SET state = 'REVIEW_READY' WHERE id = ?").run(env.taskId);
      env.reviewerService.revokeReviewerSession(issued.session.id, 'Synthetic revocation');
      await readPair(id, 'TOKEN_REVOKED');
      expect(receiptCount).toBe(8);
    } finally {
      await performSafeCleanup({
        clients: [client], servers: [transport],
        extraSteps: [
          () => { if (pid) assertExited(pid); },
          () => { if (token) expect(stderr.includes(token)).toBe(false); },
          () => { if (token && fs.existsSync(stdout)) expect(fs.readFileSync(stdout, 'utf8').includes(token)).toBe(false); },
        ],
        dbs: [env.db], tempDirs: [env.tempDir], restoreTimers: true,
      });
    }
    expect(env.db.open).toBe(false);
    expect(fs.existsSync(env.tempDir)).toBe(false);
  }, 60000);

  it('closes SQLite and removes partial fixture if setup fails before returning env', () => {
    let partial: { tempDir: string; db: import('better-sqlite3').Database } | undefined;
    const failure = new Error('injected setup failure after database open');
    expect(() => setupSyntheticRehearsalEnv({ afterDatabaseOpened(resources) {
      partial = resources;
      throw failure;
    } })).toThrow(failure);
    expect(partial).toBeDefined();
    expect(partial!.db.open).toBe(false);
    expect(fs.existsSync(partial!.tempDir)).toBe(false);
  });
});
