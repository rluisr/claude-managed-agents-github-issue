#!/usr/bin/env bun

import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";

import { Hono } from "hono";

import { PARENT_TOOLS } from "@/parent-tools";
import { handleSpawnChildTask } from "@/features/child-execution/handler";
import { handleCreateSubIssue } from "@/features/decomposition/handler";
import { createApp } from "@/features/dashboard/server";
import { handleCreateFinalPr } from "@/features/finalize-pr/handler";
import { runPreflight } from "@/features/preflight/validate";
import { createRunApiRoutes } from "@/features/run-api/server";
import {
  runIssueOrchestration,
  type RunExecutionDeps,
  type RunExecutionResult as CoreRunExecutionResult,
} from "@/features/run-execution/handler";
import {
  createRunQueueModule,
  type RunExecutionInput as QueuedRunExecutionInput,
  type RunExecutionResult as QueuedRunExecutionResult,
} from "@/features/run-queue/handler";
import { ensureEnvironment } from "@/shared/agents/environment";
import { buildChildPrompt } from "@/shared/agents/prompts/child";
import { buildParentPrompt } from "@/shared/agents/prompts/parent";
import { ensureAgents } from "@/shared/agents/registry";
import { loadConfig } from "@/shared/config";
import { createGitHubClient, readIssue } from "@/shared/github";
import { createLogger } from "@/shared/logging";
import { createDbModule } from "@/shared/persistence/db";
import { loadAgentSystemPrompts } from "@/shared/prompts/loader";
import { seedDefaultPrompts } from "@/shared/prompts/seeder";
import { createRunEventsModule } from "@/shared/run-events";
import { runSession, type SessionClient } from "@/shared/session";
import { createCleanupRegistry } from "@/shared/signals";
import { acquireRunLock, readAgentState, releaseRunLock, writeRunState } from "@/shared/state";
import { ensureGitHubCredential, ensureVault, releaseVault } from "@/shared/vault";

type BunServer = {
  stop(force?: boolean): void;
};

type BunRuntime = {
  serve(options: {
    fetch: (request: Request) => Response | Promise<Response>;
    hostname: string;
    port: number;
  }): BunServer;
};

type CountDatabase = {
  close(): void;
  query<Row>(sql: string): {
    get(): Row | null | undefined;
  };
};

type CountDatabaseConstructor = new (
  databasePath: string,
  options?: { readonly?: boolean },
) => CountDatabase;

type ServerEnv = {
  anthropicApiKey: string;
  configPath?: string;
  dbPath: string;
  githubToken: string;
  host: string;
  logFile?: string;
  logLevel?: string;
  port: number;
};

const DEFAULT_DB_PATH = ".github-issue-agent/dashboard.db";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const require = createRequire(import.meta.url);
const { Database: ReadonlyDatabase } = require("bun:sqlite") as {
  Database: CountDatabaseConstructor;
};

function requiredEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    process.stderr.write(`${name} is required\n`);
    process.exit(1);
  }

  return value;
}

function parsePort(rawPort: string | undefined): number {
  const port = Number.parseInt(rawPort ?? String(DEFAULT_PORT), 10);

  if (!Number.isInteger(port) || port <= 0) {
    process.stderr.write("PORT must be a positive integer\n");
    process.exit(1);
  }

  return port;
}

