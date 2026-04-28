import type {
  AgentCreateParams,
  BetaManagedAgentsAgentToolset20260401Params,
  BetaManagedAgentsMCPToolsetParams,
  BetaManagedAgentsURLMCPServerParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

import type { Config } from "@/shared/config";
import {
  AGENT_TOOLSET_VERSION,
  GITHUB_MCP_URL,
  MAX_THINKING_BUDGET_DEFERRED,
} from "@/shared/constants";

// Runtime guard: ensures the deferral sentinel is preserved (prevents tree-shaking + keeps grep-ability at import site).
void MAX_THINKING_BUDGET_DEFERRED;

const AGENT_TOOLSET: BetaManagedAgentsAgentToolset20260401Params = {
  type: AGENT_TOOLSET_VERSION,
};

const GITHUB_MCP_SERVER: BetaManagedAgentsURLMCPServerParams = {
  name: "github",
  type: "url",
  url: GITHUB_MCP_URL,
};

const GITHUB_MCP_TOOLSET: BetaManagedAgentsMCPToolsetParams = {
  type: "mcp_toolset",
  mcp_server_name: "github",
  default_config: {
    permission_policy: { type: "always_allow" },
  },
};

const CHILD_METADATA = {
  app: "github-issue-agent",
  role: "child",
  thinking_deferred: "sdk-v0.91",
} as const;

export function buildChildDefinition(cfg: Config, prompts: { child: string }): AgentCreateParams {
  /**
   * TODO(sdk-v0.91): re-enable thinking at MAX budget
   * @anthropic-ai/sdk@0.90.0 AgentCreateParams has no 'thinking' field — see docs/spike-notes.md
   * When SDK v0.91 ships: add `thinking: { type: "enabled", budget_tokens: MAX_THINKING_BUDGET[cfg.models.child] }` to the returned object and hydrate MAX_THINKING_BUDGET_DEFERRED in constants.ts
   */
  return {
    name: "github-issue-implementer",
    description: "Implements one delegated GitHub issue task and validates the branch.",
    model: cfg.models.child,
    system: prompts.child,
    mcp_servers: [GITHUB_MCP_SERVER],
    tools: [AGENT_TOOLSET, GITHUB_MCP_TOOLSET],
    metadata: CHILD_METADATA,
  };
}
