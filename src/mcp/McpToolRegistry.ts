import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import {
  GET_CAPABILITIES_TOOL_NAME,
  CAPABILITIES_RESOURCE_URI,
  CAPABILITIES_RESOURCE_NAME,
  CAPABILITIES_MIME_TYPE,
  CANONICAL_CAPABILITY_PAYLOAD_JSON,
  EMPTY_OBJECT_JSON_SCHEMA,
  TOOL_ANNOTATIONS,
} from "./McpProtocolSchemas";

export function registerAgentForgeCapabilities(server: McpServer): void {
  // Register deterministic read-only capability discovery tool
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

  // Register deterministic read-only capability discovery resource
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
}
