import { z } from "zod";

export const RunStartInputSchema = z
  .object({
    configPath: z.string().min(1).optional(),
    dryRun: z.boolean().default(false),
    issue: z.number().int().positive(),
    repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must match owner/name"),
    vaultId: z.string().min(1).optional(),
  })
  .strict();

export type RunStartInput = z.infer<typeof RunStartInputSchema>;