function optionalEnv(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function readServerEnv(env: NodeJS.ProcessEnv): ServerEnv {
  return {
    anthropicApiKey: requiredEnv("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY),
    configPath: optionalEnv(env.CONFIG_PATH),
    dbPath: optionalEnv(env.DB_PATH) ?? DEFAULT_DB_PATH,
    githubToken: requiredEnv("GITHUB_TOKEN", env.GITHUB_TOKEN),
    host: optionalEnv(env.HOST) ?? DEFAULT_HOST,
    logFile: optionalEnv(env.LOG_FILE),
    logLevel: optionalEnv(env.LOG_LEVEL),
    port: parsePort(env.PORT),
  };
}

function assertFinalRunStatus(result: CoreRunExecutionResult): QueuedRunExecutionResult {
  if (
    result.status === "aborted" ||
    result.status === "completed" ||
    result.status === "failed"
  ) {
    return result;
  }

  return {
    aborted: false,
    errored: {
      message: `run execution returned non-terminal status: ${result.status}`,
      type: "non_terminal_status",
    },
    runId: result.runId,
    status: "failed",
    timedOut: false,
  };
}

function getBunRuntime(): BunRuntime {
  const runtime = globalThis as typeof globalThis & { Bun?: BunRuntime };
  if (!runtime.Bun) {
    throw new Error("Bun runtime is required for the HTTP server entrypoint");
  }

  return runtime.Bun;
}

function countExistingOrphanedRuns(dbPath: string): number | undefined {
  if (dbPath === ":memory:") {
    return undefined;
  }

  let db: CountDatabase | undefined;

  try {
    db = new ReadonlyDatabase(resolve(process.cwd(), dbPath), { readonly: true });
    const runsTable = db
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
      .get();
    if (runsTable == null) {
      return 0;
    }

    const row = db
      .query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM runs WHERE status = 'running' OR status = 'queued'",
      )
      .get();
    return Number(row?.count ?? 0);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

const serverEnv = readServerEnv(process.env);
const cfg = await loadConfig(serverEnv.configPath);
const logger = createLogger({ level: serverEnv.logLevel, logFile: serverEnv.logFile });
const cleanup = createCleanupRegistry({ logger });
let resolveShutdown: () => void = () => undefined;
const shutdownPromise = new Promise<void>((resolve) => {
  resolveShutdown = resolve;
});
cleanup.register(async () => {
  if (process.exitCode === 130 || process.exitCode === 143) {
    process.exitCode = 0;
  }
  resolveShutdown();
});
const preInitOrphanCount = countExistingOrphanedRuns(serverEnv.dbPath);
const db = createDbModule(serverEnv.dbPath, { logger });

db.initDb();
cleanup.register(async () => {
  try {
    db.close();
  } catch (err) {
    logger.warn({ err }, "failed to close dashboard db");
  }
});

logger.debug(
  {
    childModel: cfg.models.child,
    configPath: serverEnv.configPath,
    maxSubIssues: cfg.maxSubIssues,
    parentModel: cfg.models.parent,
  },
  "loaded server config",
);

const orphanResync = db.resyncOrphanedRuns();
logger.info(
  { aborted: orphanResync.aborted || preInitOrphanCount || 0 },
  "resynced orphaned runs",
);

await seedDefaultPrompts({ db, logger });

const runEvents = createRunEventsModule({ db, logger });
cleanup.register(async () => {
  runEvents.close();
});

const Anthropic = (await import("@anthropic-ai/sdk")).default;
const anthropicClient = new Anthropic();

const executor = async (
  input: QueuedRunExecutionInput,
): Promise<QueuedRunExecutionResult> => {
  const { signal, ...rawInput } = input;
  const runDeps: RunExecutionDeps = {
    acquireRunLock,
    anthropicClient: anthropicClient as RunExecutionDeps["anthropicClient"],
    buildChildPrompt,
    buildParentPrompt,
    cleanup: undefined,
    createOctokit: createGitHubClient,
    db,
    ensureAgents,
    ensureEnvironment,
    ensureGitHubCredential,
    ensureVault,
    githubToken: serverEnv.githubToken,
    handleCreateFinalPr,
    handleCreateSubIssue,
    handleSpawnChildTask,
    loadAgentPrompts: loadAgentSystemPrompts,
    loadConfig,
    logger,
    parentTools: PARENT_TOOLS,
    readAgentState,
    readIssue,
    releaseRunLock,
    releaseVault,
    runEvents,
    runPreflight,
    runSession,
    seedAgentPrompts: seedDefaultPrompts,
    signal,
    writeRunState,
  };
  const result = await runIssueOrchestration(
    { ...rawInput, configPath: rawInput.configPath ?? serverEnv.configPath },
    runDeps,
  );

  return assertFinalRunStatus(result);
};

const runQueue = createRunQueueModule({ db, executor, logger, runEvents });
cleanup.register(async () => {
  await runQueue.stop({ force: false });
});
runQueue.start();

const dashboardApp = createApp({
  anthropicClient: anthropicClient as unknown as SessionClient,
  db,
  logger,
  runEvents: runEvents as Parameters<typeof createApp>[0]["runEvents"],
  runQueue,
  staticAssetsDir: "./dist",
});
const app = new Hono();

app.route(
  "/",
  createRunApiRoutes({
    anthropicClient: anthropicClient as unknown as SessionClient,
    db,
    logger,
    runEvents,
    runQueue,
  }),
);
app.route("/", dashboardApp);

const server = getBunRuntime().serve({
  fetch: app.fetch,
  hostname: serverEnv.host,
  port: serverEnv.port,
});
cleanup.register(async () => {
  server.stop(true);
});

process.stdout.write(`Listening on http://${serverEnv.host}:${serverEnv.port}\n`);

await shutdownPromise;
