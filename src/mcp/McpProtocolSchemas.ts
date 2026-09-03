export const SERVER_NAME = "agentforge";
export const SERVER_VERSION = "0.1.0";

export const GET_CAPABILITIES_TOOL_NAME = "agentforge_get_capabilities";
export const CAPABILITIES_RESOURCE_URI = "agentforge://server/capabilities";
export const CAPABILITIES_RESOURCE_NAME = "capabilities";
export const CAPABILITIES_MIME_TYPE = "application/json";

export const GET_AUTHORIZED_CONTEXT_TOOL_NAME = "agentforge_get_authorized_context";
export const AUTHORIZED_CONTEXT_RESOURCE_URI = "agentforge://session/authorized-context";
export const AUTHORIZED_CONTEXT_RESOURCE_NAME = "authorized-context";
export const AUTHORIZED_CONTEXT_MIME_TYPE = "application/json";

export interface AgentForgeCapabilityPayload {
  readonly schema_version: 2;
  readonly server: {
    readonly name: "agentforge";
    readonly version: "0.1.0";
  };
  readonly transport: "stdio";
  readonly mode: "AUTHORIZED_CONTEXT_READ";
  readonly capabilities: {
    readonly tools: readonly [
      "agentforge_get_capabilities",
      "agentforge_get_authorized_context"
    ];
    readonly resources: readonly [
      "agentforge://server/capabilities",
      "agentforge://session/authorized-context"
    ];
    readonly prompts: readonly [];
  };
  readonly authority: {
    readonly database_access: "READ_ONLY";
    readonly execution_mutation: false;
    readonly filesystem_write: false;
    readonly network_listen: false;
  };
}

export const CANONICAL_CAPABILITY_PAYLOAD: AgentForgeCapabilityPayload = {
  schema_version: 2,
  server: {
    name: "agentforge",
    version: "0.1.0",
  },
  transport: "stdio",
  mode: "AUTHORIZED_CONTEXT_READ",
  capabilities: {
    tools: ["agentforge_get_capabilities", "agentforge_get_authorized_context"],
    resources: ["agentforge://server/capabilities", "agentforge://session/authorized-context"],
    prompts: [],
  },
  authority: {
    database_access: "READ_ONLY",
    execution_mutation: false,
    filesystem_write: false,
    network_listen: false,
  },
} as const;

Object.freeze(CANONICAL_CAPABILITY_PAYLOAD.server);
Object.freeze(CANONICAL_CAPABILITY_PAYLOAD.capabilities);
Object.freeze(CANONICAL_CAPABILITY_PAYLOAD.capabilities.tools);
Object.freeze(CANONICAL_CAPABILITY_PAYLOAD.capabilities.resources);
Object.freeze(CANONICAL_CAPABILITY_PAYLOAD.capabilities.prompts);
Object.freeze(CANONICAL_CAPABILITY_PAYLOAD.authority);
Object.freeze(CANONICAL_CAPABILITY_PAYLOAD);

export const CANONICAL_CAPABILITY_PAYLOAD_JSON: string = JSON.stringify(CANONICAL_CAPABILITY_PAYLOAD);

export const EMPTY_OBJECT_JSON_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
