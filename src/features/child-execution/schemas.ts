import { z } from "zod";

import { ChildTaskErrorSchema, PriorCommitSchema } from "@/shared/tool-schema-core";

export const SpawnChildTaskInput = z
  .object({
    acceptanceCriteria: z
      .array(z.string().min(1).describe("One acceptance criterion the child must satisfy."))
      .describe("Ordered acceptance criteria for the delegated task."),
    branch: z.string().min(1).describe("Branch name the child must use for implementation work."),
    description: z
      .string()
      .min(1)
      .describe("Detailed implementation brief for the delegated child task."),
    priorCommits: z
      .array(PriorCommitSchema)
      .optional()
      .describe("Optional summary of commits already present on the shared branch."),
    taskId: z.string().min(1).describe("Stable task identifier used to correlate child results."),
    title: z.string().min(1).describe("Short task title shown to the child agent."),
  })
  .strict()
  .describe("Input payload for delegating one atomic sub-task to a child agent.");

export const SpawnChildTaskOutput = z
  .object({
    commitSha: z.string().optional().describe("Commit SHA produced by the child, when successful."),
    error: ChildTaskErrorSchema.optional().describe(
      "Structured failure details when the child fails.",
    ),
    filesChanged: z
      .array(z.string().min(1).describe("Repository-relative file path changed by the child."))
      .optional()
      .describe("Optional list of changed files reported by the child."),
    success: z.boolean().describe("Whether the child task completed successfully."),
    taskId: z.string().min(1).describe("Stable task identifier echoed back to the parent."),
    testOutput: z
      .string()
      .optional()
      .describe("Optional summarized test output from the child run."),
  })
  .strict()
  .describe("Result payload returned from a child implementation agent.");
