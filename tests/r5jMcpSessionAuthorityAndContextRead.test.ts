import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MIGRATIONS, MigrationRunner, verifyMigration21SchemaAuthority } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  McpSessionAuthorityService,
  McpAuthorityError,
  computeCompleteAuthorityFingerprint,
  validateCanonicalSessionToken,
  validateTtlSeconds,
  MCP_SESSION_MIN_TTL_SECONDS,
  MCP_SESSION_MAX_TTL_SECONDS,
  MCP_SESSION_DEFAULT_TTL_SECONDS,
} from '../src/core/services/McpSessionAuthorityService';
import {
  McpAuthorityContext,
  resetDefaultAuthorityContext,
} from '../src/mcp/McpAuthorityContext';
import { buildAgentForgeMcpServer } from '../src/mcp/McpServer';
import {
  GET_CAPABILITIES_TOOL_NAME,
  GET_AUTHORIZED_CONTEXT_TOOL_NAME,
  CAPABILITIES_RESOURCE_URI,
  AUTHORIZED_CONTEXT_RESOURCE_URI,
  CANONICAL_CAPABILITY_PAYLOAD,
} from '../src/mcp/McpProtocolSchemas';
import { formatPublicError, getCanonicalPublicErrorMessage } from '../src/mcp/McpToolRegistry';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';
import { parseCliArgs, runSessionAdmin } from '../src/mcp/sessionAdmin';
import { runStdioServer } from '../src/mcp/stdio';
import { ExecutionAuthorization } from '../src/core/types/domain';

let sharedTestRuntimeDir: string | null = null;

function getOrMaterializeTestRuntime(): string {
  if (sharedTestRuntimeDir && fs.existsSync(sharedTestRuntimeDir)) {
    return sharedTestRuntimeDir;
  }
  const projectRoot = path.resolve(__dirname, '..');
  const tempRuntimeDir = path.join(os.tmpdir(), `af-mcp-test-runtime-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tempRuntimeDir, { recursive: true });

  const tscBin = require.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.node.json', '--outDir', tempRuntimeDir], {
    cwd: projectRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  });

  const manifestPath = path.join(tempRuntimeDir, 'package.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ type: 'commonjs' }, null, 2), 'utf8');

  // Verify runtime manifest as a plain object with exactly one own property, type: 'commonjs'
  const rawManifest = fs.readFileSync(manifestPath, 'utf8');
  const parsedManifest: unknown = JSON.parse(rawManifest);
  if (
    typeof parsedManifest !== 'object' ||
    parsedManifest === null ||
    Array.isArray(parsedManifest) ||
    Object.prototype.toString.call(parsedManifest) !== '[object Object]'
  ) {
    throw new Error('Temporary test runtime manifest must be a plain object');
  }
  const manifestKeys = Object.keys(parsedManifest as Record<string, unknown>);
  if (manifestKeys.length !== 1 || manifestKeys[0] !== 'type') {
    throw new Error(`Temporary test runtime manifest must have exactly one property ('type'), found: ${manifestKeys.join(', ')}`);
  }
  if ((parsedManifest as Record<string, unknown>).type !== 'commonjs') {
    throw new Error(`Temporary test runtime manifest property 'type' must be 'commonjs', found: ${(parsedManifest as Record<string, unknown>).type}`);
  }

  // Write IPC signal bridge preload script for Windows test harnesses
  const signalPreloadPath = path.join(tempRuntimeDir, 'signal_preload.js');
  fs.writeFileSync(
    signalPreloadPath,
    `if (process.send) {\n  process.on('message', (m) => {\n    if (m === 'SIGINT') process.emit('SIGINT');\n    if (m === 'SIGTERM') process.emit('SIGTERM');\n  });\n}\n`,
    'utf8'
  );

  // Symlink / junction project node_modules into temporary test runtime
  const targetNodeModules = path.join(projectRoot, 'node_modules');
  const linkNodeModules = path.join(tempRuntimeDir, 'node_modules');
  if (!fs.existsSync(linkNodeModules) && fs.existsSync(targetNodeModules)) {
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(targetNodeModules, linkNodeModules, symlinkType);
  }

  // Verify key compiled files exist in test runtime and prove they come from the unique test-owned runtime rather than repository dist-electron
  const stdioEntry = path.join(tempRuntimeDir, 'mcp', 'stdio.js');
  const repoEntry = path.join(tempRuntimeDir, 'core', 'database', 'repositories.js');
  const serviceEntry = path.join(tempRuntimeDir, 'core', 'services', 'McpSessionAuthorityService.js');
  if (!fs.existsSync(stdioEntry) || !fs.existsSync(repoEntry) || !fs.existsSync(serviceEntry)) {
    throw new Error('Temporary test runtime is missing expected compiled modules');
  }
  const normalizedTemp = path.resolve(tempRuntimeDir);
  if (
    !path.resolve(stdioEntry).startsWith(normalizedTemp) ||
    !path.resolve(repoEntry).startsWith(normalizedTemp) ||
    !path.resolve(serviceEntry).startsWith(normalizedTemp)
  ) {
    throw new Error('Compiled modules must originate strictly within test-owned runtime directory');
  }

  sharedTestRuntimeDir = tempRuntimeDir;
  return sharedTestRuntimeDir;
}

function safeRemoveDir(dir: string, maxRetries = 10, delayMs = 50): void {
  if (!fs.existsSync(dir)) return;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      if (!fs.existsSync(dir)) {
        return;
      }
    } catch (err) {
      lastError = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  if (fs.existsSync(dir)) {
    throw new Error(
      `[CLEANUP_FAILURE] Directory "${dir}" still exists after ${maxRetries} removal attempts. Last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }
}

interface WorkerHarness<TResult> {
  readyPromise: Promise<void>;
  resultPromise: Promise<TResult>;
  cleanup: () => Promise<void>;
}

function createWorkerHarness<TResult>(w: Worker, timeoutMs = 8000): WorkerHarness<TResult> {
  let isReadySettled = false;
  let isResultSettled = false;
  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  let resultResolve!: (res: TResult) => void;
  let resultReject!: (err: Error) => void;
  let readyTimer: NodeJS.Timeout | null = null;
  let resultTimer: NodeJS.Timeout | null = null;

  const cleanupTimersAndListeners = () => {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    if (resultTimer) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }
    w.off('message', onMessage);
    w.off('error', onError);
    w.off('exit', onExit);
  };

  const settleAllFail = (err: Error) => {
    if (!isReadySettled) {
      isReadySettled = true;
      readyReject(err);
    }
    if (!isResultSettled) {
      isResultSettled = true;
      resultReject(err);
    }
    cleanupTimersAndListeners();
  };

  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const resultPromise = new Promise<TResult>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });

  const onMessage = (msg: unknown) => {
    if (msg === 'READY') {
      if (isReadySettled) {
        settleAllFail(new Error('Worker order violation: duplicate READY received'));
        return;
      }
      isReadySettled = true;
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      readyResolve();
      return;
    }

    if (!isReadySettled) {
      const desc =
        typeof msg === 'object' && msg !== null && 'error' in msg
          ? `Worker error before READY: ${String((msg as { error: unknown }).error)}`
          : `Worker order violation: received result before READY (${JSON.stringify(msg)})`;
      settleAllFail(new Error(desc));
      return;
    }

    if (typeof msg === 'object' && msg !== null && 'success' in msg) {
      if (!isResultSettled) {
        isResultSettled = true;
        if (resultTimer) {
          clearTimeout(resultTimer);
          resultTimer = null;
        }
        cleanupTimersAndListeners();
        resultResolve(msg as TResult);
      }
      return;
    }

    settleAllFail(new Error(`Worker emitted malformed message: ${JSON.stringify(msg)}`));
  };

  const onError = (err: Error) => {
    settleAllFail(err);
  };

  const onExit = (code: number) => {
    if (!isReadySettled || !isResultSettled) {
      settleAllFail(new Error(`Worker exited prematurely with code ${code}`));
    }
  };

  readyTimer = setTimeout(() => {
    settleAllFail(new Error(`Worker harness timed out waiting for READY after ${timeoutMs}ms`));
  }, timeoutMs);

  resultTimer = setTimeout(() => {
    settleAllFail(new Error(`Worker harness timed out waiting for result after ${timeoutMs}ms`));
  }, timeoutMs);

  w.on('message', onMessage);
  w.on('error', onError);
  w.on('exit', onExit);

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanupPromise = (async () => {
      const cleanupErr = new Error('[WORKER_CLEANUP_CANCELLED] Worker harness was cleaned up before settlement');
      if (!isReadySettled) {
        isReadySettled = true;
        readyReject(cleanupErr);
      }
      if (!isResultSettled) {
        isResultSettled = true;
        resultReject(cleanupErr);
      }
      cleanupTimersAndListeners();
      await w.terminate();
    })();
    return cleanupPromise;
  };

  return {
    readyPromise,
    resultPromise,
    cleanup,
  };
}

interface StdioChildHarnessOptions {
  customExecutable?: string;
  customSpawn?: (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess;
}

interface StdioChildHarness {
  child: ChildProcess;
  closeStdin: () => void;
  sendRequest: (req: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
  sendNotification: (notif: Record<string, unknown>, timeoutMs?: number) => Promise<void>;
  waitForExit: (timeoutMs?: number) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate: (signal: 'SIGINT' | 'SIGTERM') => void;
  getStdoutLines: () => string[];
  getStderr: () => string;
  close: () => Promise<void>;
}

function createStdioChildHarness(
  stdioScript: string,
  envVars: Record<string, string>,
  preloadScript?: string,
  options?: StdioChildHarnessOptions
): StdioChildHarness {
  const projectNodeModules = path.resolve(__dirname, '..', 'node_modules');
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_PATH: projectNodeModules,
    ...envVars,
  };
  const spawnArgs: string[] = [];
  if (preloadScript) {
    spawnArgs.push('-r', preloadScript);
  }
  spawnArgs.push(stdioScript);

  const spawnFn = options?.customSpawn ?? spawn;
  const executable = options?.customExecutable ?? process.execPath;
  const child = spawnFn(executable, spawnArgs, {
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  if (!child.stdout || !child.stderr || !child.stdin) {
    throw new Error('Child process stdio streams not available');
  }
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  const childStdin = child.stdin;

  const stdoutLines: string[] = [];
  const parsedMessages: Array<Record<string, unknown>> = [];
  let stdoutBuffer = '';
  let stderrOutput = '';
  let protocolContaminationError: Error | null = null;
  let childExitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let childSpawnError: Error | null = null;
  let childStdinError: Error | null = null;

  type MessageListener = (msg: Record<string, unknown>) => void;
  const messageListeners = new Set<MessageListener>();

  type ExitListener = (res: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exitListeners = new Set<ExitListener>();

  type ErrorListener = (err: Error) => void;
  const errorListeners = new Set<ErrorListener>();

  type ContaminationListener = (err: Error) => void;
  const contaminationListeners = new Set<ContaminationListener>();

  type StdinErrorListener = (err: Error) => void;
  const stdinErrorListeners = new Set<StdinErrorListener>();

  const onStdoutData = (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    let newlineIdx = stdoutBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (line) {
        stdoutLines.push(line);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (parseErr) {
          const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          const contamErr = new Error(`Protocol contamination: non-JSON stdout line emitted by child: "${line}" (${errMsg})`);
          protocolContaminationError = contamErr;
          for (const l of contaminationListeners) {
            l(contamErr);
          }
          return;
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          const contamErr = new Error(`Protocol contamination: non-object JSON stdout line emitted: "${line}"`);
          protocolContaminationError = contamErr;
          for (const l of contaminationListeners) {
            l(contamErr);
          }
          return;
        }

        const msgObj = parsed as Record<string, unknown>;
        parsedMessages.push(msgObj);
        for (const listener of messageListeners) {
          listener(msgObj);
        }
      }
      newlineIdx = stdoutBuffer.indexOf('\n');
    }
  };

  const onStderrData = (chunk: Buffer | string) => {
    stderrOutput += chunk.toString();
  };

  const onStdinError = (err: Error) => {
    childStdinError = err;
    for (const l of stdinErrorListeners) {
      l(err);
    }
  };

  const onChildError = (err: Error) => {
    childSpawnError = err;
    for (const l of errorListeners) {
      l(err);
    }
  };

  const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
    childExitResult = { code, signal };
    for (const l of exitListeners) {
      l({ code, signal });
    }
  };

  childStdout.on('data', onStdoutData);
  childStderr.on('data', onStderrData);
  childStdin.on('error', onStdinError);
  child.on('error', onChildError);
  child.on('exit', onChildExit);

  const sendRequest = (req: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, unknown>> => {
    const reqId = req.id;
    if (reqId === undefined) {
      throw new Error('sendRequest requires a request with an id');
    }

    if (protocolContaminationError) {
      return Promise.reject(protocolContaminationError);
    }
    if (childSpawnError) {
      return Promise.reject(new Error(`Cannot send request: child failed to spawn: ${childSpawnError.message}`));
    }
    if (childStdinError) {
      return Promise.reject(new Error(`Cannot send request: child stdin error: ${childStdinError.message}`));
    }
    if (childExitResult) {
      return Promise.reject(new Error(`Cannot send request: child exited prematurely with code ${childExitResult.code}`));
    }
    if (childStdin.destroyed || !childStdin.writable) {
      return Promise.reject(new Error('Cannot send request: child stdin is closed or destroyed'));
    }

    for (const existingMsg of parsedMessages) {
      if (existingMsg.id === reqId) {
        return Promise.resolve(existingMsg);
      }
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let isSettled = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        messageListeners.delete(onMessage);
        exitListeners.delete(onExit);
        errorListeners.delete(onError);
        contaminationListeners.delete(onContamination);
        stdinErrorListeners.delete(onStdinErr);
      };

      const onStdinErr: StdinErrorListener = (err) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(new Error(`Child stdin stream error while waiting for response ${reqId}: ${err.message}`));
        }
      };

      const onMessage: MessageListener = (msg) => {
        if (msg.id === reqId && !isSettled) {
          isSettled = true;
          cleanup();
          resolve(msg);
        }
      };

      const onContamination: ContaminationListener = (contamErr) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(contamErr);
        }
      };

      const onExit: ExitListener = (res) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(new Error(`Child exited prematurely with code ${res.code} while waiting for response ${reqId}`));
        }
      };

      const onError: ErrorListener = (err) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(err);
        }
      };

      timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(new Error(`Timeout (${timeoutMs}ms) waiting for JSON-RPC response ${reqId}. Lines: ${stdoutLines.join(' | ')}`));
        }
      }, timeoutMs);

      messageListeners.add(onMessage);
      exitListeners.add(onExit);
      errorListeners.add(onError);
      contaminationListeners.add(onContamination);
      stdinErrorListeners.add(onStdinErr);

      try {
        const ok = childStdin.write(JSON.stringify(req) + '\n', (writeErr) => {
          if (writeErr && !isSettled) {
            isSettled = true;
            cleanup();
            reject(new Error(`Failed to write request ${reqId} to child stdin: ${writeErr.message}`));
          }
        });
        if (!ok && childStdin.destroyed && !isSettled) {
          isSettled = true;
          cleanup();
          reject(new Error(`Failed to write request ${reqId} to child stdin: stream destroyed`));
        }
      } catch (writeErr) {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(writeErr instanceof Error ? writeErr : new Error(String(writeErr)));
        }
      }
    });
  };

  const sendNotification = (notif: Record<string, unknown>, timeoutMs = 4000): Promise<void> => {
    if (protocolContaminationError) {
      return Promise.reject(protocolContaminationError);
    }
    if (childSpawnError) {
      return Promise.reject(new Error(`Cannot send notification: child failed to spawn: ${childSpawnError.message}`));
    }
    if (childStdinError) {
      return Promise.reject(new Error(`Cannot send notification: child stdin error: ${childStdinError.message}`));
    }
    if (childExitResult) {
      return Promise.reject(new Error(`Cannot send notification: child exited prematurely with code ${childExitResult.code}`));
    }
    if (childStdin.destroyed || !childStdin.writable) {
      return Promise.reject(new Error('Cannot send notification: child stdin is closed or destroyed'));
    }

    return new Promise<void>((resolve, reject) => {
      let isSettled = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        stdinErrorListeners.delete(onStdinErr);
        errorListeners.delete(onError);
        exitListeners.delete(onExit);
        contaminationListeners.delete(onContamination);
      };

      const onContamination: ContaminationListener = (contamErr) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(contamErr);
        }
      };

      const onStdinErr: StdinErrorListener = (err) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(new Error(`Child stdin stream error while sending notification: ${err.message}`));
        }
      };

      const onError: ErrorListener = (err) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(err);
        }
      };

      const onExit: ExitListener = (res) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(new Error(`Child exited prematurely with code ${res.code} while sending notification`));
        }
      };

      timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(new Error(`Timeout (${timeoutMs}ms) waiting for notification write completion`));
        }
      }, timeoutMs);

      stdinErrorListeners.add(onStdinErr);
      errorListeners.add(onError);
      exitListeners.add(onExit);
      contaminationListeners.add(onContamination);

      try {
        const ok = childStdin.write(JSON.stringify(notif) + '\n', (writeErr) => {
          if (!isSettled) {
            isSettled = true;
            cleanup();
            if (writeErr) {
              reject(new Error(`Failed to write notification to child stdin: ${writeErr.message}`));
            } else {
              resolve();
            }
          }
        });
        if (!ok && childStdin.destroyed && !isSettled) {
          isSettled = true;
          cleanup();
          reject(new Error('Failed to write notification: child stdin destroyed'));
        }
      } catch (err) {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  };

  const waitForExit = (timeoutMs = 8000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    if (childSpawnError) {
      return Promise.reject(new Error(`Child failed to spawn: ${childSpawnError.message}`));
    }
    if (childExitResult) {
      return Promise.resolve(childExitResult);
    }
    return new Promise((resolve, reject) => {
      let isSettled = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        exitListeners.delete(onExit);
        errorListeners.delete(onError);
      };

      const onExit: ExitListener = (res) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          resolve(res);
        }
      };

      const onError: ErrorListener = (err) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(err);
        }
      };

      timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(new Error(`Timeout (${timeoutMs}ms) waiting for child exit`));
        }
      }, timeoutMs);

      exitListeners.add(onExit);
      errorListeners.add(onError);
    });
  };

  const terminate = (signal: 'SIGINT' | 'SIGTERM') => {
    if (process.platform === 'win32' && child.send) {
      child.send(signal);
    } else {
      child.kill(signal);
    }
  };

  let isFinalized = false;
  let closePromise: Promise<void> | null = null;

  const finalizeHarness = () => {
    if (isFinalized) {
      return;
    }
    isFinalized = true;

    childStdout.removeListener('data', onStdoutData);
    childStderr.removeListener('data', onStderrData);
    childStdin.removeListener('error', onStdinError);
    child.removeListener('error', onChildError);
    child.removeListener('exit', onChildExit);

    messageListeners.clear();
    exitListeners.clear();
    errorListeners.clear();
    contaminationListeners.clear();
    stdinErrorListeners.clear();
  };

  const harness: StdioChildHarness = {
    child,
    closeStdin: () => {
      childStdin.end();
    },
    sendRequest,
    sendNotification,
    waitForExit,
    terminate,
    getStdoutLines: () => [...stdoutLines],
    getStderr: () => stderrOutput,
    close: () => {
      if (closePromise) {
        return closePromise;
      }

      closePromise = (async () => {
        try {
          if (childSpawnError) {
            if (!childStdin.destroyed) {
              childStdin.destroy();
            }
            return;
          }
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await harness.waitForExit(2000);
          }
        } finally {
          finalizeHarness();
        }
      })();

      return closePromise;
    },
  };

  return harness;
}

function createTestDatabase(dir: string, name: string): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(dir, name);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);
  return { db, dbPath };
}

interface FullGraphFixtures {
  projectId: string;
  taskId: string;
  attemptId: string;
  assignmentId: string;
  providerId: string;
  accountId: string;
  resourceId: string;
  routingDecisionId: string;
  authorizationId: string;
  managerMessageId: string;
  managerRecordId: string;
  rawManagerPayload: string;
  roleId: string;
  agentId: string;
  canonicalInstructionsJson: string;
  contextFilesJson: string;
  service: McpSessionAuthorityService;
  repo: Repository;
  auth: ExecutionAuthorization;
}

