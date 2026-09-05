import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "./McpProtocolSchemas";
import { registerAgentForgeCapabilities } from "./McpToolRegistry";
import { McpAuthorityContext, getDefaultAuthorityContext } from "./McpAuthorityContext";

export interface BuildMcpServerOptions {
  authorityContext?: McpAuthorityContext;
}

export function buildAgentForgeMcpServer(options?: BuildMcpServerOptions): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const context = options?.authorityContext ?? getDefaultAuthorityContext();
  registerAgentForgeCapabilities(server, context);

  return server;
}

export { McpServer };
