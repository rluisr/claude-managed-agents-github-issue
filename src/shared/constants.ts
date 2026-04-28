export const AGENT_TOOLSET_VERSION = "agent_toolset_20260401";

export const GITHUB_API_VERSION = "2026-03-10";

export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

export const SUPPORTED_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6"] as const;

/** TODO(sdk-v0.91): when AgentCreateParams exposes `thinking`, replace this sentinel with a real MAX_THINKING_BUDGET table and wire it into parent/child definitions. Keeping the sentinel export ensures the deferral is discoverable via grep and unit-testable. */
export const MAX_THINKING_BUDGET_DEFERRED = Object.freeze({
  todo: "TODO(sdk-v0.91): re-enable thinking at MAX budget",
  reason: "@anthropic-ai/sdk@0.90.0 AgentCreateParams has no thinking field",
} as const);

export const TOOL_NAMES = {
  SPAWN_CHILD_TASK: "spawn_child_task",
  CREATE_FINAL_PR: "create_final_pr",
  CREATE_SUB_ISSUE: "create_sub_issue",
} as const;

export const STATE_FILE = ".github-issue-agent/state.json";

export const RUN_LOCK = ".github-issue-agent/run.lock";
