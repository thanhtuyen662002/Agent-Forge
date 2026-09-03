import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import {
  GET_CAPABILITIES_TOOL_NAME,
  CAPABILITIES_RESOURCE_URI,
  CAPABILITIES_RESOURCE_NAME,
  CAPABILITIES_MIME_TYPE,
  CANONICAL_CAPABILITY_PAYLOAD_JSON,
  GET_AUTHORIZED_CONTEXT_TOOL_NAME,
  AUTHORIZED_CONTEXT_RESOURCE_URI,
  AUTHORIZED_CONTEXT_RESOURCE_NAME,
  AUTHORIZED_CONTEXT_MIME_TYPE,
  EMPTY_OBJECT_JSON_SCHEMA,
  TOOL_ANNOTATIONS,
} from "./McpProtocolSchemas";
import { McpAuthorityContext, getDefaultAuthorityContext } from "./McpAuthorityContext";
import { McpAuthorityError } from "../core/services/McpSessionAuthorityService";
import { McpSessionErrorCode } from "../core/types/domain";

export function getCanonicalPublicErrorMessage(category: McpSessionErrorCode): string {
  switch (category) {
    case 'MCP_SESSION_REQUIRED':
      return 'Session token required';
    case 'MCP_SESSION_UNAUTHORIZED':
      return 'Session authentication failed';
    case 'MCP_CONFIGURATION_INVALID':
      return 'MCP configuration invalid';
    case 'MCP_AUTHORITY_FENCED':
      return 'Execution authority fenced';
    case 'MCP_CONTEXT_INTEGRITY_FAILED':
      return 'Context integrity verification failed';
    default:
      return 'Authority verification failed';
  }
}

export function formatPublicError(error: unknown): { category: McpSessionErrorCode; text: string } {
  const category: McpSessionErrorCode =
    error instanceof McpAuthorityError ? error.category : 'MCP_CONFIGURATION_INVALID';
  const canonicalMessage = getCanonicalPublicErrorMessage(category);
  return {
    category,
    text: `[${category}] ${canonicalMessage}`,
  };
}

export function registerAgentForgeCapabilities(
  server: McpServer,
  authorityContext: McpAuthorityContext = getDefaultAuthorityContext()
): void {
  // 1. Static capability discovery tool
  server.registerTool(
    GET_CAPABILITIES_TOOL_NAME,
    {
      description: "Return static, deterministic, read-only AgentForge capability and authority information.",
      inputSchema: fromJsonSchema(EMPTY_OBJECT_JSON_SCHEMA),
      annotations: TOOL_ANNOTATIONS,
    },
    async () => {
      return {
        content: [
          {
            type: "text" as const,
            text: CANONICAL_CAPABILITY_PAYLOAD_JSON,
          },
        ],
      };
    }
  );

  // 2. Static capability discovery resource
  server.registerResource(
    CAPABILITIES_RESOURCE_NAME,
    CAPABILITIES_RESOURCE_URI,
    {
      description: "Static, deterministic, read-only AgentForge capability and authority information.",
      mimeType: CAPABILITIES_MIME_TYPE,
    },
    async (uri) => {
      const uriString = typeof uri === "string" ? uri : (uri as { href: string }).href;
      return {
        contents: [
          {
            uri: uriString,
            mimeType: CAPABILITIES_MIME_TYPE,
            text: CANONICAL_CAPABILITY_PAYLOAD_JSON,
          },
        ],
      };
    }
  );

  // 3. Scoped authorized context read tool
  server.registerTool(
    GET_AUTHORIZED_CONTEXT_TOOL_NAME,
    {
      description: "Return cryptographically authenticated, task-scoped execution authorization context.",
      inputSchema: fromJsonSchema(EMPTY_OBJECT_JSON_SCHEMA),
      annotations: TOOL_ANNOTATIONS,
    },
    async () => {
      try {
        const result = authorityContext.resolveAuthorizedContext();
        const serialized = JSON.stringify(result);
        return {
          content: [
            {
              type: "text" as const,
              text: serialized,
            },
          ],
        };
      } catch (error) {
        const publicErr = formatPublicError(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: publicErr.text,
            },
          ],
        };
      }
    }
  );

  // 4. Scoped authorized context read resource
  server.registerResource(
    AUTHORIZED_CONTEXT_RESOURCE_NAME,
    AUTHORIZED_CONTEXT_RESOURCE_URI,
    {
      description: "Cryptographically authenticated, task-scoped execution authorization context.",
      mimeType: AUTHORIZED_CONTEXT_MIME_TYPE,
    },
    async (uri) => {
      const uriString = typeof uri === "string" ? uri : (uri as { href: string }).href;
      try {
        const result = authorityContext.resolveAuthorizedContext();
        const serialized = JSON.stringify(result);
        return {
          contents: [
            {
              uri: uriString,
              mimeType: AUTHORIZED_CONTEXT_MIME_TYPE,
              text: serialized,
            },
          ],
        };
      } catch (error) {
        const publicErr = formatPublicError(error);
        throw new Error(publicErr.text);
      }
    }
  );
}
