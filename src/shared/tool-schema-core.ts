import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { TOOL_NAMES } from "@/shared/constants";

export const PriorCommitSchema = z
  .object({
    message: z.string().min(1).describe("Commit message already present on the shared branch."),
    sha: z.string().min(1).describe("Commit SHA already present on the shared branch."),
  })
  .strict()
  .describe("A prior commit on the shared working branch.");

export const ChildTaskErrorSchema = z
  .object({
    message: z.string().min(1).describe("Human-readable explanation of the child task failure."),
    stderr: z
      .string()
      .optional()
      .describe("Optional stderr output captured from the failing step."),
    type: z.string().min(1).describe("Stable machine-readable error category for the child task."),
  })
  .strict()
  .describe("Structured child task failure details.");

export const ToolErrorSchema = z
  .object({
    details: z.unknown().optional().describe("Optional structured error details for debugging."),
    message: z.string().min(1).describe("Human-readable explanation of the tool failure."),
    type: z.string().min(1).describe("Stable machine-readable error category for the tool."),
  })
  .strict()
  .describe("Structured tool failure details.");

export type JsonSchemaObject = Record<string, unknown> & {
  type?: string | string[];
};

export type CustomToolDefinition = {
  description: string;
  input_schema: JsonSchemaObject;
  name: (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
  type: "custom";
};

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchemaObject {
  return zodToJsonSchema(schema, {
    $refStrategy: "none",
    errorMessages: true,
    target: "jsonSchema7",
  }) as JsonSchemaObject;
}
