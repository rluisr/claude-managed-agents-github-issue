import { TOOL_NAMES } from "@/shared/constants";
import type { CustomToolDefinition } from "@/shared/tool-schema-core";
import { toJsonSchema } from "@/shared/tool-schema-core";

import { SpawnChildTaskInput } from "./schemas";

export const SPAWN_CHILD_TASK_TOOL_DEFINITION: CustomToolDefinition = {
  description:
    "Delegate an atomic sub-task to a child implementation agent in an isolated session.",
  input_schema: toJsonSchema(SpawnChildTaskInput),
  name: TOOL_NAMES.SPAWN_CHILD_TASK,
  type: "custom",
};
