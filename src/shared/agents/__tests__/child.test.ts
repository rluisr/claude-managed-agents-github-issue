import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";

import type { Config } from "@/shared/config";
import { buildChildDefinition } from "../child";

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

function assertAgentCreateParams(definition: AgentCreateParams): AgentCreateParams {
  return definition;
}

describe("buildChildDefinition", () => {
  test("returns AgentCreateParams without a thinking field and with metadata tags", () => {
    const childDefinition = assertAgentCreateParams(
      buildChildDefinition(TEST_CONFIG, { child: "x" }),
    );

    expect("thinking" in childDefinition).toBe(false);
    expect(childDefinition.model).toBe(TEST_CONFIG.models.child);
    expect(childDefinition.metadata).toEqual({
      app: "github-issue-agent",
      role: "child",
      thinking_deferred: "sdk-v0.91",
    });
  });

  test("includes exactly one built-in agent toolset, one github MCP toolset, and no custom tools", () => {
    const childDefinition: AgentCreateParams = buildChildDefinition(TEST_CONFIG, { child: "x" });
    const childTools = childDefinition.tools ?? [];
    const agentToolsets = childTools.filter(
      (toolEntry) => toolEntry.type === "agent_toolset_20260401",
    );
    const githubMcpTools = childTools.filter(
      (toolEntry) => toolEntry.type === "mcp_toolset" && toolEntry.mcp_server_name === "github",
    );
    const customTools = childTools.filter((toolEntry) => toolEntry.type === "custom");

    expect(agentToolsets).toHaveLength(1);
    expect(githubMcpTools).toHaveLength(1);
    expect(customTools).toHaveLength(0);
  });

  test("defines exactly one github MCP server with the expected URL", () => {
    const childDefinition = buildChildDefinition(TEST_CONFIG, { child: "x" });
    const githubServers = (childDefinition.mcp_servers ?? []).filter(
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
    const childSourcePath = fileURLToPath(new URL("../child.ts", import.meta.url));
    const childSourceText = readFileSync(childSourcePath, "utf8");

    expect(childSourceText).toContain("TODO(sdk-v0.91): re-enable thinking at MAX budget");
  });
});
