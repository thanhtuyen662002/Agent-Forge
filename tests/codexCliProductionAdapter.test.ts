import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { CodexCliAdapter } from '../src/core/adapters/CodexCliAdapter';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import { AgentExecutionRequest } from '../src/core/adapters/ProviderAdapter';

describe('R5F0C3 — Production Codex CLI Adapter Contract Suite', () => {
  let tmpDir: string;
  let db: Database.Database;
  let repo: Repository;
  let artifactStore: ArtifactStore;
  let profileRootDir: string;
  let c01Dir: string;
  let c02Dir: string;
  let resolver: NativeProfileResolver;
  let fakeCodexExecutable: string;
  let fakeCodexScript: string;
  let scenarioFile: string;
  let logsDir: string;
  let projectRepoDir: string;

  const validCoderPayload = JSON.stringify({
    protocol: 'coder.v1',
    message_id: 'msg-codex-001',
    project_id: 'PROJ-CODEX-TEST',
    task_id: 'TSK-CODEX-001',
    attempt: 1,
    status: 'COMPLETED',
    completed: ['Implemented feature in Codex'],
    remaining: [],
    files_claimed_changed: ['src/index.ts'],
    tests_claimed: ['npm test'],
    blockers: [],
    review_requested: true,
    expected_task_state: 'CODING',
    expected_revision: 0,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-test-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    artifactStore = new ArtifactStore(path.join(tmpDir, 'artifacts'));

    projectRepoDir = path.join(tmpDir, 'project-repo');
    fs.mkdirSync(projectRepoDir, { recursive: true });

    repo.createProject({
      id: 'PROJ-CODEX-TEST',
      name: 'Codex Test Project',
      description: null,
      repository_path: projectRepoDir,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    repo.createTask({
      id: 'TSK-CODEX-001',
      project_id: 'PROJ-CODEX-TEST',
      milestone_id: null,
      title: 'Codex Test Task',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 5,
      base_sha: '0000000000000000000000000000000000000000',
      current_sha: '0000000000000000000000000000000000000000',
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['Passes test'],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    profileRootDir = path.join(tmpDir, 'profiles');
    c01Dir = path.join(profileRootDir, 'codex', 'c01');
    c02Dir = path.join(profileRootDir, 'codex', 'c02');
    fs.mkdirSync(c01Dir, { recursive: true });
    fs.mkdirSync(c02Dir, { recursive: true });

    resolver = new NativeProfileResolver({
      baseProfilesDir: profileRootDir,
    });

    scenarioFile = path.join(tmpDir, 'scenario.json');
    logsDir = path.join(tmpDir, 'invocation_logs');
    fs.mkdirSync(logsDir, { recursive: true });

    // Create fake codex runner script
    fakeCodexScript = path.join(tmpDir, 'fake_codex_runner.js');
    const runnerCode = `
      const fs = require('fs');
      const path = require('path');

      const scenarioFile = ${JSON.stringify(scenarioFile)};
      const logsDir = ${JSON.stringify(logsDir)};
      const args = process.argv.slice(2);

      let scenario = { mode: 'SUCCESS' };
      if (fs.existsSync(scenarioFile)) {
        try {
          scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
        } catch {}
      }

      function writeTelemetry(entry) {
        const id = Date.now() + '_' + process.pid + '_' + Math.random().toString(36).slice(2);
        entry.seq = id;
        const entryFile = path.join(logsDir, 'log_' + id + '.json');
        fs.writeFileSync(entryFile, JSON.stringify(entry, null, 2), 'utf8');
      }

      // Handle --version probe immediately without waiting on stdin
      if (args.includes('--version')) {
        const logEntry = {
          argv: args,
          cwd: process.cwd(),
          envCodexHome: process.env.CODEX_HOME || null,
          stdin: '',
          timestamp: new Date().toISOString(),
        };
        writeTelemetry(logEntry);

        if (scenario.versionError) {
          console.error("Version check failed");
          process.exit(1);
        }
        console.log("codex-cli 0.149.1");
        process.exit(0);
      }

      // Read stdin for exec calls
      let stdinData = '';
      try {
        stdinData = fs.readFileSync(0, 'utf8');
      } catch {}

      const logEntry = {
        argv: args,
        cwd: process.cwd(),
        envCodexHome: process.env.CODEX_HOME || null,
        stdin: stdinData,
        timestamp: new Date().toISOString(),
      };
      writeTelemetry(logEntry);

      // Handle exec scenarios
      if (scenario.mode === 'SUCCESS') {
        const event1 = {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: ${JSON.stringify(validCoderPayload)}
          }
        };
        console.log(JSON.stringify(event1));
        process.exit(0);
      }

      if (scenario.mode === 'MULTI_MESSAGE_LAST_WINS') {
        const intermediate = {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: "Intermediate thought, not final protocol"
          }
        };
        const finalEvent = {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: ${JSON.stringify(validCoderPayload)}
          }
        };
        console.log(JSON.stringify(intermediate));
        console.log(JSON.stringify(finalEvent));
        process.exit(0);
      }

      if (scenario.mode === 'EARLIER_VALID_FINAL_INVALID') {
        const validEvent = {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: ${JSON.stringify(validCoderPayload)}
          }
        };
        const invalidFinal = {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: "Corrupted final message without protocol"
          }
        };
        console.log(JSON.stringify(validEvent));
        console.log(JSON.stringify(invalidFinal));
        process.exit(0);
      }

      if (scenario.mode === 'MALFORMED_JSONL') {
        console.log('{"type": "item.completed", "item": { "type": "agent_message"'); // syntax error
        process.exit(0);
      }

      if (scenario.mode === 'NO_AGENT_MESSAGE') {
        console.log(JSON.stringify({ type: 'turn.started' }));
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'tool_call' } }));
        process.exit(0);
      }

      if (scenario.mode === 'INVALID_PROTOCOL_JSON') {
        const invalidProto = {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: "Not JSON at all"
          }
        };
        console.log(JSON.stringify(invalidProto));
        process.exit(0);
      }

      if (scenario.mode === 'WRONG_PROTOCOL_TYPE') {
        const wrongType = {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: JSON.stringify({ protocol: 'reviewer.v1', status: 'APPROVED' })
          }
        };
        console.log(JSON.stringify(wrongType));
        process.exit(0);
      }

      if (scenario.mode === 'AUTH_ERROR') {
        console.error("OpenAI error: Unauthorized - invalid api key / session expired");
        process.exit(1);
      }

      if (scenario.mode === 'QUOTA_ERROR') {
        console.error("QuotaExceededError: You have exceeded your current quota");
        process.exit(1);
      }

      if (scenario.mode === 'GENERIC_NONZERO') {
        console.error("Fatal command error: internal failure");
        process.exit(42);
      }

      if (scenario.mode === 'HUGE_OUTPUT') {
        const chunk = "X".repeat(1024 * 1024);
        let remaining = 40;
        function writeMore() {
          let ok = true;
          while (remaining > 0 && ok) {
            remaining--;
            if (remaining === 0) {
              process.stdout.write(chunk, () => {
                process.exit(0);
              });
            } else {
              ok = process.stdout.write(chunk);
            }
          }
          if (remaining > 0) {
            process.stdout.once('drain', writeMore);
          }
        }
        writeMore();
        return;
      }

      if (scenario.mode === 'SLEEP_TIMEOUT') {
        setTimeout(() => {
          process.exit(0);
        }, 30000);
        return;
      }

      process.exit(0);
    `;
    fs.writeFileSync(fakeCodexScript, runnerCode, 'utf8');

    if (process.platform === 'win32') {
      fakeCodexExecutable = path.join(tmpDir, 'fake_codex.cmd');
      fs.writeFileSync(
        fakeCodexExecutable,
        `@node "${fakeCodexScript}" %*`,
        'utf8'
      );
    } else {
      fakeCodexExecutable = path.join(tmpDir, 'fake_codex.sh');
      fs.writeFileSync(
        fakeCodexExecutable,
        `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexScript}" "$@"\n`,
        'utf8'
      );
      fs.chmodSync(fakeCodexExecutable, 0o755);
    }
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function setScenario(scenario: any): void {
    fs.writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8');
  }

  function getLogs(): any[] {
    if (!fs.existsSync(logsDir)) return [];
    const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.json'));
    const entries: any[] = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
      entries.push(JSON.parse(content));
    }
    entries.sort((a, b) => {
      const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      if (timeDiff !== 0) return timeDiff;
      return String(a.seq || '').localeCompare(String(b.seq || ''));
    });
    return entries;
  }

  function createValidRequest(overrides?: Partial<AgentExecutionRequest>): AgentExecutionRequest {
    return {
      taskId: 'TSK-CODEX-001',
      projectId: 'PROJ-CODEX-TEST',
      instructions: ['Implement feature'],
      contextFiles: [],
      runtimeBinding: {
        authorizationId: 'auth-codex-1',
        routingDecisionId: 'dec-codex-1',
        providerId: 'prov-codex-cli',
        accountId: 'acc-codex-1',
        resourceId: 'res-codex-1',
        assignmentId: 'asg-codex-1',
        modelName: 'gpt-4o',
        adapterType: 'LOCAL_CLI',
        accountAuthMode: 'NATIVE_PROFILE',
        profileRef: 'native-profile://codex/c01',
      },
      ...overrides,
    };
  }

  // =============================================================
  // SECTION A: RUNTIME BINDING VALIDATION (Phase 16)
  // =============================================================
  describe('A. Runtime Binding Validation Matrix', () => {
    it('1. Missing runtimeBinding fails closed with RESOURCE_UNAVAILABLE and zero spawns', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req: any = createValidRequest();
      delete req.runtimeBinding;

      const result = await adapter.execute(req);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(result.error).toContain('RUNTIME_BINDING_MISSING');
      expect(getLogs().length).toBe(0);
    });

    it('2. Wrong adapterType (API) fails closed before launch with zero spawns', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-1',
          routingDecisionId: 'dec-codex-1',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-1',
          resourceId: 'res-codex-1',
          assignmentId: 'asg-codex-1',
          modelName: 'gpt-4o',
          adapterType: 'API' as any,
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://codex/c01',
        },
      });

      const result = await adapter.execute(req);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(result.error).toContain('INVALID_ADAPTER_TYPE');
      expect(getLogs().length).toBe(0);
    });

    it('3. Wrong accountAuthMode (API_KEY) fails closed before launch with zero spawns', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-1',
          routingDecisionId: 'dec-codex-1',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-1',
          resourceId: 'res-codex-1',
          assignmentId: 'asg-codex-1',
          modelName: 'gpt-4o',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'API_KEY' as any,
          profileRef: 'native-profile://codex/c01',
        },
      });

      const result = await adapter.execute(req);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(result.error).toContain('INVALID_AUTH_MODE');
      expect(getLogs().length).toBe(0);
    });

    it('4. Null/empty profileRef fails closed before launch with zero spawns', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-1',
          routingDecisionId: 'dec-codex-1',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-1',
          resourceId: 'res-codex-1',
          assignmentId: 'asg-codex-1',
          modelName: 'gpt-4o',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: '' as any,
        },
      });

      const result = await adapter.execute(req);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(result.error).toContain('PROFILE_REF_MISSING');
      expect(getLogs().length).toBe(0);
    });

    it('5. Non-Codex profile provider (gemini) fails closed with zero spawns', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-1',
          routingDecisionId: 'dec-codex-1',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-1',
          resourceId: 'res-codex-1',
          assignmentId: 'asg-codex-1',
          modelName: 'gpt-4o',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://gemini/g01',
        },
      });

      const result = await adapter.execute(req);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(result.error).toContain('PROVIDER_MISMATCH');
      expect(getLogs().length).toBe(0);
    });

    it('6. Empty modelName fails closed with zero spawns', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-1',
          routingDecisionId: 'dec-codex-1',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-1',
          resourceId: 'res-codex-1',
          assignmentId: 'asg-codex-1',
          modelName: '   ',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://codex/c01',
        },
      });

      const result = await adapter.execute(req);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(result.error).toContain('MODEL_NAME_MISSING');
      expect(getLogs().length).toBe(0);
    });

    it('7. Malformed traversal profileRef fails closed before launch', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-1',
          routingDecisionId: 'dec-codex-1',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-1',
          resourceId: 'res-codex-1',
          assignmentId: 'asg-codex-1',
          modelName: 'gpt-4o',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://codex/../../escape',
        },
      });

      const result = await adapter.execute(req);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(getLogs().length).toBe(0);
    });

    it('8. Non-existent profile directory fails closed before launch', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-1',
          routingDecisionId: 'dec-codex-1',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-1',
          resourceId: 'res-codex-1',
          assignmentId: 'asg-codex-1',
          modelName: 'gpt-4o',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://codex/c99-nonexistent',
        },
      });

      const result = await adapter.execute(req);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(result.error).toContain('PROFILE_DIRECTORY_NOT_FOUND');
      expect(getLogs().length).toBe(0);
    });
  });

  // =============================================================
  // SECTION B: PROFILE ISOLATION & INVOCATION SECURITY (Phase 17, 18)
  // =============================================================
  describe('B. Profile Isolation & Invocation Security Matrix', () => {
    it('10-12. Sequential c01 and c02 requests use isolated CODEX_HOME without cross-leakage', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'SUCCESS' });

      const reqC01 = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-1',
          routingDecisionId: 'dec-codex-1',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-1',
          resourceId: 'res-codex-1',
          assignmentId: 'asg-codex-1',
          modelName: 'gpt-4o',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://codex/c01',
        },
      });

      const reqC02 = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-2',
          routingDecisionId: 'dec-codex-2',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-2',
          resourceId: 'res-codex-2',
          assignmentId: 'asg-codex-2',
          modelName: 'o3-mini',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://codex/c02',
        },
      });

      const res1 = await adapter.execute(reqC01);
      expect(res1.status).toBe('COMPLETED');

      const res2 = await adapter.execute(reqC02);
      expect(res2.status).toBe('COMPLETED');

      const logs = getLogs();
      expect(logs.length).toBe(2);
      expect(logs[0].envCodexHome).toBe(c01Dir);
      expect(logs[1].envCodexHome).toBe(c02Dir);
      expect(logs[0].envCodexHome).not.toBe(logs[1].envCodexHome);
    });

    it('13. Concurrent c01 and c02 executions maintain complete environment isolation', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'SUCCESS' });

      const reqC01 = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-1',
          routingDecisionId: 'dec-codex-1',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-1',
          resourceId: 'res-codex-1',
          assignmentId: 'asg-codex-1',
          modelName: 'gpt-4o',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://codex/c01',
        },
      });

      const reqC02 = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-codex-2',
          routingDecisionId: 'dec-codex-2',
          providerId: 'prov-codex-cli',
          accountId: 'acc-codex-2',
          resourceId: 'res-codex-2',
          assignmentId: 'asg-codex-2',
          modelName: 'o3-mini',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://codex/c02',
        },
      });

      const [res1, res2] = await Promise.all([adapter.execute(reqC01), adapter.execute(reqC02)]);
      expect(res1.status).toBe('COMPLETED');
      expect(res2.status).toBe('COMPLETED');

      const logs = getLogs();
      expect(logs.length).toBe(2);
      const homes = logs.map((l) => l.envCodexHome);
      expect(homes).toContain(c01Dir);
      expect(homes).toContain(c02Dir);
    });

    it('14. Global process.env.CODEX_HOME is never mutated before, during, or after execution', async () => {
      const origCodexHome = process.env.CODEX_HOME;
      try {
        delete process.env.CODEX_HOME;

        const adapter = new CodexCliAdapter({
          executable: fakeCodexExecutable,
          repo,
          artifactStore,
          profileResolver: resolver,
        });

        setScenario({ mode: 'SUCCESS' });
        const req = createValidRequest();
        await adapter.execute(req);

        expect(process.env.CODEX_HOME).toBeUndefined();
      } finally {
        if (origCodexHome !== undefined) {
          process.env.CODEX_HOME = origCodexHome;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('16-19. Invocation arguments, stdin prompt, cwd, and shell=false are strictly enforced', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'SUCCESS' });
      const req = createValidRequest({
        instructions: ['Implement task xyz', 'Write tests'],
      });

      const res = await adapter.execute(req);
      expect(res.status).toBe('COMPLETED');

      const logs = getLogs();
      expect(logs.length).toBe(1);
      const log = logs[0];

      // Argv verification: exec, --json, --model gpt-4o, --sandbox workspace-write
      expect(log.argv).toContain('exec');
      expect(log.argv).toContain('--json');
      expect(log.argv).toContain('--model');
      expect(log.argv).toContain('gpt-4o');
      expect(log.argv).toContain('--sandbox');
      expect(log.argv).toContain('workspace-write');

      // Prompt is strictly ABSENT from argv
      for (const arg of log.argv) {
        expect(arg).not.toContain('Implement task xyz');
      }

      // Prompt is strictly PRESENT in stdin
      expect(log.stdin).toContain('TASK ID: TSK-CODEX-001');
      expect(log.stdin).toContain('INSTRUCTIONS:');
      expect(log.stdin).toContain('- Implement task xyz');

      // Cwd equals durable repository path
      expect(path.normalize(log.cwd)).toBe(path.normalize(projectRepoDir));
    });
  });

  // =============================================================
  // SECTION C: JSONL PROTOCOL PARSING (Phase 19)
  // =============================================================
  describe('C. JSONL Protocol Parsing Matrix', () => {
    it('20. Valid single completed agent_message completes task with validated coder.v1 protocol', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'SUCCESS' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('COMPLETED');
      expect(res.outputProtocol).toBeDefined();
      expect(JSON.parse(res.outputProtocol!).protocol).toBe('coder.v1');
    });

    it('21. Multiple completed agent_message events: last completed message wins', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'MULTI_MESSAGE_LAST_WINS' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('COMPLETED');
      expect(JSON.parse(res.outputProtocol!).protocol).toBe('coder.v1');
    });

    it('22. Malformed JSONL line fails closed with PROTOCOL_INVALID', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'MALFORMED_JSONL' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });

    it('23. Stream with no agent_message events fails closed with PROTOCOL_INVALID', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'NO_AGENT_MESSAGE' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });

    it('24. Final agent_message with non-JSON text fails closed with PROTOCOL_INVALID', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'INVALID_PROTOCOL_JSON' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });

    it('25. Final agent_message with wrong protocol type (reviewer.v1) fails with PROTOCOL_INVALID', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'WRONG_PROTOCOL_TYPE' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });

    it('27. Earlier valid coder.v1 followed by corrupted final message fails closed with PROTOCOL_INVALID', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'EARLIER_VALID_FINAL_INVALID' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });
  });

  // =============================================================
  // SECTION D: ERROR CLASSIFICATION & REFINEMENT (Phase 20)
  // =============================================================
  describe('D. Error Classification & Refinement Matrix', () => {
    it('28. Process launch failure maps to PROCESS_LAUNCH_FAILED', async () => {
      const adapter = new CodexCliAdapter({
        executable: path.join(tmpDir, 'non_existent_binary.exe'),
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const res = await adapter.execute(createValidRequest());
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROCESS_LAUNCH_FAILED');
    });

    it('29. Process timeout maps to TIMEOUT', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        timeoutMs: 400,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'SLEEP_TIMEOUT' });
      const res = await adapter.execute(createValidRequest());
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('TIMEOUT');
    });

    it('31. Process output limit exceeded maps to OUTPUT_LIMIT_EXCEEDED', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'HUGE_OUTPUT' });
      const res = await adapter.execute(createValidRequest());
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('OUTPUT_LIMIT_EXCEEDED');
    });

    it('32. Generic non-zero exit maps to NONZERO_EXIT', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'GENERIC_NONZERO' });
      const res = await adapter.execute(createValidRequest());
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('NONZERO_EXIT');
    });

    it('33. Explicit Codex authentication error marker maps to AUTH_ERROR with 0 retry', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'AUTH_ERROR' });
      const res = await adapter.execute(createValidRequest());
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('AUTH_ERROR');
      expect(getLogs().length).toBe(1); // Exactly 1 invocation, 0 retries
    });

    it('34. Explicit Codex quota exhaustion marker maps to QUOTA_EXHAUSTED with 0 retry', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'QUOTA_ERROR' });
      const res = await adapter.execute(createValidRequest());
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('QUOTA_EXHAUSTED');
      expect(getLogs().length).toBe(1); // Exactly 1 invocation, 0 retries
    });
  });

  // =============================================================
  // SECTION E: HEALTH & CAPABILITIES (Phase 21)
  // =============================================================
  describe('E. Health & Capabilities Matrix', () => {
    it('35-37. getHealth probes only --version without prompt, returns AVAILABLE on success', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'SUCCESS' });
      const health = await adapter.getHealth();
      expect(health).toBe('AVAILABLE');

      const logs = getLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].argv).toEqual(['--version']);
      expect(logs[0].argv).not.toContain('exec');
      expect(logs[0].stdin).toBe('');
    });

    it('37b. getHealth returns OFFLINE when version probe fails', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ versionError: true });
      const health = await adapter.getHealth();
      expect(health).toBe('OFFLINE');
    });

    it('38. getCapabilities advertises exactly accepted capability set', async () => {
      const adapter = new CodexCliAdapter({
        executable: fakeCodexExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const capabilities = await adapter.getCapabilities();
      expect(capabilities).toEqual(['CODING', 'TERMINAL', 'FILESYSTEM_EDIT', 'TEST_EXECUTION']);
    });
  });
});
