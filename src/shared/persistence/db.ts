import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { createLogger } from "@/shared/logging";
import type {
  EditablePromptKey,
  PromptKey,
  PromptRevisionRow,
  PromptRevisionSource,
  PromptRow,
  RepoPromptAgent,
  RepoPromptRevisionRow,
  RepoPromptRevisionSource,
  RepoPromptRow,
} from "@/shared/persistence/schemas";
import {
  ChildTaskResultSchema,
  EditablePromptKeySchema,
  PromptKeySchema,
  PromptRevisionRowSchema,
  PromptRevisionSourceSchema,
  PromptRowSchema,
  PromptSaveInputSchema,
  RepoPromptAgentSchema,
  RepoPromptIdentifierSchema,
  RepoPromptRestoreInputSchema,
  RepoPromptRevisionRowSchema,
  RepoPromptRevisionSourceSchema,
  RepoPromptRowSchema,
  RepoPromptSaveInputSchema,
  RepoSlugSchema,
  RestoreInputSchema,
  RunEventKindSchema,
  RunEventSchema,
  RunPhaseSchema,
  RunStateSchema,
  RunStatusSchema,
  RunSummarySchema,
  SessionResultSchema,
  SubIssueSchema,
} from "@/shared/persistence/schemas";
import type { SessionResult } from "@/shared/session";
import type {
  ChildTaskResult,
  RunEvent,
  RunEventKind,
  RunPhase,
  RunState,
  RunStatus,
  RunSummary,
} from "@/shared/types";

type DbLogger = Pick<ReturnType<typeof createLogger>, "warn">;

type StatementLike<Row = unknown, Params extends unknown[] = unknown[]> = {
  all(...params: Params): Row[];
  get(...params: Params): Row | null | undefined;
  run(...params: Params): unknown;
};

type DatabaseLike = {
  close(): void;
  exec(sql: string): void;
  query<Row = unknown, Params extends unknown[] = unknown[]>(
    sql: string,
  ): StatementLike<Row, Params>;
  transaction<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void;
};

type DatabaseConstructor = new (databasePath: string) => DatabaseLike;

const require = createRequire(import.meta.url);
const { Database } = require("bun:sqlite") as { Database: DatabaseConstructor };

const DEFAULT_DB_PATH = ".github-issue-agent/dashboard.db";
const DEFAULT_LIST_RUNS_LIMIT = 100;
const RUN_ID_SCHEMA = RunStateSchema.shape.runId;
const REPO_SCHEMA = RunStateSchema.shape.repo;
const STORED_CHILD_TASK_ERROR_SCHEMA = ChildTaskResultSchema.shape.error.unwrap();
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INTEGER,
    branch TEXT,
    started_at TEXT,
    pr_url TEXT,
    vault_id TEXT,
    pid INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',
    phase TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    events_processed INTEGER,
    tool_invocations INTEGER,
    tool_errors INTEGER,
    duration_ms INTEGER,
    aborted INTEGER,
    errored INTEGER,
    idle_reached INTEGER,
    timed_out INTEGER,
    last_event_id TEXT
  );
  CREATE TABLE IF NOT EXISTS run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sub_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    issue_id INTEGER NOT NULL,
    issue_number INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS child_task_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    success INTEGER NOT NULL,
    commit_sha TEXT,
    files_changed TEXT,
    test_output TEXT,
    error_type TEXT,
    error_message TEXT
  );
  CREATE TABLE IF NOT EXISTS prompts (
    prompt_key TEXT PRIMARY KEY,
    current_revision_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prompt_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_key TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('seed','edit','restore'))
  );
  CREATE TABLE IF NOT EXISTS repo_prompts (
    repo TEXT NOT NULL,
    agent TEXT NOT NULL CHECK(agent IN ('parent','child')),
    current_revision_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo, agent)
  );
  CREATE TABLE IF NOT EXISTS repo_prompt_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    agent TEXT NOT NULL CHECK(agent IN ('parent','child')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('edit','restore'))
  );
  CREATE INDEX IF NOT EXISTS idx_runs_repo ON runs(repo);
  CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run_id);
  CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
  CREATE INDEX IF NOT EXISTS idx_sub_issues_run ON sub_issues(run_id);
  CREATE INDEX IF NOT EXISTS idx_ctr_run ON child_task_results(run_id);
  CREATE INDEX IF NOT EXISTS idx_prompt_revisions_key ON prompt_revisions(prompt_key, id DESC);
  CREATE INDEX IF NOT EXISTS idx_prompt_revisions_sha ON prompt_revisions(prompt_key, body_sha256);
  CREATE INDEX IF NOT EXISTS idx_repo_prompt_revisions_target
    ON repo_prompt_revisions(repo, agent, id DESC);
  CREATE INDEX IF NOT EXISTS idx_repo_prompt_revisions_sha
    ON repo_prompt_revisions(repo, agent, body_sha256);
  CREATE INDEX IF NOT EXISTS idx_repo_prompts_repo ON repo_prompts(repo);
