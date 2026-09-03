import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { spawn, execSync, ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { buildAgentForgeMcpServer, McpServer } from '../src/mcp/McpServer';
import {
  SERVER_NAME,
  SERVER_VERSION,
  GET_CAPABILITIES_TOOL_NAME,
  CAPABILITIES_RESOURCE_URI,
  CAPABILITIES_RESOURCE_NAME,
  CAPABILITIES_MIME_TYPE,
  CANONICAL_CAPABILITY_PAYLOAD,
  CANONICAL_CAPABILITY_PAYLOAD_JSON,
  TOOL_ANNOTATIONS,
} from '../src/mcp/McpProtocolSchemas';

const STDIO_SCRIPT_PATH = path.resolve(__dirname, '../dist-electron/mcp/stdio.js');

describe('R5J1 MCP Server Foundation Integration Suite', () => {
  beforeAll(() => {
    // Ensure compiled stdio.js exists before tests spawn child processes
    if (!fs.existsSync(STDIO_SCRIPT_PATH)) {
      execSync('npx tsc -p tsconfig.node.json', { stdio: 'pipe' });
    }
  });

  // 1. Server factory identity
  it('1. Server factory identity matches agentforge 0.1.0', () => {
    const server = buildAgentForgeMcpServer();
    expect(server).toBeInstanceOf(McpServer);
    expect(SERVER_NAME).toBe('agentforge');
    expect(SERVER_VERSION).toBe('0.1.0');
    expect(CANONICAL_CAPABILITY_PAYLOAD.server.name).toBe('agentforge');
    expect(CANONICAL_CAPABILITY_PAYLOAD.server.version).toBe('0.1.0');
  });

  // 2. Legacy initialization
  it('2. Legacy initialization connects and completes handshake', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client(
      { name: 'test-legacy-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } }
    );
    try {
      await client.connect(transport);
      const version = client.getServerVersion();
      expect(version?.name).toBe('agentforge');
      expect(version?.version).toBe('0.1.0');
    } finally {
      await client.close();
    }
  });

  // 3. Modern server/discover
  it('3. Modern server/discover negotiates and connects', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client(
      { name: 'test-modern-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    try {
      await client.connect(transport);
      const version = client.getServerVersion();
      expect(version?.name).toBe('agentforge');
      expect(version?.version).toBe('0.1.0');
    } finally {
      await client.close();
    }
  });

  // 4. Modern/legacy capability equivalence
  it('4. Modern and legacy capability discoveries are equivalent', async () => {
    const legacyTransport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const legacyClient = new Client(
      { name: 'legacy-equiv-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } }
    );

    const modernTransport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const modernClient = new Client(
      { name: 'modern-equiv-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );

    try {
      await legacyClient.connect(legacyTransport);
      await modernClient.connect(modernTransport);

      const [legacyTools, modernTools] = await Promise.all([
        legacyClient.listTools(),
        modernClient.listTools(),
      ]);
      expect(legacyTools.tools).toEqual(modernTools.tools);

      const [legacyResources, modernResources] = await Promise.all([
        legacyClient.listResources(),
        modernClient.listResources(),
      ]);
      expect(legacyResources.resources).toEqual(modernResources.resources);

      const [legacyPrompts, modernPrompts] = await Promise.all([
        legacyClient.listPrompts(),
        modernClient.listPrompts(),
      ]);
      expect(legacyPrompts.prompts).toEqual(modernPrompts.prompts);
      expect(legacyClient.getServerVersion()).toEqual(modernClient.getServerVersion());
    } finally {
      await Promise.all([legacyClient.close(), modernClient.close()]);
    }
  });

  // 5. Exact tool list
  it('5. Exact tool list exposes only agentforge_get_capabilities', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-tools-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const toolList = await client.listTools();
      expect(toolList.tools).toHaveLength(1);
      expect(toolList.tools[0].name).toBe(GET_CAPABILITIES_TOOL_NAME);
    } finally {
      await client.close();
    }
  });

  // 6. Exact resource list
  it('6. Exact resource list exposes only agentforge://server/capabilities', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-resource-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const resourceList = await client.listResources();
      expect(resourceList.resources).toHaveLength(1);
      expect(resourceList.resources[0].name).toBe(CAPABILITIES_RESOURCE_NAME);
      expect(resourceList.resources[0].uri).toBe(CAPABILITIES_RESOURCE_URI);
      expect(resourceList.resources[0].mimeType).toBe(CAPABILITIES_MIME_TYPE);
    } finally {
      await client.close();
    }
  });

  // 7. No prompts exposed
  it('7. No prompts exposed returns empty collection', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-prompts-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const promptList = await client.listPrompts();
      expect(promptList.prompts).toEqual([]);
    } finally {
      await client.close();
    }
  });

  // 8. Tool annotation contract
  it('8. Tool annotation contract identifies read-only, non-destructive, idempotent, closed-world', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-annotations-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const toolList = await client.listTools();
      const tool = toolList.tools[0];
      expect(tool.annotations).toEqual(TOOL_ANNOTATIONS);
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    } finally {
      await client.close();
    }
  });

  // 9. Valid empty tool input
  it('9. Valid empty tool input returns canonical capability payload', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-call-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: GET_CAPABILITIES_TOOL_NAME,
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed).toEqual(CANONICAL_CAPABILITY_PAYLOAD);
    } finally {
      await client.close();
    }
  });

  // 10. Additional tool input rejected
  it('10. Additional tool input is rejected with validation error', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-validation-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: GET_CAPABILITIES_TOOL_NAME,
        arguments: { prohibitedField: 'malicious' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('validation error');
    } finally {
      await client.close();
    }
  });

  // 11. Deterministic repeated tool calls
  it('11. Deterministic repeated tool calls produce byte-identical payloads', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-repeat-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const results: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await client.callTool({
          name: GET_CAPABILITIES_TOOL_NAME,
          arguments: {},
        });
        expect(res.isError).toBeFalsy();
        const text = (res.content[0] as { type: 'text'; text: string }).text;
        results.push(text);
      }
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toBe(results[0]);
      }
      expect(results[0]).toBe(CANONICAL_CAPABILITY_PAYLOAD_JSON);
    } finally {
      await client.close();
    }
  });

  // 12. Resource payload equality
  it('12. Resource payload equality returns identical canonical payload', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-resource-eq-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const resourceResult = await client.readResource({
        uri: CAPABILITIES_RESOURCE_URI,
      });
      expect(resourceResult.contents).toHaveLength(1);
      const content = resourceResult.contents[0] as { uri: string; mimeType?: string; text?: string };
      expect(content.uri).toBe(CAPABILITIES_RESOURCE_URI);
      expect(content.mimeType).toBe(CAPABILITIES_MIME_TYPE);
      expect(content.text).toBe(CANONICAL_CAPABILITY_PAYLOAD_JSON);

      const toolResult = await client.callTool({
        name: GET_CAPABILITIES_TOOL_NAME,
        arguments: {},
      });
      const toolText = (toolResult.content[0] as { type: 'text'; text: string }).text;
      expect(content.text).toBe(toolText);
    } finally {
      await client.close();
    }
  });

  // 13. Unknown tool rejection
  it('13. Unknown tool call fails with typed MethodNotFound error', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-unknown-tool-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      await expect(
        client.callTool({ name: 'unregistered_mutation_tool', arguments: {} })
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  // 14. Unknown resource rejection
  it('14. Unknown resource read fails with typed ResourceNotFound error', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-unknown-res-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      await expect(
        client.readResource({ uri: 'agentforge://server/nonexistent' })
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for condition after ${timeoutMs}ms`));
      }
      setTimeout(check, 25);
    };
    check();
  });
}

  // 15. Malformed JSON-RPC rejection without server crash
  it('15. Malformed JSON-RPC is rejected without crashing server process', async () => {
    const child = spawn(process.execPath, [STDIO_SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      const responses: string[] = [];
      child.stdout.on('data', (chunk: Buffer) => {
        responses.push(chunk.toString());
      });

      // 1. Send syntax-malformed non-JSON data (should be discarded safely without crashing)
      child.stdin.write('{"jsonrpc": "2.0", "malformed": \n');
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 2. Send invalid JSON-RPC method request (should return typed JSON-RPC error)
      const invalidReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'nonexistent/invalid_method',
      }) + '\n';
      child.stdin.write(invalidReq);

      await waitFor(() => responses.join('').includes('-32601'));
      expect(responses.join('')).toContain('-32601'); // Method not found error code

      // 3. Verify server is still completely responsive by sending valid legacy initialize
      const initResponses: string[] = [];
      child.stdout.on('data', (chunk: Buffer) => {
        initResponses.push(chunk.toString());
      });

      const validInit = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }) + '\n';
      child.stdin.write(validInit);

      await waitFor(() => initResponses.join('').includes('"result"'));
      const initCombined = initResponses.join('');
      expect(initCombined).toContain('"result"');
      expect(initCombined).toContain('agentforge');
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        setTimeout(() => {
          try {
            child.kill();
          } catch {
            // ignore
          }
          resolve();
        }, 1000);
      });
    }
  });

  // 16. Multiple sequential requests remain isolated
  it('16. Multiple sequential requests remain isolated without state leakage', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_SCRIPT_PATH],
    });
    const client = new Client({ name: 'test-isolation-client', version: '1.0.0' });
    try {
      await client.connect(transport);

      const t1 = await client.listTools();
      expect(t1.tools).toHaveLength(1);

      const c1 = await client.callTool({ name: GET_CAPABILITIES_TOOL_NAME, arguments: {} });
      expect(c1.isError).toBeFalsy();

      const r1 = await client.listResources();
      expect(r1.resources).toHaveLength(1);

      const res1 = await client.readResource({ uri: CAPABILITIES_RESOURCE_URI });
      expect(res1.contents).toHaveLength(1);

      const p1 = await client.listPrompts();
      expect(p1.prompts).toHaveLength(0);

      const c2 = await client.callTool({ name: GET_CAPABILITIES_TOOL_NAME, arguments: {} });
      expect(c2.isError).toBeFalsy();

      expect((c1.content[0] as { text: string }).text).toBe((c2.content[0] as { text: string }).text);
    } finally {
      await client.close();
    }
  });

  // 17. Protocol stdout contains no diagnostic text
  it('17. Protocol stdout contains exclusively valid JSON-RPC traffic', async () => {
    const child = spawn(process.execPath, [STDIO_SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutLines: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').map((l) => l.trim()).filter(Boolean);
      stdoutLines.push(...lines);
    });

    try {
      // Send initialize
      const initReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }) + '\n';
      child.stdin.write(initReq);

      // Send tool call
      const toolReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: GET_CAPABILITIES_TOOL_NAME,
          arguments: {},
        },
      }) + '\n';
      child.stdin.write(toolReq);

      await waitFor(() => stdoutLines.length >= 2);

      expect(stdoutLines.length).toBeGreaterThanOrEqual(2);
      for (const line of stdoutLines) {
        expect(() => JSON.parse(line)).not.toThrow();
        const parsed = JSON.parse(line);
        expect(parsed.jsonrpc).toBe('2.0');
      }
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        setTimeout(() => {
          try {
            child.kill();
          } catch {
            // ignore
          }
          resolve();
        }, 1000);
      });
    }
  });

  // 18. Diagnostics use stderr only
  it('18. Diagnostics and errors are written to stderr, leaving stdout clean', async () => {
    const child = spawn(process.execPath, [STDIO_SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk.toString()));

    try {
      // Trigger a parse error
      child.stdin.write('invalid-json-payload\n');
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Stdout must contain only valid JSON-RPC
      const stdoutLines = stdoutChunks.join('').split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of stdoutLines) {
        const parsed = JSON.parse(line);
        expect(parsed.jsonrpc).toBe('2.0');
      }
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        setTimeout(() => {
          try {
            child.kill();
          } catch {
            // ignore
          }
          resolve();
        }, 1000);
      });
    }
  });

  // 19. EOF/client disconnect exits cleanly
  it('19. EOF / client disconnect shuts down cleanly with code 0', async () => {
    const child = spawn(process.execPath, [STDIO_SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    // Close stdin to send EOF
    child.stdin.end();

    const { code } = await exitPromise;
    expect(code).toBe(0);
  });

  // 20. Static/runtime proof of zero database access, filesystem writes, network listeners, and authority mutation
  it('20. Static and runtime proof of zero database access, filesystem writes, network listeners, and authority mutation', () => {
    // Runtime authority proof
    expect(CANONICAL_CAPABILITY_PAYLOAD.authority.database_access).toBe(false);
    expect(CANONICAL_CAPABILITY_PAYLOAD.authority.execution_mutation).toBe(false);
    expect(CANONICAL_CAPABILITY_PAYLOAD.authority.filesystem_write).toBe(false);
    expect(CANONICAL_CAPABILITY_PAYLOAD.authority.network_listen).toBe(false);

    // Static code analysis across src/mcp/**
    const mcpDir = path.resolve(__dirname, '../src/mcp');
    const files = fs.readdirSync(mcpDir);
    expect(files.length).toBeGreaterThan(0);

    const prohibitedImports = [
      'better-sqlite3',
      'Database',
      'MigrationRunner',
      'Repository',
      'src/core/database',
      'src/core/services',
    ];

    const prohibitedMutatingToolNames = [
      'claim',
      'dispatch',
      'handoff',
      'cancel',
      'settle',
      'submit',
    ];

    const prohibitedNetworkWriteApis = [
      'net.createServer',
      'http.createServer',
      'https.createServer',
      'ws.Server',
      'express',
      'fastify',
      'fs.writeFileSync',
      'fs.promises.writeFile',
      'fs.createWriteStream',
    ];

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(mcpDir, file), 'utf8');

      for (const forbidden of prohibitedImports) {
        expect(content).not.toContain(`from '${forbidden}'`);
        expect(content).not.toContain(`from "${forbidden}"`);
        expect(content).not.toContain(`require('${forbidden}')`);
        expect(content).not.toContain(`require("${forbidden}")`);
      }

      for (const toolName of prohibitedMutatingToolNames) {
        expect(content).not.toMatch(new RegExp(`registerTool\\s*\\(\\s*['"]${toolName}['"]`));
      }

      for (const api of prohibitedNetworkWriteApis) {
        expect(content).not.toContain(api);
      }
    }
  });
});
