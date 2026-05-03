import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const SubIssueSchema = z.object({
  issueId: PositiveIntegerSchema,
  issueNumber: PositiveIntegerSchema,
  taskId: NonEmptyStringSchema,
});

export const RunStateSchema = z.object({
  branch: NonEmptyStringSchema,
  issueNumber: PositiveIntegerSchema,
  pid: PositiveIntegerSchema.optional(),
  prUrl: NonEmptyStringSchema.optional(),
  repo: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  sessionIds: z.array(NonEmptyStringSchema),
  startedAt: NonEmptyStringSchema,
  subIssues: z.array(SubIssueSchema),
  vaultId: NonEmptyStringSchema.optional(),
});

export const SessionResultSchema = z.object({
  aborted: z.boolean(),
  durationMs: NonNegativeIntegerSchema,
  errored: z.boolean(),
  eventsProcessed: NonNegativeIntegerSchema,
  idleReached: z.boolean(),
  lastEventId: z.union([NonEmptyStringSchema, z.undefined()]),
  sessionId: NonEmptyStringSchema,
  timedOut: z.boolean(),
  toolErrors: NonNegativeIntegerSchema,
  toolInvocations: NonNegativeIntegerSchema,
});

const ChildTaskErrorSchema = z.object({
  message: NonEmptyStringSchema,
  stderr: NonEmptyStringSchema.optional(),
  type: NonEmptyStringSchema,
});

export const ChildTaskResultSchema = z.object({
  commitSha: NonEmptyStringSchema.optional(),
  error: ChildTaskErrorSchema.optional(),
  filesChanged: z.array(NonEmptyStringSchema).optional(),
  success: z.boolean(),
  taskId: NonEmptyStringSchema,
  testOutput: NonEmptyStringSchema.optional(),
});

export const PromptKeySchema = z.enum([
  "parent.system",
  "child.system",
  "parent.runtime",
  "child.runtime",
]);

export type PromptKey = z.infer<typeof PromptKeySchema>;

export const EditablePromptKeySchema = z.enum(["parent.system", "child.system"]);
export type EditablePromptKey = z.infer<typeof EditablePromptKeySchema>;

export const PromptRowSchema = z.object({
  promptKey: PromptKeySchema,
  currentRevisionId: PositiveIntegerSchema,
  updatedAt: NonEmptyStringSchema,
});
export type PromptRow = z.infer<typeof PromptRowSchema>;

export const PromptRevisionSourceSchema = z.enum(["seed", "edit", "restore"]);
export type PromptRevisionSource = z.infer<typeof PromptRevisionSourceSchema>;

export const PromptRevisionRowSchema = z.object({
  id: PositiveIntegerSchema,
  promptKey: PromptKeySchema,
  body: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  bodySha256: NonEmptyStringSchema,
  source: PromptRevisionSourceSchema,
});
export type PromptRevisionRow = z.infer<typeof PromptRevisionRowSchema>;

// 100KB max, min 10 chars, must contain non-whitespace
export const PromptSaveInputSchema = z.object({
  body: z
    .string()
    .min(10)
    .max(102400)
    .refine((s) => s.trim().length > 0, { message: "body must contain non-whitespace" }),
});
export type PromptSaveInput = z.infer<typeof PromptSaveInputSchema>;

export const RestoreInputSchema = z.object({
  promptKey: EditablePromptKeySchema,
  revisionId: PositiveIntegerSchema,
});
export type RestoreInput = z.infer<typeof RestoreInputSchema>;

// --- Per-repository prompt overrides ---

// `owner/name` slug, validated server-side wherever it is parsed.
const RepoSlugSchema = z
  .string()
  .min(3)
  .max(140)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
    {
      message: "repo must match owner/name",
    },
  );
export type RepoSlug = z.infer<typeof RepoSlugSchema>;
export { RepoSlugSchema };

// Repo-level prompts target either parent or child agent only.
// Runtime templates are not configurable per repo.
export const RepoPromptAgentSchema = z.enum(["parent", "child"]);
export type RepoPromptAgent = z.infer<typeof RepoPromptAgentSchema>;

// Sources for repo prompt revisions: only edits and restores.
// (Seeding does not apply because there is no default body.)
export const RepoPromptRevisionSourceSchema = z.enum(["edit", "restore"]);
export type RepoPromptRevisionSource = z.infer<typeof RepoPromptRevisionSourceSchema>;

export const RepoPromptRowSchema = z.object({
  repo: RepoSlugSchema,
  agent: RepoPromptAgentSchema,
  currentRevisionId: PositiveIntegerSchema,
  updatedAt: NonEmptyStringSchema,
});
export type RepoPromptRow = z.infer<typeof RepoPromptRowSchema>;

export const RepoPromptRevisionRowSchema = z.object({
  id: PositiveIntegerSchema,
  repo: RepoSlugSchema,
  agent: RepoPromptAgentSchema,
  body: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  bodySha256: NonEmptyStringSchema,
  source: RepoPromptRevisionSourceSchema,
});
export type RepoPromptRevisionRow = z.infer<typeof RepoPromptRevisionRowSchema>;

// Same length window as the global prompt save schema for consistency.
export const RepoPromptSaveInputSchema = z.object({
  body: z
    .string()
    .min(10)
    .max(102400)
    .refine((s) => s.trim().length > 0, { message: "body must contain non-whitespace" }),
});
export type RepoPromptSaveInput = z.infer<typeof RepoPromptSaveInputSchema>;

export const RepoPromptRestoreInputSchema = z.object({
  repo: RepoSlugSchema,
  agent: RepoPromptAgentSchema,
  revisionId: PositiveIntegerSchema,
});
export type RepoPromptRestoreInput = z.infer<typeof RepoPromptRestoreInputSchema>;

export const RepoPromptIdentifierSchema = z.object({
  repo: RepoSlugSchema,
  agent: RepoPromptAgentSchema,
});
export type RepoPromptIdentifier = z.infer<typeof RepoPromptIdentifierSchema>;

// --- Run-level types (T4) ---
export const RunStatusSchema = z.enum(["queued", "running", "completed", "failed", "aborted"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunPhaseSchema = z.enum([
  "preflight",
  "environment",
  "vault",
  "lock",
  "session_start",
  "decomposition",
  "child_execution",
  "finalize_pr",
  "cleanup",
  "aborted",
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const RunEventKindSchema = z.enum([
  "phase",
  "session",
  "subIssue",
  "log",
  "complete",
  "error",
]);
export type RunEventKind = z.infer<typeof RunEventKindSchema>;

export const RunEventSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  ts: NonEmptyStringSchema,
  kind: RunEventKindSchema,
  payload: z.unknown(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunSummarySchema = z.object({
  runId: NonEmptyStringSchema,
  issueNumber: PositiveIntegerSchema,
  repo: NonEmptyStringSchema,
  branch: NonEmptyStringSchema.optional(),
  startedAt: NonEmptyStringSchema,
  status: RunStatusSchema,
  phase: RunPhaseSchema.optional(),
  prUrl: NonEmptyStringSchema.optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;
