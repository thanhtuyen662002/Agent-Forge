import fs from 'fs';
import path from 'path';
import os from 'os';

export type SupportedClient = 'antigravity' | 'cursor' | 'claude';

export const SUPPORTED_CLIENTS: readonly SupportedClient[] = [
  'antigravity',
  'cursor',
  'claude',
] as const;

export const OPERATOR_SESSION_TOKEN_PLACEHOLDER = '<OPERATOR_SESSION_TOKEN_REQUIRED>';

export interface AgentForgeMcpServerConfig {
  command: string;
  args: [string];
  env: {
    ELECTRON_RUN_AS_NODE?: string;
    AGENTFORGE_MCP_DB_PATH: string;
    AGENTFORGE_MCP_SESSION_TOKEN: string;
  };
}

export interface ClientConfigTemplate {
  mcpServers: {
    agentforge: AgentForgeMcpServerConfig;
  };
}

export interface ClientConfigEnvelope {
  status: 'TEMPLATE_GENERATED';
  client: SupportedClient;
  incomplete: true;
  secret_delivery: 'MANUAL_OPERATOR_INPUT';
  config: ClientConfigTemplate;
}

export interface GenerateClientConfigOptions {
  client: string;
  dbPath?: string;
  executablePath?: string;
  stdioScriptPath?: string;
}

/**
 * Normalizes and validates the client name according to the closed domain:
 * antigravity | cursor | claude.
 * Client names are case-insensitive on input and returned in canonical lowercase.
 */
export function normalizeClient(client: string): SupportedClient {
  if (typeof client !== 'string') {
    throw new Error('Client parameter must be a string');
  }
  const trimmed = client.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('Client name cannot be empty');
  }
  if (SUPPORTED_CLIENTS.includes(trimmed as SupportedClient)) {
    return trimmed as SupportedClient;
  }
  throw new Error(`Unsupported client '${trimmed}'. Supported clients: ${SUPPORTED_CLIENTS.join(', ')}`);
}

/**
 * Determines whether an executable is an Electron binary (e.g. AgentForge.exe or electron.exe)
 * requiring ELECTRON_RUN_AS_NODE=1 to execute the stdio MCP script as a Node child.
 */
export function isElectronExecutable(execPath: string): boolean {
  if (!execPath || typeof execPath !== 'string') {
    return false;
  }
  const base = path.basename(execPath).toLowerCase();
  return /^(agentforge|electron)(\.exe)?$/i.test(base);
}

/**
 * Derives the platform production database default path without opening or checking existence.
 */
export function getDefaultPlatformDbPath(): string {
  const dataDirEnv = process.env.AGENT_FORGE_DATA_DIR;
  if (dataDirEnv && dataDirEnv.trim().length > 0) {
    return path.resolve(dataDirEnv.trim(), 'database', 'agent-forge.db');
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.resolve(appData, 'AgentForge', 'database', 'agent-forge.db');
  }

  if (process.platform === 'darwin') {
    return path.resolve(os.homedir(), 'Library', 'Application Support', 'AgentForge', 'database', 'agent-forge.db');
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.resolve(configHome, 'AgentForge', 'database', 'agent-forge.db');
}

/**
 * Derives and validates the runtime executable and sibling stdio.js script paths.
 * Both paths must be absolute and exist on the filesystem.
 */
export function deriveRuntimePaths(options?: {
  executablePath?: string;
  stdioScriptPath?: string;
}): {
  executable: string;
  stdioScript: string;
  isElectron: boolean;
} {
  const candidateExe = options?.executablePath ?? process.execPath;
  if (!candidateExe || typeof candidateExe !== 'string' || candidateExe.trim().length === 0) {
    throw new Error('Executable path cannot be empty');
  }
  if (!path.isAbsolute(candidateExe)) {
    throw new Error('Executable path must be absolute');
  }
  const resolvedExe = path.resolve(candidateExe);
  if (!fs.existsSync(resolvedExe)) {
    throw new Error('Executable file does not exist');
  }

  const candidateStdio =
    options?.stdioScriptPath ??
    process.env.AGENTFORGE_MCP_STDIO_PATH ??
    path.join(path.dirname(__filename), 'stdio.js');
  if (!candidateStdio || typeof candidateStdio !== 'string' || candidateStdio.trim().length === 0) {
    throw new Error('Stdio script path cannot be empty');
  }
  if (!path.isAbsolute(candidateStdio)) {
    throw new Error('Stdio script path must be absolute');
  }
  const resolvedStdio = path.resolve(candidateStdio);
  if (!fs.existsSync(resolvedStdio)) {
    throw new Error('Stdio script file does not exist');
  }

  const isElectron = isElectronExecutable(resolvedExe);

  return {
    executable: resolvedExe,
    stdioScript: resolvedStdio,
    isElectron,
  };
}

/**
 * Generates the deterministic client configuration object for AgentForge MCP.
 */
export function generateClientConfig(options: GenerateClientConfigOptions): ClientConfigTemplate {
  // 1. Validate client name
  normalizeClient(options.client);

  // 2. Validate and resolve database path
  let resolvedDbPath: string;
  if (options.dbPath !== undefined) {
    if (typeof options.dbPath !== 'string' || options.dbPath.trim().length === 0) {
      throw new Error('Database path cannot be empty');
    }
    if (!path.isAbsolute(options.dbPath)) {
      throw new Error('Database path must be an absolute path');
    }
    resolvedDbPath = path.resolve(options.dbPath);
  } else {
    resolvedDbPath = getDefaultPlatformDbPath();
  }

  // 3. Derive and validate runtime paths
  const { executable, stdioScript, isElectron } = deriveRuntimePaths({
    executablePath: options.executablePath,
    stdioScriptPath: options.stdioScriptPath,
  });

  const env: AgentForgeMcpServerConfig['env'] = {
    ...(isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    AGENTFORGE_MCP_DB_PATH: resolvedDbPath,
    AGENTFORGE_MCP_SESSION_TOKEN: OPERATOR_SESSION_TOKEN_PLACEHOLDER,
  };

  return {
    mcpServers: {
      agentforge: {
        command: executable,
        args: [stdioScript],
        env,
      },
    },
  };
}

/**
 * Generates the deterministic JSON envelope for configure-client output.
 */
export function generateClientConfigEnvelope(
  options: GenerateClientConfigOptions
): ClientConfigEnvelope {
  const canonicalClient = normalizeClient(options.client);
  const config = generateClientConfig(options);

  return {
    status: 'TEMPLATE_GENERATED',
    client: canonicalClient,
    incomplete: true,
    secret_delivery: 'MANUAL_OPERATOR_INPUT',
    config,
  };
}
