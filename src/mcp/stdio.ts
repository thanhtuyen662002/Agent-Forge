import { serveStdio, StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { buildAgentForgeMcpServer } from "./McpServer";
import { resetDefaultAuthorityContext } from "./McpAuthorityContext";

export function runStdioServer(): StdioServerHandle {
  const cleanup = () => {
    try {
      resetDefaultAuthorityContext();
    } catch {
      // Ignore cleanup errors during process exit
    }
  };

  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

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
    cleanup();
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
