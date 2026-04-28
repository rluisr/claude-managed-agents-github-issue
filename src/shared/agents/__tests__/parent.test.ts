import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AgentCreateParams,
  BetaManagedAgentsCustomToolParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { Config } from "@/shared/config";
import { buildParentDefinition, GITHUB_MCP_TOOLSET } from "../parent";

const TEST_CONFIG: Config = {
  models: {
    parent: "claude-opus-4-7",
    child: "claude-sonnet-4-6",
  },
  maxSubIssues: 10,
  maxRunMinutes: 120,
  maxChildMinutes: 30,
  pr: { draft: true },
  commitStyle: "conventional",
  git: {
    authorName: "claude-agent[bot]",
    authorEmail: "claude-agent@users.noreply.github.com",
  },
};

const TEST_CUSTOM_TOOLS: BetaManagedAgentsCustomToolParams[] = [
  {
    description: "First test custom tool used to validate parent agent wiring.",
    input_schema: { type: "object" },
    name: "test_tool_alpha",
    type: "custom",
  },
  {
    description: "Second test custom tool used to validate parent agent wiring.",
    input_schema: { type: "object" },
    name: "test_tool_beta",
    type: "custom",
  },
];

function buildTestParentTools(): NonNullable<AgentCreateParams["tools"]> {
  return [GITHUB_MCP_TOOLSET, ...TEST_CUSTOM_TOOLS];
}

function assertAgentCreateParams(definition: AgentCreateParams): AgentCreateParams {
  return definition;
}

describe("buildParentDefinition", () => {
  test("returns AgentCreateParams without a thinking field and with metadata tags", () => {
    const parentDefinition = assertAgentCreateParams(
      buildParentDefinition(TEST_CONFIG, { parent: "x" }, buildTestParentTools()),
    );

    expect("thinking" in parentDefinition).toBe(false);
    expect(parentDefinition.model).toBe(TEST_CONFIG.models.parent);
    expect(parentDefinition.metadata).toEqual({
      app: "github-issue-agent",
      role: "parent",
      thinking_deferred: "sdk-v0.91",
    });
  });

  test("forwards the supplied custom tools and includes the github MCP toolset", () => {
    const parentDefinition: AgentCreateParams = buildParentDefinition(
      TEST_CONFIG,
      { parent: "x" },
      buildTestParentTools(),
    );
    const parentTools = parentDefinition.tools ?? [];
    const customTools = parentTools.filter((toolEntry) => toolEntry.type === "custom");
    const githubMcpTools = parentTools.filter(
      (toolEntry) => toolEntry.type === "mcp_toolset" && toolEntry.mcp_server_name === "github",
    );
    const agentToolsets = parentTools.filter(
      (toolEntry) => toolEntry.type === "agent_toolset_20260401",
    );
    const customToolNames = new Set(customTools.map((toolEntry) => toolEntry.name));

    expect(agentToolsets).toHaveLength(0);
    expect(customTools).toHaveLength(TEST_CUSTOM_TOOLS.length);
    expect(customToolNames.size).toBe(TEST_CUSTOM_TOOLS.length);
    for (const expectedTool of TEST_CUSTOM_TOOLS) {
      expect(customToolNames.has(expectedTool.name)).toBe(true);
    }
    expect(githubMcpTools).toHaveLength(1);
  });

  test("defines exactly one github MCP server with the expected URL", () => {
    const parentDefinition = buildParentDefinition(
      TEST_CONFIG,
      { parent: "x" },
      buildTestParentTools(),
    );
    const githubServers = (parentDefinition.mcp_servers ?? []).filter(
      (serverEntry) => serverEntry.name === "github",
    );

    expect(githubServers).toEqual([
      {
        name: "github",
        type: "url",
        url: "https://api.githubcopilot.com/mcp/",
      },
    ]);
  });

  test("keeps the sdk-v0.91 TODO anchor in source", () => {
    const parentSourcePath = fileURLToPath(new URL("../parent.ts", import.meta.url));
    const parentSourceText = readFileSync(parentSourcePath, "utf8");

    expect(parentSourceText).toContain("TODO(sdk-v0.91): re-enable thinking at MAX budget");
  });
});
