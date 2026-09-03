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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[agentforge-mcp] Cleanup diagnostic: ${msg}\n`);
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
      onerror: (error: Error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[agentforge-mcp] ${message}\n`);
      },
    });

    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      cleanup();
      return originalClose();
    };

    return handle;
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
