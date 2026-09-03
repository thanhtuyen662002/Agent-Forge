import { serveStdio, StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { buildAgentForgeMcpServer } from "./McpServer";
import { resetDefaultAuthorityContext } from "./McpAuthorityContext";

export function runStdioServer(): StdioServerHandle {
  let isCleaningUp = false;

  const removeSignalListeners = () => {
    process.off("exit", onExit);
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  };

  const cleanup = () => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    removeSignalListeners();
    try {
      resetDefaultAuthorityContext();
    } catch {
      process.stderr.write('[agentforge-mcp] Cleanup diagnostic: MCP_CLEANUP_FAILED\n');
    }
  };

  const onSigInt = () => {
    cleanup();
    process.exit(0);
  };

  const onSigTerm = () => {
    cleanup();
    process.exit(0);
  };

  const onExit = () => {
    cleanup();
  };

  process.once("exit", onExit);
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);

  try {
    const handle = serveStdio(() => buildAgentForgeMcpServer(), {
      onerror: () => {
        process.stderr.write('[agentforge-mcp] MCP_SERVER_ERROR\n');
      },
    });

    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      cleanup();
      return originalClose();
    };

    return handle;
  } catch {
    process.stderr.write('[agentforge-mcp-fatal] Startup failure: MCP_STARTUP_FAILED\n');
    cleanup();
    process.exit(1);
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  try {
    runStdioServer();
  } catch {
    process.stderr.write('[agentforge-mcp-fatal] MCP_FATAL_ERROR\n');
    process.exit(1);
  }
}