`;

type RunRow = {
  runId: string;
  repo: string;
  issueNumber: number | null;
  branch: string | null;
  startedAt: string | null;
  prUrl: string | null;
  vaultId: string | null;
  pid: number | null;
};

type RunsTableColumnRow = {
  name: string;
};

type RunSummaryRow = {
  branch: string | null;
  issueNumber: number | null;
  phase: string | null;
  prUrl: string | null;
  repo: string;
  runId: string;
  startedAt: string | null;
  status: string;
};

type RunEventRow = {
  id: string;
  runId: string;
  ts: string;
  kind: string;
  payload: string;
};

type StatementRunResult = {
  changes?: number;
};

type SessionRow = {
  sessionId: string;
  runId: string;
  eventsProcessed: number;
  toolInvocations: number;
  toolErrors: number;
  durationMs: number;
  aborted: number;
  errored: number;
  idleReached: number;
  timedOut: number;
  lastEventId: string | null;
};

type SubIssueRow = {
  taskId: string;
  issueId: number;
  issueNumber: number;
};

type ChildTaskResultRow = {
  taskId: string;
  success: number;
  commitSha: string | null;
  filesChanged: string | null;
  testOutput: string | null;
  errorType: string | null;
  errorMessage: string | null;
};

type RepositorySummaryRow = {
  repo: string;
  runCount: number;
  lastRunAt: string | null;
};

type PromptWithBodyRow = PromptRow & {
  body: string;
};

type PromptCurrentRevisionRow = PromptRevisionRow & {
  currentRevisionId: number;
  updatedAt: string;
};

type PromptSavePublicInput = {
  body: string;
  key: EditablePromptKey;
  source: "edit" | "seed";
};

type PromptSaveTransactionInput = {
  allowDuplicateBody: boolean;
  body: string;
  bodySha256: string;
  key: EditablePromptKey;
  now: string;
  source: PromptRevisionSource;
};

type PromptSaveResult = {
  isNoChange: boolean;
  revisionId: number;
};

type PromptRestoreTransactionInput = {
  key: EditablePromptKey;
  revisionId: number;
  now: string;
};

type PromptRestoreResult = {
  alreadyCurrent: boolean;
  newRevisionId: number;
};

type PromptSeedTransactionInput = {
  body: string;
  bodySha256: string;
  key: PromptKey;
  now: string;
  source: PromptRevisionSource;
};

type PromptSeedResult = {
  seeded: boolean;
};

type RepoPromptWithBodyRow = RepoPromptRow & {
  body: string;
};

type RepoPromptCurrentRevisionRow = RepoPromptRevisionRow & {
  currentRevisionId: number;
  updatedAt: string;
};

type RepoPromptSaveTransactionInput = {
  agent: RepoPromptAgent;
  allowDuplicateBody: boolean;
  body: string;
  bodySha256: string;
  now: string;
  repo: string;
  source: RepoPromptRevisionSource;
};

type RepoPromptSaveResult = {
  isNoChange: boolean;
  revisionId: number;
};

type RepoPromptRestoreTransactionInput = {
  agent: RepoPromptAgent;
  now: string;
  repo: string;
  revisionId: number;
};

type RepoPromptRestoreResult = {
  alreadyCurrent: boolean;
  newRevisionId: number;
};

type RepoPromptOverrideSummaryRow = {
  repo: string;
  agent: RepoPromptAgent;
  currentRevisionId: number;
  updatedAt: string;
  revisionCount: number;
};

type PreparedStatements = {
  deleteSubIssuesByRun: StatementLike<unknown, [string]>;
  getChildTaskResultsByRun: StatementLike<ChildTaskResultRow, [string]>;
  getPromptByKey: StatementLike<PromptWithBodyRow, [PromptKey]>;
  getPromptCurrentRevisionByKey: StatementLike<PromptCurrentRevisionRow, [PromptKey]>;
  getPromptRevisionByKeyAndId: StatementLike<PromptRevisionRow, [PromptKey, number]>;
  getPromptRevisionsByKey: StatementLike<PromptRevisionRow, [PromptKey]>;
  getPromptRowByKey: StatementLike<PromptRow, [PromptKey]>;
  getRunById: StatementLike<RunRow, [string]>;
  getRunsByRepo: StatementLike<RunRow, [string]>;
  insertRunEvent: StatementLike<unknown, [string, string, string, RunEventKind, string]>;
  getSessionIdsByRun: StatementLike<{ sessionId: string }, [string]>;
  getSessionsByRun: StatementLike<SessionRow, [string]>;
  getSubIssuesByRun: StatementLike<SubIssueRow, [string]>;
  insertChildTaskResult: StatementLike<
    unknown,
    [
      string,
      string,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >;
  insertPrompt: StatementLike<unknown, [PromptKey, number, string]>;
  insertPromptRevision: StatementLike<
    { id: number },
    [PromptKey, string, string, string, PromptRevisionSource]
  >;
  insertRun: StatementLike<
    unknown,
    [string, string, number, string, string, string | null, string | null, number | null]
  >;
  insertSession: StatementLike<
    unknown,
    [string, string, number, number, number, number, number, number, number, number, string | null]
  >;
  insertSubIssue: StatementLike<unknown, [string, string, number, number]>;
  listRepositories: StatementLike<RepositorySummaryRow, []>;
  listRuns: StatementLike<RunSummaryRow, [number]>;
  listRunsByRepo: StatementLike<RunSummaryRow, [string, number]>;
  listRunsByStatus: StatementLike<RunSummaryRow, [RunStatus, number]>;
  listRunsByStatusAndRepo: StatementLike<RunSummaryRow, [RunStatus, string, number]>;
  listRunEvents: StatementLike<RunEventRow, [string, number]>;
  listRunEventsAfter: StatementLike<RunEventRow, [string, string, number]>;
  resyncOrphanedRuns: StatementLike<unknown, []>;
  setRunPhase: StatementLike<unknown, [RunPhase | null, string]>;
  setRunStatus: StatementLike<unknown, [RunStatus, string]>;
  upsertPrompt: StatementLike<unknown, [PromptKey, number, string]>;
  // Repo prompts
  deleteRepoPromptByKey: StatementLike<unknown, [string, RepoPromptAgent]>;
  deleteRepoPromptRevisionsByKey: StatementLike<unknown, [string, RepoPromptAgent]>;
  getRepoPromptByKey: StatementLike<RepoPromptWithBodyRow, [string, RepoPromptAgent]>;
  getRepoPromptCurrentRevisionByKey: StatementLike<
    RepoPromptCurrentRevisionRow,
    [string, RepoPromptAgent]
  >;
  getRepoPromptRevisionByKeyAndId: StatementLike<
    RepoPromptRevisionRow,
    [string, RepoPromptAgent, number]
  >;
  getRepoPromptRevisionsByKey: StatementLike<RepoPromptRevisionRow, [string, RepoPromptAgent]>;
  getRepoPromptRowByKey: StatementLike<RepoPromptRow, [string, RepoPromptAgent]>;
  insertRepoPrompt: StatementLike<unknown, [string, RepoPromptAgent, number, string]>;
  insertRepoPromptRevision: StatementLike<
    { id: number },
    [string, RepoPromptAgent, string, string, string, RepoPromptRevisionSource]
  >;
  listRepoPromptOverrides: StatementLike<RepoPromptOverrideSummaryRow, []>;
  listRepoPromptOverridesByRepo: StatementLike<RepoPromptOverrideSummaryRow, [string]>;
  upsertRepoPrompt: StatementLike<unknown, [string, RepoPromptAgent, number, string]>;
};

type PreparedRuntime = {
  replaceRunAndSubIssues: (run: RunState) => void;
  restorePromptToRevisionTransaction: (
    input: PromptRestoreTransactionInput,
    setResult: (result: PromptRestoreResult) => void,
  ) => void;
  savePromptRevisionTransaction: (
    input: PromptSaveTransactionInput,
    setResult: (result: PromptSaveResult) => void,
  ) => void;
  saveRepoPromptRevisionTransaction: (
    input: RepoPromptSaveTransactionInput,
    setResult: (result: RepoPromptSaveResult) => void,
  ) => void;
  restoreRepoPromptToRevisionTransaction: (
    input: RepoPromptRestoreTransactionInput,
    setResult: (result: RepoPromptRestoreResult) => void,
  ) => void;
  deleteRepoPromptTransaction: (
    input: { agent: RepoPromptAgent; repo: string },
    setResult: (result: { deleted: boolean }) => void,
  ) => void;
  seedPromptIfMissingTransaction: (
    input: PromptSeedTransactionInput,
    setResult: (result: PromptSeedResult) => void,
  ) => void;
  statements: PreparedStatements;
};

export type DbModuleDependencies = {
  cwd: () => string;
  logger?: DbLogger;
  openDatabase: (databasePath: string) => DatabaseLike;
};

function resolveDatabasePath(databasePath: string | undefined, cwd: string): string {
  if (databasePath === ":memory:") {
    return databasePath;
  }

  return resolve(cwd, databasePath ?? DEFAULT_DB_PATH);
}

function decodeChildTaskError(
  errorType: string | null,
  errorMessage: string | null,
  logger?: DbLogger,
): ChildTaskResult["error"] | undefined {
  if (errorType === null || errorMessage === null) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(errorMessage);
    const decoded = STORED_CHILD_TASK_ERROR_SCHEMA.safeParse({
      ...parsed,
      type: errorType,
    });

    if (decoded.success) {
      return decoded.data;
    }
  } catch (err) {
    logger?.warn(
      { err },
      "failed to parse stored child task error JSON; using plain text fallback",
    );
  }

  return {
    message: errorMessage,
    type: errorType,
  };
}

function parseFilesChanged(filesChanged: string | null): string[] | undefined {
  if (filesChanged === null) {
    return undefined;
  }

  return ChildTaskResultSchema.shape.filesChanged.unwrap().parse(JSON.parse(filesChanged));
}

function normalizePromptBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function hashPromptBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function parsePromptWithBody(row: PromptWithBodyRow): {
  body: string;
  currentRevisionId: number;
  promptKey: PromptKey;
  updatedAt: string;
} {
  const promptRow = PromptRowSchema.parse(row);

  return {
    body: PromptRevisionRowSchema.shape.body.parse(row.body),
    currentRevisionId: promptRow.currentRevisionId,
    promptKey: promptRow.promptKey,
    updatedAt: promptRow.updatedAt,
  };
}

function parsePromptCurrentRevision(row: PromptCurrentRevisionRow): PromptCurrentRevisionRow {
  const revisionRow = PromptRevisionRowSchema.parse(row);
  const promptRow = PromptRowSchema.parse(row);

  return {
    ...revisionRow,
    currentRevisionId: promptRow.currentRevisionId,
    updatedAt: promptRow.updatedAt,
  };
}

function parseInsertedPromptRevisionId(row: { id: number } | null | undefined): number {
  if (row == null) {
    throw new Error("Failed to insert prompt revision");
  }

  return PromptRevisionRowSchema.shape.id.parse(row.id);
}

function parseInsertedRepoPromptRevisionId(row: { id: number } | null | undefined): number {
  if (row == null) {
    throw new Error("Failed to insert repo prompt revision");
  }

  return RepoPromptRevisionRowSchema.shape.id.parse(row.id);
}

function parseRepoPromptWithBody(row: RepoPromptWithBodyRow): {
  agent: RepoPromptAgent;
  body: string;
  currentRevisionId: number;
  repo: string;
  updatedAt: string;
} {
  const promptRow = RepoPromptRowSchema.parse(row);

  return {
    agent: promptRow.agent,
    body: RepoPromptRevisionRowSchema.shape.body.parse(row.body),
    currentRevisionId: promptRow.currentRevisionId,
    repo: promptRow.repo,
    updatedAt: promptRow.updatedAt,
  };
}

function parseRepoPromptCurrentRevision(
  row: RepoPromptCurrentRevisionRow,
): RepoPromptCurrentRevisionRow {
  const revisionRow = RepoPromptRevisionRowSchema.parse(row);
  const promptRow = RepoPromptRowSchema.parse(row);

  return {
    ...revisionRow,
    currentRevisionId: promptRow.currentRevisionId,
    updatedAt: promptRow.updatedAt,
  };
}

function normalizeListRunsLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIST_RUNS_LIMIT;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("listRuns limit must be a positive integer");
  }

  return limit;
}

function normalizeRunEventsLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return -1;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("listRunEvents limit must be a positive integer");
  }

  return limit;
}

function stringifyRunEventPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);

  if (serialized === undefined) {
    throw new Error("run event payload must be JSON-serializable");
  }

  return serialized;
}

function parseRunEventRow(row: RunEventRow): RunEvent {
  const parsedEvent = RunEventSchema.parse({
    id: row.id,
    kind: RunEventKindSchema.parse(row.kind),
    payload: JSON.parse(row.payload),
    runId: row.runId,
    ts: row.ts,
  });

  return {
    id: parsedEvent.id,
    kind: parsedEvent.kind,
    payload: parsedEvent.payload,
    runId: parsedEvent.runId,
    ts: parsedEvent.ts,
  };
}

function readChanges(result: unknown): number {
  const maybeResult = result as StatementRunResult | undefined;

  return maybeResult?.changes ?? 0;
}

function parseRunSummaryRow(row: RunSummaryRow): RunSummary {
  return RunSummarySchema.parse({
    branch: row.branch ?? undefined,
    issueNumber: row.issueNumber,
    phase: row.phase ?? undefined,
    prUrl: row.prUrl ?? undefined,
    repo: row.repo,
    runId: row.runId,
    startedAt: row.startedAt,
    status: row.status,
  });
}

export function createDbModule(dbPath?: string, overrides: Partial<DbModuleDependencies> = {}) {
  const dependencies: DbModuleDependencies = {
    cwd: () => process.cwd(),
    openDatabase: (databasePath) => new Database(databasePath),
    ...overrides,
  };
  const db = dependencies.openDatabase(resolveDatabasePath(dbPath, dependencies.cwd()));
  let runtime: PreparedRuntime | null = null;

  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");

  function hasRunsColumn(name: string): boolean {
    return (
      db
        .query<RunsTableColumnRow, [string]>(
          "SELECT name FROM pragma_table_info('runs') WHERE name = ?1",
        )
        .get(name) != null
    );
  }

  function migrateRunsAddColumn(name: string, sql: string): void {
    if (hasRunsColumn(name)) {
      return;
    }

    db.exec(sql);
  }

  function migrateRunsColumns(): void {
    migrateRunsAddColumn(
      "status",
      "ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'",
    );
    migrateRunsAddColumn("phase", "ALTER TABLE runs ADD COLUMN phase TEXT");
    migrateRunsAddColumn("pid", "ALTER TABLE runs ADD COLUMN pid INTEGER");
  }

  function getRuntime(): PreparedRuntime {
    if (runtime !== null) {
      return runtime;
    }

    db.exec(SCHEMA_SQL);
    migrateRunsColumns();

    const statements: PreparedStatements = {
      deleteSubIssuesByRun: db.query("DELETE FROM sub_issues WHERE run_id = ?1"),
      getChildTaskResultsByRun: db.query<ChildTaskResultRow, [string]>(
        `SELECT
           task_id AS taskId,
           success,
           commit_sha AS commitSha,
           files_changed AS filesChanged,
           test_output AS testOutput,
           error_type AS errorType,
           error_message AS errorMessage
         FROM child_task_results
         WHERE run_id = ?1
         ORDER BY id ASC`,
      ),
      getPromptByKey: db.query<PromptWithBodyRow, [PromptKey]>(
        `SELECT
           p.prompt_key AS promptKey,
           p.current_revision_id AS currentRevisionId,
           r.body,
           p.updated_at AS updatedAt
         FROM prompts p
         JOIN prompt_revisions r
           ON r.id = p.current_revision_id
          AND r.prompt_key = p.prompt_key
         WHERE p.prompt_key = ?1`,
      ),
      getPromptCurrentRevisionByKey: db.query<PromptCurrentRevisionRow, [PromptKey]>(
        `SELECT
           r.id,
           r.prompt_key AS promptKey,
           r.body,
           r.created_at AS createdAt,
           r.body_sha256 AS bodySha256,
           r.source,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt
         FROM prompts p
         JOIN prompt_revisions r
           ON r.id = p.current_revision_id
          AND r.prompt_key = p.prompt_key
         WHERE p.prompt_key = ?1`,
      ),
      getPromptRevisionByKeyAndId: db.query<PromptRevisionRow, [PromptKey, number]>(
        `SELECT
           id,
           prompt_key AS promptKey,
           body,
           created_at AS createdAt,
           body_sha256 AS bodySha256,
           source
         FROM prompt_revisions
         WHERE prompt_key = ?1
           AND id = ?2`,
      ),
      getPromptRevisionsByKey: db.query<PromptRevisionRow, [PromptKey]>(
        `SELECT
           id,
           prompt_key AS promptKey,
           body,
           created_at AS createdAt,
           body_sha256 AS bodySha256,
           source
         FROM prompt_revisions
         WHERE prompt_key = ?1
         ORDER BY id DESC`,
      ),
      getPromptRowByKey: db.query<PromptRow, [PromptKey]>(
        `SELECT
           prompt_key AS promptKey,
           current_revision_id AS currentRevisionId,
           updated_at AS updatedAt
         FROM prompts
         WHERE prompt_key = ?1`,
      ),
      getRunById: db.query<RunRow, [string]>(
        `SELECT
           run_id AS runId,
           repo,
           issue_number AS issueNumber,
           branch,
           started_at AS startedAt,
           pr_url AS prUrl,
           vault_id AS vaultId,
           pid
         FROM runs
         WHERE run_id = ?1`,
      ),
      getRunsByRepo: db.query<RunRow, [string]>(
        `SELECT
           run_id AS runId,
           repo,
           issue_number AS issueNumber,
           branch,
           started_at AS startedAt,
           pr_url AS prUrl,
           vault_id AS vaultId,
           pid
         FROM runs
         WHERE repo = ?1
         ORDER BY started_at DESC`,
      ),
      getSessionIdsByRun: db.query<{ sessionId: string }, [string]>(
        `SELECT session_id AS sessionId
         FROM sessions
         WHERE run_id = ?1
         ORDER BY rowid ASC`,
      ),
      getSessionsByRun: db.query<SessionRow, [string]>(
        `SELECT
           session_id AS sessionId,
           run_id AS runId,
           events_processed AS eventsProcessed,
           tool_invocations AS toolInvocations,
           tool_errors AS toolErrors,
           duration_ms AS durationMs,
           aborted,
           errored,
           idle_reached AS idleReached,
           timed_out AS timedOut,
           last_event_id AS lastEventId
         FROM sessions
         WHERE run_id = ?1
         ORDER BY rowid ASC`,
      ),
      getSubIssuesByRun: db.query<SubIssueRow, [string]>(
        `SELECT
           task_id AS taskId,
           issue_id AS issueId,
           issue_number AS issueNumber
         FROM sub_issues
         WHERE run_id = ?1
         ORDER BY id ASC`,
      ),
      insertChildTaskResult: db.query(
        `INSERT INTO child_task_results (
           run_id,
           task_id,
           success,
           commit_sha,
           files_changed,
           test_output,
           error_type,
           error_message
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ),
      insertPrompt: db.query(
        `INSERT INTO prompts (
           prompt_key,
           current_revision_id,
           updated_at
         ) VALUES (?1, ?2, ?3)`,
      ),
      insertPromptRevision: db.query<
        { id: number },
        [PromptKey, string, string, string, PromptRevisionSource]
      >(
        `INSERT INTO prompt_revisions (
           prompt_key,
           body,
           created_at,
           body_sha256,
           source
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         RETURNING id`,
      ),
      insertRun: db.query(
        `INSERT INTO runs (
            run_id,
            repo,
           issue_number,
           branch,
           started_at,
           pr_url,
           vault_id,
           pid
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(run_id) DO UPDATE SET
           repo = excluded.repo,
           issue_number = excluded.issue_number,
           branch = excluded.branch,
           started_at = excluded.started_at,
            pr_url = excluded.pr_url,
            vault_id = excluded.vault_id,
            pid = excluded.pid`,
      ),
      insertRunEvent: db.query(
        `INSERT INTO run_events (
           id,
           run_id,
           ts,
           kind,
           payload
         ) VALUES (?1, ?2, ?3, ?4, ?5)`,
      ),
      insertSession: db.query(
        `INSERT OR REPLACE INTO sessions (
            session_id,
            run_id,
           events_processed,
           tool_invocations,
           tool_errors,
           duration_ms,
           aborted,
           errored,
           idle_reached,
           timed_out,
           last_event_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ),
      insertSubIssue: db.query(
        `INSERT INTO sub_issues (
           run_id,
           task_id,
           issue_id,
           issue_number
         ) VALUES (?1, ?2, ?3, ?4)`,
      ),
      listRepositories: db.query<RepositorySummaryRow>(
        `SELECT
           repo,
           COUNT(*) AS runCount,
           MAX(started_at) AS lastRunAt
         FROM runs
           GROUP BY repo
           ORDER BY MAX(started_at) DESC`,
      ),
      listRuns: db.query<RunSummaryRow, [number]>(
        `SELECT
           run_id AS runId,
           issue_number AS issueNumber,
           repo,
           branch,
           started_at AS startedAt,
           status,
           phase,
           pr_url AS prUrl
         FROM runs
         ORDER BY started_at DESC
         LIMIT ?1`,
      ),
      listRunsByRepo: db.query<RunSummaryRow, [string, number]>(
        `SELECT
           run_id AS runId,
           issue_number AS issueNumber,
           repo,
           branch,
           started_at AS startedAt,
           status,
           phase,
           pr_url AS prUrl
         FROM runs
         WHERE repo = ?1
         ORDER BY started_at DESC
         LIMIT ?2`,
      ),
      listRunsByStatus: db.query<RunSummaryRow, [RunStatus, number]>(
        `SELECT
           run_id AS runId,
           issue_number AS issueNumber,
           repo,
           branch,
           started_at AS startedAt,
           status,
           phase,
           pr_url AS prUrl
         FROM runs
         WHERE status = ?1
         ORDER BY started_at DESC
         LIMIT ?2`,
      ),
      listRunsByStatusAndRepo: db.query<RunSummaryRow, [RunStatus, string, number]>(
        `SELECT
            run_id AS runId,
           issue_number AS issueNumber,
           repo,
           branch,
           started_at AS startedAt,
           status,
           phase,
           pr_url AS prUrl
         FROM runs
         WHERE status = ?1
           AND repo = ?2
          ORDER BY started_at DESC
          LIMIT ?3`,
      ),
      listRunEvents: db.query<RunEventRow, [string, number]>(
        `SELECT
           id,
           run_id AS runId,
           ts,
           kind,
           payload
         FROM run_events
         WHERE run_id = ?1
         ORDER BY id ASC
         LIMIT ?2`,
      ),
      listRunEventsAfter: db.query<RunEventRow, [string, string, number]>(
        `SELECT
           id,
           run_id AS runId,
           ts,
           kind,
           payload
         FROM run_events
         WHERE run_id = ?1
           AND id > ?2
         ORDER BY id ASC
         LIMIT ?3`,
      ),
      resyncOrphanedRuns: db.query(
        `UPDATE runs
          SET status = 'aborted'
         WHERE status = 'running'
            OR status = 'queued'`,
      ),
      setRunPhase: db.query(
        `UPDATE runs
         SET phase = ?1
         WHERE run_id = ?2`,
      ),
      setRunStatus: db.query(
        `UPDATE runs
         SET status = ?1
         WHERE run_id = ?2`,
      ),
      upsertPrompt: db.query(
        `INSERT INTO prompts (
           prompt_key,
           current_revision_id,
           updated_at
         ) VALUES (?1, ?2, ?3)
         ON CONFLICT(prompt_key) DO UPDATE SET
           current_revision_id = excluded.current_revision_id,
           updated_at = excluded.updated_at`,
      ),
      deleteRepoPromptByKey: db.query("DELETE FROM repo_prompts WHERE repo = ?1 AND agent = ?2"),
      deleteRepoPromptRevisionsByKey: db.query(
        "DELETE FROM repo_prompt_revisions WHERE repo = ?1 AND agent = ?2",
      ),
      getRepoPromptByKey: db.query<RepoPromptWithBodyRow, [string, RepoPromptAgent]>(
        `SELECT
           p.repo AS repo,
           p.agent AS agent,
           p.current_revision_id AS currentRevisionId,
           r.body,
           p.updated_at AS updatedAt
         FROM repo_prompts p
         JOIN repo_prompt_revisions r
           ON r.id = p.current_revision_id
          AND r.repo = p.repo
          AND r.agent = p.agent
         WHERE p.repo = ?1
           AND p.agent = ?2`,
      ),
      getRepoPromptCurrentRevisionByKey: db.query<
        RepoPromptCurrentRevisionRow,
        [string, RepoPromptAgent]
      >(
        `SELECT
           r.id,
           r.repo,
           r.agent,
           r.body,
           r.created_at AS createdAt,
           r.body_sha256 AS bodySha256,
           r.source,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt
         FROM repo_prompts p
         JOIN repo_prompt_revisions r
           ON r.id = p.current_revision_id
          AND r.repo = p.repo
          AND r.agent = p.agent
         WHERE p.repo = ?1
           AND p.agent = ?2`,
      ),
      getRepoPromptRevisionByKeyAndId: db.query<
        RepoPromptRevisionRow,
        [string, RepoPromptAgent, number]
      >(
        `SELECT
           id,
           repo,
           agent,
           body,
           created_at AS createdAt,
           body_sha256 AS bodySha256,
           source
         FROM repo_prompt_revisions
         WHERE repo = ?1
           AND agent = ?2
           AND id = ?3`,
      ),
      getRepoPromptRevisionsByKey: db.query<RepoPromptRevisionRow, [string, RepoPromptAgent]>(
        `SELECT
           id,
           repo,
           agent,
           body,
           created_at AS createdAt,
           body_sha256 AS bodySha256,
           source
         FROM repo_prompt_revisions
         WHERE repo = ?1
           AND agent = ?2
         ORDER BY id DESC`,
      ),
      getRepoPromptRowByKey: db.query<RepoPromptRow, [string, RepoPromptAgent]>(
        `SELECT
           repo,
           agent,
           current_revision_id AS currentRevisionId,
           updated_at AS updatedAt
         FROM repo_prompts
         WHERE repo = ?1
           AND agent = ?2`,
      ),
      insertRepoPrompt: db.query(
        `INSERT INTO repo_prompts (
           repo,
           agent,
           current_revision_id,
           updated_at
         ) VALUES (?1, ?2, ?3, ?4)`,
      ),
      insertRepoPromptRevision: db.query<
        { id: number },
        [string, RepoPromptAgent, string, string, string, RepoPromptRevisionSource]
      >(
        `INSERT INTO repo_prompt_revisions (
           repo,
           agent,
           body,
           created_at,
           body_sha256,
           source
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         RETURNING id`,
      ),
      listRepoPromptOverrides: db.query<RepoPromptOverrideSummaryRow>(
        `SELECT
           p.repo AS repo,
           p.agent AS agent,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM repo_prompt_revisions r
              WHERE r.repo = p.repo AND r.agent = p.agent) AS revisionCount
         FROM repo_prompts p
         ORDER BY p.updated_at DESC`,
      ),
      listRepoPromptOverridesByRepo: db.query<RepoPromptOverrideSummaryRow, [string]>(
        `SELECT
           p.repo AS repo,
           p.agent AS agent,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM repo_prompt_revisions r
              WHERE r.repo = p.repo AND r.agent = p.agent) AS revisionCount
         FROM repo_prompts p
         WHERE p.repo = ?1
         ORDER BY p.agent ASC`,
      ),
      upsertRepoPrompt: db.query(
        `INSERT INTO repo_prompts (
           repo,
           agent,
           current_revision_id,
           updated_at
         ) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(repo, agent) DO UPDATE SET
           current_revision_id = excluded.current_revision_id,
           updated_at = excluded.updated_at`,
      ),
    };
    const replaceRunAndSubIssues = db.transaction((run: RunState) => {
      statements.insertRun.run(
        run.runId,
        run.repo,
        run.issueNumber,
        run.branch,
        run.startedAt,
        run.prUrl ?? null,
        run.vaultId ?? null,
        run.pid ?? null,
      );

      statements.deleteSubIssuesByRun.run(run.runId);

      for (const subIssue of run.subIssues) {
        statements.insertSubIssue.run(
          run.runId,
          subIssue.taskId,
          subIssue.issueId,
          subIssue.issueNumber,
        );
      }
    });

    function insertPromptRevision(input: {
      body: string;
      bodySha256: string;
      key: PromptKey;
      now: string;
      source: PromptRevisionSource;
    }): number {
      return parseInsertedPromptRevisionId(
        statements.insertPromptRevision.get(
          input.key,
          input.body,
          input.now,
          input.bodySha256,
          input.source,
        ),
      );
    }

    function insertRevisionAndUpsertPrompt(input: {
      body: string;
      bodySha256: string;
      key: PromptKey;
      now: string;
      source: PromptRevisionSource;
    }): number {
      const revisionId = insertPromptRevision(input);
      statements.upsertPrompt.run(input.key, revisionId, input.now);
      return revisionId;
    }

    const savePromptRevisionTransaction = db.transaction(
      (input: PromptSaveTransactionInput, setResult: (result: PromptSaveResult) => void) => {
        const currentRow = statements.getPromptCurrentRevisionByKey.get(input.key);

        if (currentRow != null) {
          const currentRevision = parsePromptCurrentRevision(currentRow);

          if (!input.allowDuplicateBody && currentRevision.bodySha256 === input.bodySha256) {
            setResult({
              isNoChange: true,
              revisionId: currentRevision.currentRevisionId,
            });
            return;
          }
        }

        const revisionId = insertRevisionAndUpsertPrompt(input);
        setResult({ isNoChange: false, revisionId });
      },
    );

    const restorePromptToRevisionTransaction = db.transaction(
      (input: PromptRestoreTransactionInput, setResult: (result: PromptRestoreResult) => void) => {
        const targetRow = statements.getPromptRevisionByKeyAndId.get(input.key, input.revisionId);

        if (targetRow == null) {
          throw new Error(`Prompt revision ${input.revisionId} not found for ${input.key}`);
        }

        const targetRevision = PromptRevisionRowSchema.parse(targetRow);
        const currentRow = statements.getPromptCurrentRevisionByKey.get(input.key);

        if (currentRow != null) {
          const currentRevision = parsePromptCurrentRevision(currentRow);

          if (targetRevision.body === currentRevision.body) {
            setResult({
              alreadyCurrent: true,
              newRevisionId: currentRevision.currentRevisionId,
            });
            return;
          }
        }

        const newRevisionId = insertRevisionAndUpsertPrompt({
          body: targetRevision.body,
          bodySha256: hashPromptBody(targetRevision.body),
          key: input.key,
          now: input.now,
          source: PromptRevisionSourceSchema.parse("restore"),
        });
        setResult({ alreadyCurrent: false, newRevisionId });
      },
    );

    const seedPromptIfMissingTransaction = db.transaction(
      (input: PromptSeedTransactionInput, setResult: (result: PromptSeedResult) => void) => {
        const promptRow = statements.getPromptRowByKey.get(input.key);

        if (promptRow != null) {
          PromptRowSchema.parse(promptRow);
          setResult({ seeded: false });
          return;
        }

        const revisionId = insertPromptRevision(input);
        statements.insertPrompt.run(input.key, revisionId, input.now);
        setResult({ seeded: true });
      },
    );

    function insertRepoPromptRevisionRow(input: {
      agent: RepoPromptAgent;
      body: string;
      bodySha256: string;
      now: string;
      repo: string;
      source: RepoPromptRevisionSource;
    }): number {
      return parseInsertedRepoPromptRevisionId(
        statements.insertRepoPromptRevision.get(
          input.repo,
          input.agent,
          input.body,
          input.now,
          input.bodySha256,
          input.source,
        ),
      );
    }

    function insertRepoPromptRevisionAndUpsert(input: {
      agent: RepoPromptAgent;
      body: string;
      bodySha256: string;
      now: string;
      repo: string;
      source: RepoPromptRevisionSource;
    }): number {
      const revisionId = insertRepoPromptRevisionRow(input);
      statements.upsertRepoPrompt.run(input.repo, input.agent, revisionId, input.now);
      return revisionId;
    }

    const saveRepoPromptRevisionTransaction = db.transaction(
      (
        input: RepoPromptSaveTransactionInput,
        setResult: (result: RepoPromptSaveResult) => void,
      ) => {
        const currentRow = statements.getRepoPromptCurrentRevisionByKey.get(
          input.repo,
          input.agent,
        );

        if (currentRow != null) {
          const currentRevision = parseRepoPromptCurrentRevision(currentRow);

          if (!input.allowDuplicateBody && currentRevision.bodySha256 === input.bodySha256) {
            setResult({
              isNoChange: true,
              revisionId: currentRevision.currentRevisionId,
            });
            return;
          }
        }

        const revisionId = insertRepoPromptRevisionAndUpsert(input);
        setResult({ isNoChange: false, revisionId });
      },
    );

    const restoreRepoPromptToRevisionTransaction = db.transaction(
      (
        input: RepoPromptRestoreTransactionInput,
        setResult: (result: RepoPromptRestoreResult) => void,
      ) => {
        const targetRow = statements.getRepoPromptRevisionByKeyAndId.get(
          input.repo,
          input.agent,
          input.revisionId,
        );

        if (targetRow == null) {
          throw new Error(
            `Repo prompt revision ${input.revisionId} not found for ${input.repo}/${input.agent}`,
          );
        }

        const targetRevision = RepoPromptRevisionRowSchema.parse(targetRow);
        const currentRow = statements.getRepoPromptCurrentRevisionByKey.get(
          input.repo,
          input.agent,
        );

        if (currentRow != null) {
          const currentRevision = parseRepoPromptCurrentRevision(currentRow);

          if (targetRevision.body === currentRevision.body) {
            setResult({
              alreadyCurrent: true,
              newRevisionId: currentRevision.currentRevisionId,
            });
            return;
          }
        }

        const newRevisionId = insertRepoPromptRevisionAndUpsert({
          agent: input.agent,
          body: targetRevision.body,
          bodySha256: hashPromptBody(targetRevision.body),
          now: input.now,
          repo: input.repo,
          source: RepoPromptRevisionSourceSchema.parse("restore"),
        });
        setResult({ alreadyCurrent: false, newRevisionId });
      },
    );

    const deleteRepoPromptTransaction = db.transaction(
      (
        input: { agent: RepoPromptAgent; repo: string },
        setResult: (result: { deleted: boolean }) => void,
      ) => {
        const promptRow = statements.getRepoPromptRowByKey.get(input.repo, input.agent);

        if (promptRow == null) {
          setResult({ deleted: false });
          return;
        }

        statements.deleteRepoPromptByKey.run(input.repo, input.agent);
        statements.deleteRepoPromptRevisionsByKey.run(input.repo, input.agent);
        setResult({ deleted: true });
      },
    );

    runtime = {
      replaceRunAndSubIssues,
      restorePromptToRevisionTransaction,
      restoreRepoPromptToRevisionTransaction,
      saveRepoPromptRevisionTransaction,
      savePromptRevisionTransaction,
      deleteRepoPromptTransaction,
      seedPromptIfMissingTransaction,
      statements,
    };
    resyncOrphanedRuns();

    return runtime;
  }

  function hydrateRun(row: RunRow): RunState {
    const { statements } = getRuntime();

    return RunStateSchema.parse({
      branch: row.branch,
      issueNumber: row.issueNumber,
      pid: row.pid ?? undefined,
      prUrl: row.prUrl ?? undefined,
      repo: row.repo,
      runId: row.runId,
      sessionIds: statements.getSessionIdsByRun
        .all(row.runId)
        .map((sessionRow) => sessionRow.sessionId),
      startedAt: row.startedAt,
      subIssues: statements.getSubIssuesByRun
        .all(row.runId)
        .map((subIssueRow) => SubIssueSchema.parse(subIssueRow)),
      vaultId: row.vaultId ?? undefined,
    });
  }

  function initDb(): void {
    getRuntime();
  }

  function insertRun(run: RunState): void {
    getRuntime().replaceRunAndSubIssues(RunStateSchema.parse(run));
  }

  function insertRunEvent(event: RunEvent): void {
    const parsedEvent = RunEventSchema.parse(event);

    getRuntime().statements.insertRunEvent.run(
      parsedEvent.id,
      RUN_ID_SCHEMA.parse(parsedEvent.runId),
      parsedEvent.ts,
      RunEventKindSchema.parse(parsedEvent.kind),
      stringifyRunEventPayload(parsedEvent.payload),
    );
  }

  function listRunEvents(opts: {
    fromEventId?: string;
    limit?: number;
    runId: string;
  }): RunEvent[] {
    const parsedRunId = RUN_ID_SCHEMA.parse(opts.runId);
    const limit = normalizeRunEventsLimit(opts.limit);
    const { statements } = getRuntime();

    if (opts.fromEventId !== undefined) {
      return statements.listRunEventsAfter
        .all(parsedRunId, RunEventSchema.shape.id.parse(opts.fromEventId), limit)
        .map((row) => parseRunEventRow(row));
    }

    return statements.listRunEvents.all(parsedRunId, limit).map((row) => parseRunEventRow(row));
  }

  function getRunsByRepo(repo: string): RunState[] {
    return getRuntime()
      .statements.getRunsByRepo.all(REPO_SCHEMA.parse(repo))
      .map((row) => hydrateRun(row));
  }

  function getRunById(runId: string): RunState | null {
    const row = getRuntime().statements.getRunById.get(RUN_ID_SCHEMA.parse(runId));
    return row == null ? null : hydrateRun(row);
  }

  function setRunStatus(runId: string, status: RunStatus): void {
    getRuntime().statements.setRunStatus.run(
      RunStatusSchema.parse(status),
      RUN_ID_SCHEMA.parse(runId),
    );
  }

  function setRunPhase(runId: string, phase: RunPhase | null): void {
    getRuntime().statements.setRunPhase.run(
      phase === null ? null : RunPhaseSchema.parse(phase),
      RUN_ID_SCHEMA.parse(runId),
    );
  }

  function listRuns(opts: { status?: RunStatus; repo?: string; limit?: number }): RunSummary[] {
    const status = opts.status === undefined ? undefined : RunStatusSchema.parse(opts.status);
    const repo = opts.repo === undefined ? undefined : REPO_SCHEMA.parse(opts.repo);
    const limit = normalizeListRunsLimit(opts.limit);
    const { statements } = getRuntime();

    if (status !== undefined && repo !== undefined) {
      return statements.listRunsByStatusAndRepo
        .all(status, repo, limit)
        .map((row) => parseRunSummaryRow(row));
    }

    if (status !== undefined) {
      return statements.listRunsByStatus.all(status, limit).map((row) => parseRunSummaryRow(row));
    }

    if (repo !== undefined) {
      return statements.listRunsByRepo.all(repo, limit).map((row) => parseRunSummaryRow(row));
    }

    return statements.listRuns.all(limit).map((row) => parseRunSummaryRow(row));
  }

  function resyncOrphanedRuns(): { aborted: number } {
    return {
      aborted: readChanges(getRuntime().statements.resyncOrphanedRuns.run()),
    };
  }

  function insertSession(runId: string, session: SessionResult): void {
    const parsedRunId = RUN_ID_SCHEMA.parse(runId);
    const parsedSession = SessionResultSchema.parse(session);

    getRuntime().statements.insertSession.run(
      parsedSession.sessionId,
      parsedRunId,
      parsedSession.eventsProcessed,
      parsedSession.toolInvocations,
      parsedSession.toolErrors,
      parsedSession.durationMs,
      Number(parsedSession.aborted),
      Number(parsedSession.errored),
      Number(parsedSession.idleReached),
      Number(parsedSession.timedOut),
      parsedSession.lastEventId ?? null,
    );
  }

  function insertSessionPlaceholder(runId: string, sessionId: string): void {
    insertSession(runId, {
      aborted: false,
      durationMs: 0,
      errored: false,
      eventsProcessed: 0,
      idleReached: false,
      lastEventId: undefined,
      sessionId,
      timedOut: false,
      toolErrors: 0,
      toolInvocations: 0,
    });
  }

  function getSessionsByRun(runId: string): SessionResult[] {
    return getRuntime()
      .statements.getSessionsByRun.all(RUN_ID_SCHEMA.parse(runId))
      .map((row) => {
        const parsedSession = SessionResultSchema.parse({
          aborted: Boolean(row.aborted),
          durationMs: row.durationMs,
          errored: Boolean(row.errored),
          eventsProcessed: row.eventsProcessed,
          idleReached: Boolean(row.idleReached),
          lastEventId: row.lastEventId ?? undefined,
          sessionId: row.sessionId,
          timedOut: Boolean(row.timedOut),
          toolErrors: row.toolErrors,
          toolInvocations: row.toolInvocations,
        });

        return {
          aborted: parsedSession.aborted,
          durationMs: parsedSession.durationMs,
          errored: parsedSession.errored,
          eventsProcessed: parsedSession.eventsProcessed,
          idleReached: parsedSession.idleReached,
          lastEventId: parsedSession.lastEventId,
          sessionId: parsedSession.sessionId,
          timedOut: parsedSession.timedOut,
          toolErrors: parsedSession.toolErrors,
          toolInvocations: parsedSession.toolInvocations,
        };
      });
  }

  function insertSubIssue(
    runId: string,
    subIssue: { taskId: string; issueId: number; issueNumber: number },
  ): void {
    const parsedRunId = RUN_ID_SCHEMA.parse(runId);
    const parsedSubIssue = SubIssueSchema.parse(subIssue);

    getRuntime().statements.insertSubIssue.run(
      parsedRunId,
      parsedSubIssue.taskId,
      parsedSubIssue.issueId,
      parsedSubIssue.issueNumber,
    );
  }

  function getSubIssuesByRun(
    runId: string,
  ): Array<{ taskId: string; issueId: number; issueNumber: number }> {
    return getRuntime()
      .statements.getSubIssuesByRun.all(RUN_ID_SCHEMA.parse(runId))
      .map((row) => SubIssueSchema.parse(row));
  }

  function insertChildTaskResult(runId: string, result: ChildTaskResult): void {
    const parsedRunId = RUN_ID_SCHEMA.parse(runId);
    const parsedResult = ChildTaskResultSchema.parse(result);

    getRuntime().statements.insertChildTaskResult.run(
      parsedRunId,
      parsedResult.taskId,
      Number(parsedResult.success),
      parsedResult.commitSha ?? null,
      parsedResult.filesChanged === undefined ? null : JSON.stringify(parsedResult.filesChanged),
      parsedResult.testOutput ?? null,
      parsedResult.error?.type ?? null,
      parsedResult.error === undefined
        ? null
        : JSON.stringify({
            message: parsedResult.error.message,
            stderr: parsedResult.error.stderr,
          }),
    );
  }

  function getChildTaskResultsByRun(runId: string): ChildTaskResult[] {
    return getRuntime()
      .statements.getChildTaskResultsByRun.all(RUN_ID_SCHEMA.parse(runId))
      .map((row) =>
        ChildTaskResultSchema.parse({
          commitSha: row.commitSha ?? undefined,
          error: decodeChildTaskError(row.errorType, row.errorMessage, dependencies.logger),
          filesChanged: parseFilesChanged(row.filesChanged),
          success: Boolean(row.success),
          taskId: row.taskId,
          testOutput: row.testOutput ?? undefined,
        }),
      );
  }

  function listRepositories(): Array<{ repo: string; runCount: number; lastRunAt: string | null }> {
    return getRuntime()
      .statements.listRepositories.all()
      .map((row) => ({
        lastRunAt: row.lastRunAt,
        repo: REPO_SCHEMA.parse(row.repo),
        runCount: row.runCount,
      }));
  }

  function getPrompt(key: PromptKey): {
    body: string;
    currentRevisionId: number;
    promptKey: PromptKey;
    updatedAt: string;
  } | null {
    const row = getRuntime().statements.getPromptByKey.get(PromptKeySchema.parse(key));
    return row == null ? null : parsePromptWithBody(row);
  }

  function getPromptRevisions(key: EditablePromptKey): PromptRevisionRow[] {
    return getRuntime()
      .statements.getPromptRevisionsByKey.all(EditablePromptKeySchema.parse(key))
      .map((row) => PromptRevisionRowSchema.parse(row));
  }

  function getPromptRevision(key: EditablePromptKey, revisionId: number): PromptRevisionRow | null {
    const input = RestoreInputSchema.parse({ promptKey: key, revisionId });
    const row = getRuntime().statements.getPromptRevisionByKeyAndId.get(
      input.promptKey,
      input.revisionId,
    );

    return row == null ? null : PromptRevisionRowSchema.parse(row);
  }

  function savePromptRevision(
    input: PromptSavePublicInput,
    opts: { allowDuplicateBody?: boolean } = {},
  ): PromptSaveResult {
    const normalizedBody = normalizePromptBody(input.body);
    const parsedBody = PromptSaveInputSchema.parse({ body: normalizedBody }).body;
    const parsedKey = EditablePromptKeySchema.parse(input.key);
    const parsedSource = PromptRevisionSourceSchema.parse(input.source);
    let result: PromptSaveResult | null = null;

    getRuntime().savePromptRevisionTransaction(
      {
        allowDuplicateBody: opts.allowDuplicateBody === true,
        body: parsedBody,
        bodySha256: hashPromptBody(parsedBody),
        key: parsedKey,
        now: new Date().toISOString(),
        source: parsedSource,
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Prompt revision save did not complete");
    }

    return result;
  }

  function restorePromptToRevision(
    key: EditablePromptKey,
    revisionId: number,
  ): PromptRestoreResult {
    const input = RestoreInputSchema.parse({ promptKey: key, revisionId });
    let result: PromptRestoreResult | null = null;

    getRuntime().restorePromptToRevisionTransaction(
      {
        key: input.promptKey,
        now: new Date().toISOString(),
        revisionId: input.revisionId,
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Prompt restore did not complete");
    }

    return result;
  }

  function seedPromptIfMissing(key: PromptKey, defaultBody: string): PromptSeedResult {
    const parsedKey = PromptKeySchema.parse(key);
    const parsedBody = PromptSaveInputSchema.parse({ body: defaultBody }).body;
    let result: PromptSeedResult | null = null;

    getRuntime().seedPromptIfMissingTransaction(
      {
        body: parsedBody,
        bodySha256: hashPromptBody(parsedBody),
        key: parsedKey,
        now: new Date().toISOString(),
        source: PromptRevisionSourceSchema.parse("seed"),
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Prompt seed did not complete");
    }

    return result;
  }

  // ---- Per-repository prompt overrides ----

  function getRepoPrompt(
    repo: string,
    agent: RepoPromptAgent,
  ): {
    agent: RepoPromptAgent;
    body: string;
    currentRevisionId: number;
    repo: string;
    updatedAt: string;
  } | null {
    const parsedRepo = RepoSlugSchema.parse(repo);
    const parsedAgent = RepoPromptAgentSchema.parse(agent);
    const row = getRuntime().statements.getRepoPromptByKey.get(parsedRepo, parsedAgent);
    return row == null ? null : parseRepoPromptWithBody(row);
  }

  function getRepoPromptRevisions(repo: string, agent: RepoPromptAgent): RepoPromptRevisionRow[] {
    const parsedRepo = RepoSlugSchema.parse(repo);
    const parsedAgent = RepoPromptAgentSchema.parse(agent);
    return getRuntime()
      .statements.getRepoPromptRevisionsByKey.all(parsedRepo, parsedAgent)
      .map((row) => RepoPromptRevisionRowSchema.parse(row));
  }

  function getRepoPromptRevision(
    repo: string,
    agent: RepoPromptAgent,
    revisionId: number,
  ): RepoPromptRevisionRow | null {
    const parsed = RepoPromptRestoreInputSchema.parse({ agent, repo, revisionId });
    const row = getRuntime().statements.getRepoPromptRevisionByKeyAndId.get(
      parsed.repo,
      parsed.agent,
      parsed.revisionId,
    );
    return row == null ? null : RepoPromptRevisionRowSchema.parse(row);
  }

  function saveRepoPromptRevision(
    input: { agent: RepoPromptAgent; body: string; repo: string; source: "edit" | "restore" },
    opts: { allowDuplicateBody?: boolean } = {},
  ): RepoPromptSaveResult {
    const normalizedBody = normalizePromptBody(input.body);
    const parsedBody = RepoPromptSaveInputSchema.parse({ body: normalizedBody }).body;
    const parsedRepo = RepoSlugSchema.parse(input.repo);
    const parsedAgent = RepoPromptAgentSchema.parse(input.agent);
    const parsedSource = RepoPromptRevisionSourceSchema.parse(input.source);
    let result: RepoPromptSaveResult | null = null;

    getRuntime().saveRepoPromptRevisionTransaction(
      {
        agent: parsedAgent,
        allowDuplicateBody: opts.allowDuplicateBody === true,
        body: parsedBody,
        bodySha256: hashPromptBody(parsedBody),
        now: new Date().toISOString(),
        repo: parsedRepo,
        source: parsedSource,
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Repo prompt revision save did not complete");
    }

    return result;
  }

  function restoreRepoPromptToRevision(
    repo: string,
    agent: RepoPromptAgent,
    revisionId: number,
  ): RepoPromptRestoreResult {
    const input = RepoPromptRestoreInputSchema.parse({ agent, repo, revisionId });
    let result: RepoPromptRestoreResult | null = null;

    getRuntime().restoreRepoPromptToRevisionTransaction(
      {
        agent: input.agent,
        now: new Date().toISOString(),
        repo: input.repo,
        revisionId: input.revisionId,
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Repo prompt restore did not complete");
    }

    return result;
  }

  function deleteRepoPrompt(repo: string, agent: RepoPromptAgent): { deleted: boolean } {
    const parsed = RepoPromptIdentifierSchema.parse({ agent, repo });
    let result: { deleted: boolean } | null = null;

    getRuntime().deleteRepoPromptTransaction(
      { agent: parsed.agent, repo: parsed.repo },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Repo prompt delete did not complete");
    }

    return result;
  }

  function listRepoPromptOverrides(opts: { repo?: string } = {}): Array<{
    agent: RepoPromptAgent;
    currentRevisionId: number;
    repo: string;
    revisionCount: number;
    updatedAt: string;
  }> {
    const { statements } = getRuntime();
    const rows =
      opts.repo === undefined
        ? statements.listRepoPromptOverrides.all()
        : statements.listRepoPromptOverridesByRepo.all(RepoSlugSchema.parse(opts.repo));

    return rows.map((row) => ({
      agent: RepoPromptAgentSchema.parse(row.agent),
      currentRevisionId: RepoPromptRowSchema.shape.currentRevisionId.parse(row.currentRevisionId),
      repo: RepoSlugSchema.parse(row.repo),
      revisionCount: Number(row.revisionCount),
      updatedAt: RepoPromptRowSchema.shape.updatedAt.parse(row.updatedAt),
    }));
  }

  function close(): void {
    db.close();
  }

  return {
    close,
    deleteRepoPrompt,
    getChildTaskResultsByRun,
    getPrompt,
    getPromptRevision,
    getPromptRevisions,
    getRepoPrompt,
    getRepoPromptRevision,
    getRepoPromptRevisions,
    getRunById,
    getRunsByRepo,
    getSessionsByRun,
    getSubIssuesByRun,
    initDb,
    insertChildTaskResult,
    insertRun,
    insertRunEvent,
    insertSession,
    insertSessionPlaceholder,
    insertSubIssue,
    listRepositories,
    listRepoPromptOverrides,
    listRunEvents,
    listRuns,
    resyncOrphanedRuns,
    restorePromptToRevision,
    restoreRepoPromptToRevision,
    savePromptRevision,
    saveRepoPromptRevision,
    seedPromptIfMissing,
    setRunPhase,
    setRunStatus,
  };
}
