import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "./McpProtocolSchemas";
import { registerAgentForgeCapabilities } from "./McpToolRegistry";

export function buildAgentForgeMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerAgentForgeCapabilities(server);

  return server;
}

export { McpServer };