function setupFullGraph(db: Database.Database): FullGraphFixtures {
  const repo = new Repository(db);
  const service = new McpSessionAuthorityService(repo, db);

  const now = new Date().toISOString();
  const projectId = `proj-${crypto.randomUUID()}`;
  const taskId = `task-${crypto.randomUUID()}`;
  const attemptId = `att-${crypto.randomUUID()}`;
  const assignmentId = `asgn-${crypto.randomUUID()}`;
  const providerId = `prov-${crypto.randomUUID()}`;
  const accountId = `acc-${crypto.randomUUID()}`;
  const resourceId = `res-${crypto.randomUUID()}`;
  const routingDecisionId = `route-${crypto.randomUUID()}`;
  const authorizationId = `auth-${crypto.randomUUID()}`;
  const managerMessageId = `msg-proto-${crypto.randomUUID()}`;
  const managerRecordId = `msg-rec-${crypto.randomUUID()}`;

  // 1. Project
  repo.createProject({
    id: projectId,
    name: 'Test Project',
    description: 'Testing',
    repository_path: 'D:/fake/repo',
    default_branch: 'main',
    status: 'RUNNING',
    contract: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
  });

  // 2. Task
  const baseSha = 'b'.repeat(40);
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
    VALUES (?, ?, 'Task 1', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
  `).run(taskId, projectId, baseSha, now, now);

  // 3. Profiles
  const roleId = `role-${crypto.randomUUID()}`;
  const agentId = `agent-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
    VALUES (?, 'CODER', 'Coder Role', '["CODING"]', '[]', '[]', 1, ?, ?)
  `).run(roleId, now, now);

  db.prepare(`
    INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
    VALUES (?, ?, 'Agent Coder', 1, ?, ?)
  `).run(agentId, roleId, now, now);

  // 4. Provider, Account, Resource
  db.prepare(`
    INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at)
    VALUES (?, 'Anthropic Claude', 'LOCAL_CLI', 1, ?)
  `).run(providerId, now);

  db.prepare(`
    INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
    VALUES (?, ?, 'default-account', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 20, ?, ?)
  `).run(accountId, providerId, now, now);

  db.prepare(`
    INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
    VALUES (?, ?, ?, 'claude-3-7-sonnet', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
  `).run(resourceId, providerId, accountId, now);

  // 5. Task Attempt
  repo.createTaskAttempt({
    id: attemptId,
    task_id: taskId,
    attempt_number: 1,
    status: 'RUNNING',
    agent_profile_id: agentId,
    agent_id: null,
    started_at: now,
    ended_at: null,
    summary: null,
  });

  // 6. Routing Decision Event (canonical ROLE_AWARE_ROUTING_DECISION schema)
  const routingPayload = {
    decisionId: routingDecisionId,
    projectId,
    taskId,
    attemptId,
    roleProfileId: roleId,
    role: 'CODER',
    outcome: 'SELECTED',
    routePolicyId: null,
    failoverPolicyAuthoritySnapshot: null,
    selectedProviderId: providerId,
    selectedAccountId: accountId,
    selectedResourceId: resourceId,
    selectedAssignmentId: assignmentId,
    requestedConstraints: [],
    appliedExclusions: [],
    appliedSeparation: null,
    reason: 'Optimal route',
  };
  db.prepare(`
    INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
    VALUES (?, ?, ?, 'ROLE_AWARE_ROUTING_DECISION', 'Optimal route', ?, ?)
  `).run(routingDecisionId, projectId, taskId, JSON.stringify(routingPayload), now);

  // 7. Agent Assignment
  repo.createAgentAssignment({
    id: assignmentId,
    project_id: projectId,
    task_id: taskId,
    attempt_id: attemptId,
    role_profile_id: roleId,
    agent_profile_id: agentId,
    selected_provider_id: providerId,
    selected_account_id: accountId,
    selected_resource_id: resourceId,
    selected_worker_slot_id: null,
    routing_decision_id: routingDecisionId,
    status: 'ASSIGNED',
    created_at: now,
    ended_at: null,
    preferred_metadata: null,
  });

  // 8. Canonical Protocol Message
  const instructions = ['Task: Task 1', 'Implement authorized context read'];
  const managerPayload = {
    protocol: 'manager.v1',
    message_id: managerMessageId,
    project_id: projectId,
    task_id: taskId,
    decision: 'EXECUTE',
    priority: 'LOW',
    risk: 'LOW',
    instructions,
    acceptance_criteria: ['All tests pass'],
    constraints: ['No regressions'],
    review_issues: [],
    expected_task_state: 'CODING',
    expected_revision: 1,
    created_at: now,
  };
  const rawManagerPayload = JSON.stringify(managerPayload);
  const managerPayloadHash = crypto.createHash('sha256').update(rawManagerPayload, 'utf8').digest('hex');
  repo.recordProtocolMessage(
    managerRecordId,
    managerMessageId,
    'manager.v1',
    projectId,
    taskId,
    'CODING',
    1,
    managerPayloadHash,
    rawManagerPayload,
    'APPLIED',
    undefined,
    now
  );

  // 9. Canonical Instructions and Context Files
  const canonicalInstructionsJson = JSON.stringify(instructions);
  const contextFiles = ['src/mcp/McpServer.ts'];
  const contextFilesJson = JSON.stringify(contextFiles);

  const canonicalPayload = computeCanonicalPayload({
    projectId,
    taskId,
    attemptId,
    taskTitle: 'Task 1',
    taskDescription: 'Test task description',
    acceptanceCriteria: ['All tests pass'],
    constraints: ['No regressions'],
    instructions,
    contextFiles,
    verificationCommands: {
      TEST: { executable: 'npm', args: ['test'] },
      LINT: null,
      BUILD: null,
    },
    managerMessageId: managerRecordId,
    managerPayloadHash,
  });
  const canonicalPayloadJson = JSON.stringify(canonicalPayload);
  const instructionPayloadHash = computePayloadHash(canonicalPayload);
  const contextManifestHash = computeContextManifestHash(contextFiles);

  // 10. Execution Authorization
  const auth: ExecutionAuthorization = {
    id: authorizationId,
    project_id: projectId,
    task_id: taskId,
    task_revision: 1,
    base_sha: 'b'.repeat(40),
    repository_head_sha: 'c'.repeat(40),
    manager_message_id: managerRecordId,
    manager_payload_hash: managerPayloadHash,
    routing_decision_id: routingDecisionId,
    selected_resource_id: resourceId,
    selected_provider_id: providerId,
    instruction_payload_hash: instructionPayloadHash,
    context_manifest_hash: contextManifestHash,
    canonical_instructions_json: canonicalInstructionsJson,
    context_files_json: contextFilesJson,
    canonical_payload_json: canonicalPayloadJson,
    status: 'AUTHORIZED',
    created_at: now,
    dispatched_at: null,
    execution_id: null,
    task_ownership_epoch: 1,
    lifecycle_version: 1,
    selected_account_id: accountId,
    adapter_started_at: null,
    adapter_finished_at: null,
    adapter_error_json: null,
    settlement_status: null,
    settled_at: null,
    settlement_evidence_json: null,
    settlement_evidence_hash: null,
    assignment_id: assignmentId,
    attempt_id: attemptId,
  };
  repo.createExecutionAuthorization(auth);

  return {
    projectId,
    taskId,
    attemptId,
    assignmentId,
    providerId,
    accountId,
    resourceId,
    routingDecisionId,
    authorizationId,
    managerMessageId,
    managerRecordId,
    rawManagerPayload,
    roleId,
    agentId,
    canonicalInstructionsJson,
    contextFilesJson,
    service,
    repo,
    auth,
  };
}

describe('R5J2 MCP Session Authority and Scoped Context Read Truth Suite', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(process.cwd(), 'temp', `r5j2-test-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    resetDefaultAuthorityContext();
  });

  afterEach(() => {
    resetDefaultAuthorityContext();
    safeRemoveDir(tempDir);
  });

  afterAll(() => {
    resetDefaultAuthorityContext();
    if (sharedTestRuntimeDir) {
      const dirToClean = sharedTestRuntimeDir;
      sharedTestRuntimeDir = null;
      safeRemoveDir(dirToClean);
    }
  });

  // =========================================================================
  // Part 1: Truthful Migration 21 Authority & Schema Integrity
  // =========================================================================

  it('1. Fresh Migration 1->21 applies cleanly ending at version 21 without proxy or stack sniffing', () => {
    const { db } = createTestDatabase(tempDir, 'fresh21.db');
    try {
      const row = db.prepare('SELECT COUNT(*) as c, MAX(version) as max_v FROM schema_migrations').get() as { c: number; max_v: number };
      expect(row.c).toBe(21);
      expect(row.max_v).toBe(21);
      expect(MIGRATIONS.length).toBe(21);
      expect(Array.isArray(MIGRATIONS)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('2. Sequential upgrade from v20 applies Migration 21 cleanly ending at version 21', () => {
    const upgradeDb = new Database(path.join(tempDir, 'upgrade.db'));
    upgradeDb.pragma('foreign_keys = ON');
    try {
      upgradeDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const m of MIGRATIONS.filter((m) => m.version <= 20)) {
        m.up(upgradeDb);
        upgradeDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      }
      MigrationRunner.run(upgradeDb);
      const row = upgradeDb.prepare('SELECT COUNT(*) as c, MAX(version) as max_v FROM schema_migrations').get() as { c: number; max_v: number };
      expect(row.c).toBe(21);
      expect(row.max_v).toBe(21);
    } finally {
      upgradeDb.close();
    }
  });

  it('3. Static audit: production and release code contain zero test filename sniffing, stack inspection, or MIGRATIONS proxy', () => {
    const migrationsSource = fs.readFileSync(path.join(process.cwd(), 'src/core/database/migrations.ts'), 'utf-8');
    expect(migrationsSource).not.toContain('r5iCrashRecoveryAndAuditStream');
    expect(migrationsSource).not.toContain('new Error().stack');
    expect(migrationsSource).not.toContain('new Proxy');
    expect(migrationsSource).not.toContain('RAW_MIGRATIONS');

    const rcScript = fs.readFileSync(path.join(process.cwd(), 'scripts/verify-demo-rc-win.ps1'), 'utf-8');
    expect(rcScript).not.toContain('Expected exactly 20 migrations');
    expect(rcScript).toContain('Expected exactly 21 migrations');
  });

  it('4. Migration 21 fails closed on pre-existing conflicting mcp_client_sessions table with no ledger row written', () => {
    const testDb = new Database(path.join(tempDir, 'conflict_table.db'));
    testDb.pragma('foreign_keys = ON');
    try {
      testDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const m of MIGRATIONS.filter((m) => m.version <= 20)) {
        m.up(testDb);
        testDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      }
      // Create conflicting table beforehand without proper schema
      testDb.exec('CREATE TABLE mcp_client_sessions (bogus_col TEXT PRIMARY KEY);');

      expect(() => {
        MigrationRunner.run(testDb);
      }).toThrow();

      const ledger = testDb.prepare('SELECT * FROM schema_migrations WHERE version = 21').get();
      expect(ledger).toBeUndefined();
    } finally {
      testDb.close();
    }
  });

  it('5. Migration 21 fails closed on pre-existing conflicting index with no ledger row written', () => {
    const testDb = new Database(path.join(tempDir, 'conflict_idx.db'));
    testDb.pragma('foreign_keys = ON');
    try {
      testDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const m of MIGRATIONS.filter((m) => m.version <= 20)) {
        m.up(testDb);
        testDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      }
      // Conflicting index on another table
      testDb.exec('CREATE TABLE temp_foo (token_hash TEXT);');
      testDb.exec('CREATE INDEX idx_mcp_client_sessions_token_hash ON temp_foo(token_hash);');

      expect(() => {
        MigrationRunner.run(testDb);
      }).toThrow();

      const ledger = testDb.prepare('SELECT * FROM schema_migrations WHERE version = 21').get();
      expect(ledger).toBeUndefined();
    } finally {
      testDb.close();
    }
  });

  it('6. verifyMigration21SchemaAuthority rejects missing version 21 ledger row', () => {
    const testDb = new Database(path.join(tempDir, 'fake_table.db'));
    try {
      testDb.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
        CREATE TABLE mcp_client_sessions (id TEXT PRIMARY KEY);
      `);
      expect(() => {
        verifyMigration21SchemaAuthority(testDb);
      }).toThrow(/missing Migration 21 ledger authority/);
    } finally {
      testDb.close();
    }
  });

  it('7. verifyMigration21SchemaAuthority rejects missing required columns or constraints', () => {
    const testDb = new Database(path.join(tempDir, 'bad_schema.db'));
    try {
      testDb.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (21, '021_r5j_mcp_client_session_authority', datetime('now'));
        CREATE TABLE mcp_client_sessions (id TEXT PRIMARY KEY, authorization_id TEXT NOT NULL);
      `);
      expect(() => {
        verifyMigration21SchemaAuthority(testDb);
      }).toThrow(/missing column/);
    } finally {
      testDb.close();
    }
  });

  // =========================================================================
  // Part 2: Cryptographic Token & TTL Contract
  // =========================================================================

  it('8. Token entropy is >= 256 bits canonical base64url and returned plaintext once', () => {
    const token1 = McpSessionAuthorityService.generateSessionToken();
    const token2 = McpSessionAuthorityService.generateSessionToken();
    expect(token1).not.toEqual(token2);
    expect(token1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token2).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('9. Database stores only lowercase SHA-256 token digest, never plaintext', () => {
    const { db } = createTestDatabase(tempDir, 'tokenhash.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session, plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const expectedHash = crypto.createHash('sha256').update(plaintextToken, 'utf8').digest('hex').toLowerCase();
      expect(session.token_hash).toBe(expectedHash);

      const row = db.prepare('SELECT * FROM mcp_client_sessions WHERE id = ?').get(session.id) as Record<string, unknown>;
      expect(row.token_hash).toBe(expectedHash);

      const allTextInRow = Object.values(row).join(' ');
      expect(allTextInRow).not.toContain(plaintextToken);
    } finally {
      db.close();
    }
  });

  it('10. Successful CLI issue output contains returned plaintext token exactly once; every table, event, context, stdout/stderr, and database byte contains it zero times', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'notokenleak.db');
    // Enable WAL mode unconditionally so WAL and SHM sidecars are materialized
    db.pragma('journal_mode = WAL');
    try {
      const fixtures = setupFullGraph(db);

      // 1. Issue via CLI and capture stdout & stderr
      let issueStdout = '';
      let issueStderr = '';
      const origStdout = process.stdout.write;
      const origStderr = process.stderr.write;
      process.stdout.write = ((chunk: unknown) => { issueStdout += String(chunk); return true; }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown) => { issueStderr += String(chunk); return true; }) as typeof process.stderr.write;

      let exitCode = 1;
      try {
        exitCode = runSessionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId, '--json']);
      } finally {
        process.stdout.write = origStdout;
        process.stderr.write = origStderr;
      }

      expect(exitCode).toBe(0);
      const parsedIssue = JSON.parse(issueStdout);
      const plaintextToken = parsedIssue.plaintext_token;
      expect(plaintextToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // Plaintext token appears EXACTLY ONCE in successful issue stdout
      const occurrences = issueStdout.split(plaintextToken).length - 1;
      expect(occurrences).toBe(1);
      expect(issueStderr).not.toContain(plaintextToken);

      // 2. Check context response contains token ZERO times
      const ctx = fixtures.service.resolveAuthorizedContext(plaintextToken);
      expect(JSON.stringify(ctx)).not.toContain(plaintextToken);

      // 3. Subsequent admin revoke: stdout and stderr contain token ZERO times
      let revokeStdout = '';
      let revokeStderr = '';
      process.stdout.write = ((chunk: unknown) => { revokeStdout += String(chunk); return true; }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown) => { revokeStderr += String(chunk); return true; }) as typeof process.stderr.write;
      try {
        const revExit = runSessionAdmin(['revoke', '--db', dbPath, '--session', parsedIssue.session.id, '--json']);
        expect(revExit).toBe(0);
      } finally {
        process.stdout.write = origStdout;
        process.stderr.write = origStderr;
      }
      expect(revokeStdout).not.toContain(plaintextToken);
      expect(revokeStderr).not.toContain(plaintextToken);

      // 4. Failed CLI commands: stdout and stderr contain token ZERO times
      let failStderr = '';
      process.stderr.write = ((chunk: unknown) => { failStderr += String(chunk); return true; }) as typeof process.stderr.write;
      try {
        runSessionAdmin(['issue', '--db', dbPath, '--auth', 'nonexistent-auth']);
        runSessionAdmin(['revoke', '--db', dbPath, '--session', 'nonexistent-session']);
      } finally {
        process.stderr.write = origStderr;
      }
      expect(failStderr).not.toContain(plaintextToken);

      // 5. Check lookup by ID and by token hash contain token ZERO times
      const storedRow = fixtures.repo.getMcpClientSessionById(parsedIssue.session.id);
      expect(storedRow).toBeDefined();
      expect(parsedIssue.session.token_hash).toBeUndefined();
      expect(storedRow?.token_hash).toBeDefined();
      expect(storedRow?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(storedRow)).not.toContain(plaintextToken);
      expect(JSON.stringify(parsedIssue.session)).not.toContain(plaintextToken);

      const lookedUp = fixtures.repo.getMcpClientSessionByTokenHash(storedRow!.token_hash);
      expect(lookedUp).toBeDefined();
      expect(lookedUp!.id).toBe(parsedIssue.session.id);
      expect(JSON.stringify(lookedUp)).not.toContain(plaintextToken);
      const activeSessions = fixtures.repo.getActiveMcpClientSessionByAuthorizationId(fixtures.authorizationId);
      expect(JSON.stringify(activeSessions)).not.toContain(plaintextToken);

      // 6. Check every database table row contains token ZERO times
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      for (const t of tables) {
        const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
        expect(JSON.stringify(rows)).not.toContain(plaintextToken);
      }

      // 7. Check database file, WAL, and SHM bytes contain token ZERO times unconditionally
      const dbBytes = fs.readFileSync(dbPath);
      expect(dbBytes.includes(Buffer.from(plaintextToken))).toBe(false);
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      expect(fs.existsSync(walPath)).toBe(true);
      expect(fs.existsSync(shmPath)).toBe(true);
      const walBytes = fs.readFileSync(walPath);
      const shmBytes = fs.readFileSync(shmPath);
      expect(walBytes.length).toBeGreaterThan(0);
      expect(shmBytes.length).toBeGreaterThan(0);
      expect(walBytes.includes(Buffer.from(plaintextToken))).toBe(false);
      expect(shmBytes.includes(Buffer.from(plaintextToken))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('11. Canonical token validation: valid 43-char base64url token succeeds', () => {
    const token = McpSessionAuthorityService.generateSessionToken();
    expect(validateCanonicalSessionToken(token)).toBe(token);
  });

  it('12. Canonical token rejection: empty string and null/undefined return MCP_SESSION_REQUIRED', () => {
    expect(() => validateCanonicalSessionToken('')).toThrowError(/MCP_SESSION_REQUIRED/);
    expect(() => validateCanonicalSessionToken(undefined)).toThrowError(/MCP_SESSION_REQUIRED/);
    expect(() => validateCanonicalSessionToken(null)).toThrowError(/MCP_SESSION_REQUIRED/);
  });

  it('13. Non-canonical token rejection: whitespace-wrapped, wrong length, invalid chars return MCP_SESSION_UNAUTHORIZED', () => {
    const valid = McpSessionAuthorityService.generateSessionToken();
    expect(() => validateCanonicalSessionToken(` ${valid} `)).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    expect(() => validateCanonicalSessionToken(valid.slice(0, 42))).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    expect(() => validateCanonicalSessionToken(`${valid}a`)).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    expect(() => validateCanonicalSessionToken(`${valid.slice(0, 42)}=`)).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    expect(() => validateCanonicalSessionToken(`${valid.slice(0, 42)}+`)).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
  });

  it('14. Strict TTL bounds [300, 86400]: rejects below, above, fractional, NaN, infinity, exponent, signed, suffixed', () => {
    expect(validateTtlSeconds(undefined)).toBe(MCP_SESSION_DEFAULT_TTL_SECONDS);
    expect(validateTtlSeconds(3600)).toBe(3600);
    expect(validateTtlSeconds(300)).toBe(300);
    expect(validateTtlSeconds(86400)).toBe(86400);

    expect(() => validateTtlSeconds(299)).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds(86401)).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds(3600.5)).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds(NaN)).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds(Infinity)).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds('3600s')).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds('+3600')).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds('-3600')).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds('1e4')).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds('3600abc')).toThrowError(/MCP_CONFIGURATION_INVALID/);
  });

  // =========================================================================
  // Part 3: Complete Authority Graph Validation on Issuance
  // =========================================================================

  it('15. Full graph issuance succeeds using real routing event with all 8 mandatory payload fields', () => {
    const { db } = createTestDatabase(tempDir, 'fullgraph.db');
    try {
      const fixtures = setupFullGraph(db);
      const result = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(result.session.id).toBeDefined();
      expect(result.plaintextToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      db.close();
    }
  });

  it('16. Issuance rejects unknown authorization returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'unknownauth.db');
    try {
      const fixtures = setupFullGraph(db);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: 'non-existent-auth' });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('17. Issuance rejects legacy lifecycle_version != 1 returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'legacyauth.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE execution_authorizations SET lifecycle_version = NULL WHERE id = ?').run(fixtures.authorizationId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('18. Issuance rejects invalid authorization status returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'invalidstatus.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE execution_authorizations SET status = 'INVALIDATED' WHERE id = ?").run(fixtures.authorizationId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('19. Issuance rejects terminal settlement returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'settled.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare(`
        UPDATE execution_authorizations
        SET settlement_status = 'COMPLETED',
            settled_at = datetime('now'),
            settlement_evidence_json = '{}',
            settlement_evidence_hash = ?
        WHERE id = ?
      `).run('a'.repeat(64), fixtures.authorizationId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('20. Issuance rejects missing project or project mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'projmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      const otherProjId = 'other-proj-id';
      fixtures.repo.createProject({
        id: otherProjId,
        name: 'Other',
        description: 'Testing',
        repository_path: 'D:/fake/other',
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      });
      db.prepare('UPDATE execution_authorizations SET project_id = ? WHERE id = ?').run(otherProjId, fixtures.authorizationId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('21. Issuance rejects missing task, task project mismatch, or revision mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'taskmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE tasks SET revision_count = 2 WHERE id = ?').run(fixtures.taskId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('22. Issuance rejects task ownership epoch mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'epochmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE execution_authorizations SET task_ownership_epoch = 2 WHERE id = ?').run(fixtures.authorizationId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('23. Issuance rejects missing attempt or attempt task mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'attmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      const otherTaskId = `task-${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, created_at, updated_at)
        VALUES (?, ?, 'Task 2', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, datetime('now'), datetime('now'))
      `).run(otherTaskId, fixtures.projectId, 'b'.repeat(40));
      db.prepare('UPDATE task_attempts SET task_id = ? WHERE id = ?').run(otherTaskId, fixtures.attemptId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('24. Issuance rejects missing assignment or terminal assignment status returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'asgnstatus.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE agent_assignments SET status = 'COMPLETED' WHERE id = ?").run(fixtures.assignmentId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('25. Issuance rejects missing provider or disabled provider returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'provstatus.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(fixtures.providerId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('26. Issuance rejects missing account, disabled account, or account-provider mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'accstatus.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE provider_accounts SET enabled = 0 WHERE id = ?').run(fixtures.accountId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('27. Issuance rejects missing resource, disabled resource, or resource account mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'resstatus.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE provider_resources SET enabled = 0 WHERE id = ?').run(fixtures.resourceId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('28. Issuance rejects missing protocol message or hash mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'msgmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE protocol_messages SET payload_hash = ? WHERE id = ?").run('b'.repeat(64), fixtures.managerRecordId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // Part 4: Mandatory Routing Payload Field Validation (One at a time)
  // =========================================================================

  it('29. Routing decision event mutated top-level project_id column fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_noproj.db');
    try {
      const fixtures = setupFullGraph(db);
      const otherProjId = `proj-alt-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      fixtures.repo.createProject({
        id: otherProjId,
        name: 'Alternate Project',
        description: 'Alt',
        repository_path: '/path/alt',
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
        started_at: now,
        completed_at: null,
      });
      db.prepare('UPDATE events SET project_id = ? WHERE id = ?').run(otherProjId, fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('30. Routing decision event mutated top-level task_id column fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_notask.db');
    try {
      const fixtures = setupFullGraph(db);
      const otherTaskId = `task-alt-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const baseSha = 'b'.repeat(40);
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
        VALUES (?, ?, 'Task Alt', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
      `).run(otherTaskId, fixtures.projectId, baseSha, now, now);
      db.prepare('UPDATE events SET task_id = ? WHERE id = ?').run(otherTaskId, fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('31. Routing decision event missing attempt_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_noatt.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('32. Routing decision event missing routing_decision_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_nodec.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('33. Routing decision event missing selected_provider_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_noprov.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('34. Routing decision event missing selected_account_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_noacc.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('35. Routing decision event missing selected_resource_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_nores.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        outcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('36. Routing decision event missing or non-SELECTED outcome fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_nooutcome.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'REJECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('37. Routing decision non-authoritative event type fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_badtype.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE events SET type = 'CUSTOM_EVENT' WHERE id = ?").run(fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // Part 5: Complete Graph Fingerprint & Post-Issuance Read Fencing
  // =========================================================================

  it('38. Recomputed complete graph fingerprint matches on unmodified graph', () => {
    const { db } = createTestDatabase(tempDir, 'fingerprint_match.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      const ctx = fixtures.service.resolveAuthorizedContext(plaintextToken);
      expect(ctx.authorization.id).toBe(fixtures.authorizationId);
    } finally {
      db.close();
    }
  });

  it('39. Post-issuance read fenced after mutating project name/path in database returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_proj.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE projects SET name = 'Tampered Project' WHERE id = ?").run(fixtures.projectId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('40. Post-issuance read fenced after mutating task state returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_task.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(fixtures.taskId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/(?:MCP_CONTEXT_INTEGRITY_FAILED|MCP_AUTHORITY_FENCED)/);
    } finally {
      db.close();
    }
  });

  it('41. Post-issuance read fenced after mutating attempt status returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_att.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE task_attempts SET status = 'COMPLETED' WHERE id = ?").run(fixtures.attemptId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/(?:MCP_CONTEXT_INTEGRITY_FAILED|MCP_AUTHORITY_FENCED)/);
    } finally {
      db.close();
    }
  });

  it('42. Post-issuance read fenced after mutating assignment status to COMPLETED returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_asgn.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE agent_assignments SET status = 'COMPLETED' WHERE id = ?").run(fixtures.assignmentId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('43. Post-issuance read fenced after mutating assignment cross-binding returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_asgn_bind.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      const otherProvId = `prov-${crypto.randomUUID()}`;
      db.prepare("INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES (?, 'Other Prov', 'LOCAL_CLI', 1, datetime('now'))").run(otherProvId);
      db.prepare("UPDATE agent_assignments SET selected_provider_id = ? WHERE id = ?").run(otherProvId, fixtures.assignmentId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('44. Post-issuance read fenced after mutating provider name returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_prov.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE providers SET name = 'Mutated Claude' WHERE id = ?").run(fixtures.providerId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('45. Post-issuance read fenced after mutating account label returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_acc.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE provider_accounts SET label = 'tampered-label' WHERE id = ?").run(fixtures.accountId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('46. Post-issuance read fenced after mutating resource model_name returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_res.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE provider_resources SET model_name = 'claude-3-opus' WHERE id = ?").run(fixtures.resourceId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('47. Post-issuance read fenced after mutating routing decision structured payload returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_route.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      const tamperedPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        roleProfileId: fixtures.roleId,
        role: 'CODER',
        outcome: 'SELECTED',
        routePolicyId: null,
        failoverPolicyAuthoritySnapshot: null,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        selectedAssignmentId: fixtures.assignmentId,
        requestedConstraints: [],
        appliedExclusions: [],
        appliedSeparation: null,
        reason: 'Tampered reason',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(tamperedPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('48. Post-issuance read fenced after deleting a referenced node returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'del_node.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare('DELETE FROM events WHERE id = ?').run(fixtures.routingDecisionId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // Part 6: Canonical Payload & Integrity Verification
  // =========================================================================

  it('49. Missing or malformed canonical_payload_json fails closed returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'bad_payload.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE execution_authorizations SET canonical_payload_json = '{bad json}' WHERE id = ?").run(fixtures.authorizationId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('50. Canonical payload schema validation failure rejects unknown fields returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'unknown_fields.db');
    try {
      const fixtures = setupFullGraph(db);
      const parsed = JSON.parse(fixtures.auth.canonical_payload_json!);
      parsed.surplusMaliciousField = 'exploit';
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(JSON.stringify(parsed), fixtures.authorizationId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('51. Instruction payload hash recomputation mismatch fails closed returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'hash_mismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE execution_authorizations SET instruction_payload_hash = ? WHERE id = ?').run('e'.repeat(64), fixtures.authorizationId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('52. Context manifest hash recomputation mismatch fails closed returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'manifest_mismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE execution_authorizations SET context_manifest_hash = ? WHERE id = ?').run('f'.repeat(64), fixtures.authorizationId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // Part 7: Session Authentication & Non-Oracular Equivalence
  // =========================================================================

  it('53. Unknown token, expired token, and revoked token produce identical non-oracular error MCP_SESSION_UNAUTHORIZED', () => {
    const { db } = createTestDatabase(tempDir, 'non_oracular.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session, plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      // Unknown token
      const unknownToken = McpSessionAuthorityService.generateSessionToken();
      let errUnknown: Error | null = null;
      try {
        fixtures.service.resolveAuthorizedContext(unknownToken);
      } catch (e) {
        errUnknown = e as Error;
      }

      // Expired token
      db.prepare("UPDATE mcp_client_sessions SET issued_at = '2020-01-01T00:00:00.000Z', expires_at = '2020-01-01T01:00:00.000Z' WHERE id = ?").run(session.id);
      let errExpired: Error | null = null;
      try {
        fixtures.service.resolveAuthorizedContext(plaintextToken);
      } catch (e) {
        errExpired = e as Error;
      }

      // Revoked token
      fixtures.service.revokeSession({ sessionId: session.id });
      let errRevoked: Error | null = null;
      try {
        fixtures.service.resolveAuthorizedContext(plaintextToken);
      } catch (e) {
        errRevoked = e as Error;
      }

      expect(errUnknown).toBeInstanceOf(Error);
      expect(errExpired).toBeInstanceOf(Error);
      expect(errRevoked).toBeInstanceOf(Error);
      expect(errUnknown?.message).toBe(errExpired?.message);
      expect(errUnknown?.message).toBe(errRevoked?.message);
      expect(errUnknown?.message).toContain('MCP_SESSION_UNAUTHORIZED');
    } finally {
      db.close();
    }
  });

  it('54. Single error category prefix in public error formatting with zero double prefixing', () => {
    const authErr = new McpAuthorityError('MCP_SESSION_UNAUTHORIZED', 'Session authentication failed');
    const formatted = formatPublicError(authErr);
    expect(formatted.text).toBe('[MCP_SESSION_UNAUTHORIZED] Session authentication failed');
    expect(formatted.text).not.toContain('[[MCP_SESSION_UNAUTHORIZED]]');
    expect(formatted.text).not.toContain('[MCP_SESSION_UNAUTHORIZED] [MCP_SESSION_UNAUTHORIZED]');
  });

  it('55. Duplicate active session rejected on issuance returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'dupactive.db');
    try {
      const fixtures = setupFullGraph(db);
      fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('56. Idempotent session revocation succeeds without error or duplicate mutations', () => {
    const { db } = createTestDatabase(tempDir, 'idempotent_revoke.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const rev1 = fixtures.service.revokeSession({ sessionId: session.id });
      expect(rev1.revoked).toBe(true);

      const rev2 = fixtures.service.revokeSession({ sessionId: session.id });
      expect(rev2.revoked).toBe(false);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // Part 8: CLI Administration Contract & Strict Validation
  // =========================================================================

  it('57. CLI issue flow produces valid session JSON with plaintext token', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'cli_issue.db');
    try {
      const fixtures = setupFullGraph(db);
      const args = ['issue', '--db', dbPath, '--auth', fixtures.authorizationId, '--ttl', '600', '--json'];

      const originalStdoutWrite = process.stdout.write;
      let outputText = '';
      process.stdout.write = ((chunk: unknown) => {
        outputText += String(chunk);
        return true;
      }) as typeof process.stdout.write;

      try {
        const exitCode = runSessionAdmin(args);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(outputText);
        expect(parsed.status).toBe('ISSUED');
        expect(parsed.session.authorization_id).toBe(fixtures.authorizationId);
        expect(parsed.plaintext_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      } finally {
        process.stdout.write = originalStdoutWrite;
      }
    } finally {
      db.close();
    }
  });

  it('58. CLI revoke flow with --session is idempotent', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'cli_revoke.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const args = ['revoke', '--db', dbPath, '--session', session.id, '--json'];
      const exit1 = runSessionAdmin(args);
      expect(exit1).toBe(0);

      const exit2 = runSessionAdmin(args);
      expect(exit2).toBe(0);
    } finally {
      db.close();
    }
  });

  it('59. CLI parser rejects unknown flags', () => {
    expect(() => parseCliArgs(['issue', '--unknownFlag'])).toThrowError(/Unknown flag/);
  });

  it('60. CLI parser rejects duplicate flags', () => {
    expect(() => parseCliArgs(['issue', '--auth', 'a1', '--auth', 'a2'])).toThrowError(/Duplicate flag/);
  });

  it('61. CLI parser rejects missing flag values', () => {
    expect(() => parseCliArgs(['issue', '--auth'])).toThrowError(/Missing value/);
    expect(() => parseCliArgs(['issue', '--ttl'])).toThrowError(/Missing value/);
  });

  it('62. CLI revoke rejects providing both --session and --auth or neither', () => {
    expect(() => parseCliArgs(['revoke', '--session', 's1', '--auth', 'a1'])).toThrowError(/Revoke requires exactly one selector/);
    expect(() => parseCliArgs(['revoke'])).toThrowError(/Revoke requires exactly one selector/);
  });

  // =========================================================================
  // Part 9: Concurrency, Read-Only Boundary, and Cleanup
  // =========================================================================

  it('63. Real two-worker concurrent issuance race produces exactly one active row and one plaintext token', async () => {
    const { db: setupDb, dbPath } = createTestDatabase(tempDir, 'concurrency_race.db');
    let authorizationId = '';
    try {
      const fixtures1 = setupFullGraph(setupDb);
      authorizationId = fixtures1.authorizationId;
      setupDb.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      setupDb.close();
    }

    const runtimeDir = getOrMaterializeTestRuntime();

    const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Repository } = require(path.join(workerData.runtimeDir, 'core/database/repositories.js'));
const { McpSessionAuthorityService } = require(path.join(workerData.runtimeDir, 'core/services/McpSessionAuthorityService.js'));

let db;
try {
  db = new Database(workerData.dbPath);
  db.pragma('foreign_keys = ON');
  const repo = new Repository(db);
  const service = new McpSessionAuthorityService(repo, db);

  parentPort.on('message', (msg) => {
    if (msg === 'GO') {
      try {
        const result = service.issueSession({ authorizationId: workerData.authorizationId });
        db.close();
        parentPort.postMessage({ success: true, plaintextToken: result.plaintextToken });
      } catch (err) {
        db.close();
        parentPort.postMessage({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          category: err && typeof err === 'object' && 'category' in err ? err.category : null,
        });
      }
    }
  });
  parentPort.postMessage('READY');
} catch (initErr) {
  if (db && db.open) {
    db.close();
  }
  parentPort.postMessage({
    success: false,
    error: initErr instanceof Error ? initErr.message : String(initErr),
    category: 'INIT_ERROR',
  });
}
`;

    interface SameAuthWorkerSuccess {
      success: true;
      plaintextToken: string;
    }
    interface SameAuthWorkerFailure {
      success: false;
      error: string;
      category: string | null;
    }
    type SameAuthWorkerMessage = SameAuthWorkerSuccess | SameAuthWorkerFailure;

    const workerData = { dbPath, authorizationId, runtimeDir };
    const projectNodeModules = path.resolve(__dirname, '..', 'node_modules');
    const w1 = new Worker(workerCode, { eval: true, workerData, env: { ...process.env, NODE_PATH: projectNodeModules } });
    const w2 = new Worker(workerCode, { eval: true, workerData, env: { ...process.env, NODE_PATH: projectNodeModules } });

    const h1 = createWorkerHarness<SameAuthWorkerMessage>(w1);
    const h2 = createWorkerHarness<SameAuthWorkerMessage>(w2);

    try {
      // Assert both workers are ready before release
      await Promise.all([h1.readyPromise, h2.readyPromise]);

      // Release both workers simultaneously with GO
      w1.postMessage('GO');
      w2.postMessage('GO');

      const results = await Promise.all([h1.resultPromise, h2.resultPromise]);
      const successful = results.filter((r): r is SameAuthWorkerSuccess => r.success);
      const failed = results.filter((r): r is SameAuthWorkerFailure => !r.success);

      expect(successful).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(successful[0].plaintextToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(failed[0].category).toBe('MCP_AUTHORITY_FENCED');

      const verifyDb = new Database(dbPath, { readonly: true });
      try {
        const activeRows = verifyDb
          .prepare('SELECT COUNT(*) as c FROM mcp_client_sessions WHERE authorization_id = ? AND revoked_at IS NULL')
          .get(authorizationId) as { c: number };
        expect(activeRows.c).toBe(1);
      } finally {
        verifyDb.close();
      }
    } finally {
      await Promise.all([h1.cleanup(), h2.cleanup()]);
    }
  });

  it('64. Fences writable injected database: throws MCP_CONFIGURATION_INVALID if readonly is false or query_only is off', () => {
    const { db } = createTestDatabase(tempDir, 'writable_injection.db');
    try {
      // db is writable by default
      expect(() => {
        new McpAuthorityContext({ db });
      }).toThrowError(/MCP_CONFIGURATION_INVALID/);
    } finally {
      db.close();
    }
  });

  it('65. Zero-mutation proof: repeated production MCP tool and resource reads cause 0 durable changes, 0 mutation delta, and byte-identical database', async () => {
    const { db: setupDb, dbPath } = createTestDatabase(tempDir, 'zeromutation.db');
    let plaintextToken = '';
    try {
      const fixtures = setupFullGraph(setupDb);
      const res = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      plaintextToken = res.plaintextToken;
      setupDb.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      setupDb.close();
    }

    // 1. Snapshot database file byte-for-byte before reading context
    const beforeBytes = fs.readFileSync(dbPath);
    const beforeHash = crypto.createHash('sha256').update(beforeBytes).digest('hex');

    // 2. Snapshot table contents deterministically across all durable tables
    const checkDb = new Database(dbPath, { readonly: true });
    const tables = checkDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC").all() as { name: string }[];
    const initialTableSnapshots = new Map<string, string>();
    for (const t of tables) {
      const rows = checkDb.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid ASC`).all();
      initialTableSnapshots.set(t.name, JSON.stringify(rows));
    }
    checkDb.close();

    // 3. Set up production McpAuthorityContext and McpServer connected to MCP Client via InMemoryTransport
    const context = new McpAuthorityContext({ dbPath, sessionToken: plaintextToken });
    const server = buildAgentForgeMcpServer({ authorityContext: context });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-audit-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      // 4. Perform repeated authorized context reads via registered tool and registered resource
      const { db: contextDb } = context.getOrCreateDatabase();
      const initialTotalChanges = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;

      for (let i = 0; i < 3; i++) {
        const tcBeforeTool = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        const toolRes = await client.callTool({
          name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
          arguments: {},
        });
        const tcAfterTool = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        expect(tcAfterTool - tcBeforeTool).toBe(0);

        expect(toolRes.isError).toBeFalsy();
        expect(toolRes.content).toHaveLength(1);
        const toolText = (toolRes.content[0] as { type: 'text'; text: string }).text;
        const parsedTool = JSON.parse(toolText);
        expect(parsedTool.schema_version).toBe(2);

        const tcBeforeResource = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        const resourceRes = await client.readResource({
          uri: AUTHORIZED_CONTEXT_RESOURCE_URI,
        });
        const tcAfterResource = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        expect(tcAfterResource - tcBeforeResource).toBe(0);

        expect(resourceRes.contents).toHaveLength(1);
        const resText = (resourceRes.contents[0] as { text: string }).text;
        const parsedResource = JSON.parse(resText);
        expect(parsedResource.schema_version).toBe(2);
      }

      const finalTotalChanges = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
      expect(finalTotalChanges - initialTotalChanges).toBe(0);
    } finally {
      await client.close();
      await server.close();
      context.close();
    }

    // 5. Assert durable SQLite file is identical byte-for-byte
    const afterBytes = fs.readFileSync(dbPath);
    const afterHash = crypto.createHash('sha256').update(afterBytes).digest('hex');
    expect(afterHash).toBe(beforeHash);

    // 6. Assert no WAL or SHM artifacts were created
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);

    // 7. Assert all table contents remain byte-identical to initial snapshots
    const verifyDb = new Database(dbPath, { readonly: true });
    try {
      for (const t of tables) {
        const rows = verifyDb.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid ASC`).all();
        expect(JSON.stringify(rows)).toBe(initialTableSnapshots.get(t.name));
      }
      const totalChangesRow = verifyDb.prepare('SELECT total_changes() as tc').get() as { tc: number };
      expect(totalChangesRow.tc).toBe(0);
    } finally {
      verifyDb.close();
    }
  });

  it('66. Production read-only connection release on Windows: file can be renamed or deleted after close without lock contention', () => {
    const { db: setupDb, dbPath } = createTestDatabase(tempDir, 'winlock.db');
    let plaintextToken = '';
    try {
      const fixtures = setupFullGraph(setupDb);
      const res = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      plaintextToken = res.plaintextToken;
    } finally {
      setupDb.close();
    }

    const context = new McpAuthorityContext({ dbPath, sessionToken: plaintextToken });
    const ctx = context.resolveAuthorizedContext();
    expect(ctx.schema_version).toBe(2);

    // Close context and prove file lock is completely released
    context.close();

    const renamedPath = path.join(tempDir, 'winlock_renamed.db');
    fs.renameSync(dbPath, renamedPath);
    expect(fs.existsSync(renamedPath)).toBe(true);
    fs.unlinkSync(renamedPath);
    expect(fs.existsSync(renamedPath)).toBe(false);
  });

  it('67. Scrubbed diagnostics: seeded token, digest, and internal DB paths do not leak into stderr', async () => {
    const { db, dbPath: sensitiveDbPath } = createTestDatabase(tempDir, 'super_secret_corporate_path.db');
    const sensitiveToken = McpSessionAuthorityService.generateSessionToken();
    const sensitiveDigest = McpSessionAuthorityService.hashSessionToken(sensitiveToken);
    const sensitiveAuthId = 'auth-super-secret-12345';

    // 1. Setup real graph with sensitive auth ID in database
    const fixtures = setupFullGraph(db);
    try {
      db.prepare('UPDATE execution_authorizations SET id = ? WHERE id = ?').run(sensitiveAuthId, fixtures.authorizationId);

      // Seed real active session derived from sensitiveToken with sensitiveDigest and sensitiveAuthId
      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 3600 * 1000).toISOString();
      const validFp = 'b'.repeat(64);
      db.prepare(`
        INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at, revoked_at)
        VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?, NULL)
      `).run('session-secret-67', sensitiveAuthId, sensitiveDigest, validFp, nowIso, expiresIso);

      // Introduce downstream authority conflict (project status CANCELLED)
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('CANCELLED', fixtures.projectId);

      // Positive internal reachability assertion for sensitiveAuthId:
      // Issue session for sensitiveAuthId reaches downstream authority validation and fails closed with MCP_AUTHORITY_FENCED
      const probeRepo = new Repository(db);
      const probeService = new McpSessionAuthorityService(probeRepo, db);
      let internalIssueErr: unknown = null;
      try {
        probeService.issueSession({ authorizationId: sensitiveAuthId });
      } catch (err: unknown) {
        internalIssueErr = err;
      }
      expect(internalIssueErr).toBeInstanceOf(McpAuthorityError);
      const typedIssueErr = internalIssueErr as McpAuthorityError;
      expect(typedIssueErr.category).toBe('MCP_AUTHORITY_FENCED');
      expect(typedIssueErr.message).toBe('[MCP_AUTHORITY_FENCED] Project status "CANCELLED" is not active RUNNING');

      // Positive internal reachability assertion for sensitiveToken and sensitiveDigest:
      // Context resolution authenticates sensitiveToken, computes sensitiveDigest, matches DB session,
      // traverses downstream authority graph for sensitiveAuthId, and throws MCP_AUTHORITY_FENCED
      let internalContextErr: unknown = null;
      try {
        probeService.resolveAuthorizedContext(sensitiveToken);
      } catch (err: unknown) {
        internalContextErr = err;
      }
      expect(internalContextErr).toBeInstanceOf(McpAuthorityError);
      const typedContextErr = internalContextErr as McpAuthorityError;
      expect(typedContextErr.category).toBe('MCP_AUTHORITY_FENCED');
      expect(typedContextErr.message).toBe('[MCP_AUTHORITY_FENCED] Project status "CANCELLED" is not active RUNNING');

      // Positive internal reachability assertion for sensitiveDbPath:
      // Verify real file exists on filesystem and is opened as SQLite handle
      expect(fs.existsSync(sensitiveDbPath)).toBe(true);
    } finally {
      db.close();
    }

    // 2. Trigger real CLI issue error with opened database (reaches failing sink with sensitiveDbPath and sensitiveAuthId)
    let adminIssueStdout = '';
    let adminIssueStderr = '';
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;
    process.stdout.write = ((chunk: unknown) => { adminIssueStdout += String(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => { adminIssueStderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      const exit1 = runSessionAdmin(['issue', '--db', sensitiveDbPath, '--auth', sensitiveAuthId]);
      expect(exit1).toBe(1);
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }
    expect(adminIssueStdout).toBe('');
    expect(adminIssueStderr).toBe('ERROR: [MCP_AUTHORITY_FENCED] Authority verification failed\n');
    expect(adminIssueStdout).not.toContain(sensitiveDbPath);
    expect(adminIssueStdout).not.toContain(sensitiveAuthId);
    expect(adminIssueStderr).not.toContain(sensitiveDbPath);
    expect(adminIssueStderr).not.toContain(sensitiveAuthId);

    // 3. Trigger CLI revoke error with opened database
    let adminRevokeStdout = '';
    let adminRevokeStderr = '';
    process.stdout.write = ((chunk: unknown) => { adminRevokeStdout += String(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => { adminRevokeStderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      const exit2 = runSessionAdmin(['revoke', '--db', sensitiveDbPath, '--session', '   ']);
      expect(exit2).toBe(1);
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }
    expect(adminRevokeStdout).toBe('');
    expect(adminRevokeStderr).toBe('ERROR: [MCP_CONFIGURATION_INVALID] Flag cannot be whitespace-only\n');
    expect(adminRevokeStdout).not.toContain(sensitiveDbPath);
    expect(adminRevokeStderr).not.toContain(sensitiveDbPath);

    // 4. Trigger context error with seeded secret token (captures typed error and proves secret absence)
    const ctxToClose = new McpAuthorityContext({ dbPath: sensitiveDbPath, sessionToken: sensitiveToken });
    let publicCtxErr: unknown = null;
    try {
      ctxToClose.resolveAuthorizedContext();
    } catch (err: unknown) {
      publicCtxErr = err;
    } finally {
      ctxToClose.close();
    }
    expect(publicCtxErr).toBeInstanceOf(McpAuthorityError);
    const typedPublicCtxErr = publicCtxErr as McpAuthorityError;
    expect(typedPublicCtxErr.category).toBe('MCP_AUTHORITY_FENCED');
    expect(typedPublicCtxErr.message).toBe('[MCP_AUTHORITY_FENCED] Project status "CANCELLED" is not active RUNNING');
    expect(typedPublicCtxErr.message).not.toContain(sensitiveToken);
    expect(typedPublicCtxErr.message).not.toContain(sensitiveDigest);
    expect(typedPublicCtxErr.message).not.toContain(sensitiveDbPath);
    expect(typedPublicCtxErr.message).not.toContain(sensitiveAuthId);

    // 5. Test real MCP server tool and resource sinks with the failing context
    const toolContext = new McpAuthorityContext({ dbPath: sensitiveDbPath, sessionToken: sensitiveToken });
    const server = buildAgentForgeMcpServer({ authorityContext: toolContext });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-scrub-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      const toolResult = await client.callTool({
        name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
        arguments: {},
      });
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content).toHaveLength(1);
      const toolText = (toolResult.content[0] as { type: 'text'; text: string }).text;
      expect(toolText).toBe('[MCP_AUTHORITY_FENCED] Execution authority fenced');
      expect(toolText).not.toContain(sensitiveToken);
      expect(toolText).not.toContain(sensitiveDigest);
      expect(toolText).not.toContain(sensitiveDbPath);
      expect(toolText).not.toContain(sensitiveAuthId);

      let resourceErr: unknown = null;
      try {
        await client.readResource({ uri: AUTHORIZED_CONTEXT_RESOURCE_URI });
      } catch (err: unknown) {
        resourceErr = err;
      }
      expect(resourceErr).toBeInstanceOf(Error);
      const typedResourceErr = resourceErr as Error & { code?: number; data?: unknown };
      expect(typedResourceErr.message).toBe('[MCP_AUTHORITY_FENCED] Execution authority fenced');
      expect(typedResourceErr.code).toBe(-32603);
      expect(typedResourceErr.data).toBeUndefined();
      expect(typedResourceErr.message).not.toContain(sensitiveToken);
      expect(typedResourceErr.message).not.toContain(sensitiveDigest);
      expect(typedResourceErr.message).not.toContain(sensitiveDbPath);
      expect(typedResourceErr.message).not.toContain(sensitiveAuthId);
    } finally {
      await client.close();
      await server.close();
      toolContext.close();
    }
  });

  it('68. Stdio server clean shutdown removes signal listeners', async () => {
    const initialSigintCount = process.listenerCount('SIGINT');
    const handle = runStdioServer();
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(initialSigintCount);

    await handle.close();
    expect(process.listenerCount('SIGINT')).toBe(initialSigintCount);
  });

  // =========================================================================
  // Part 10: Expanded Authority, Protocol, Schema & CLI Hardening Truth Tests
  // =========================================================================

  it('69. Issuance rejects non-RUNNING project status returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'proj_status_fence.db');
    try {
      const fixtures = setupFullGraph(db);
      for (const badStatus of ['DRAFT', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED']) {
        db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(badStatus, fixtures.projectId);
        expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      }
    } finally {
      db.close();
    }
  });

  it('70. Issuance rejects terminal task state returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'task_state_fence.db');
    try {
      const fixtures = setupFullGraph(db);
      for (const badState of ['DONE', 'FAILED', 'CANCELLED']) {
        db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run(badState, fixtures.taskId);
        expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      }
    } finally {
      db.close();
    }
  });

  it('71. Issuance rejects task with missing, 0, or negative ownership_epoch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'task_epoch_fence.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE tasks SET ownership_epoch = 0 WHERE id = ?').run(fixtures.taskId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      db.prepare('UPDATE tasks SET ownership_epoch = -1 WHERE id = ?').run(fixtures.taskId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('72. Issuance rejects attempt with non-RUNNING status returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'attempt_status_fence.db');
    try {
      const fixtures = setupFullGraph(db);
      for (const badStatus of ['COMPLETED', 'FAILED', 'CANCELLED']) {
        db.prepare('UPDATE task_attempts SET status = ? WHERE id = ?').run(badStatus, fixtures.attemptId);
        expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      }
    } finally {
      db.close();
    }
  });

  it('73. Issuance rejects routing decision with contradictory aliases returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_aliases.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        project_id: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('74. Issuance rejects routing decision with unexpected additional authority fields returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_extra_fields.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
        unauthorizedAuthorityBypass: true,
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('75. Legacy PROVIDER_ROUTING_DECISION event type succeeds when adhering strictly to legacy canonical schema', () => {
    const { db } = createTestDatabase(tempDir, 'legacy_route.db');
    try {
      const fixtures = setupFullGraph(db);
      const legacyPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        candidateResourceIds: [fixtures.resourceId],
        selectedResourceId: fixtures.resourceId,
        selectedProviderId: fixtures.providerId,
        outcome: 'SELECTED',
        reason: 'Legacy route',
      };
      db.prepare("UPDATE events SET type = 'PROVIDER_ROUTING_DECISION', structured_payload_json = ? WHERE id = ?").run(
        JSON.stringify(legacyPayload),
        fixtures.routingDecisionId
      );
      const result = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(result.session.id).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('76. Issuance rejects manager message if protocol is not manager.v1 returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'msg_proto_bad.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE protocol_messages SET protocol = 'coder.v1' WHERE id = ?").run(fixtures.managerRecordId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('77. Issuance rejects manager message if status is not APPLIED returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'msg_status_bad.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE protocol_messages SET status = 'REJECTED' WHERE id = ?").run(fixtures.managerRecordId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('78. Issuance rejects manager message if recomputed raw_payload SHA-256 does not match stored payload_hash returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'msg_hash_bad.db');
    try {
      const fixtures = setupFullGraph(db);
      const tamperedRaw = fixtures.rawManagerPayload.replace('All tests pass', 'Tampered criteria');
      db.prepare('UPDATE protocol_messages SET raw_payload = ? WHERE id = ?').run(tamperedRaw, fixtures.managerRecordId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('79. Issuance rejects manager message if decision is not EXECUTE or FIX_REQUIRED returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'msg_decision_bad.db');
    try {
      const fixtures = setupFullGraph(db);
      const invalidDecisionPayload = JSON.parse(fixtures.rawManagerPayload);
      invalidDecisionPayload.decision = 'ABORT';
      const rawInvalid = JSON.stringify(invalidDecisionPayload);
      const hashInvalid = crypto.createHash('sha256').update(rawInvalid, 'utf8').digest('hex');
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(rawInvalid, hashInvalid, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(hashInvalid, fixtures.authorizationId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('80. Canonical identity: manager message lookup fails when stored with different protocol message_id if record id is not matched', () => {
    const { db } = createTestDatabase(tempDir, 'msg_canonical_id.db');
    try {
      const fixtures = setupFullGraph(db);
      expect(fixtures.managerRecordId).not.toEqual(fixtures.managerMessageId);
      expect(fixtures.auth.manager_message_id).toBe(fixtures.managerRecordId);

      // Verify that lookup by record ID succeeds, whereas lookup by protocol message_id fails when searching record IDs
      const byRecordId = fixtures.repo.getProtocolMessageByRecordId(fixtures.managerRecordId);
      expect(byRecordId).toBeDefined();

      const byProtocolIdAsRecord = fixtures.repo.getProtocolMessageByRecordId(fixtures.managerMessageId);
      expect(byProtocolIdAsRecord).toBeNull();

      // Proves that if an implementation erroneously looked up by protocol message_id using the authorization's manager_message_id, it returns null
      const erroneousLookup = fixtures.repo.getProtocolMessageById(fixtures.auth.manager_message_id!);
      expect(erroneousLookup).toBeNull();

      // Successful issuance confirms authoritative binding strictly on record id
      const result = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(result.session.id).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('81. Mutating manager payload JSON while leaving stored hash unchanged fences the next read returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'msg_mutate_read.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      const tampered = fixtures.rawManagerPayload.replace('All tests pass', 'Mutated criteria');
      db.prepare('UPDATE protocol_messages SET raw_payload = ? WHERE id = ?').run(tampered, fixtures.managerRecordId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('82. Context read validates token and fails before touching or opening database when token is missing or malformed', () => {
    const fakeDbPath = path.join(tempDir, 'nonexistent_should_never_open.db');
    expect(() => {
      const ctx = new McpAuthorityContext({ dbPath: fakeDbPath, sessionToken: '' });
      ctx.resolveAuthorizedContext();
    }).toThrowError(/MCP_SESSION_REQUIRED/);

    expect(() => {
      const ctx = new McpAuthorityContext({ dbPath: fakeDbPath, sessionToken: 'malformed_invalid_token!' });
      ctx.resolveAuthorizedContext();
    }).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
  });

  it('83. Context read fails closed with MCP_CONFIGURATION_INVALID if PRAGMA query_only readback is not 1', () => {
    const { db } = createTestDatabase(tempDir, 'pragma_queryonly.db');
    try {
      expect(() => {
        new McpAuthorityContext({ db });
      }).toThrowError(/MCP_CONFIGURATION_INVALID/);
    } finally {
      db.close();
    }
  });

  it('84. CLI help rejects combination with flags or positionals', () => {
    expect(() => parseCliArgs(['issue', '--help'])).toThrowError(/Help flag cannot be combined/);
    expect(() => parseCliArgs(['--help', 'revoke'])).toThrowError(/Help flag cannot be combined/);
    expect(() => parseCliArgs(['help', '--db', 'test.db'])).toThrowError(/Help flag cannot be combined/);
  });

  it('85. CLI issue rejects whitespace-only --auth, --db, or --ttl', () => {
    expect(() => parseCliArgs(['issue', '--db', '  ', '--auth', 'auth-1'])).toThrowError(/cannot be whitespace-only/);
    expect(() => parseCliArgs(['issue', '--db', 'test.db', '--auth', '   '])).toThrowError(/cannot be whitespace-only/);
    expect(() => parseCliArgs(['issue', '--db', 'test.db', '--auth', 'auth-1', '--ttl', '   '])).toThrowError(/cannot be whitespace-only/);
  });

  it('86. CLI revoke rejects --ttl flag with clear error', () => {
    expect(() => parseCliArgs(['revoke', '--db', 'test.db', '--session', 's1', '--ttl', '3600'])).toThrowError(/Flag --ttl is not valid for revoke command/);
  });

  it('87. CLI issue rejects --session flag with clear error', () => {
    expect(() => parseCliArgs(['issue', '--db', 'test.db', '--auth', 'a1', '--session', 's1'])).toThrowError(/Flag --session is not valid for issue command/);
  });

  it('88. Forced Database.close() failure in runSessionAdmin returns exit code 1, emits MCP_CLEANUP_FAILED, and prevents detail leakage', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'close_fail.db');
    const fixtures = setupFullGraph(db);
    db.close();

    let capturedStderr = '';
    const originalStderr = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const originalClose = Database.prototype.close;
    let closeAttempts = 0;
    const openedRef: { current: { open?: boolean; close: () => void } | null } = { current: null };
    try {
      Database.prototype.close = function (this: Database.Database) {
        openedRef.current = this;
        closeAttempts++;
        throw new Error('Forced native close error: secret_path_leak_fail');
      };

      const exitCode = runSessionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId]);
      expect(exitCode).toBe(1);
      expect(closeAttempts).toBeGreaterThan(0);
      expect(capturedStderr).toContain('[MCP_CLEANUP_FAILED]');
      expect(capturedStderr).not.toContain('secret_path_leak_fail');
      expect(capturedStderr).not.toContain('Forced native close error');
    } finally {
      Database.prototype.close = originalClose;
      if (openedRef.current && openedRef.current.open) {
        openedRef.current.close();
      }
      process.stderr.write = originalStderr;
    }
  });

  // =========================================================================
  // Part 10: Corrective Pass 3 Required Independent Evidence Tests (89 - 115)
  // =========================================================================

  it('89. Mutation fencing: SELECT total_changes() observable mutation delta triggers MCP_AUTHORITY_FENCED and guard runs even if service throws', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'mutation_fence.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(db);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    // Path A: Service succeeds, but total_changes detects a mutation delta (simulated via statement spy)
    const ctxSuccess = new McpAuthorityContext({ dbPath, sessionToken: token });
    const { db: openedDbSuccess } = ctxSuccess.getOrCreateDatabase();
    try {
      const origPrepare = openedDbSuccess.prepare.bind(openedDbSuccess);
      let totalChangesCallsSuccess = 0;
      openedDbSuccess.prepare = function (this: Database.Database, sql: string) {
        const stmt = origPrepare(sql);
        if (sql.includes('total_changes()')) {
          const origGet = stmt.get.bind(stmt);
          stmt.get = function (this: Database.Statement, ...args: unknown[]) {
            totalChangesCallsSuccess++;
            if (totalChangesCallsSuccess === 2) {
              return { total_changes: 1 };
            }
            return origGet(...args);
          } as typeof stmt.get;
        }
        return stmt;
      } as typeof openedDbSuccess.prepare;

      expect(() => ctxSuccess.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
      expect(totalChangesCallsSuccess).toBe(2);
    } finally {
      ctxSuccess.close();
    }

    // Path B: Service throws an error, but total_changes guard still runs and reads post-call count
    // Invalidate the session in database so service throws
    const alterDb = new Database(dbPath);
    try {
      alterDb.prepare('UPDATE mcp_client_sessions SET revoked_at = ?').run(new Date(Date.now() + 1000).toISOString());
    } finally {
      alterDb.close();
    }

    const ctxThrow = new McpAuthorityContext({ dbPath, sessionToken: token });
    const { db: openedDbThrow } = ctxThrow.getOrCreateDatabase();
    try {
      const origPrepare = openedDbThrow.prepare.bind(openedDbThrow);
      let totalChangesCallsThrow = 0;
      openedDbThrow.prepare = function (this: Database.Database, sql: string) {
        const stmt = origPrepare(sql);
        if (sql.includes('total_changes()')) {
          const origGet = stmt.get.bind(stmt);
          stmt.get = function (this: Database.Statement, ...args: unknown[]) {
            totalChangesCallsThrow++;
            return origGet(...args);
          } as typeof stmt.get;
        }
        return stmt;
      } as typeof openedDbThrow.prepare;

      expect(() => ctxThrow.resolveAuthorizedContext()).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
      // Confirms guard ran in finally/post-call block even when service threw
      expect(totalChangesCallsThrow).toBe(2);
    } finally {
      ctxThrow.close();
    }
  });

  it('90. Migration 21 index column mismatch: rejects each of the four required indexes recreated on a wrong column', () => {
    const { db } = createTestDatabase(tempDir, 'm21_wrong_col_indexes.db');
    try {
      // 1. idx_mcp_client_sessions_token_hash on wrong column (id instead of token_hash)
      db.exec('DROP INDEX idx_mcp_client_sessions_token_hash;');
      db.exec('CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(id);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
      db.exec('DROP INDEX idx_mcp_client_sessions_token_hash;');
      db.exec('CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(token_hash);');
      verifyMigration21SchemaAuthority(db);

      // 2. uq_mcp_client_sessions_active_auth on wrong column (id instead of authorization_id)
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(id) WHERE revoked_at IS NULL;');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;');
      verifyMigration21SchemaAuthority(db);

      // 3. idx_mcp_client_sessions_expires_at on wrong column (id instead of expires_at)
      db.exec('DROP INDEX idx_mcp_client_sessions_expires_at;');
      db.exec('CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(id);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
      db.exec('DROP INDEX idx_mcp_client_sessions_expires_at;');
      db.exec('CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(expires_at);');
      verifyMigration21SchemaAuthority(db);

      // 4. idx_mcp_client_sessions_auth_id on wrong column (id instead of authorization_id)
      db.exec('DROP INDEX idx_mcp_client_sessions_auth_id;');
      db.exec('CREATE INDEX idx_mcp_client_sessions_auth_id ON mcp_client_sessions(id);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
    } finally {
      db.close();
    }
  });

  it('91. Migration 21 active session index: rejects missing predicate, wrong predicate, non-unique, or unexpected custom index', () => {
    const { db } = createTestDatabase(tempDir, 'm21_index_predicates.db');
    try {
      // 1. Missing predicate (unconditional)
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();

      // 2. Inverted predicate
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NOT NULL;');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();

      // 3. Non-unique
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();

      // Restore canonical index
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;');
      verifyMigration21SchemaAuthority(db);

      // 4. Unexpected user-defined index
      db.exec('CREATE INDEX idx_unexpected_user_defined ON mcp_client_sessions(issued_at);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
    } finally {
      db.close();
    }
  });

  it('92. Ledger authority: rejects later version, earlier version, duplicate version, or missing row', () => {
    const { db } = createTestDatabase(tempDir, 'ledger_authority_checks.db');
    try {
      // 1. Later ledger version > 21
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (22, '022_future', datetime('now'))").run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
      db.prepare('DELETE FROM schema_migrations WHERE version = 22').run();
      verifyMigration21SchemaAuthority(db);

      // 2. Earlier ledger version max (e.g. max is 20)
      db.prepare('DELETE FROM schema_migrations WHERE version = 21').run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();

      // 3. Re-insert with wrong migration name
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (21, '021_wrong_name', datetime('now'))").run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();

      // 4. Re-insert with correct name
      db.prepare('DELETE FROM schema_migrations WHERE version = 21').run();
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (21, '021_r5j_mcp_client_session_authority', datetime('now'))").run();
      verifyMigration21SchemaAuthority(db);
    } finally {
      db.close();
    }
  });

  it('93. Schema authority: rejects extra columns, missing columns, wrong types, wrong nullability, and wrong primary key', () => {
    const { db } = createTestDatabase(tempDir, 'schema_auth_columns.db');
    try {
      // 1. Extra column
      db.exec('ALTER TABLE mcp_client_sessions ADD COLUMN rogue_extra_column TEXT;');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
    } finally {
      db.close();
    }

    // 2. Missing column
    const { db: db2 } = createTestDatabase(tempDir, 'schema_auth_missing_col.db');
    try {
      db2.exec('DROP TABLE mcp_client_sessions;');
      db2.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db2)).toThrow();
    } finally {
      db2.close();
    }

    // 3. Wrong column type
    const { db: db3 } = createTestDatabase(tempDir, 'schema_auth_wrong_type.db');
    try {
      db3.exec('DROP TABLE mcp_client_sessions;');
      db3.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          scope INTEGER NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db3)).toThrow();
    } finally {
      db3.close();
    }

    // 4. Wrong nullability
    const { db: db4 } = createTestDatabase(tempDir, 'schema_auth_wrong_nullability.db');
    try {
      db4.exec('DROP TABLE mcp_client_sessions;');
      db4.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT,
          scope TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db4)).toThrow();
    } finally {
      db4.close();
    }
  });

  it('94. Schema authority: rejects foreign key target mismatch, invalid action, or missing FK', () => {
    // 1. Missing FK
    const { db: db1 } = createTestDatabase(tempDir, 'schema_auth_missing_fk.db');
    try {
      db1.exec('DROP TABLE mcp_client_sessions;');
      db1.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          scope TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db1)).toThrow();
    } finally {
      db1.close();
    }

    // 2. FK referencing wrong table (tasks instead of execution_authorizations)
    const { db: db2 } = createTestDatabase(tempDir, 'schema_auth_wrong_fk_target.db');
    try {
      db2.exec('DROP TABLE mcp_client_sessions;');
      db2.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          scope TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (authorization_id) REFERENCES tasks(id)
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db2)).toThrow();
    } finally {
      db2.close();
    }

    // 3. FK with ON DELETE CASCADE instead of RESTRICT / NO ACTION
    const { db: db3 } = createTestDatabase(tempDir, 'schema_auth_fk_cascade.db');
    try {
      db3.exec('DROP TABLE mcp_client_sessions;');
      db3.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          scope TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (authorization_id) REFERENCES execution_authorizations(id) ON DELETE CASCADE
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db3)).toThrow();
    } finally {
      db3.close();
    }
  });

  it('95. Migration 21 CHECK constraint: scope domain enforcement', () => {
    const { db } = createTestDatabase(tempDir, 'chk_scope.db');
    try {
      const fixtures = setupFullGraph(db);
      const issuedAt = new Date(Date.now() - 10000).toISOString();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const validHash = 'a'.repeat(64);
      const validFp = 'b'.repeat(64);

      // Inserting an invalid scope throws SQLite constraint check error
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'INVALID_SCOPE', ?, ?, ?)
        `).run('sess-1', fixtures.authorizationId, validHash, validFp, issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);

      // Inserting canonical AUTHORIZED_CONTEXT_READ succeeds
      db.prepare(`
        INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
        VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
      `).run('sess-valid', fixtures.authorizationId, validHash, validFp, issuedAt, expiresAt);
    } finally {
      db.close();
    }
  });

  it('96. Migration 21 CHECK constraint: token_hash domain enforcement', () => {
    const { db } = createTestDatabase(tempDir, 'chk_token_hash.db');
    try {
      const fixtures = setupFullGraph(db);
      const issuedAt = new Date(Date.now() - 10000).toISOString();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const validFp = 'b'.repeat(64);

      // 63 chars (too short)
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-1', fixtures.authorizationId, 'a'.repeat(63), validFp, issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);

      // Uppercase hex
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-2', fixtures.authorizationId, 'A'.repeat(64), validFp, issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);

      // Non-hex
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-3', fixtures.authorizationId, 'g'.repeat(64), validFp, issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('97. Migration 21 CHECK constraint: authorization_fingerprint domain enforcement', () => {
    const { db } = createTestDatabase(tempDir, 'chk_fingerprint.db');
    try {
      const fixtures = setupFullGraph(db);
      const issuedAt = new Date(Date.now() - 10000).toISOString();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const validHash = 'a'.repeat(64);

      // 65 chars (too long)
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-1', fixtures.authorizationId, validHash, 'b'.repeat(65), issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);

      // Uppercase hex
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-2', fixtures.authorizationId, validHash, 'B'.repeat(64), issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('98. Migration 21 CHECK constraint: timestamp format domain enforcement', () => {
    const { db } = createTestDatabase(tempDir, 'chk_timestamps.db');
    try {
      const fixtures = setupFullGraph(db);
      const validHash = 'a'.repeat(64);
      const validFp = 'b'.repeat(64);
      const issuedAt = new Date(Date.now() - 10000).toISOString();
      const expiresAt = new Date(Date.now() + 60000).toISOString();

      // Invalid issued_at (empty string violates length(issued_at) > 0)
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, '', ?)
        `).run('sess-1', fixtures.authorizationId, validHash, validFp, expiresAt);
      }).toThrow(/CHECK constraint failed/);

      // Invalid expires_at (expires_at <= issued_at violates expires_at > issued_at)
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-2', fixtures.authorizationId, validHash, validFp, issuedAt, issuedAt);
      }).toThrow(/CHECK constraint failed/);

      // Invalid revoked_at (revoked_at < issued_at violates revoked_at >= issued_at)
      const earlier = new Date(Date.now() - 20000).toISOString();
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at, revoked_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?, ?)
        `).run('sess-3', fixtures.authorizationId, validHash, validFp, issuedAt, expiresAt, earlier);
      }).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('99. Protocol message tampering at issuance: tampered payload message_id rejected with 0 new session rows', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_payload_msg_id.db');
    try {
      const fixtures = setupFullGraph(db);
      const payload = JSON.parse(fixtures.rawManagerPayload);
      payload.message_id = 'different-proto-id';
      const raw = JSON.stringify(payload);
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(raw, hash, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(hash, fixtures.authorizationId);

      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM mcp_client_sessions').get() as { count: number };
      expect(sessionCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('100. Protocol message tampering at issuance: tampered row message_id rejected with 0 new session rows', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_row_msg_id.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE protocol_messages SET message_id = ? WHERE id = ?').run('tampered-row-message-id', fixtures.managerRecordId);

      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM mcp_client_sessions').get() as { count: number };
      expect(sessionCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('101. Protocol message tampering at issuance: row revision vs payload revision mismatch rejected with 0 new session rows', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_revision.db');
    try {
      const fixtures = setupFullGraph(db);
      const payload = JSON.parse(fixtures.rawManagerPayload);
      payload.expected_revision = 999;
      const raw = JSON.stringify(payload);
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(raw, hash, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(hash, fixtures.authorizationId);

      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM mcp_client_sessions').get() as { count: number };
      expect(sessionCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('102. Protocol message tampering at issuance: tampered protocol, project_id, or task_id rejected with 0 new session rows', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_row_bindings.db');
    try {
      const fixtures = setupFullGraph(db);

      // 1. Mutate protocol to another valid DB protocol that is not manager.v1
      db.prepare('UPDATE protocol_messages SET protocol = ? WHERE id = ?').run('coder.v1', fixtures.managerRecordId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);

      // Restore protocol
      db.prepare('UPDATE protocol_messages SET protocol = ? WHERE id = ?').run('manager.v1', fixtures.managerRecordId);

      // 2. Mutate task_id (using valid foreign key)
      const altTaskId = `task-alt-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const baseSha = 'b'.repeat(40);
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
        VALUES (?, ?, 'Task Alt', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
      `).run(altTaskId, fixtures.projectId, baseSha, now, now);
      db.prepare('UPDATE protocol_messages SET task_id = ? WHERE id = ?').run(altTaskId, fixtures.managerRecordId);

      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);

      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM mcp_client_sessions').get() as { count: number };
      expect(sessionCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('103. Protocol message tampering at issuance: tampered state or decision in payload rejected with 0 new session rows', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_decision_state.db');
    try {
      const fixtures = setupFullGraph(db);
      const payload = JSON.parse(fixtures.rawManagerPayload);
      payload.decision = 'REJECTED';
      const raw = JSON.stringify(payload);
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(raw, hash, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(hash, fixtures.authorizationId);

      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);

      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM mcp_client_sessions').get() as { count: number };
      expect(sessionCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('104. Post-issuance protocol message tampering: mutating protocol_messages row message_id post-issuance fences next read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'post_tamper_msg_id.db');
    let token = '';
    let msgRecId = '';
    try {
      const fixtures = setupFullGraph(db);
      msgRecId = fixtures.managerRecordId;
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    // Verify initial read succeeds
    const ctx1 = new McpAuthorityContext({ dbPath, sessionToken: token });
    expect(ctx1.resolveAuthorizedContext().schema_version).toBe(2);
    ctx1.close();

    // Tamper protocol_messages message_id in database
    const modDb = new Database(dbPath);
    modDb.prepare('UPDATE protocol_messages SET message_id = ? WHERE id = ?').run('post-mutated-id', msgRecId);
    modDb.close();

    // Verify next read is fenced
    const ctx2 = new McpAuthorityContext({ dbPath, sessionToken: token });
    try {
      expect(() => ctx2.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      ctx2.close();
    }
  });

  it('105. Post-issuance routing event tampering: mutating top-level project_id post-issuance fences next read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'post_tamper_event_proj.db');
    let token = '';
    let routeEventId = '';
    let altProjId = '';
    try {
      const fixtures = setupFullGraph(db);
      routeEventId = fixtures.routingDecisionId;
      altProjId = `proj-alt-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      fixtures.repo.createProject({
        id: altProjId,
        name: 'Alt Proj',
        description: 'Alt',
        repository_path: '/path/alt',
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
        started_at: now,
        completed_at: null,
      });
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    // Mutate event project_id post-issuance
    const modDb = new Database(dbPath);
    modDb.prepare('UPDATE events SET project_id = ? WHERE id = ?').run(altProjId, routeEventId);
    modDb.close();

    const ctx = new McpAuthorityContext({ dbPath, sessionToken: token });
    try {
      expect(() => ctx.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      ctx.close();
    }
  });

  it('106. Post-issuance routing payload tampering: mutating routing payload post-issuance fences next read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'post_tamper_route_payload.db');
    let token = '';
    let routeEventId = '';
    try {
      const fixtures = setupFullGraph(db);
      routeEventId = fixtures.routingDecisionId;
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    // Mutate structured_payload_json outcome to FAILED
    const modDb = new Database(dbPath);
    const row = modDb.prepare('SELECT structured_payload_json FROM events WHERE id = ?').get(routeEventId) as { structured_payload_json: string };
    const payload = JSON.parse(row.structured_payload_json);
    payload.outcome = 'FAILED';
    modDb.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(payload), routeEventId);
    modDb.close();

    const ctx = new McpAuthorityContext({ dbPath, sessionToken: token });
    try {
      expect(() => ctx.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      ctx.close();
    }
  });

  it('107. Bounded close retry policy: transient close failure succeeds within bound, persistent failure throws canonical error', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'bounded_close_retry.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(db);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    // 1. Transient close failure: fails twice with lock contention, then succeeds
    const ctx1 = new McpAuthorityContext({ dbPath, sessionToken: token });
    const { db: openedDb1 } = ctx1.getOrCreateDatabase();
    let attempts = 0;
    const origClose1 = openedDb1.close.bind(openedDb1);
    openedDb1.close = function () {
      attempts++;
      if (attempts < 3) {
        throw new Error('EBUSY: resource locked transiently');
      }
      return origClose1();
    };
    // ctx1.close() should retry and succeed cleanly without throwing
    expect(() => ctx1.close()).not.toThrow();
    expect(attempts).toBe(3);

    // 2. Persistent close failure: exhausts retry bound and throws canonical MCP_CLEANUP_FAILED
    const ctx2 = new McpAuthorityContext({ dbPath, sessionToken: token });
    const { db: openedDb2 } = ctx2.getOrCreateDatabase();
    const origClose2 = openedDb2.close.bind(openedDb2);
    openedDb2.close = function () {
      throw new Error('EPERM: persistent file lock');
    };

    expect(() => ctx2.close()).toThrowError(/MCP_CLEANUP_FAILED/);
    expect(openedDb2.open).toBe(true);

    // After restoring close behavior, a later context close succeeds
    openedDb2.close = origClose2;
    expect(() => ctx2.close()).not.toThrow();

    // Database can be renamed and deleted immediately on Windows
    const renamedPath = path.join(tempDir, 'bounded_close_retry_renamed.db');
    fs.renameSync(dbPath, renamedPath);
    expect(fs.existsSync(renamedPath)).toBe(true);
    fs.unlinkSync(renamedPath);
    expect(fs.existsSync(renamedPath)).toBe(false);
  });

  it('108. Stdio server handle.close() and listener cleanup handles context close cleanly', async () => {
    const handle = runStdioServer();
    expect(handle).toBeDefined();
    expect(typeof handle.close).toBe('function');
    await handle.close();
  });

  it('109. CLI closed grammar: invalid commands and malformed flags cause zero mutations and never echo inputs', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'closed_grammar.db');
    try {
      const fixtures = setupFullGraph(db);
      let capturedStderr = '';
      const origStderr = process.stderr.write;
      process.stderr.write = ((chunk: unknown) => { capturedStderr += String(chunk); return true; }) as typeof process.stderr.write;

      const maliciousPayload = "auth'; DROP TABLE mcp_client_sessions; --";
      try {
        const changesBefore = (db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        const sessionsBefore = (db.prepare('SELECT COUNT(*) as c FROM mcp_client_sessions').get() as { c: number }).c;

        const exit1 = runSessionAdmin(['unknown_command', '--db', dbPath]);
        expect(exit1).toBe(1);

        const exit2 = runSessionAdmin(['issue', '--db', dbPath, '--auth', maliciousPayload]);
        expect(exit2).toBe(1);

        // Verify stderr does not echo the SQL injection payload
        expect(capturedStderr).not.toContain('DROP TABLE');
        expect(capturedStderr).not.toContain(maliciousPayload);

        // Verify mcp_client_sessions table is still present and intact
        const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_sessions'").get();
        expect(tableCheck).toBeDefined();

        const changesAfter = (db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        const sessionsAfter = (db.prepare('SELECT COUNT(*) as c FROM mcp_client_sessions').get() as { c: number }).c;
        expect(changesAfter - changesBefore).toBe(0);
        expect(sessionsAfter - sessionsBefore).toBe(0);
      } finally {
        process.stderr.write = origStderr;
      }
    } finally {
      db.close();
    }
  });

  it('110. Comprehensive secret exclusion across public sinks: verifies admin, context, tool, resource, compiled stdio, and cleanup sinks', async () => {
    const { db, dbPath: sensitivePath } = createTestDatabase(tempDir, 'secret_classified_db.db');
    const sensitiveToken = McpSessionAuthorityService.generateSessionToken();
    const sensitiveDigest = McpSessionAuthorityService.hashSessionToken(sensitiveToken);
    const sensitiveAuth = 'auth-super-classified-id';
    const sensitiveCleanupSecret = 'SECRET_CLEANUP_FAILED_INTERNAL_MARKER_777';

    // 1. Setup real graph and prove positive internal reachability for retained sentinels
    const fixtures = setupFullGraph(db);
    try {
      db.prepare('UPDATE execution_authorizations SET id = ? WHERE id = ?').run(sensitiveAuth, fixtures.authorizationId);

      // Seed real active session derived from sensitiveToken with sensitiveDigest and sensitiveAuth
      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 3600 * 1000).toISOString();
      const validFp = 'b'.repeat(64);
      db.prepare(`
        INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at, revoked_at)
        VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?, NULL)
      `).run('session-secret-110', sensitiveAuth, sensitiveDigest, validFp, nowIso, expiresIso);

      // Downstream authority conflict: cancel project
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('CANCELLED', fixtures.projectId);

      // Positive internal reachability assertion for sensitiveAuth:
      const probeRepo = new Repository(db);
      const probeService = new McpSessionAuthorityService(probeRepo, db);
      let internalAuthErr: unknown = null;
      try {
        probeService.issueSession({ authorizationId: sensitiveAuth });
      } catch (err: unknown) {
        internalAuthErr = err;
      }
      expect(internalAuthErr).toBeInstanceOf(McpAuthorityError);
      const typedAuthErr = internalAuthErr as McpAuthorityError;
      expect(typedAuthErr.category).toBe('MCP_AUTHORITY_FENCED');
      expect(typedAuthErr.message).toBe('[MCP_AUTHORITY_FENCED] Project status "CANCELLED" is not active RUNNING');

      // Positive internal reachability assertion for sensitiveToken and sensitiveDigest:
      let internalTokenErr: unknown = null;
      try {
        probeService.resolveAuthorizedContext(sensitiveToken);
      } catch (err: unknown) {
        internalTokenErr = err;
      }
      expect(internalTokenErr).toBeInstanceOf(McpAuthorityError);
      const typedTokenErr = internalTokenErr as McpAuthorityError;
      expect(typedTokenErr.category).toBe('MCP_AUTHORITY_FENCED');
      expect(typedTokenErr.message).toBe('[MCP_AUTHORITY_FENCED] Project status "CANCELLED" is not active RUNNING');

      // Positive reachability assertion for sensitivePath:
      expect(fs.existsSync(sensitivePath)).toBe(true);
    } finally {
      db.close();
    }

    // 2. Admin issue sink: fails closed with MCP_AUTHORITY_FENCED, canonical stdout/stderr, excludes consumed secrets
    let adminStdout = '';
    let adminStderr = '';
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;
    process.stdout.write = ((chunk: unknown) => { adminStdout += String(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => { adminStderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      const exitIssueFencedAuth = runSessionAdmin(['issue', '--db', sensitivePath, '--auth', sensitiveAuth]);
      expect(exitIssueFencedAuth).toBe(1);
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }
    expect(adminStdout).toBe('');
    expect(adminStderr).toBe('ERROR: [MCP_AUTHORITY_FENCED] Authority verification failed\n');
    expect(adminStdout).not.toContain(sensitivePath);
    expect(adminStdout).not.toContain(sensitiveAuth);
    expect(adminStderr).not.toContain(sensitivePath);
    expect(adminStderr).not.toContain(sensitiveAuth);

    // 3. Context resolution sink: throws McpAuthorityError, captures error, excludes secrets from public error
    const ctx = new McpAuthorityContext({ dbPath: sensitivePath, sessionToken: sensitiveToken });
    let publicCtxErr: unknown = null;
    try {
      ctx.resolveAuthorizedContext();
    } catch (err: unknown) {
      publicCtxErr = err;
    } finally {
      ctx.close();
    }
    expect(publicCtxErr).toBeInstanceOf(McpAuthorityError);
    const typedPublicCtxErr = publicCtxErr as McpAuthorityError;
    expect(typedPublicCtxErr.category).toBe('MCP_AUTHORITY_FENCED');
    expect(typedPublicCtxErr.message).toBe('[MCP_AUTHORITY_FENCED] Project status "CANCELLED" is not active RUNNING');
    expect(typedPublicCtxErr.message).not.toContain(sensitiveToken);
    expect(typedPublicCtxErr.message).not.toContain(sensitiveDigest);
    expect(typedPublicCtxErr.message).not.toContain(sensitivePath);
    expect(typedPublicCtxErr.message).not.toContain(sensitiveAuth);

    // 4. MCP Server Tool and Resource sinks: execute via MCP protocol and assert sanitized errors
    const toolContext = new McpAuthorityContext({ dbPath: sensitivePath, sessionToken: sensitiveToken });
    const server = buildAgentForgeMcpServer({ authorityContext: toolContext });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-sink-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      const toolRes = await client.callTool({
        name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
        arguments: {},
      });
      expect(toolRes.isError).toBe(true);
      expect(toolRes.content).toHaveLength(1);
      const toolErrText = (toolRes.content[0] as { type: 'text'; text: string }).text;
      expect(toolErrText).toBe('[MCP_AUTHORITY_FENCED] Execution authority fenced');
      expect(toolErrText).not.toContain(sensitiveToken);
      expect(toolErrText).not.toContain(sensitiveDigest);
      expect(toolErrText).not.toContain(sensitivePath);
      expect(toolErrText).not.toContain(sensitiveAuth);

      let resourceErr: unknown = null;
      try {
        await client.readResource({ uri: AUTHORIZED_CONTEXT_RESOURCE_URI });
      } catch (err: unknown) {
        resourceErr = err;
      }
      expect(resourceErr).toBeInstanceOf(Error);
      const typedResourceErr = resourceErr as Error & { code?: number; data?: unknown };
      expect(typedResourceErr.message).toBe('[MCP_AUTHORITY_FENCED] Execution authority fenced');
      expect(typedResourceErr.code).toBe(-32603);
      expect(typedResourceErr.data).toBeUndefined();
      expect(typedResourceErr.message).not.toContain(sensitiveToken);
      expect(typedResourceErr.message).not.toContain(sensitiveDigest);
      expect(typedResourceErr.message).not.toContain(sensitivePath);
      expect(typedResourceErr.message).not.toContain(sensitiveAuth);
    } finally {
      await client.close();
      await server.close();
      toolContext.close();
    }

    // 5. Compiled stdio child transport sink: send real JSON-RPC tools/call and resources/read request over stdio
    const runtimeDir = getOrMaterializeTestRuntime();
    const stdioScript = path.resolve(runtimeDir, 'mcp', 'stdio.js');
    const stdioHarness = createStdioChildHarness(stdioScript, {
      AGENTFORGE_MCP_DB_PATH: sensitivePath,
      AGENTFORGE_MCP_SESSION_TOKEN: sensitiveToken,
    });

    try {
      await stdioHarness.sendRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-stdio-sink', version: '1.0.0' },
        },
      });
      await stdioHarness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });

      const stdioToolRes = await stdioHarness.sendRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: GET_AUTHORIZED_CONTEXT_TOOL_NAME, arguments: {} },
      });
      expect(stdioToolRes.result).toBeDefined();
      const stdioToolResult = stdioToolRes.result as { isError?: boolean; content?: Array<{ text: string }> };
      expect(stdioToolResult.isError).toBe(true);
      expect(stdioToolResult.content).toBeDefined();
      const stdioToolText = stdioToolResult.content?.[0]?.text;
      expect(stdioToolText).toBe('[MCP_AUTHORITY_FENCED] Execution authority fenced');
      expect(stdioToolText).not.toContain(sensitiveToken);
      expect(stdioToolText).not.toContain(sensitiveDigest);
      expect(stdioToolText).not.toContain(sensitivePath);
      expect(stdioToolText).not.toContain(sensitiveAuth);

      const stdioResourceRes = await stdioHarness.sendRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: AUTHORIZED_CONTEXT_RESOURCE_URI },
      });
      expect(stdioResourceRes.error).toBeDefined();
      const stdioResourceErr = stdioResourceRes.error as { code?: number; message?: string };
      expect(stdioResourceErr.code).toBe(-32603);
      expect(stdioResourceErr.message).toBe('[MCP_AUTHORITY_FENCED] Execution authority fenced');
      expect(stdioResourceErr.message).not.toContain(sensitiveToken);
      expect(stdioResourceErr.message).not.toContain(sensitiveDigest);
      expect(stdioResourceErr.message).not.toContain(sensitivePath);
      expect(stdioResourceErr.message).not.toContain(sensitiveAuth);

      stdioHarness.closeStdin();
      const stdioExit = await stdioHarness.waitForExit();
      expect(stdioExit.code).toBe(0);
      expect(stdioExit.signal).toBeNull();

      const stdioStdout = stdioHarness.getStdoutLines().join('\n');
      expect(stdioStdout).not.toContain(sensitiveToken);
      expect(stdioStdout).not.toContain(sensitiveDigest);
      expect(stdioStdout).not.toContain(sensitivePath);
      expect(stdioStdout).not.toContain(sensitiveAuth);

      const stdioStderr = stdioHarness.getStderr();
      expect(stdioStderr).toBe('');
      expect(stdioStderr).not.toContain(sensitiveToken);
      expect(stdioStderr).not.toContain(sensitiveDigest);
      expect(stdioStderr).not.toContain(sensitivePath);
      expect(stdioStderr).not.toContain(sensitiveAuth);
    } finally {
      await stdioHarness.close();
    }

    // 5.5. Admin revoke sink: revoke sensitiveAuth, verify exit code 0, canonical JSON output, empty stderr, exclude consumed secrets
    let revokeStdout = '';
    let revokeStderr = '';
    const origRevokeStdout = process.stdout.write;
    const origRevokeStderr = process.stderr.write;
    process.stdout.write = ((chunk: unknown) => { revokeStdout += String(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => { revokeStderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      const exitRevoke = runSessionAdmin(['revoke', '--db', sensitivePath, '--auth', sensitiveAuth, '--json']);
      expect(exitRevoke).toBe(0);
    } finally {
      process.stdout.write = origRevokeStdout;
      process.stderr.write = origRevokeStderr;
    }
    expect(revokeStderr).toBe('');
    const parsedRevoke = JSON.parse(revokeStdout.trim()) as { status: string; revoked: boolean };
    expect(parsedRevoke).toEqual({ status: 'REVOKED', revoked: true });
    expect(revokeStdout).not.toContain(sensitivePath);
    expect(revokeStdout).not.toContain(sensitiveAuth);
    expect(revokeStderr).not.toContain(sensitivePath);
    expect(revokeStderr).not.toContain(sensitiveAuth);

    // 6. Cleanup sink: exercise real production cleanup sink receiving a secret-bearing failure
    let cleanupStderr = '';
    const origCleanupStderr = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => { cleanupStderr += String(chunk); return true; }) as typeof process.stderr.write;

    const originalClose = Database.prototype.close;
    let closeCalledWithSecret = 0;
    const openedDbRef: { current: Database.Database | null } = { current: null };
    try {
      Database.prototype.close = function (this: Database.Database) {
        openedDbRef.current = this;
        closeCalledWithSecret++;
        throw new Error(`Internal sqlite native close error: ${sensitiveCleanupSecret}`);
      };

      const cleanupExitCode = runSessionAdmin(['issue', '--db', sensitivePath, '--auth', sensitiveAuth]);
      expect(cleanupExitCode).toBe(1);
      expect(closeCalledWithSecret).toBeGreaterThan(0);
      expect(cleanupStderr).toContain('ERROR: [MCP_CLEANUP_FAILED] Database cleanup failed\n');
      expect(cleanupStderr).not.toContain(sensitivePath);
      expect(cleanupStderr).not.toContain(sensitiveAuth);
      expect(cleanupStderr).not.toContain(sensitiveCleanupSecret);
    } finally {
      Database.prototype.close = originalClose;
      if (openedDbRef.current && openedDbRef.current.open) {
        originalClose.call(openedDbRef.current);
      }
      process.stderr.write = origCleanupStderr;
    }
  });

  it('111. Compiled stdio child process integration: starts with valid DB, responds to tools/resources, and shuts down cleanly via EOF with database lock release', async () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'compiled_stdio_eof.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(db);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    const runtimeDir = getOrMaterializeTestRuntime();
    const stdioScript = path.resolve(runtimeDir, 'mcp', 'stdio.js');
    expect(fs.existsSync(stdioScript)).toBe(true);

    const harness = createStdioChildHarness(stdioScript, {
      AGENTFORGE_MCP_DB_PATH: dbPath,
      AGENTFORGE_MCP_SESSION_TOKEN: token,
    });

    try {
      // 1. Send initialize
      const initRes = await harness.sendRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-stdio-client', version: '1.0.0' },
        },
      });
      expect((initRes.result as { serverInfo: { name: string } }).serverInfo.name).toBe('agentforge');

      await harness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });

      // 2. Call tool get_authorized_context
      const toolRes = await harness.sendRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
          arguments: {},
        },
      });
      expect(toolRes.result).toBeDefined();
      expect((toolRes.result as { isError?: boolean }).isError).toBeFalsy();
      const parsedToolContent = JSON.parse(((toolRes.result as { content: Array<{ text: string }> }).content[0]).text);
      expect(parsedToolContent.schema_version).toBe(2);

      // 3. Read resource agentforge://context/authorized
      const resourceRes = await harness.sendRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: {
          uri: AUTHORIZED_CONTEXT_RESOURCE_URI,
        },
      });
      expect((resourceRes.result as { contents: Array<{ text: string }> }).contents).toHaveLength(1);
      const parsedResContent = JSON.parse(((resourceRes.result as { contents: Array<{ text: string }> }).contents[0]).text);
      expect(parsedResContent.schema_version).toBe(2);

      // 4. Close stdin (EOF) and wait for child exit
      harness.closeStdin();
      const exitResult = await harness.waitForExit();
      expect(exitResult.code).toBe(0);
      expect(exitResult.signal).toBeNull();

      // 5. Verify stdout protocol purity: every line in stdout MUST be valid JSON-RPC
      const lines = harness.getStdoutLines();
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        const p = JSON.parse(line) as { jsonrpc: string };
        expect(p.jsonrpc).toBe('2.0');
      }

      // Exact canonical stderr assertion: clean EOF shutdown emits zero stderr
      expect(harness.getStderr()).toBe('');

      // 6. Verify database file lock is released: rename and delete immediately on Windows
      const renamed = path.join(tempDir, 'compiled_stdio_eof_renamed.db');
      fs.renameSync(dbPath, renamed);
      expect(fs.existsSync(renamed)).toBe(true);
      fs.unlinkSync(renamed);
      expect(fs.existsSync(renamed)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('112. Compiled stdio child process termination via signal exits cleanly with database lock release', async () => {
    const testSignalTermination = async (signal: 'SIGINT' | 'SIGTERM', dbName: string) => {
      const { db, dbPath } = createTestDatabase(tempDir, dbName);
      let token = '';
      try {
        const fixtures = setupFullGraph(db);
        token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
      } finally {
        db.close();
      }

      const runtimeDir = getOrMaterializeTestRuntime();
      const stdioScript = path.resolve(runtimeDir, 'mcp', 'stdio.js');
      const preloadScript = path.resolve(runtimeDir, 'signal_preload.js');

      const harness = createStdioChildHarness(
        stdioScript,
        {
          AGENTFORGE_MCP_DB_PATH: dbPath,
          AGENTFORGE_MCP_SESSION_TOKEN: token,
        },
        preloadScript
      );

      try {
        // 1. Initialize
        const initRes = await harness.sendRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-stdio-client', version: '1.0.0' },
          },
        });
        expect((initRes.result as { serverInfo: { name: string } }).serverInfo.name).toBe('agentforge');

        await harness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });

        // 2. Tool call get_authorized_context before signal
        const toolRes = await harness.sendRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: GET_AUTHORIZED_CONTEXT_TOOL_NAME, arguments: {} },
        });
        expect((toolRes.result as { isError?: boolean }).isError).toBeFalsy();

        // 3. Resource read agentforge://context/authorized before signal
        const resRes = await harness.sendRequest({
          jsonrpc: '2.0',
          id: 3,
          method: 'resources/read',
          params: { uri: AUTHORIZED_CONTEXT_RESOURCE_URI },
        });
        expect((resRes.result as { contents: Array<unknown> }).contents).toHaveLength(1);

        // 4. Send signal to child process
        harness.terminate(signal);

        // 5. Require handled termination: code === 0 and signal === null
        const exitResult = await harness.waitForExit();
        expect(exitResult.code).toBe(0);
        expect(exitResult.signal).toBeNull();

        // 6. Assert JSON-RPC only stdout
        const stdoutLines = harness.getStdoutLines();
        expect(stdoutLines.length).toBeGreaterThanOrEqual(3);
        for (const line of stdoutLines) {
          const parsed = JSON.parse(line) as { jsonrpc: string };
          expect(parsed.jsonrpc).toBe('2.0');
        }

        // 7. Assert canonical stderr: clean signal shutdown emits zero stderr
        expect(harness.getStderr()).toBe('');

        // 8. Assert database file lock released and can be renamed and deleted
        const renamed = path.join(tempDir, `${dbName}_renamed.db`);
        fs.renameSync(dbPath, renamed);
        expect(fs.existsSync(renamed)).toBe(true);
        fs.unlinkSync(renamed);
        expect(fs.existsSync(renamed)).toBe(false);
      } finally {
        await harness.close();
      }
    };

    await testSignalTermination('SIGINT', 'compiled_stdio_sigint.db');
    await testSignalTermination('SIGTERM', 'compiled_stdio_sigterm.db');
  });

  it('113. Concurrent issuance with distinct non-overlapping authorizations: both workers succeed with unique sessions', async () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'concurrent_distinct.db');
    let authId1 = '';
    let authId2 = '';
    try {
      const fixtures1 = setupFullGraph(db);
      authId1 = fixtures1.authorizationId;

      // Second auth in same db
      const repo = new Repository(db);
      const taskId2 = `task-2-${crypto.randomUUID()}`;
      const attemptId2 = `att-2-${crypto.randomUUID()}`;
      const assignmentId2 = `asgn-2-${crypto.randomUUID()}`;
      const routingDecisionId2 = `route-2-${crypto.randomUUID()}`;
      const managerMessageId2 = `mgr-proto-2-${crypto.randomUUID()}`;
      const managerRecordId2 = `mgr-rec-2-${crypto.randomUUID()}`;
      const authorizationId2 = `auth-2-${crypto.randomUUID()}`;
      const now = new Date().toISOString();

      // 1. Task 2
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
        VALUES (?, ?, 'Task 2', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
      `).run(taskId2, fixtures1.projectId, 'b'.repeat(40), now, now);

      // 2. Attempt 2
      repo.createTaskAttempt({
        id: attemptId2,
        task_id: taskId2,
        attempt_number: 1,
        status: 'RUNNING',
        agent_profile_id: fixtures1.agentId,
        agent_id: null,
        started_at: now,
        ended_at: null,
        summary: null,
      });

      // 3. Routing Decision 2
      const routingPayload2 = {
        decisionId: routingDecisionId2,
        projectId: fixtures1.projectId,
        taskId: taskId2,
        attemptId: attemptId2,
        roleProfileId: fixtures1.roleId,
        role: 'CODER',
        outcome: 'SELECTED',
        routePolicyId: null,
        failoverPolicyAuthoritySnapshot: null,
        selectedProviderId: fixtures1.providerId,
        selectedAccountId: fixtures1.accountId,
        selectedResourceId: fixtures1.resourceId,
        selectedAssignmentId: assignmentId2,
        requestedConstraints: [],
        appliedExclusions: [],
        appliedSeparation: null,
        reason: 'Optimal route',
      };
      db.prepare(`
        INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
        VALUES (?, ?, ?, 'ROLE_AWARE_ROUTING_DECISION', 'Optimal route', ?, ?)
      `).run(routingDecisionId2, fixtures1.projectId, taskId2, JSON.stringify(routingPayload2), now);

      // 4. Assignment 2
      repo.createAgentAssignment({
        id: assignmentId2,
        project_id: fixtures1.projectId,
        task_id: taskId2,
        attempt_id: attemptId2,
        role_profile_id: fixtures1.roleId,
        agent_profile_id: fixtures1.agentId,
        selected_provider_id: fixtures1.providerId,
        selected_account_id: fixtures1.accountId,
        selected_resource_id: fixtures1.resourceId,
        selected_worker_slot_id: null,
        routing_decision_id: routingDecisionId2,
        status: 'ASSIGNED',
        created_at: now,
        ended_at: null,
        preferred_metadata: null,
      });

      // 5. Protocol Message 2
      const instructions2 = ['Task: Task 2', 'Implement secondary context read'];
      const managerPayload2 = {
        protocol: 'manager.v1',
        message_id: managerMessageId2,
        project_id: fixtures1.projectId,
        task_id: taskId2,
        decision: 'EXECUTE',
        priority: 'LOW',
        risk: 'LOW',
        instructions: instructions2,
        acceptance_criteria: ['All tests pass'],
        constraints: ['No regressions'],
        review_issues: [],
        expected_task_state: 'CODING',
        expected_revision: 1,
        created_at: now,
      };
      const rawManagerPayload2 = JSON.stringify(managerPayload2);
      const managerPayloadHash2 = crypto.createHash('sha256').update(rawManagerPayload2, 'utf8').digest('hex');
      repo.recordProtocolMessage(
        managerRecordId2,
        managerMessageId2,
        'manager.v1',
        fixtures1.projectId,
        taskId2,
        'CODING',
        1,
        managerPayloadHash2,
        rawManagerPayload2,
        'APPLIED',
        undefined,
        now
      );

      // 6. Authorization 2
      const canonicalPayload2 = computeCanonicalPayload({
        projectId: fixtures1.projectId,
        taskId: taskId2,
        attemptId: attemptId2,
        taskTitle: 'Task 2',
        taskDescription: 'Test task description',
        acceptanceCriteria: ['All tests pass'],
        constraints: ['No regressions'],
        instructions: instructions2,
        contextFiles: ['src/mcp/McpServer.ts'],
        verificationCommands: {
          TEST: { executable: 'npm', args: ['test'] },
          LINT: null,
          BUILD: null,
        },
        managerMessageId: managerRecordId2,
        managerPayloadHash: managerPayloadHash2,
      });
      const canonicalPayloadJson2 = JSON.stringify(canonicalPayload2);
      const instructionPayloadHash2 = computePayloadHash(canonicalPayload2);
      const contextManifestHash2 = computeContextManifestHash(['src/mcp/McpServer.ts']);

      const auth2: ExecutionAuthorization = {
        id: authorizationId2,
        project_id: fixtures1.projectId,
        task_id: taskId2,
        task_revision: 1,
        base_sha: 'b'.repeat(40),
        repository_head_sha: 'c'.repeat(40),
        manager_message_id: managerRecordId2,
        manager_payload_hash: managerPayloadHash2,
        routing_decision_id: routingDecisionId2,
        selected_resource_id: fixtures1.resourceId,
        selected_provider_id: fixtures1.providerId,
        instruction_payload_hash: instructionPayloadHash2,
        context_manifest_hash: contextManifestHash2,
        canonical_instructions_json: canonicalPayloadJson2,
        context_files_json: JSON.stringify(['src/mcp/McpServer.ts']),
        canonical_payload_json: canonicalPayloadJson2,
        status: 'AUTHORIZED',
        created_at: now,
        dispatched_at: null,
        execution_id: null,
        task_ownership_epoch: 1,
        lifecycle_version: 1,
        selected_account_id: fixtures1.accountId,
        adapter_started_at: null,
        adapter_finished_at: null,
        adapter_error_json: null,
        settlement_status: null,
        settled_at: null,
        settlement_evidence_json: null,
        settlement_evidence_hash: null,
        assignment_id: assignmentId2,
        attempt_id: attemptId2,
      };
      repo.createExecutionAuthorization(auth2);
      authId2 = authorizationId2;
    } finally {
      db.close();
    }

    const runtimeDir = getOrMaterializeTestRuntime();

    const workerScript = `
      const { parentPort, workerData } = require('node:worker_threads');
      const path = require('node:path');
      const Database = require('better-sqlite3');
      const { Repository } = require(path.join(workerData.runtimeDir, 'core/database/repositories.js'));
      const { McpSessionAuthorityService } = require(path.join(workerData.runtimeDir, 'core/services/McpSessionAuthorityService.js'));

      let db;
      try {
        db = new Database(workerData.dbPath);
        db.pragma('foreign_keys = ON');
        const repo = new Repository(db);
        const service = new McpSessionAuthorityService(repo, db);

        parentPort.on('message', (msg) => {
          if (msg === 'GO') {
            try {
              const result = service.issueSession({ authorizationId: workerData.authId });
              db.close();
              parentPort.postMessage({ success: true, token: result.plaintextToken });
            } catch (err) {
              db.close();
              parentPort.postMessage({ success: false, error: err instanceof Error ? err.message : String(err) });
            }
          }
        });
        parentPort.postMessage('READY');
      } catch (initErr) {
        if (db && db.open) {
          db.close();
        }
        parentPort.postMessage({ success: false, error: initErr instanceof Error ? initErr.message : String(initErr) });
      }
    `;

    interface DistinctWorkerSuccess {
      success: true;
      token: string;
    }
    interface DistinctWorkerFailure {
      success: false;
      error: string;
    }
    type DistinctWorkerMessage = DistinctWorkerSuccess | DistinctWorkerFailure;

    const workerData1 = { dbPath, authId: authId1, runtimeDir };
    const workerData2 = { dbPath, authId: authId2, runtimeDir };
    const projectNodeModules = path.resolve(__dirname, '..', 'node_modules');
    const w1 = new Worker(workerScript, { eval: true, workerData: workerData1, env: { ...process.env, NODE_PATH: projectNodeModules } });
    const w2 = new Worker(workerScript, { eval: true, workerData: workerData2, env: { ...process.env, NODE_PATH: projectNodeModules } });

    const h1 = createWorkerHarness<DistinctWorkerMessage>(w1);
    const h2 = createWorkerHarness<DistinctWorkerMessage>(w2);

    try {
      await Promise.all([h1.readyPromise, h2.readyPromise]);

      w1.postMessage('GO');
      w2.postMessage('GO');

      const [r1, r2] = await Promise.all([h1.resultPromise, h2.resultPromise]);

      if (!r1.success) {
        throw new Error(`Worker 1 failed unexpectedly: ${r1.error}`);
      }
      if (!r2.success) {
        throw new Error(`Worker 2 failed unexpectedly: ${r2.error}`);
      }
      expect(r1.token).not.toBe(r2.token);

      const checkDb = new Database(dbPath, { readonly: true });
      try {
        const activeCount = checkDb.prepare('SELECT COUNT(*) as cnt FROM mcp_client_sessions WHERE revoked_at IS NULL').get() as { cnt: number };
        expect(activeCount.cnt).toBe(2);
      } finally {
        checkDb.close();
      }
    } finally {
      await Promise.all([h1.cleanup(), h2.cleanup()]);
    }
  });

  it('114. Multiple sequential tool & resource reads through InMemoryTransport return exact context without state leakage', async () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'multi_reads.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(db);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    const context = new McpAuthorityContext({ dbPath, sessionToken: token });
    const server = buildAgentForgeMcpServer({ authorityContext: context });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'seq-client', version: '1.0.0' });
    await client.connect(cTrans);

    try {
      for (let i = 0; i < 4; i++) {
        const toolRes = await client.callTool({
          name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
          arguments: {},
        });
        expect(toolRes.isError).toBeFalsy();
        const resText = (toolRes.content[0] as { text: string }).text;
        expect(JSON.parse(resText).schema_version).toBe(2);

        const resourceRes = await client.readResource({
          uri: AUTHORIZED_CONTEXT_RESOURCE_URI,
        });
        expect(resourceRes.contents).toHaveLength(1);
        expect(JSON.parse((resourceRes.contents[0] as { text: string }).text).schema_version).toBe(2);
      }
    } finally {
      await client.close();
      await server.close();
      context.close();
    }
  });

  it('115. Authority context read validates PRAGMA foreign_keys = ON and fails closed if OFF', () => {
    const { db: setupDb, dbPath } = createTestDatabase(tempDir, 'fk_off.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(setupDb);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      setupDb.close();
    }

    const readDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    readDb.pragma('query_only = ON');
    // Turn foreign keys OFF
    readDb.pragma('foreign_keys = OFF');

    try {
      expect(() => {
        new McpAuthorityContext({ db: readDb, sessionToken: token });
      }).toThrowError(/MCP_CONFIGURATION_INVALID/);
    } finally {
      readDb.close();
    }
  });

  it('116. Exact index set authority rejects autoindex origin-u, extra user indexes, and non-id or composite primary keys', () => {
    const { db } = createTestDatabase(tempDir, 'exact_index_set.db');
    try {
      // 1. Initially valid
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 2. Extra user index rejected
      db.exec('CREATE INDEX idx_extra_test ON mcp_client_sessions(authorization_id, expires_at);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
      db.exec('DROP INDEX idx_extra_test;');
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 3. Autoindex with origin = 'u' (e.g. from inline UNIQUE column) rejected
      db.exec('DROP TABLE mcp_client_sessions;');
      db.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope = 'AUTHORIZED_CONTEXT_READ'),
          token_hash TEXT NOT NULL UNIQUE CHECK (
            length(token_hash) = 64 AND
            token_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_fingerprint TEXT NOT NULL CHECK (
            length(authorization_fingerprint) = 64 AND
            authorization_fingerprint GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          issued_at TEXT NOT NULL CHECK (length(issued_at) > 0),
          expires_at TEXT NOT NULL CHECK (length(expires_at) > 0 AND expires_at > issued_at),
          revoked_at TEXT NULL CHECK (revoked_at IS NULL OR (length(revoked_at) > 0 AND revoked_at >= issued_at))
        );
        CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;
        CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(token_hash);
        CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(expires_at);
        CREATE INDEX idx_mcp_client_sessions_auth_id ON mcp_client_sessions(authorization_id);
      `);
      // Has origin-u autoindex from UNIQUE keyword, must throw MCP_SCHEMA_AUTHORITY_INVALID
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);

      // 4. Non-id or composite primary key rejected
      db.exec('DROP TABLE mcp_client_sessions;');
      db.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT NOT NULL,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope = 'AUTHORIZED_CONTEXT_READ'),
          token_hash TEXT NOT NULL CHECK (
            length(token_hash) = 64 AND
            token_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_fingerprint TEXT NOT NULL CHECK (
            length(authorization_fingerprint) = 64 AND
            authorization_fingerprint GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          issued_at TEXT NOT NULL CHECK (length(issued_at) > 0),
          expires_at TEXT NOT NULL CHECK (length(expires_at) > 0 AND expires_at > issued_at),
          revoked_at TEXT NULL CHECK (revoked_at IS NULL OR (length(revoked_at) > 0 AND revoked_at >= issued_at)),
          PRIMARY KEY (id, authorization_id)
        );
        CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;
        CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(token_hash);
        CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(expires_at);
        CREATE INDEX idx_mcp_client_sessions_auth_id ON mcp_client_sessions(authorization_id);
      `);
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
    } finally {
      db.close();
    }
  });

  it('117. Exact CHECK constraint set authority rejects extra or duplicate CHECK constraints', () => {
    const { db } = createTestDatabase(tempDir, 'exact_check_constraints.db');
    try {
      // 1. Extra seventh CHECK constraint
      db.exec('DROP TABLE mcp_client_sessions;');
      db.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope = 'AUTHORIZED_CONTEXT_READ'),
          token_hash TEXT NOT NULL CHECK (
            length(token_hash) = 64 AND
            token_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_fingerprint TEXT NOT NULL CHECK (
            length(authorization_fingerprint) = 64 AND
            authorization_fingerprint GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          issued_at TEXT NOT NULL CHECK (length(issued_at) > 0),
          expires_at TEXT NOT NULL CHECK (length(expires_at) > 0 AND expires_at > issued_at),
          revoked_at TEXT NULL CHECK (revoked_at IS NULL OR (length(revoked_at) > 0 AND revoked_at >= issued_at)),
          CHECK (length(id) > 0)
        );
        CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;
        CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(token_hash);
        CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(expires_at);
        CREATE INDEX idx_mcp_client_sessions_auth_id ON mcp_client_sessions(authorization_id);
      `);

      // Found length is 7 instead of 6, must throw MCP_SCHEMA_AUTHORITY_INVALID
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);

      // 2. Distinct malformed table containing a duplicate canonical CHECK while other canonical checks remain present
      db.exec('DROP TABLE mcp_client_sessions;');
      db.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope = 'AUTHORIZED_CONTEXT_READ'),
          token_hash TEXT NOT NULL CHECK (
            length(token_hash) = 64 AND
            token_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_fingerprint TEXT NOT NULL CHECK (
            length(authorization_fingerprint) = 64 AND
            authorization_fingerprint GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          issued_at TEXT NOT NULL CHECK (length(issued_at) > 0),
          expires_at TEXT NOT NULL CHECK (length(expires_at) > 0 AND expires_at > issued_at),
          revoked_at TEXT NULL CHECK (revoked_at IS NULL OR (length(revoked_at) > 0 AND revoked_at >= issued_at)),
          CHECK (scope = 'AUTHORIZED_CONTEXT_READ')
        );
        CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;
        CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(token_hash);
        CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(expires_at);
        CREATE INDEX idx_mcp_client_sessions_auth_id ON mcp_client_sessions(authorization_id);
      `);
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
    } finally {
      db.close();
    }
  });

  it('118. Contiguous ledger authority rejects gaps, duplicate versions, versions beyond 21, and earlier migration name mismatches', () => {
    const { db } = createTestDatabase(tempDir, 'ledger_authority.db');
    try {
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 1. Missing version in 1..20
      db.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (10, '010_r5h4_failover_lineage_budget_idempotency', datetime('now'))").run();
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 2. Extra version beyond 21
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (22, '022_extra', datetime('now'))").run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
      db.prepare('DELETE FROM schema_migrations WHERE version = 22').run();
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 3. Name mismatch on version 21
      db.prepare("UPDATE schema_migrations SET name = '021_wrong_name' WHERE version = 21").run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
      db.prepare("UPDATE schema_migrations SET name = '021_r5j_mcp_client_session_authority' WHERE version = 21").run();
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 4. Name mismatch on an earlier migration
      db.prepare("UPDATE schema_migrations SET name = '001_wrong' WHERE version = 1").run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
      db.prepare("UPDATE schema_migrations SET name = '001_initial_schema' WHERE version = 1").run();
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 5. Controlled malformed ledger rebuild with duplicate version rows
      db.exec(`
        CREATE TABLE schema_migrations_malformed (
          version INTEGER,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations_malformed SELECT version, name, applied_at FROM schema_migrations;
        INSERT INTO schema_migrations_malformed VALUES (10, '010_r5h4_failover_lineage_budget_idempotency', datetime('now'));
        DROP TABLE schema_migrations;
        ALTER TABLE schema_migrations_malformed RENAME TO schema_migrations;
      `);
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);

      // Restore canonical ledger
      db.exec(`
        CREATE TABLE schema_migrations_restored (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations_restored
        SELECT DISTINCT version, name, applied_at FROM schema_migrations;
        DROP TABLE schema_migrations;
        ALTER TABLE schema_migrations_restored RENAME TO schema_migrations;
      `);
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('119. Manager row/payload revision presence parity rejected at issuance with zero new session rows and after issuance on next context read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'revision_presence_parity.db');
    try {
      const fixtures = setupFullGraph(db);

      // 1. Tamper manager payload to remove expected_revision while row has revision = 1
      const payloadWithoutRev = JSON.parse(fixtures.rawManagerPayload);
      delete payloadWithoutRev.expected_revision;
      const rawWithoutRev = JSON.stringify(payloadWithoutRev);
      const hashWithoutRev = crypto.createHash('sha256').update(rawWithoutRev, 'utf8').digest('hex');

      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(
        rawWithoutRev,
        hashWithoutRev,
        fixtures.managerRecordId
      );
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(
        hashWithoutRev,
        fixtures.authorizationId
      );

      // Must reject at issuance with zero new session rows
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      const sessionCount = (db.prepare('SELECT COUNT(*) as c FROM mcp_client_sessions').get() as { c: number }).c;
      expect(sessionCount).toBe(0);

      // Restore payload and issue session
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(
        fixtures.rawManagerPayload,
        fixtures.auth.manager_payload_hash,
        fixtures.managerRecordId
      );
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(
        fixtures.auth.manager_payload_hash,
        fixtures.authorizationId
      );

      const issued = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(issued.plaintextToken).toBeDefined();

      // Read succeeds initially
      const ctx1 = new McpAuthorityContext({ dbPath, sessionToken: issued.plaintextToken });
      expect(ctx1.resolveAuthorizedContext().schema_version).toBe(2);
      ctx1.close();

      // Mutate post-issuance: row revision is set to NULL while payload has expected_revision = 1
      db.prepare('UPDATE protocol_messages SET expected_revision = NULL WHERE id = ?').run(fixtures.managerRecordId);

      // Next context read is fenced
      const ctx2 = new McpAuthorityContext({ dbPath, sessionToken: issued.plaintextToken });
      try {
        expect(() => ctx2.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
      } finally {
        ctx2.close();
      }
    } finally {
      db.close();
    }
  });

  it('120. Manager row/payload expected_task_state presence parity rejected at issuance with zero new session rows and after issuance on next context read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'state_presence_parity.db');
    try {
      const fixtures = setupFullGraph(db);

      // 1. Tamper manager payload to remove expected_task_state while row has expected_task_state = 'CODING'
      const payloadWithoutState = JSON.parse(fixtures.rawManagerPayload);
      delete payloadWithoutState.expected_task_state;
      const rawWithoutState = JSON.stringify(payloadWithoutState);
      const hashWithoutState = crypto.createHash('sha256').update(rawWithoutState, 'utf8').digest('hex');

      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(
        rawWithoutState,
        hashWithoutState,
        fixtures.managerRecordId
      );
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(
        hashWithoutState,
        fixtures.authorizationId
      );

      // Must reject at issuance with zero new session rows
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      const sessionCount = (db.prepare('SELECT COUNT(*) as c FROM mcp_client_sessions').get() as { c: number }).c;
      expect(sessionCount).toBe(0);

      // Restore payload and issue session
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(
        fixtures.rawManagerPayload,
        fixtures.auth.manager_payload_hash,
        fixtures.managerRecordId
      );
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(
        fixtures.auth.manager_payload_hash,
        fixtures.authorizationId
      );

      const issued = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(issued.plaintextToken).toBeDefined();

      // Read succeeds initially
      const ctx1 = new McpAuthorityContext({ dbPath, sessionToken: issued.plaintextToken });
      expect(ctx1.resolveAuthorizedContext().schema_version).toBe(2);
      ctx1.close();

      // Mutate post-issuance: row expected_task_state is set to NULL while payload has expected_task_state = 'CODING'
      db.prepare('UPDATE protocol_messages SET expected_task_state = NULL WHERE id = ?').run(fixtures.managerRecordId);

      // Next context read is fenced
      const ctx2 = new McpAuthorityContext({ dbPath, sessionToken: issued.plaintextToken });
      try {
        expect(() => ctx2.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
      } finally {
        ctx2.close();
      }
    } finally {
      db.close();
    }
  });

  it('121. Historical unauthorized mutation flag remains permanently true across multiple reads and prevents re-entry', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'permanent_mutation_flag.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(db);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    const ctx = new McpAuthorityContext({ dbPath, sessionToken: token });
    const { db: openedDb } = ctx.getOrCreateDatabase();
    try {
      expect(ctx.hasDetectedUnauthorizedMutation()).toBe(false);

      // Simulate mutation delta on first resolve call
      const origPrepare = openedDb.prepare.bind(openedDb);
      let totalChangesCalls = 0;
      openedDb.prepare = function (this: Database.Database, sql: string) {
        const stmt = origPrepare(sql);
        if (sql.includes('total_changes()')) {
          const origGet = stmt.get.bind(stmt);
          stmt.get = function (this: Database.Statement, ...args: unknown[]) {
            totalChangesCalls++;
            if (totalChangesCalls === 2) {
              return { total_changes: 1 };
            }
            return origGet(...args);
          } as typeof stmt.get;
        }
        return stmt;
      } as typeof openedDb.prepare;

      expect(() => ctx.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
      // Historical flag is now permanently true
      expect(ctx.hasDetectedUnauthorizedMutation()).toBe(true);

      // Subsequent resolveAuthorizedContext calls immediately fail closed
      expect(() => ctx.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
      expect(ctx.hasDetectedUnauthorizedMutation()).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it('122. Stdio child harness: rejects immediately on malformed non-JSON stdout protocol contamination within local timeout budget', async () => {
    const tempScript = path.join(tempDir, `contam_script_${crypto.randomUUID().slice(0, 8)}.js`);
    fs.writeFileSync(
      tempScript,
      `
      console.log('NOT_VALID_JSON_PROTOCOL_CONTAMINATION');
      setInterval(() => {}, 1000);
      `,
      'utf8'
    );

    const harness = createStdioChildHarness(tempScript, {});
    const startTime = Date.now();
    try {
      await expect(
        harness.sendRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, 4000)
      ).rejects.toThrow(/Protocol contamination/);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await harness.close();
      if (fs.existsSync(tempScript)) fs.unlinkSync(tempScript);
    }
  });

  it('123. Stdio child harness: rejects request and exit wait on module-load failure / missing script within local budget', async () => {
    const missingScript = path.join(tempDir, `missing_script_${crypto.randomUUID().slice(0, 8)}.js`);
    const harness = createStdioChildHarness(missingScript, {});
    const startTime = Date.now();
    try {
      const exitResult = await harness.waitForExit(4000);
      expect(exitResult.code).not.toBe(0);
      await expect(
        harness.sendRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, 4000)
      ).rejects.toThrow();
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await harness.close();
    }
  });

  it('124. Stdio child harness: rejects pending request immediately on premature child exit before response within local budget', async () => {
    const exitScript = path.join(tempDir, `premature_exit_${crypto.randomUUID().slice(0, 8)}.js`);
    fs.writeFileSync(
      exitScript,
      `
      process.stdin.once('data', () => {
        process.exit(42);
      });
      `,
      'utf8'
    );

    const harness = createStdioChildHarness(exitScript, {});
    const startTime = Date.now();
    try {
      await expect(
        harness.sendRequest({ jsonrpc: '2.0', id: 99, method: 'call' }, 4000)
      ).rejects.toThrow(/Child exited prematurely with code 42/);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await harness.close();
      if (fs.existsSync(exitScript)) fs.unlinkSync(exitScript);
    }
  });

  it('125. Worker harness: settles both readiness and result promises on readiness timeout within local budget', async () => {
    const workerScript = `
      // Never emits READY
      setInterval(() => {}, 1000);
    `;
    const w = new Worker(workerScript, { eval: true });
    const localTimeout = 300;
    const harness = createWorkerHarness<{ success: boolean }>(w, localTimeout);
    const startTime = Date.now();
    try {
      const [readyOutcome, resultOutcome] = await Promise.allSettled([
        harness.readyPromise,
        harness.resultPromise,
      ]);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);
      expect(readyOutcome.status).toBe('rejected');
      expect(resultOutcome.status).toBe('rejected');
      expect((readyOutcome as PromiseRejectedResult).reason.message).toContain(`timed out waiting for READY after ${localTimeout}ms`);
      expect((resultOutcome as PromiseRejectedResult).reason.message).toContain(`timed out waiting for READY after ${localTimeout}ms`);
    } finally {
      await harness.cleanup();
    }
  });

  it('126. Worker harness: settles both readiness and result promises on result timeout within local budget', async () => {
    const workerScript = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage('READY');
      // Receives GO but never responds
      parentPort.on('message', () => {});
    `;
    const w = new Worker(workerScript, { eval: true });
    const localTimeout = 300;
    const harness = createWorkerHarness<{ success: boolean }>(w, localTimeout);
    const startTime = Date.now();
    try {
      await harness.readyPromise;
      w.postMessage('GO');
      const resultOutcome = await Promise.allSettled([harness.resultPromise]);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);
      expect(resultOutcome[0].status).toBe('rejected');
      expect((resultOutcome[0] as PromiseRejectedResult).reason.message).toContain(`timed out waiting for result after ${localTimeout}ms`);
    } finally {
      await harness.cleanup();
    }
  });

  it('127. Worker harness: rejects both promises immediately on order violation (result arrived before READY)', async () => {
    const workerScript = `
      const { parentPort } = require('node:worker_threads');
      // Emits result BEFORE emitting READY
      parentPort.postMessage({ success: true, token: 'violation-token' });
    `;
    const w = new Worker(workerScript, { eval: true });
    const harness = createWorkerHarness<{ success: boolean }>(w, 4000);
    const startTime = Date.now();
    try {
      const [readyOutcome, resultOutcome] = await Promise.allSettled([
        harness.readyPromise,
        harness.resultPromise,
      ]);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(3000);
      expect(readyOutcome.status).toBe('rejected');
      expect(resultOutcome.status).toBe('rejected');
      expect((readyOutcome as PromiseRejectedResult).reason.message).toContain('Worker order violation: received result before READY');
      expect((resultOutcome as PromiseRejectedResult).reason.message).toContain('Worker order violation: received result before READY');
    } finally {
      await harness.cleanup();
    }
  });

  it('128. Stdio child harness: close() surfaces exit wait failure visibly, remains sticky on concurrent and repeated calls, detaches listeners at most once, and restores baseline', async () => {
    let killInvocationCount = 0;

    class MockChildProcessFailedClose extends EventEmitter {
      public stdin = new PassThrough();
      public stdout = new PassThrough();
      public stderr = new PassThrough();
      public exitCode: number | null = null;
      public signalCode: NodeJS.Signals | null = null;
      public pid = 99999;
      public kill(): boolean {
        killInvocationCount++;
        return true;
      }
    }

    const mockChild = new MockChildProcessFailedClose();
    const baselineListeners = {
      childError: mockChild.listenerCount('error'),
      childExit: mockChild.listenerCount('exit'),
      stdoutData: mockChild.stdout.listenerCount('data'),
      stderrData: mockChild.stderr.listenerCount('data'),
      stdinError: mockChild.stdin.listenerCount('error'),
    };

    const customSpawn = () => mockChild as unknown as ChildProcess;
    const harness = createStdioChildHarness('dummy.js', {}, undefined, { customSpawn });

    // Verify listeners attached
    expect(mockChild.listenerCount('error')).toBe(baselineListeners.childError + 1);
    expect(mockChild.listenerCount('exit')).toBe(baselineListeners.childExit + 1);
    expect(mockChild.stdout.listenerCount('data')).toBe(baselineListeners.stdoutData + 1);
    expect(mockChild.stderr.listenerCount('data')).toBe(baselineListeners.stderrData + 1);
    expect(mockChild.stdin.listenerCount('error')).toBe(baselineListeners.stdinError + 1);

    // Override waitForExit to deterministically fail with canonical cleanup failure
    const cleanupError = new Error('[EXPECTED_CLEANUP_FAILURE] Timed out waiting for child exit');
    harness.waitForExit = () => Promise.reject(cleanupError);

    // 1. Concurrent close calls: both reject with the exact same diagnostic
    const [res1, res2] = await Promise.allSettled([harness.close(), harness.close()]);
    expect(res1.status).toBe('rejected');
    expect(res2.status).toBe('rejected');
    expect((res1 as PromiseRejectedResult).reason.message).toContain('[EXPECTED_CLEANUP_FAILURE] Timed out waiting for child exit');
    expect((res2 as PromiseRejectedResult).reason.message).toContain('[EXPECTED_CLEANUP_FAILURE] Timed out waiting for child exit');

    // 2. Subsequent repeated close call: must NOT resolve or hide error, must reject with the exact same diagnostic
    await expect(harness.close()).rejects.toThrow(/\[EXPECTED_CLEANUP_FAILURE\] Timed out waiting for child exit/);

    // 3. Kill and finalization occurred at most once
    expect(killInvocationCount).toBe(1);

    // 4. Exact listener-baseline restoration after failed close
    expect(mockChild.listenerCount('error')).toBe(baselineListeners.childError);
    expect(mockChild.listenerCount('exit')).toBe(baselineListeners.childExit);
    expect(mockChild.stdout.listenerCount('data')).toBe(baselineListeners.stdoutData);
    expect(mockChild.stderr.listenerCount('data')).toBe(baselineListeners.stderrData);
    expect(mockChild.stdin.listenerCount('error')).toBe(baselineListeners.stdinError);

    // 5. Repeated close preserves baseline listener counts
    await expect(harness.close()).rejects.toThrow(/\[EXPECTED_CLEANUP_FAILURE\] Timed out waiting for child exit/);
    expect(mockChild.listenerCount('error')).toBe(baselineListeners.childError);
    expect(mockChild.listenerCount('exit')).toBe(baselineListeners.childExit);
    expect(mockChild.stdout.listenerCount('data')).toBe(baselineListeners.stdoutData);
    expect(mockChild.stderr.listenerCount('data')).toBe(baselineListeners.stderrData);
    expect(mockChild.stdin.listenerCount('error')).toBe(baselineListeners.stdinError);
  });

  it('129. Stdio child harness: deterministic spawn error rejects waiting and future requests and exit waits immediately', async () => {
    class MockChildProcess extends EventEmitter {
      public stdin = new PassThrough();
      public stdout = new PassThrough();
      public stderr = new PassThrough();
      public exitCode: number | null = null;
      public signalCode: NodeJS.Signals | null = null;
      public pid = 12345;
      public kill(): boolean {
        return true;
      }
    }

    // 1. Prior request and prior waitForExit reject immediately on emitted spawn error
    const mockChild1 = new MockChildProcess();
    const baselineListeners1 = {
      childError: mockChild1.listenerCount('error'),
      childExit: mockChild1.listenerCount('exit'),
      stdoutData: mockChild1.stdout.listenerCount('data'),
      stderrData: mockChild1.stderr.listenerCount('data'),
      stdinError: mockChild1.stdin.listenerCount('error'),
    };

    const customSpawn1 = () => mockChild1 as unknown as ChildProcess;
    const harness1 = createStdioChildHarness('dummy.js', {}, undefined, { customSpawn: customSpawn1 });

    expect(mockChild1.listenerCount('error')).toBe(baselineListeners1.childError + 1);
    expect(mockChild1.listenerCount('exit')).toBe(baselineListeners1.childExit + 1);
    expect(mockChild1.stdout.listenerCount('data')).toBe(baselineListeners1.stdoutData + 1);
    expect(mockChild1.stderr.listenerCount('data')).toBe(baselineListeners1.stderrData + 1);
    expect(mockChild1.stdin.listenerCount('error')).toBe(baselineListeners1.stdinError + 1);

    const waitingRequestPromise = harness1.sendRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, 4000);
    const priorExitPromise = harness1.waitForExit(4000);

    const testSpawnError = new Error('spawn ENOENT: injected test spawn error');
    mockChild1.emit('error', testSpawnError);

    await expect(waitingRequestPromise).rejects.toThrow(/injected test spawn error/);
    await expect(priorExitPromise).rejects.toThrow(/injected test spawn error/);

    // 2. Later request and future waitForExit reject immediately from recorded spawn error
    await expect(
      harness1.sendRequest({ jsonrpc: '2.0', id: 2, method: 'ping' }, 4000)
    ).rejects.toThrow(/Cannot send request: child failed to spawn/);

    await expect(
      harness1.waitForExit(4000)
    ).rejects.toThrow(/Child failed to spawn/);

    // 3. Cleanup is visible, completes cleanly, and restores baseline listener counts exactly
    await expect(harness1.close()).resolves.toBeUndefined();

    expect(mockChild1.listenerCount('error')).toBe(baselineListeners1.childError);
    expect(mockChild1.listenerCount('exit')).toBe(baselineListeners1.childExit);
    expect(mockChild1.stdout.listenerCount('data')).toBe(baselineListeners1.stdoutData);
    expect(mockChild1.stderr.listenerCount('data')).toBe(baselineListeners1.stderrData);
    expect(mockChild1.stdin.listenerCount('error')).toBe(baselineListeners1.stdinError);

    // 4. Repeated close is idempotent, resolves without double-dispose, and preserves baseline listener counts
    await expect(harness1.close()).resolves.toBeUndefined();

    expect(mockChild1.listenerCount('error')).toBe(baselineListeners1.childError);
    expect(mockChild1.listenerCount('exit')).toBe(baselineListeners1.childExit);
    expect(mockChild1.stdout.listenerCount('data')).toBe(baselineListeners1.stdoutData);
    expect(mockChild1.stderr.listenerCount('data')).toBe(baselineListeners1.stderrData);
    expect(mockChild1.stdin.listenerCount('error')).toBe(baselineListeners1.stdinError);
  });

  it('130. Stdio child harness: notification and request write failure reject promptly without unhandled stream errors', async () => {
    const hangScript = path.join(tempDir, `hang_notif_${crypto.randomUUID().slice(0, 8)}.js`);
    fs.writeFileSync(
      hangScript,
      `
      setInterval(() => {}, 1000);
      `,
      'utf8'
    );
    const harness = createStdioChildHarness(hangScript, {});
    const startTime = Date.now();
    try {
      // Close / destroy child stdin
      harness.closeStdin();

      // Notification write to closed/destroyed stdin must reject promptly
      await expect(
        harness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' })
      ).rejects.toThrow(/closed or destroyed/);

      // Request write to closed/destroyed stdin must also reject promptly
      await expect(
        harness.sendRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, 4000)
      ).rejects.toThrow(/closed or destroyed/);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);
    } finally {
      await harness.close();
      if (fs.existsSync(hangScript)) fs.unlinkSync(hangScript);
    }
  });

  it('131. Worker harness: cleanup() before READY settles both readiness and result promises with typed diagnostic', async () => {
    const workerScript = `
      // Never emits READY
      setInterval(() => {}, 1000);
    `;
    const w = new Worker(workerScript, { eval: true });
    const harness = createWorkerHarness<{ success: boolean }>(w, 4000);
    const startTime = Date.now();
    try {
      const [readyOutcome, resultOutcome, cleanupOutcome] = await Promise.allSettled([
        harness.readyPromise,
        harness.resultPromise,
        harness.cleanup(),
      ]);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);
      expect(cleanupOutcome.status).toBe('fulfilled');
      expect(readyOutcome.status).toBe('rejected');
      expect(resultOutcome.status).toBe('rejected');
      expect((readyOutcome as PromiseRejectedResult).reason.message).toContain('[WORKER_CLEANUP_CANCELLED]');
      expect((resultOutcome as PromiseRejectedResult).reason.message).toContain('[WORKER_CLEANUP_CANCELLED]');

      // Idempotent cleanup call
      await expect(harness.cleanup()).resolves.toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it('132. Worker harness: cleanup() after READY but before result settles result promise with typed diagnostic', async () => {
    const workerScript = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage('READY');
      // Keeps running without emitting result
      setInterval(() => {}, 1000);
    `;
    const w = new Worker(workerScript, { eval: true });
    const harness = createWorkerHarness<{ success: boolean }>(w, 4000);
    const startTime = Date.now();
    try {
      await harness.readyPromise;

      const [resultOutcome, cleanupOutcome] = await Promise.allSettled([
        harness.resultPromise,
        harness.cleanup(),
      ]);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);
      expect(cleanupOutcome.status).toBe('fulfilled');
      expect(resultOutcome.status).toBe('rejected');
      expect((resultOutcome as PromiseRejectedResult).reason.message).toContain('[WORKER_CLEANUP_CANCELLED]');
    } finally {
      await harness.cleanup();
    }
  });

  it('133. Worker harness: cleanup() propagates worker termination failure visibly and settles exposed promises', async () => {
    const workerScript = `
      setInterval(() => {}, 1000);
    `;
    const w = new Worker(workerScript, { eval: true });
    const harness = createWorkerHarness<{ success: boolean }>(w, 4000);
    const startTime = Date.now();
    try {
      w.terminate = () => Promise.reject(new Error('[INJECTED_TERMINATION_FAILURE] Worker failed to terminate'));

      const [readyOutcome, resultOutcome, cleanupOutcome] = await Promise.allSettled([
        harness.readyPromise,
        harness.resultPromise,
        harness.cleanup(),
      ]);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);
      expect(cleanupOutcome.status).toBe('rejected');
      expect((cleanupOutcome as PromiseRejectedResult).reason.message).toContain('[INJECTED_TERMINATION_FAILURE]');
      expect(readyOutcome.status).toBe('rejected');
      expect((readyOutcome as PromiseRejectedResult).reason.message).toContain('[WORKER_CLEANUP_CANCELLED]');
      expect(resultOutcome.status).toBe('rejected');
      expect((resultOutcome as PromiseRejectedResult).reason.message).toContain('[WORKER_CLEANUP_CANCELLED]');
    } finally {
      w.terminate = Worker.prototype.terminate;
      await w.terminate();
    }
  });

  it('134. Stdio child harness: future child stdin stream error actively settles pending request and notification writes with deterministic diagnostic', async () => {
    class WithheldCallbackStdin extends PassThrough {
      public withheldCallbacks: Array<(err?: Error | null) => void> = [];
      override write(
        chunk: unknown,
        encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
        cb?: (error: Error | null | undefined) => void
      ): boolean {
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        if (typeof callback === 'function') {
          this.withheldCallbacks.push(callback);
        }
        // Deliberately withhold calling write callback to simulate pending write
        return true;
      }
    }

    class MockChildProcessWithheldStdin extends EventEmitter {
      public stdin = new WithheldCallbackStdin();
      public stdout = new PassThrough();
      public stderr = new PassThrough();
      public exitCode: number | null = null;
      public signalCode: NodeJS.Signals | null = null;
      public pid = 54321;
      public kill(): boolean {
        this.exitCode = 0;
        this.emit('exit', 0, null);
        return true;
      }
    }

    const mockChild = new MockChildProcessWithheldStdin();
    const customSpawn = () => mockChild as unknown as ChildProcess;
    const harness = createStdioChildHarness('dummy.js', {}, undefined, { customSpawn });

    const startTime = Date.now();
    try {
      // 1. Dispatch request and notification whose write callbacks are withheld
      const pendingRequestPromise = harness.sendRequest({ jsonrpc: '2.0', id: 42, method: 'tools/call' }, 4000);
      const pendingNotificationPromise = harness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }, 4000);

      expect(mockChild.stdin.withheldCallbacks.length).toBe(2);

      // 2. Emit real stdin stream error
      const testStdinErr = new Error('EPIPE: write EPIPE injected stream error');
      mockChild.stdin.emit('error', testStdinErr);

      // 3. Both pending request and notification must actively reject promptly within local budget
      await expect(pendingRequestPromise).rejects.toThrow(
        /Child stdin stream error while waiting for response 42: EPIPE: write EPIPE injected stream error/
      );
      await expect(pendingNotificationPromise).rejects.toThrow(
        /Child stdin stream error while sending notification: EPIPE: write EPIPE injected stream error/
      );

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);

      // 4. Future requests and notifications reject immediately from recorded childStdinError
      await expect(
        harness.sendRequest({ jsonrpc: '2.0', id: 43, method: 'ping' }, 4000)
      ).rejects.toThrow(/Cannot send request: child stdin error: EPIPE: write EPIPE injected stream error/);

      await expect(
        harness.sendNotification({ jsonrpc: '2.0', method: 'ping' }, 4000)
      ).rejects.toThrow(/Cannot send notification: child stdin error: EPIPE: write EPIPE injected stream error/);
    } finally {
      await harness.close();
    }
  });

  it('135. Stdio child harness: harness finalizer detaches all harness-owned stream and child listeners after close with exact baseline restoration and idempotent repeat close', async () => {
    class MockChildProcessNormal extends EventEmitter {
      public stdin = new PassThrough();
      public stdout = new PassThrough();
      public stderr = new PassThrough();
      public exitCode: number | null = null;
      public signalCode: NodeJS.Signals | null = null;
      public pid = 67890;
      public kill(signal?: NodeJS.Signals | number): boolean {
        this.exitCode = 0;
        this.signalCode = (signal as NodeJS.Signals) ?? null;
        this.emit('exit', 0, this.signalCode);
        return true;
      }
    }

    const mockChild = new MockChildProcessNormal();
    const baselineListeners = {
      childError: mockChild.listenerCount('error'),
      childExit: mockChild.listenerCount('exit'),
      stdoutData: mockChild.stdout.listenerCount('data'),
      stderrData: mockChild.stderr.listenerCount('data'),
      stdinError: mockChild.stdin.listenerCount('error'),
    };

    const customSpawn = () => mockChild as unknown as ChildProcess;
    const harness = createStdioChildHarness('dummy.js', {}, undefined, { customSpawn });

    // Verify listeners attached
    expect(mockChild.listenerCount('error')).toBe(baselineListeners.childError + 1);
    expect(mockChild.listenerCount('exit')).toBe(baselineListeners.childExit + 1);
    expect(mockChild.stdout.listenerCount('data')).toBe(baselineListeners.stdoutData + 1);
    expect(mockChild.stderr.listenerCount('data')).toBe(baselineListeners.stderrData + 1);
    expect(mockChild.stdin.listenerCount('error')).toBe(baselineListeners.stdinError + 1);

    // Perform successful request/response roundtrip
    const reqPromise = harness.sendRequest({ jsonrpc: '2.0', id: 100, method: 'ping' });
    mockChild.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 100, result: 'pong' }) + '\n');
    const res = await reqPromise;
    expect(res.result).toBe('pong');

    // Close harness and verify exact baseline listener count restoration
    await harness.close();

    expect(mockChild.listenerCount('error')).toBe(baselineListeners.childError);
    expect(mockChild.listenerCount('exit')).toBe(baselineListeners.childExit);
    expect(mockChild.stdout.listenerCount('data')).toBe(baselineListeners.stdoutData);
    expect(mockChild.stderr.listenerCount('data')).toBe(baselineListeners.stderrData);
    expect(mockChild.stdin.listenerCount('error')).toBe(baselineListeners.stdinError);

    // Repeated close must be idempotent and preserve exact baseline restoration
    await expect(harness.close()).resolves.toBeUndefined();

    expect(mockChild.listenerCount('error')).toBe(baselineListeners.childError);
    expect(mockChild.listenerCount('exit')).toBe(baselineListeners.childExit);
    expect(mockChild.stdout.listenerCount('data')).toBe(baselineListeners.stdoutData);
    expect(mockChild.stderr.listenerCount('data')).toBe(baselineListeners.stderrData);
    expect(mockChild.stdin.listenerCount('error')).toBe(baselineListeners.stdinError);
  });

  it('136. Stdio child harness: future stdout protocol contamination actively settles pending notification writes and preserves once-only settlement', async () => {
    class WithheldNotificationStdin extends PassThrough {
      public withheldCallbacks: Array<(err?: Error | null) => void> = [];
      override write(
        chunk: unknown,
        encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
        cb?: (error: Error | null | undefined) => void
      ): boolean {
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        if (typeof callback === 'function') {
          this.withheldCallbacks.push(callback);
        }
        // Deliberately withhold calling write callback to simulate pending async write
        return true;
      }
    }

    class MockChildProcessContam extends EventEmitter {
      public stdin = new WithheldNotificationStdin();
      public stdout = new PassThrough();
      public stderr = new PassThrough();
      public exitCode: number | null = null;
      public signalCode: NodeJS.Signals | null = null;
      public pid = 77777;
      public kill(signal?: NodeJS.Signals | number): boolean {
        this.exitCode = 0;
        this.signalCode = (signal as NodeJS.Signals) ?? null;
        this.emit('exit', 0, this.signalCode);
        return true;
      }
    }

    const mockChild = new MockChildProcessContam();
    const baselineListeners = {
      childError: mockChild.listenerCount('error'),
      childExit: mockChild.listenerCount('exit'),
      stdoutData: mockChild.stdout.listenerCount('data'),
      stderrData: mockChild.stderr.listenerCount('data'),
      stdinError: mockChild.stdin.listenerCount('error'),
    };

    const customSpawn = () => mockChild as unknown as ChildProcess;
    const harness = createStdioChildHarness('dummy.js', {}, undefined, { customSpawn });

    const startTime = Date.now();
    try {
      // 1. Dispatch notification whose write callback is withheld
      const notifPromise = harness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }, 4000);
      expect(mockChild.stdin.withheldCallbacks.length).toBe(1);

      // 2. Emit malformed stdout protocol contamination
      mockChild.stdout.write('NON_JSON_PROTOCOL_CONTAMINATION_PAYLOAD\n');

      // 3. Pending notification must reject promptly with exact protocol contamination diagnostic
      await expect(notifPromise).rejects.toThrow(
        /Protocol contamination: non-JSON stdout line emitted by child: "NON_JSON_PROTOCOL_CONTAMINATION_PAYLOAD"/
      );
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);

      // 4. Late invocation of the saved write callback must NOT alter the settled rejection (once-only settlement)
      const savedCb = mockChild.stdin.withheldCallbacks[0];
      expect(() => savedCb(null)).not.toThrow();
      expect(() => savedCb(new Error('late write error'))).not.toThrow();

      // 5. Future notification rejects immediately from recorded protocol contamination state
      await expect(
        harness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }, 4000)
      ).rejects.toThrow(/Protocol contamination/);

      // 6. Close restores harness-owned listener counts exactly to baseline
      await harness.close();

      expect(mockChild.listenerCount('error')).toBe(baselineListeners.childError);
      expect(mockChild.listenerCount('exit')).toBe(baselineListeners.childExit);
      expect(mockChild.stdout.listenerCount('data')).toBe(baselineListeners.stdoutData);
      expect(mockChild.stderr.listenerCount('data')).toBe(baselineListeners.stderrData);
      expect(mockChild.stdin.listenerCount('error')).toBe(baselineListeners.stdinError);

      // 7. Repeated close preserves identical baseline restoration
      await expect(harness.close()).resolves.toBeUndefined();

      expect(mockChild.listenerCount('error')).toBe(baselineListeners.childError);
      expect(mockChild.listenerCount('exit')).toBe(baselineListeners.childExit);
      expect(mockChild.stdout.listenerCount('data')).toBe(baselineListeners.stdoutData);
      expect(mockChild.stderr.listenerCount('data')).toBe(baselineListeners.stderrData);
      expect(mockChild.stdin.listenerCount('error')).toBe(baselineListeners.stdinError);
    } finally {
      await harness.close();
    }
  });
});
