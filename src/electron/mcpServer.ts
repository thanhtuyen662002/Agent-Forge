import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { IpcHandlerRegistry, McpSettingsControl } from './ipcHandlers';
import { MCP_INSTRUCTIONS, MCP_TOOLS, McpToolError, type McpToolDefinition } from './mcpTools';

/**
 * Local MCP server (#289): lets an external AI the owner already talks to
 * (Claude Code, Codex) drive Agent Forge through curated tools.
 *
 * - Off by default; the owner turns it on in Settings.
 * - Loopback only (127.0.0.1), Streamable HTTP with JSON responses at POST /mcp.
 * - Every request needs the owner's bearer token, compared in constant time.
 * - A request with an Origin header (a browser page) or a non-loopback Host is
 *   refused, which defeats DNS rebinding.
 */
export const DEFAULT_MCP_PORT = 47615;
const MAX_BODY_BYTES = 1024 * 1024;
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpSettings {
  enabled: boolean;
  port: number;
  token: string;
}

export interface McpSettingsView extends McpSettings {
  url: string;
  running: boolean;
  /** Why the server is not listening although enabled, e.g. PORT_IN_USE. */
  errorCode: string | null;
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

const newToken = () => crypto.randomBytes(32).toString('base64url');
const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest();

export class AgentForgeMcpServer implements McpSettingsControl {
  private settings: McpSettings;
  private server: http.Server | null = null;
  private registry: IpcHandlerRegistry | null = null;
  private errorCode: string | null = null;

  constructor(private readonly options: {
    settingsFile: string;
    version: string;
    tools?: readonly McpToolDefinition[];
    /** Tests use port 0 to get a free port. */
    portOverride?: number;
  }) {
    this.settings = this.load();
  }

  /** The IPC handlers the tools call; set once they are registered. */
  public attach(registry: IpcHandlerRegistry): void { this.registry = registry; }

  public async start(): Promise<void> {
    if (!this.settings.enabled || this.server) return;
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 120_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.portOverride ?? this.settings.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      this.server = server;
      this.errorCode = null;
    } catch (error) {
      this.errorCode = (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'START_FAILED';
      server.close();
    }
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  public getSettings(): McpSettingsView {
    return { ...this.settings, port: this.port(), url: `http://127.0.0.1:${this.port()}/mcp`, running: this.server !== null, errorCode: this.errorCode };
  }

  public async setEnabled(enabled: boolean): Promise<{ success: true; settings: McpSettingsView }> {
    this.settings = { ...this.settings, enabled };
    this.save();
    if (enabled) await this.start();
    else { await this.stop(); this.errorCode = null; }
    return { success: true, settings: this.getSettings() };
  }

  /** A new token; clients using the old one are refused from the next request. */
  public async regenerateToken(): Promise<{ success: true; settings: McpSettingsView }> {
    this.settings = { ...this.settings, token: newToken() };
    this.save();
    return { success: true, settings: this.getSettings() };
  }

  private port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : this.settings.port;
  }

  private load(): McpSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.settingsFile, 'utf8')) as Partial<McpSettings>;
      const port = Number.isInteger(raw.port) && raw.port! > 1023 && raw.port! < 65536 ? raw.port! : DEFAULT_MCP_PORT;
      const token = typeof raw.token === 'string' && raw.token.length >= 32 ? raw.token : newToken();
      const settings = { enabled: raw.enabled === true, port, token };
      if (token !== raw.token) { this.settings = settings; this.save(); }
      return settings;
    } catch {
      const settings = { enabled: false, port: DEFAULT_MCP_PORT, token: newToken() };
      this.settings = settings;
      this.save();
      return settings;
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.options.settingsFile), { recursive: true });
    const temp = `${this.options.settingsFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.options.settingsFile);
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    return crypto.timingSafeEqual(digest(header.slice('Bearer '.length).trim()), digest(this.settings.token));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      if (body === undefined) { res.writeHead(status, headers).end(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
    };
    try {
      const host = String(req.headers.host ?? '').toLowerCase();
      const loopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
      if (req.headers.origin !== undefined || !loopbackHost) { reply(403, { error: 'FORBIDDEN_ORIGIN' }); return; }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/mcp') { reply(404, { error: 'NOT_FOUND' }); return; }
      if (!this.authorized(req)) { reply(401, { error: 'UNAUTHORIZED' }, { 'WWW-Authenticate': 'Bearer' }); return; }
      if (req.method === 'DELETE') { reply(200, {}); return; } // No sessions to end.
      if (req.method !== 'POST') { reply(405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' }); return; }

      let body: unknown;
      try { body = JSON.parse(await readBody(req)); }
      catch (error) {
        if (error instanceof BodyTooLargeError) { reply(413, { error: 'PAYLOAD_TOO_LARGE' }); return; }
        reply(400, rpcError(null, -32700, 'Parse error'));
        return;
      }
      if (Array.isArray(body)) { reply(400, rpcError(null, -32600, 'Batches are not supported')); return; }
      const message = body as JsonRpcRequest;
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        reply(400, rpcError(null, -32600, 'Invalid request'));
        return;
      }
      // Notifications and responses carry no id: accepted, nothing to answer.
      if (message.id === undefined) { reply(202); return; }
      const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
      reply(200, await this.dispatch(id, message.method, message.params));
    } catch {
      if (!res.headersSent) reply(500, rpcError(null, -32603, 'Internal error'));
    }
  }

  private async dispatch(id: JsonRpcId, method: string, params: unknown): Promise<unknown> {
    const args = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    switch (method) {
      case 'initialize': {
        const requested = typeof args.protocolVersion === 'string' ? args.protocolVersion : '';
        return rpcResult(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-forge', title: 'Agent Forge', version: this.options.version },
          instructions: MCP_INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: this.tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = this.tools().find((entry) => entry.name === args.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(args.name)}`);
        if (!this.registry) return rpcResult(id, toolResult({ success: false, errorCode: 'AGENT_FORGE_STARTING' }, true));
        const input = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {};
        try {
          return rpcResult(id, toolResult(await tool.run(input, this.registry), false));
        } catch (error) {
          if (error instanceof McpToolError) return rpcResult(id, toolResult(error.result, true));
          return rpcResult(id, toolResult({ success: false, errorCode: 'TOOL_FAILED', error: error instanceof Error ? error.message.slice(0, 300) : 'failed' }, true));
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  private tools(): readonly McpToolDefinition[] { return this.options.tools ?? MCP_TOOLS; }
}

class BodyTooLargeError extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new BodyTooLargeError()); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

function toolResult(value: unknown, isError: boolean) {
  const structured = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { result: value ?? null };
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }], structuredContent: structured, isError };
}
