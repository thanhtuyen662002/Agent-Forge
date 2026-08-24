import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { GeminiCliAdapter } from '../src/core/adapters/GeminiCliAdapter';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import { AgentExecutionRequest } from '../src/core/adapters/ProviderAdapter';

describe('R5F0D1 — Production Gemini CLI Adapter Contract Suite', () => {
  let tmpDir: string;
  let db: Database.Database;
  let repo: Repository;
  let artifactStore: ArtifactStore;
  let profileRootDir: string;
  let g01Dir: string;
  let g02Dir: string;
  let resolver: NativeProfileResolver;
  let fakeGeminiExecutable: string;
  let fakeGeminiScript: string;
  let scenarioFile: string;
  let logFile: string;
  let projectRepoDir: string;

  const validCoderPayload = JSON.stringify({
    protocol: 'coder.v1',
    message_id: 'msg-gemini-001',
    project_id: 'PROJ-GEMINI-TEST',
    task_id: 'TSK-GEMINI-001',
    attempt: 1,
    status: 'COMPLETED',
    completed: ['Implemented feature in Gemini'],
    remaining: [],
    files_claimed_changed: ['src/index.ts'],
    tests_claimed: ['npm test'],
    blockers: [],
    review_requested: true,
    expected_task_state: 'CODING',
    expected_revision: 0,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-adapter-test-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    artifactStore = new ArtifactStore(path.join(tmpDir, 'artifacts'));

    projectRepoDir = path.join(tmpDir, 'project-repo');
    fs.mkdirSync(projectRepoDir, { recursive: true });

    repo.createProject({
      id: 'PROJ-GEMINI-TEST',
      name: 'Gemini Test Project',
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
      id: 'TSK-GEMINI-001',
      project_id: 'PROJ-GEMINI-TEST',
      milestone_id: null,
      title: 'Gemini Test Task',
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
    g01Dir = path.join(profileRootDir, 'gemini', 'g01');
    g02Dir = path.join(profileRootDir, 'gemini', 'g02');
    fs.mkdirSync(g01Dir, { recursive: true });
    fs.mkdirSync(g02Dir, { recursive: true });

    resolver = new NativeProfileResolver({
      baseProfilesDir: profileRootDir,
    });

    scenarioFile = path.join(tmpDir, 'scenario.json');
    logFile = path.join(tmpDir, 'invocation_log.json');

    // Create fake gemini runner script
    fakeGeminiScript = path.join(tmpDir, 'fake_gemini_runner.js');
    const runnerCode = `
      const fs = require('fs');
      const path = require('path');

      const scenarioFile = ${JSON.stringify(scenarioFile)};
      const logFile = ${JSON.stringify(logFile)};
      const args = process.argv.slice(2);

      let scenario = { mode: 'SUCCESS' };
      if (fs.existsSync(scenarioFile)) {
        try {
          scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
        } catch {}
      }

      // Handle --version probe immediately without waiting on stdin
      if (args.includes('--version')) {
        const logEntry = {
          argv: args,
          cwd: process.cwd(),
          envGeminiHome: process.env.GEMINI_CLI_HOME || null,
          stdin: '',
          timestamp: new Date().toISOString(),
        };
        try {
          let currentLogs = [];
          if (fs.existsSync(logFile)) {
            currentLogs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
          }
          currentLogs.push(logEntry);
          fs.writeFileSync(logFile, JSON.stringify(currentLogs, null, 2), 'utf8');
        } catch {}

        if (scenario.versionError) {
          console.error("Version check failed");
          process.exit(1);
        }
        console.log("0.56.0");
        process.exit(0);
      }

      // Read stdin for model calls
      let stdinData = '';
      try {
        stdinData = fs.readFileSync(0, 'utf8');
      } catch {}

      const logEntry = {
        argv: args,
        cwd: process.cwd(),
        envGeminiHome: process.env.GEMINI_CLI_HOME || null,
        stdin: stdinData,
        timestamp: new Date().toISOString(),
      };

      try {
        let currentLogs = [];
        if (fs.existsSync(logFile)) {
          currentLogs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        }
        currentLogs.push(logEntry);
        fs.writeFileSync(logFile, JSON.stringify(currentLogs, null, 2), 'utf8');
      } catch {}

      // Handle execution scenarios
      if (scenario.mode === 'SUCCESS') {
        const jsonEnvelope = {
          session_id: "test-session-123",
          response: ${JSON.stringify(validCoderPayload)},
          stats: { input_tokens: 100, output_tokens: 50 },
          warnings: []
        };
        console.log(JSON.stringify(jsonEnvelope, null, 2));
        process.exit(0);
      }

      if (scenario.mode === 'MALFORMED_JSON') {
        console.log("Error: not JSON output");
        process.exit(0);
      }

      if (scenario.mode === 'MISSING_RESPONSE_FIELD') {
        const noResponse = {
          session_id: "test-session-123",
          stats: { tokens: 10 }
        };
        console.log(JSON.stringify(noResponse));
        process.exit(0);
      }

      if (scenario.mode === 'EMPTY_RESPONSE') {
        const emptyResponse = {
          session_id: "test-session-123",
          response: "   "
        };
        console.log(JSON.stringify(emptyResponse));
        process.exit(0);
      }

      if (scenario.mode === 'RESPONSE_WRONG_TYPE') {
        const wrongType = {
          session_id: "test-session-123",
          response: { nested: "object" }
        };
        console.log(JSON.stringify(wrongType));
        process.exit(0);
      }

      if (scenario.mode === 'INVALID_INNER_PROTOCOL') {
        const invalidProto = {
          session_id: "test-session-123",
          response: "Plain text that is not valid coder.v1 JSON"
        };
        console.log(JSON.stringify(invalidProto));
        process.exit(0);
      }

      if (scenario.mode === 'WRONG_PROTOCOL_TYPE') {
        const wrongType = {
          session_id: "test-session-123",
          response: JSON.stringify({ protocol: 'reviewer.v1', status: 'APPROVED' })
        };
        console.log(JSON.stringify(wrongType));
        process.exit(0);
      }

      if (scenario.mode === 'AUTH_ERROR') {
        console.error("Authentication failed: invalid token / session expired");
        process.exit(1);
      }

      if (scenario.mode === 'QUOTA_ERROR') {
        console.error("QuotaExceededError: Resource exhausted: you have exceeded your current quota");
        process.exit(1);
      }

      if (scenario.mode === 'UNSUPPORTED_CLIENT') {
        console.error("Gemini CLI error: UNSUPPORTED_CLIENT - legacy consumer client is not supported");
        process.exit(1);
      }

      if (scenario.mode === 'GENERIC_NONZERO') {
        console.error("Fatal command error: internal failure");
        process.exit(42);
      }

      if (scenario.mode === 'HUGE_OUTPUT') {
        const chunk = "X".repeat(1024 * 1024);
        for (let i = 0; i < 40; i++) {
          process.stdout.write(chunk);
        }
        process.exit(0);
      }

      if (scenario.mode === 'SLEEP_TIMEOUT') {
        const start = Date.now();
        while (Date.now() - start < 5000) {}
        process.exit(0);
      }

      if (scenario.mode === 'FALSE_POSITIVE_QUOTA_EXIT_0') {
        const fpQuota = {
          session_id: "test-session-123",
          response: JSON.stringify({
            protocol: 'coder.v1',
            message_id: 'msg-fp-quota',
            project_id: 'PROJ-GEMINI-TEST',
            task_id: 'TSK-GEMINI-001',
            status: 'COMPLETED',
            completed: ['quota limit and usage limit checks passed'],
            remaining: [],
            files_claimed_changed: [],
            tests_claimed: [],
            blockers: [],
            review_requested: true
          })
        };
        console.log(JSON.stringify(fpQuota));
        process.exit(0);
      }

      if (scenario.mode === 'FALSE_POSITIVE_AUTH_EXIT_0') {
        const fpAuth = {
          session_id: "test-session-123",
          response: JSON.stringify({
            protocol: 'coder.v1',
            message_id: 'msg-fp-auth',
            project_id: 'PROJ-GEMINI-TEST',
            task_id: 'TSK-GEMINI-001',
            status: 'COMPLETED',
            completed: ['fixed authentication error in module'],
            remaining: [],
            files_claimed_changed: [],
            tests_claimed: [],
            blockers: [],
            review_requested: true
          })
        };
        console.log(JSON.stringify(fpAuth));
        process.exit(0);
      }

      if (scenario.mode === 'FALSE_POSITIVE_UNSUPPORTED_CLIENT_EXIT_0') {
        const fpUnsupp = {
          session_id: "test-session-123",
          response: JSON.stringify({
            protocol: 'coder.v1',
            message_id: 'msg-fp-unsupp',
            project_id: 'PROJ-GEMINI-TEST',
            task_id: 'TSK-GEMINI-001',
            status: 'COMPLETED',
            completed: ['migrated unsupported client legacy call'],
            remaining: [],
            files_claimed_changed: [],
            tests_claimed: [],
            blockers: [],
            review_requested: true
          })
        };
        console.log(JSON.stringify(fpUnsupp));
        process.exit(0);
      }
    `;
    fs.writeFileSync(fakeGeminiScript, runnerCode, 'utf8');

    if (process.platform === 'win32') {
      fakeGeminiExecutable = path.join(tmpDir, 'fake_gemini.cmd');
      fs.writeFileSync(
        fakeGeminiExecutable,
        `@echo off\r\n"${process.execPath}" "${fakeGeminiScript}" %*\r\n`,
        'utf8'
      );
    } else {
      fakeGeminiExecutable = path.join(tmpDir, 'fake_gemini.sh');
      fs.writeFileSync(
        fakeGeminiExecutable,
        `#!/bin/sh\nexec "${process.execPath}" "${fakeGeminiScript}" "$@"\n`,
        'utf8'
      );
      fs.chmodSync(fakeGeminiExecutable, 0o755);
    }
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function setScenario(scenario: Record<string, any>) {
    fs.writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8');
  }

  function getLogs(): any[] {
    if (!fs.existsSync(logFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(logFile, 'utf8'));
    } catch {
      return [];
    }
  }

  function createValidRequest(overrides?: Partial<AgentExecutionRequest>): AgentExecutionRequest {
    const defaultBinding = {
      authorizationId: 'auth-gemini-test-01',
      routingDecisionId: 'dec-gemini-test-01',
      assignmentId: 'asg-gemini-test-01',
      providerId: 'prov-gemini-cli',
      accountId: 'acc-gemini-g01',
      resourceId: 'res-gemini-01',
      modelName: 'gemini-1.5-pro',
      adapterType: 'LOCAL_CLI' as const,
      accountAuthMode: 'NATIVE_PROFILE' as const,
      profileRef: 'native-profile://gemini/g01',
    };

    const hasBindingOverride = overrides && Object.prototype.hasOwnProperty.call(overrides, 'runtimeBinding');
    const runtimeBinding = hasBindingOverride
      ? (overrides.runtimeBinding ? { ...defaultBinding, ...overrides.runtimeBinding } : undefined)
      : defaultBinding;

    return {
      taskId: 'TSK-GEMINI-001',
      projectId: 'PROJ-GEMINI-TEST',
      instructions: ['Implement task in Gemini', 'Return coder.v1 JSON'],
      contextFiles: [],
      ...overrides,
      runtimeBinding,
    };
  }

  // =============================================================
  // SECTION A: BINDING VALIDATION MATRIX (Phase 17)
  // =============================================================
  describe('A. Binding Validation Matrix', () => {
    it('1. Missing runtimeBinding fails before spawn (0 spawn)', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req: AgentExecutionRequest = {
        taskId: 'TSK-GEMINI-001',
        projectId: 'PROJ-GEMINI-TEST',
        instructions: ['Test prompt'],
        contextFiles: [],
      };

      const res = await adapter.execute(req);
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(res.error).toMatch(/RUNTIME_BINDING_MISSING/);
      expect(getLogs().length).toBe(0);
    });

    it('2. Missing profileRef fails before spawn (0 spawn)', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-1',
          routingDecisionId: 'dec-1',
          assignmentId: 'asg-1',
          providerId: 'prov-gemini-cli',
          accountId: 'acc-1',
          resourceId: 'res-1',
          modelName: 'gemini-1.5-pro',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: '',
        },
      });

      const res = await adapter.execute(req);
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(res.error).toMatch(/PROFILE_REF_MISSING/);
      expect(getLogs().length).toBe(0);
    });

    it('3. Non-Gemini profileRef provider fails before spawn (0 spawn)', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-1',
          routingDecisionId: 'dec-1',
          assignmentId: 'asg-1',
          providerId: 'prov-gemini-cli',
          accountId: 'acc-1',
          resourceId: 'res-1',
          modelName: 'gemini-1.5-pro',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://codex/c01',
        },
      });

      const res = await adapter.execute(req);
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(res.error).toMatch(/PROVIDER_MISMATCH/);
      expect(getLogs().length).toBe(0);
    });

    it('4. Missing modelName in request and adapter fails before spawn (0 spawn)', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-1',
          routingDecisionId: 'dec-1',
          assignmentId: 'asg-1',
          providerId: 'prov-gemini-cli',
          accountId: 'acc-1',
          resourceId: 'res-1',
          modelName: '',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://gemini/g01',
        },
      });

      const res = await adapter.execute(req);
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(res.error).toMatch(/MODEL_NAME_MISSING/);
      expect(getLogs().length).toBe(0);
    });

    it('5. Profile directory absent on disk fails before spawn (0 spawn)', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-1',
          routingDecisionId: 'dec-1',
          assignmentId: 'asg-1',
          providerId: 'prov-gemini-cli',
          accountId: 'acc-1',
          resourceId: 'res-1',
          modelName: 'gemini-1.5-pro',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://gemini/nonexistent_profile',
        },
      });

      const res = await adapter.execute(req);
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(res.error).toMatch(/PROFILE_DIRECTORY_NOT_FOUND/);
      expect(getLogs().length).toBe(0);
    });
  });

  // =============================================================
  // SECTION B: PROFILE ISOLATION MATRIX (Phase 18)
  // =============================================================
  describe('B. Profile Isolation Matrix', () => {
    it('6. g01 execution injects GEMINI_CLI_HOME pointing strictly to g01 directory', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-1',
          routingDecisionId: 'dec-1',
          assignmentId: 'asg-1',
          providerId: 'prov-gemini-cli',
          accountId: 'acc-1',
          resourceId: 'res-1',
          modelName: 'gemini-1.5-pro',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://gemini/g01',
        },
      });

      const res = await adapter.execute(req);
      expect(res.status).toBe('COMPLETED');

      const logs = getLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].envGeminiHome).toBe(g01Dir);
    });

    it('7. g02 execution injects GEMINI_CLI_HOME pointing strictly to g02 directory', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-2',
          routingDecisionId: 'dec-2',
          assignmentId: 'asg-2',
          providerId: 'prov-gemini-cli',
          accountId: 'acc-2',
          resourceId: 'res-2',
          modelName: 'gemini-1.5-pro',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://gemini/g02',
        },
      });

      const res = await adapter.execute(req);
      expect(res.status).toBe('COMPLETED');

      const logs = getLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].envGeminiHome).toBe(g02Dir);
    });

    it('8. Single adapter handles g01 then g02 with zero profile state cross-contamination', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req1 = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-1',
          routingDecisionId: 'dec-1',
          assignmentId: 'asg-1',
          providerId: 'prov-gemini-cli',
          accountId: 'acc-1',
          resourceId: 'res-1',
          modelName: 'gemini-1.5-pro',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://gemini/g01',
        },
      });

      const req2 = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-2',
          routingDecisionId: 'dec-2',
          assignmentId: 'asg-2',
          providerId: 'prov-gemini-cli',
          accountId: 'acc-2',
          resourceId: 'res-2',
          modelName: 'gemini-1.5-flash',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://gemini/g02',
        },
      });

      const res1 = await adapter.execute(req1);
      const res2 = await adapter.execute(req2);

      expect(res1.status).toBe('COMPLETED');
      expect(res2.status).toBe('COMPLETED');

      const logs = getLogs();
      expect(logs.length).toBe(2);
      expect(logs[0].envGeminiHome).toBe(g01Dir);
      expect(logs[1].envGeminiHome).toBe(g02Dir);
    });

    it('9. Single adapter handles concurrent g01 and g02 executions safely', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const req1 = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-1',
          routingDecisionId: 'dec-1',
          assignmentId: 'asg-1',
          providerId: 'prov-gemini-cli',
          accountId: 'acc-1',
          resourceId: 'res-1',
          modelName: 'gemini-1.5-pro',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://gemini/g01',
        },
      });

      const req2 = createValidRequest({
        runtimeBinding: {
          authorizationId: 'auth-2',
          routingDecisionId: 'dec-2',
          assignmentId: 'asg-2',
          providerId: 'prov-gemini-cli',
          accountId: 'acc-2',
          resourceId: 'res-2',
          modelName: 'gemini-1.5-flash',
          adapterType: 'LOCAL_CLI',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://gemini/g02',
        },
      });

      const [res1, res2] = await Promise.all([
        adapter.execute(req1),
        adapter.execute(req2),
      ]);

      expect(res1.status).toBe('COMPLETED');
      expect(res2.status).toBe('COMPLETED');

      const logs = getLogs();
      expect(logs.length).toBe(2);
      const homes = logs.map(l => l.envGeminiHome);
      expect(homes).toContain(g01Dir);
      expect(homes).toContain(g02Dir);
    });

    it('10. Global process.env.GEMINI_CLI_HOME remains unchanged after execution', async () => {
      const envBefore = process.env.GEMINI_CLI_HOME;

      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      await adapter.execute(createValidRequest());

      expect(process.env.GEMINI_CLI_HOME).toBe(envBefore);
    });
  });

  // =============================================================
  // SECTION C: INVOCATION & ARGV MATRIX (Phase 19)
  // =============================================================
  describe('C. Invocation & Argv Matrix', () => {
    it('11. Prompt payload is transported via STDIN and omitted from ARGV', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const instructions = ['Instruction line 1', 'Instruction line 2'];
      const req = createValidRequest({ instructions });

      const res = await adapter.execute(req);
      expect(res.status).toBe('COMPLETED');

      const logs = getLogs();
      expect(logs.length).toBe(1);
      const log = logs[0];

      // Prompt is in stdin
      expect(log.stdin).toContain('Instruction line 1');
      expect(log.stdin).toContain('Instruction line 2');

      // Prompt is NOT in argv
      for (const arg of log.argv) {
        expect(arg).not.toContain('Instruction line 1');
        expect(arg).not.toContain('Instruction line 2');
      }

      // Argv structure: --prompt, "", --output-format, json, --model, <model>, --sandbox, --approval-mode, default
      expect(log.argv).toContain('--prompt');
      expect(log.argv).toContain('--output-format');
      expect(log.argv).toContain('json');
      expect(log.argv).toContain('--model');
      expect(log.argv).toContain('gemini-1.5-pro');
      expect(log.argv).toContain('--sandbox');
      expect(log.argv).toContain('--approval-mode');
      expect(log.argv).toContain('default');

      // No YOLO flag
      expect(log.argv).not.toContain('--yolo');
      expect(log.argv).not.toContain('-y');
      expect(log.argv).not.toContain('yolo');
    });

    it('12. Working directory matches target project repository directory', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      await adapter.execute(createValidRequest());

      const logs = getLogs();
      expect(logs.length).toBe(1);
      expect(path.resolve(logs[0].cwd)).toBe(path.resolve(projectRepoDir));
    });
  });

  // =============================================================
  // SECTION D: JSON / PROTOCOL MATRIX (Phase 20)
  // =============================================================
  describe('D. JSON / Protocol Matrix', () => {
    it('13. Valid exact Gemini JSON envelope with coder.v1 returns COMPLETED', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
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

    it('14. Malformed JSON stdout returns PROTOCOL_INVALID', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'MALFORMED_JSON' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });

    it('15. Missing response field in JSON envelope returns PROTOCOL_INVALID', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'MISSING_RESPONSE_FIELD' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });

    it('16. Empty response string in JSON envelope returns PROTOCOL_INVALID', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'EMPTY_RESPONSE' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });

    it('17. Non-string response field in JSON envelope returns PROTOCOL_INVALID', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'RESPONSE_WRONG_TYPE' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });

    it('18. Non-protocol inner response string returns PROTOCOL_INVALID', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'INVALID_INNER_PROTOCOL' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });

    it('19. Non-coder protocol type (e.g. reviewer.v1) returns PROTOCOL_INVALID', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'WRONG_PROTOCOL_TYPE' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROTOCOL_INVALID');
    });
  });

  // =============================================================
  // SECTION E: ERROR CLASSIFICATION MATRIX (Phase 21)
  // =============================================================
  describe('E. Error Classification Matrix', () => {
    it('20. Process launch failure maps to PROCESS_LAUNCH_FAILED', async () => {
      const adapter = new GeminiCliAdapter({
        executable: path.join(tmpDir, 'non_existent_binary.exe'),
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const res = await adapter.execute(createValidRequest());
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PROCESS_LAUNCH_FAILED');
    });

    it('21. Process timeout maps to TIMEOUT', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
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

    it('22. Process output limit exceeded maps to OUTPUT_LIMIT_EXCEEDED', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'HUGE_OUTPUT' });
      const res = await adapter.execute(createValidRequest());
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('OUTPUT_LIMIT_EXCEEDED');
    });

    it('23. Generic non-zero exit maps to NONZERO_EXIT', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'GENERIC_NONZERO' });
      const res = await adapter.execute(createValidRequest());
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('NONZERO_EXIT');
    });

    it('24. Explicit Gemini authentication error marker maps to AUTH_ERROR with 0 retry', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
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

    it('25. Explicit Gemini quota exhaustion marker maps to QUOTA_EXHAUSTED with 0 retry', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
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

    it('26. Explicit Gemini UNSUPPORTED_CLIENT marker maps to UNSUPPORTED_CLIENT with 0 retry', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'UNSUPPORTED_CLIENT' });
      const res = await adapter.execute(createValidRequest());
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('UNSUPPORTED_CLIENT');
      expect(getLogs().length).toBe(1); // Exactly 1 invocation, 0 retries
    });
  });

  // =============================================================
  // SECTION F: FALSE-POSITIVE IMMUNITY MATRIX (Phase 22)
  // =============================================================
  describe('F. False-Positive Immunity Matrix', () => {
    it('27. Successful exit-zero response containing quota/usage words is NOT classified as QUOTA_EXHAUSTED', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'FALSE_POSITIVE_QUOTA_EXIT_0' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('COMPLETED');
      expect(res.errorCode).toBeUndefined();
      expect(res.outputProtocol).toBeDefined();
    });

    it('28. Successful exit-zero response containing auth words is NOT classified as AUTH_ERROR', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'FALSE_POSITIVE_AUTH_EXIT_0' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('COMPLETED');
      expect(res.errorCode).toBeUndefined();
      expect(res.outputProtocol).toBeDefined();
    });

    it('29. Successful exit-zero response containing unsupported client words is NOT classified as UNSUPPORTED_CLIENT', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ mode: 'FALSE_POSITIVE_UNSUPPORTED_CLIENT_EXIT_0' });
      const res = await adapter.execute(createValidRequest());

      expect(res.status).toBe('COMPLETED');
      expect(res.errorCode).toBeUndefined();
      expect(res.outputProtocol).toBeDefined();
    });
  });

  // =============================================================
  // SECTION G: HEALTH & CAPABILITIES MATRIX (Phase 23)
  // =============================================================
  describe('G. Health & Capabilities Matrix', () => {
    it('30. getHealth runs --version without sending prompt or invoking model', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      const health = await adapter.getHealth();
      expect(health).toBe('AVAILABLE');

      const logs = getLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].argv).toContain('--version');
      expect(logs[0].stdin).toBe('');
    });

    it('31. getHealth returns OFFLINE if binary fails', async () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      setScenario({ versionError: true });
      const health = await adapter.getHealth();
      expect(health).toBe('OFFLINE');
    });

    it('32. Capabilities strictly match accepted truthful subset and omit LARGE_CONTEXT', () => {
      const adapter = new GeminiCliAdapter({
        executable: fakeGeminiExecutable,
        repo,
        artifactStore,
        profileResolver: resolver,
      });

      expect(adapter.capabilities).toEqual([
        'CODING',
        'FILESYSTEM_EDIT',
        'TEST_EXECUTION',
        'TERMINAL',
      ]);
      expect(adapter.capabilities).not.toContain('LARGE_CONTEXT');
    });
  });
});
