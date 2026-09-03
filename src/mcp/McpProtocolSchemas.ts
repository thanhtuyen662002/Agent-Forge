export const SERVER_NAME = "agentforge";
export const SERVER_VERSION = "0.1.0";

export const GET_CAPABILITIES_TOOL_NAME = "agentforge_get_capabilities";
export const CAPABILITIES_RESOURCE_URI = "agentforge://server/capabilities";
export const CAPABILITIES_RESOURCE_NAME = "capabilities";
export const CAPABILITIES_MIME_TYPE = "application/json";

export interface AgentForgeCapabilityPayload {
  readonly schema_version: 1;
  readonly server: {
    readonly name: "agentforge";
    readonly version: "0.1.0";
  };
  readonly transport: "stdio";
  readonly mode: "READ_ONLY_FOUNDATION";
  readonly capabilities: {
    readonly tools: readonly ["agentforge_get_capabilities"];
    readonly resources: readonly ["agentforge://server/capabilities"];
    readonly prompts: readonly [];
  };
  readonly authority: {
    readonly database_access: false;
    readonly execution_mutation: false;
    readonly filesystem_write: false;
    readonly network_listen: false;
  };
}

export const CANONICAL_CAPABILITY_PAYLOAD: AgentForgeCapabilityPayload = {
  schema_version: 1,
  server: {
    name: "agentforge",
    version: "0.1.0",
  },
  transport: "stdio",
  mode: "READ_ONLY_FOUNDATION",
  capabilities: {
    tools: ["agentforge_get_capabilities"],
    resources: ["agentforge://server/capabilities"],
    prompts: [],
  },
  authority: {
    database_access: false,
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
