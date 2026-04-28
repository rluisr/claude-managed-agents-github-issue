import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PARENT_TOOLS } from "@/parent-tools";
import { buildChildDefinition } from "@/shared/agents/child";
import { hashDefinition } from "@/shared/agents/hash";
import { buildParentDefinition } from "@/shared/agents/parent";
import type { Config } from "@/shared/config";
import { TOOL_NAMES } from "@/shared/constants";
import { GENERIC_CHILD_AGENT_PROMPT, GENERIC_PARENT_AGENT_PROMPT } from "@/shared/prompts/defaults";

const TEST_CONFIG: Config = {
  models: { parent: "claude-opus-4-7", child: "claude-sonnet-4-6" },
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

async function loadGolden(): Promise<{ parent: string; child: string }> {
  const goldenPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../.sisyphus/evidence/hash-golden.json",
  );
  const raw = await readFile(goldenPath, "utf8");
  return JSON.parse(raw) as { parent: string; child: string };
}

describe("parent tools composition", () => {
  test("PARENT_TOOLS has exactly 4 entries", () => {
    expect(PARENT_TOOLS).toHaveLength(4);
  });

  test("PARENT_TOOLS[0] is GITHUB_MCP_TOOLSET", () => {
    const tool = PARENT_TOOLS[0] as { type?: string } | undefined;
    expect(tool?.type).toBe("mcp_toolset");
  });

  test("PARENT_TOOLS[1] is spawn_child_task", () => {
    const tool = PARENT_TOOLS[1] as { name: string };
    expect(tool.name).toBe("spawn_child_task");
  });

  test("PARENT_TOOLS[2] is create_final_pr", () => {
    const tool = PARENT_TOOLS[2] as { name: string };
    expect(tool.name).toBe("create_final_pr");
  });

  test("PARENT_TOOLS[3] is create_sub_issue", () => {
    const tool = PARENT_TOOLS[3] as { name: string };
    expect(tool.name).toBe("create_sub_issue");
  });

  test("custom tool entries match TOOL_NAMES in declaration order", () => {
    const customTools = PARENT_TOOLS.filter((tool) => tool.type === "custom");
    expect(customTools.map((tool) => tool.name)).toEqual([
      TOOL_NAMES.SPAWN_CHILD_TASK,
      TOOL_NAMES.CREATE_FINAL_PR,
      TOOL_NAMES.CREATE_SUB_ISSUE,
    ]);
  });

  test("every custom tool has type=custom and object input_schema", () => {
    const customTools = PARENT_TOOLS.filter((tool) => tool.type === "custom");
    expect(customTools).toHaveLength(3);
    for (const tool of customTools) {
      expect(tool.type).toBe("custom");
      expect(tool.input_schema.type).toBe("object");
    }
  });
});

describe("hash-stability", () => {
  test("parent agent definition hash matches golden", async () => {
    const golden = await loadGolden();
    const parentDef = buildParentDefinition(TEST_CONFIG, { parent: GENERIC_PARENT_AGENT_PROMPT }, [
      ...PARENT_TOOLS,
    ]);

    expect(hashDefinition(parentDef)).toBe(golden.parent);
  });

  test("child agent definition hash matches golden", async () => {
    const golden = await loadGolden();
    const childDef = buildChildDefinition(TEST_CONFIG, {
      child: GENERIC_CHILD_AGENT_PROMPT,
    });

    expect(hashDefinition(childDef)).toBe(golden.child);
  });
});
