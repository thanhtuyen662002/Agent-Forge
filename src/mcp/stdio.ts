import { serveStdio, StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { buildAgentForgeMcpServer } from "./McpServer";

export function runStdioServer(): StdioServerHandle {
  try {
    return serveStdio(() => buildAgentForgeMcpServer(), {
      onerror: (error: Error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[agentforge-mcp] ${message}\n`);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[agentforge-mcp-fatal] Startup failure: ${message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    runStdioServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[agentforge-mcp-fatal] ${message}\n`);
    process.exit(1);
  }
}
