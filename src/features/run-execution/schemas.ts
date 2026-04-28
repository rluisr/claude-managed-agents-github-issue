import { z } from "zod";

import { RunStatusSchema } from "@/shared/persistence/schemas";

const NonEmptyStringSchema = z.string().min(1);

export const RunExecutionInputSchema = z
  .object({
    configPath: NonEmptyStringSchema.optional(),
    dryRun: z.boolean(),
    issue: z.number().int().positive(),
    repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must match owner/name"),
    runId: NonEmptyStringSchema.optional(),
    vaultId: NonEmptyStringSchema.optional(),
  })
  .strict();

export const RunExecutionResultSchema = z
  .object({
    aborted: z.boolean(),
    decompositionPlan: z.unknown().optional(),
    errored: z
      .object({
        message: NonEmptyStringSchema,
        type: NonEmptyStringSchema,
      })
      .optional(),
    prUrl: NonEmptyStringSchema.optional(),
    runId: NonEmptyStringSchema,
    status: RunStatusSchema,
    timedOut: z.boolean(),
  })
  .strict();

export type RunExecutionInput = z.infer<typeof RunExecutionInputSchema>;
export type RunExecutionResult = z.infer<typeof RunExecutionResultSchema>;
