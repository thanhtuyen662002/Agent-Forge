import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentForgeMcpServer } from '../src/electron/mcpServer';
import { MCP_TOOLS } from '../src/electron/mcpTools';
import type { IpcHandlerRegistry } from '../src/electron/ipcHandlers';

/** #289: the local MCP server that lets an external AI drive Agent Forge. */
describe('local MCP server (#289)', () => {
  let dir: string;
  let settingsFile: string;
  let server: AgentForgeMcpServer;
  let calls: Array<{ channel: string; payload: unknown }>;
  let replies: Record<string, unknown>;
  const registry: IpcHandlerRegistry = {
    invoke: async (channel, payload) => { calls.push({ channel, payload }); return replies[channel] ?? { success: true }; },
    selectRepositoryPath: async (repositoryPath) => {
      calls.push({ channel: 'select', payload: repositoryPath });
      return repositoryPath === 'D:/Projects/app' ? { success: true, selectionId: '7b0c9f1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f' } : { success: false, errorCode: 'NOT_GIT_REPOSITORY' };
    },
  };

  const request = (body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; json: any }> => {
    const { url, token } = server.getSettings();
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      // A fresh connection per request: no reuse of a socket the server closed.
      const req = http.request({ host: '127.0.0.1', port: target.port, path: target.pathname, method, agent: false,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
  const rpc = (method: string, params?: unknown, id: number = 1) => request({ jsonrpc: '2.0', id, method, params });
  const call = async (name: string, args: Record<string, unknown>) => (await rpc('tools/call', { name, arguments: args })).json.result;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mcp-'));
    settingsFile = path.join(dir, 'mcp-settings.json');
    calls = [];
    replies = {};
    server = new AgentForgeMcpServer({ settingsFile, version: '0.1.0-test', portOverride: 0 });
    server.attach(registry);
  });
  afterEach(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is off by default, with a strong random token persisted in the settings file', async () => {
    const settings = server.getSettings();
    expect(settings).toMatchObject({ enabled: false, running: false, port: 47615 });
    expect(settings.token.length).toBeGreaterThanOrEqual(43);
    await server.start();
    expect(server.getSettings().running).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).token).toBe(settings.token);
    // Reloading keeps the same token.
    expect(new AgentForgeMcpServer({ settingsFile, version: 'x' }).getSettings().token).toBe(settings.token);
  });

  it('listens on loopback once enabled, and stops when disabled', async () => {
    await server.setEnabled(true);
    const settings = server.getSettings();
    expect(settings.running).toBe(true);
    expect(settings.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).enabled).toBe(true);
    await server.setEnabled(false);
    expect(server.getSettings().running).toBe(false);
  });

  it('refuses requests without the token, with a wrong or regenerated token, from a browser Origin, or for another Host', async () => {
    await server.setEnabled(true);
    expect((await rpc('ping')).status).toBe(200);
    expect((await request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: '' })).status).toBe(401);
    expect((await request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong-token' })).status).toBe(401);
    expect((await request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Host: 'evil.example:47615' })).status).toBe(403);
    const oldToken = server.getSettings().token;
    await server.regenerateToken();
    expect(server.getSettings().token).not.toBe(oldToken);
    expect((await request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: `Bearer ${oldToken}` })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('speaks the MCP lifecycle: initialize, notifications, tools/list, unknown methods', async () => {
    await server.setEnabled(true);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.json.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-forge' } });
    expect(init.json.result.instructions).toContain('create_project');
    expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).json.result.protocolVersion).toBe('2025-06-18');
    expect((await request({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const listed = (await rpc('tools/list')).json.result.tools;
    expect(listed.map((tool: { name: string }) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    expect(listed.every((tool: { inputSchema: { type: string } }) => tool.inputSchema.type === 'object')).toBe(true);
    expect((await rpc('resources/list')).json.error.code).toBe(-32601);
    expect((await request({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, 'GET')).status).toBe(405);
    expect((await request([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status).toBe(400);
  });

  it('drives a whole project through the existing handlers', async () => {
    await server.setEnabled(true);
    replies['project:create'] = { success: true, project: { id: 'PROJ-1' } };
    expect((await call('create_project', { name: 'Demo', repositoryPath: 'D:/Projects/app' })).isError).toBe(false);
    await call('set_project_plan', { projectId: 'PROJ-1', goal: 'Add stats', acceptance_criteria: ['countWords works'], owner_policies: ['Do not edit run-tests.js'] });
    await call('approve_plan', { projectId: 'PROJ-1' });
    await call('set_test_command', { projectId: 'PROJ-1', command: 'node run-tests.js' });
    await call('configure_automation', { projectId: 'PROJ-1', managerMode: 'AUTO', autoIntegrate: true });
    await call('start_project', { projectId: 'PROJ-1' });

    expect(calls).toEqual([
      { channel: 'select', payload: 'D:/Projects/app' },
      { channel: 'project:create', payload: { name: 'Demo', description: '', repositorySelectionId: '7b0c9f1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f', defaultBranch: 'main' } },
      { channel: 'project:importContract', payload: { projectId: 'PROJ-1', contract: { goal: 'Add stats', acceptance_criteria: ['countWords works'], owner_policies: ['Do not edit run-tests.js'] } } },
      { channel: 'project:transition', payload: { projectId: 'PROJ-1', trigger: 'PLAN_APPROVED' } },
      { channel: 'verification:saveCommands', payload: { projectId: 'PROJ-1', commands: { TEST: 'node run-tests.js' } } },
      { channel: 'automation:setManagerMode', payload: { projectId: 'PROJ-1', mode: 'AUTO' } },
      { channel: 'integration:setAuto', payload: { projectId: 'PROJ-1', enabled: true } },
      { channel: 'project:transition', payload: { projectId: 'PROJ-1', trigger: 'START_PROJECT' } },
    ]);
  });

  it('reports refusals and bad input as tool errors, never as success', async () => {
    await server.setEnabled(true);
    const badPath = await call('create_project', { name: 'Demo', repositoryPath: 'C:/Windows' });
    expect(badPath.isError).toBe(true);
    expect(badPath.structuredContent).toMatchObject({ errorCode: 'NOT_GIT_REPOSITORY' });
    replies['project:transition'] = { success: false, error: 'Invalid transition' };
    expect((await call('start_project', { projectId: 'PROJ-1' })).isError).toBe(true);
    expect((await call('set_project_plan', { projectId: 'PROJ-1' })).structuredContent).toMatchObject({ errorCode: 'INVALID_INPUT' });
    expect((await rpc('tools/call', { name: 'reveal_token', arguments: {} })).json.error.code).toBe(-32602);
  });

  it('summarizes events newest last and bounded', async () => {
    await server.setEnabled(true);
    replies['events:list'] = Array.from({ length: 50 }, (_, i) => ({ timestamp: `2026-10-27T00:00:${String(i).padStart(2, '0')}Z`, type: `E${i}`, task_id: null, summary: `s${i}` })).reverse();
    const result = await call('list_events', { projectId: 'PROJ-1', limit: 3 });
    expect(JSON.parse(result.content[0].text).map((event: { type: string }) => event.type)).toEqual(['E47', 'E48', 'E49']);
  });
});
