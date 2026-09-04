import { serveStdio, StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { buildAgentForgeMcpServer } from "./McpServer";
import { resetDefaultAuthorityContext } from "./McpAuthorityContext";

export function runStdioServer(): StdioServerHandle {
  let isCleaningUp = false;
  let cleanupSuccess = true;

  const removeSignalListeners = () => {
    process.off("exit", onExit);
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  };

  const cleanup = (): boolean => {
    if (isCleaningUp) return cleanupSuccess;
    isCleaningUp = true;
    removeSignalListeners();
    try {
      resetDefaultAuthorityContext();
      cleanupSuccess = true;
    } catch {
      cleanupSuccess = false;
      process.stderr.write('[agentforge-mcp] Cleanup diagnostic: MCP_CLEANUP_FAILED\n');
    }
    return cleanupSuccess;
  };

  const onSigInt = () => {
    const success = cleanup();
    process.exit(success ? 0 : 1);
  };

  const onSigTerm = () => {
    const success = cleanup();
    process.exit(success ? 0 : 1);
  };

  const onExit = () => {
    const success = cleanup();
    if (!success) {
      process.exitCode = 1;
    }
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
      const success = cleanup();
      let closeErr: unknown = null;
      try {
        await originalClose();
      } catch (err) {
        closeErr = err;
      }
      if (!success) {
        throw new Error('Cleanup failed: MCP_CLEANUP_FAILED');
      }
      if (closeErr) {
        throw closeErr;
      }
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
