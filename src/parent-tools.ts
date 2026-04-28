import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";

import { SPAWN_CHILD_TASK_TOOL_DEFINITION } from "@/features/child-execution/tool-definition";
import { CREATE_SUB_ISSUE_TOOL_DEFINITION } from "@/features/decomposition/tool-definition";
import { CREATE_FINAL_PR_TOOL_DEFINITION } from "@/features/finalize-pr/tool-definition";
import { GITHUB_MCP_TOOLSET, toCustomToolParams } from "@/shared/agents/parent";

type ParentToolParams = NonNullable<AgentCreateParams["tools"]>[number];

export const PARENT_TOOLS: ReadonlyArray<ParentToolParams> = [
  GITHUB_MCP_TOOLSET,
  toCustomToolParams(SPAWN_CHILD_TASK_TOOL_DEFINITION),
  toCustomToolParams(CREATE_FINAL_PR_TOOL_DEFINITION),
  toCustomToolParams(CREATE_SUB_ISSUE_TOOL_DEFINITION),
] as const;
