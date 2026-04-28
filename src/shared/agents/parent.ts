import type {
  AgentCreateParams,
  BetaManagedAgentsCustomToolInputSchema,
  BetaManagedAgentsCustomToolParams,
  BetaManagedAgentsMCPToolsetParams,
  BetaManagedAgentsURLMCPServerParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

import type { Config } from "@/shared/config";
import { GITHUB_MCP_URL, MAX_THINKING_BUDGET_DEFERRED } from "@/shared/constants";
import type { CustomToolDefinition } from "@/shared/tool-schema-core";

// Runtime guard: ensures the deferral sentinel is preserved (prevents tree-shaking + keeps grep-ability at import site).
void MAX_THINKING_BUDGET_DEFERRED;

const GITHUB_MCP_SERVER: BetaManagedAgentsURLMCPServerParams = {
  name: "github",
  type: "url",
  url: GITHUB_MCP_URL,
};

export const GITHUB_MCP_TOOLSET: BetaManagedAgentsMCPToolsetParams = {
  type: "mcp_toolset",
  mcp_server_name: "github",
  default_config: {
    permission_policy: { type: "always_allow" },
  },
};

const PARENT_METADATA = {
  app: "github-issue-agent",
  role: "parent",
  thinking_deferred: "sdk-v0.91",
} as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entryValue) => typeof entryValue === "string");
}

function toCustomToolInputSchema(
  inputSchema: Record<string, unknown> & { type?: string | string[] },
): BetaManagedAgentsCustomToolInputSchema {
  const { properties, required, type } = inputSchema;

  if (typeof type !== "undefined" && type !== "object") {
    throw new Error("Custom tool input_schema.type must be 'object'");
  }

  if (typeof properties !== "undefined" && properties !== null && !isObjectRecord(properties)) {
    throw new Error("Custom tool input_schema.properties must be an object when present");
  }

  if (typeof required !== "undefined" && !isStringArray(required)) {
    throw new Error("Custom tool input_schema.required must be a string array when present");
  }

  return {
    type: "object",
    ...(typeof properties === "undefined" ? {} : { properties }),
    ...(typeof required === "undefined" ? {} : { required }),
  };
}

export function toCustomToolParams(
  toolDefinition: CustomToolDefinition,
): BetaManagedAgentsCustomToolParams {
  return {
    ...toolDefinition,
    input_schema: toCustomToolInputSchema(toolDefinition.input_schema),
  };
}

export function buildParentDefinition(
  cfg: Config,
  prompts: { parent: string },
  tools: NonNullable<AgentCreateParams["tools"]>,
): AgentCreateParams {
  /**
   * TODO(sdk-v0.91): re-enable thinking at MAX budget
   * @anthropic-ai/sdk@0.90.0 AgentCreateParams has no 'thinking' field — see docs/spike-notes.md
   * When SDK v0.91 ships: add `thinking: { type: "enabled", budget_tokens: MAX_THINKING_BUDGET[cfg.models.parent] }` to the returned object and hydrate MAX_THINKING_BUDGET_DEFERRED in constants.ts
   */
  return {
    name: "github-issue-orchestrator",
    description: "Orchestrates GitHub issue decomposition, delegation, and final PR creation.",
    model: cfg.models.parent,
    system: prompts.parent,
    mcp_servers: [GITHUB_MCP_SERVER],
    tools,
    metadata: PARENT_METADATA,
  };
}
