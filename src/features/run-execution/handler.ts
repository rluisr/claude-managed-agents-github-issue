import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { BetaManagedAgentsUserMessageEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";

import type { handleSpawnChildTask } from "@/features/child-execution/handler";
import type { handleCreateSubIssue } from "@/features/decomposition/handler";
import type { handleCreateFinalPr } from "@/features/finalize-pr/handler";
import type { runPreflight } from "@/features/preflight/validate";
import type { ensureEnvironment } from "@/shared/agents/environment";
import type { buildChildPrompt } from "@/shared/agents/prompts/child";
import type { buildParentPrompt } from "@/shared/agents/prompts/parent";
import type { ensureAgents } from "@/shared/agents/registry";
import type { Config, loadConfig } from "@/shared/config";
import type { createGitHubClient, readIssue } from "@/shared/github";
import type { createDbModule } from "@/shared/persistence/db";
import type { PromptKey } from "@/shared/prompts/seeder";
import type { createRunEventsModule } from "@/shared/run-events";
import type { runSession } from "@/shared/session";
import type { acquireRunLock, readAgentState, releaseRunLock, writeRunState } from "@/shared/state";
import type { ChildTaskResult, RunPhase, RunState, RunStatus } from "@/shared/types";
import type { ensureGitHubCredential, ensureVault, releaseVault } from "@/shared/vault";
import { createRunEventsBridge } from "./event-bridge";
import {
  type RunExecutionInput,
  RunExecutionInputSchema,
  type RunExecutionResult,
} from "./schemas";

export type { RunExecutionInput, RunExecutionResult } from "./schemas";

type SessionApiClient = {
  beta: {
    sessions: {
      create: (params: SessionCreateParams) => Promise<{ id: string }>;
      delete: (sessionId: string) => Promise<unknown>;
      events: {
        send: (
          sessionId: string,
          params: { events: BetaManagedAgentsUserMessageEventParams[] },
        ) => Promise<unknown>;
      };
    };
  };
};

type AnthropicClientLike = Parameters<typeof ensureAgents>[0] &
  Parameters<typeof ensureEnvironment>[0] &
  Parameters<typeof ensureVault>[0] &
  Parameters<typeof ensureGitHubCredential>[0] &
  Parameters<typeof releaseVault>[0] &
  NonNullable<Parameters<typeof runPreflight>[0]["anthropicClient"]> &
  Parameters<typeof runSession>[0] &
  SessionApiClient;

type DashboardDbModule = ReturnType<typeof createDbModule>;
type RunEventsModule = Pick<ReturnType<typeof createRunEventsModule>, "emit">;
type ParentTools = ReadonlyArray<NonNullable<AgentCreateParams["tools"]>[number]>;

export type RunExecutionDb = Pick<
  DashboardDbModule,
  | "getPrompt"
  | "insertChildTaskResult"
  | "insertRun"
  | "insertSession"
  | "insertSessionPlaceholder"
  | "seedPromptIfMissing"
  | "setRunPhase"
  | "setRunStatus"
>;

type CleanupHandler = () => Promise<void> | void;

export type RunExecutionCleanup = {
  register(fn: CleanupHandler): void;
  triggerAll(): Promise<void>;
};

export type RunExecutionObservers = {
  onLog?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
  onPhase?: (phase: RunPhase, details?: unknown) => void;
  onSession?: (event: { kind: string; payload?: unknown; sessionId: string }) => void;
  onSubIssue?: (event: { kind: "created" | "updated"; payload: unknown }) => void;
};

export type RunExecutionDeps = {
  acquireRunLock: typeof acquireRunLock;
  anthropicClient?: AnthropicClientLike;
  buildChildPrompt: typeof buildChildPrompt;
  buildParentPrompt: typeof buildParentPrompt;
  cleanup?: RunExecutionCleanup;
  createOctokit: typeof createGitHubClient;
  db?: RunExecutionDb;
  ensureAgents: typeof ensureAgents;
  ensureEnvironment: typeof ensureEnvironment;
  ensureGitHubCredential: typeof ensureGitHubCredential;
  ensureVault: typeof ensureVault;
  forceRecreate?: boolean;
  githubToken: string;
  handleCreateFinalPr: typeof handleCreateFinalPr;
  handleCreateSubIssue: typeof handleCreateSubIssue;
  handleSpawnChildTask: typeof handleSpawnChildTask;
  loadAgentPrompts: (deps: {
    db: RunExecutionDb;
    logger: Logger;
  }) => Promise<{ child: string; parent: string }>;
  loadConfig: typeof loadConfig;
  logger: Logger;
  parentTools: ParentTools;
  readAgentState: typeof readAgentState;
  readIssue: typeof readIssue;
  releaseRunLock: typeof releaseRunLock;
  releaseVault: typeof releaseVault;
  runPreflight: typeof runPreflight;
  runEvents?: RunEventsModule;
  runSession: typeof runSession;
  seedAgentPrompts: (deps: {
    db: RunExecutionDb;
    logger: Logger;
  }) => Promise<{ seeded: PromptKey[] }>;
  signal?: AbortSignal;
  writeRunState: typeof writeRunState;
};

type RepoRef = {
  name: string;
  owner: string;
};

type ErrorResult = {
  message: string;
  type: string;
};

type SubIssueObserverPayload = {
  changeKind: "created" | "updated";
  issueId: number;
  issueNumber: number;
  repo: string;
  status: "pending";
  taskId: string;
  title?: string;
};

class RunExecutionFailure extends Error {
  readonly type: string;

  constructor(type: string, message: string) {
    super(message);
    this.name = "RunExecutionFailure";
    this.type = type;
  }
}

class RunExecutionAborted extends Error {
  constructor() {
    super("Run orchestration was aborted");
    this.name = "RunExecutionAborted";
  }
}

function createLocalCleanup(): RunExecutionCleanup {
  const cleanupHandlers: CleanupHandler[] = [];
  let triggerPromise: Promise<void> | undefined;

  return {
    register(fn) {
      cleanupHandlers.push(fn);
    },
    triggerAll() {
      triggerPromise ??= (async () => {
        while (cleanupHandlers.length > 0) {
          const cleanupHandler = cleanupHandlers.pop();
          if (cleanupHandler) {
            await cleanupHandler();
          }
        }
      })();

      return triggerPromise;
    },
  };
}

function parseRepoRef(repo: string): RepoRef {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new RunExecutionFailure("invalid_input", "repo must match owner/name");
  }

  return { name, owner };
}

function resolveBaseBranch(
  configuredBaseBranch: string | undefined,
  defaultBranch: string,
): string {
  const trimmedConfiguredBaseBranch = configuredBaseBranch?.trim();
  return trimmedConfiguredBaseBranch ? trimmedConfiguredBaseBranch : defaultBranch;
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "task"
  );
}

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function categorizeError(error: unknown): ErrorResult {
  if (error instanceof RunExecutionFailure) {
    return { message: error.message, type: error.type };
  }

  if (error instanceof RunExecutionAborted) {
    return { message: error.message, type: "aborted" };
  }

  return {
    message: errorMessageFromUnknown(error),
    type: error instanceof Error && error.name !== "Error" ? error.name : "unexpected",
  };
}

function safeObserverCall(
  logger: Logger,
  action: () => void,
  details: Record<string, unknown>,
): void {
  try {
    action();
  } catch (error) {
    logger.warn({ err: error, ...details }, "run execution observer callback failed");
  }
}

function callComposedObserver<TArgs extends unknown[]>(
  first: ((...args: TArgs) => void) | undefined,
  second: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void {
  let firstError: unknown;

  if (first) {
    try {
      first(...args);
    } catch (error) {
      firstError = error;
    }
  }

  if (second) {
    try {
      second(...args);
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError !== undefined) {
    throw firstError;
  }
}

function composeObservers(
  first: RunExecutionObservers,
  second: RunExecutionObservers,
): RunExecutionObservers {
  return {
    onLog: (level, msg, fields) => {
      callComposedObserver(first.onLog, second.onLog, level, msg, fields);
    },
    onPhase: (phase, details) => {
      callComposedObserver(first.onPhase, second.onPhase, phase, details);
    },
    onSession: (event) => {
      callComposedObserver(first.onSession, second.onSession, event);
    },
    onSubIssue: (event) => {
      callComposedObserver(first.onSubIssue, second.onSubIssue, event);
    },
  };
}

function notifyLog(
  logger: Logger,
  observers: RunExecutionObservers,
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
): void {
  switch (level) {
    case "info":
      if (fields) {
        logger.info(fields, msg);
      } else {
        logger.info(msg);
      }
      break;
    case "warn":
      if (fields) {
        logger.warn(fields, msg);
      } else {
        logger.warn(msg);
      }
      break;
    case "error":
      if (fields) {
        logger.error(fields, msg);
      } else {
        logger.error(msg);
      }
      break;
  }

  if (observers.onLog) {
    safeObserverCall(logger, () => observers.onLog?.(level, msg, fields), {
      observer: "onLog",
    });
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RunExecutionAborted();
  }
}

function buildDryRunDecompositionPlan(input: {
  branch: string;
  cfg: Config;
  issueBody: string;
  issueNumber: number;
  issueTitle: string;
  repo: string;
}): unknown {
  return {
    branch: input.branch,
    commitStyle: input.cfg.commitStyle,
    issue: {
      body: input.issueBody,
      number: input.issueNumber,
      title: input.issueTitle,
    },
    maxSubIssues: input.cfg.maxSubIssues,
    repo: input.repo,
  };
}

function buildChildTaskResultForDb(childResult: ChildTaskResult): ChildTaskResult {
  return {
    commitSha: childResult.commitSha,
    error: childResult.error && {
      message: childResult.error.message,
      stderr: childResult.error.stderr,
      type: childResult.error.type,
    },
    filesChanged: childResult.filesChanged,
    success: childResult.success,
    taskId: childResult.taskId,
    testOutput: childResult.testOutput,
  };
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function buildSubIssueObserverPayload(input: {
  args: unknown;
  changeKind: "created" | "updated";
  repo: string;
  result: { subIssueId: number; subIssueNumber: number };
  runState: RunState;
}): SubIssueObserverPayload {
  const subIssue = input.runState.subIssues.find(
    (item) =>
      item.issueId === input.result.subIssueId || item.issueNumber === input.result.subIssueNumber,
  );
  const title = stringProperty(input.args, "title");

  return {
    changeKind: input.changeKind,
    issueId: input.result.subIssueId,
    issueNumber: input.result.subIssueNumber,
    repo: input.repo,
    status: "pending",
    taskId: subIssue?.taskId ?? `issue-${input.result.subIssueNumber}`,
    ...(title === undefined ? {} : { title }),
  };
}

export async function runIssueOrchestration(
  rawInput: RunExecutionInput,
  deps: RunExecutionDeps,
  observers: RunExecutionObservers = {},
): Promise<RunExecutionResult> {
  const fallbackRunId =
    typeof rawInput.runId === "string" && rawInput.runId.trim().length > 0
      ? rawInput.runId
      : uuidv7();
  const sessionController = new AbortController();
  const cleanup = deps.cleanup ?? createLocalCleanup();
  const logger = deps.logger.child({ runId: fallbackRunId });
  const bridgeObservers = deps.runEvents
    ? createRunEventsBridge({ logger, runEvents: deps.runEvents, runId: fallbackRunId })
    : undefined;
  const activeObservers = bridgeObservers
    ? composeObservers(observers, bridgeObservers)
    : observers;

  let currentPhase: RunPhase | undefined;
  let currentStatus: RunStatus = "running";
  let runState: RunState | undefined;
  let cleanupStarted = false;
  let externalAbortListener: (() => void) | undefined;

  const safeSetRunStatus = (status: RunStatus): void => {
    currentStatus = status;
    if (!deps.db) {
      return;
    }

    try {
      deps.db.setRunStatus(fallbackRunId, status);
    } catch (error) {
      logger.warn({ err: error, runId: fallbackRunId, status }, "failed to set run status");
    }
  };

  const safeSetRunPhase = (phase: RunPhase | null): void => {
    if (phase !== null) {
      currentPhase = phase;
    }

    if (!deps.db) {
      return;
    }

    try {
      deps.db.setRunPhase(fallbackRunId, phase);
    } catch (error) {
      logger.warn({ err: error, phase, runId: fallbackRunId }, "failed to set run phase");
    }
  };

  const notifyPhase = (phase: RunPhase, details?: unknown): void => {
    safeSetRunPhase(phase);
    if (activeObservers.onPhase) {
      safeObserverCall(logger, () => activeObservers.onPhase?.(phase, details), {
        observer: "onPhase",
        phase,
      });
    }
  };

  const syncRunToDb = async (): Promise<void> => {
    if (!deps.db || !runState) {
      return;
    }

    try {
      deps.db.insertRun(runState);
      deps.db.setRunStatus(fallbackRunId, currentStatus);
      if (currentPhase) {
        deps.db.setRunPhase(fallbackRunId, currentPhase);
      }
    } catch (error) {
      logger.warn({ err: error, runId: fallbackRunId }, "failed to sync run state to SQLite");
    }
  };

  const writeAndSyncRunState = async (): Promise<void> => {
    if (!runState) {
      return;
    }

    await deps.writeRunState(fallbackRunId, runState);
    await syncRunToDb();
  };

  const notifySession = (event: { kind: string; payload?: unknown; sessionId: string }): void => {
    if (activeObservers.onSession) {
      safeObserverCall(logger, () => activeObservers.onSession?.(event), {
        observer: "onSession",
        sessionId: event.sessionId,
      });
    }
  };

  const notifySubIssue = (event: { kind: "created" | "updated"; payload: unknown }): void => {
    if (activeObservers.onSubIssue) {
      safeObserverCall(logger, () => activeObservers.onSubIssue?.(event), {
        observer: "onSubIssue",
      });
    }
  };

  const triggerCleanup = async (): Promise<void> => {
    if (cleanupStarted) {
      return;
    }

    cleanupStarted = true;
    notifyPhase("cleanup");
    try {
      await cleanup.triggerAll();
    } catch (error) {
      logger.error({ err: error, runId: fallbackRunId }, "cleanup failed");
    }
  };

  if (deps.signal) {
    externalAbortListener = () => {
      sessionController.abort();
    };

    if (deps.signal.aborted) {
      sessionController.abort();
    } else {
      deps.signal.addEventListener("abort", externalAbortListener, { once: true });
    }
  }

  try {
    const input = RunExecutionInputSchema.parse({ ...rawInput, runId: fallbackRunId });
    const cfg = await deps.loadConfig(input.configPath);
    const githubToken = deps.githubToken;
    if (!githubToken.trim()) {
      throw new RunExecutionFailure("auth", "GITHUB_TOKEN is required");
    }

    const octokit = deps.createOctokit(githubToken, { logger });
    const { name: repoName, owner } = parseRepoRef(input.repo);

    if (input.dryRun) {
      notifyPhase("preflight", { dryRun: true });
      try {
        await deps.runPreflight({
          issueN: input.issue,
          octokit,
          owner,
          repo: repoName,
          skipAnthropicCheck: true,
        });
      } catch (error) {
        notifyLog(
          logger,
          activeObservers,
          "warn",
          "preflight validation failed in dry-run mode; continuing with offline plan input",
          { err: error },
        );
      }

      throwIfAborted(sessionController.signal);

      let issueTitle = `issue-${input.issue}`;
      let issueBody = "";
      try {
        const result = await deps.readIssue(octokit, owner, repoName, input.issue);
        issueTitle = result.issue.title;
        issueBody = result.issue.body ?? "";
      } catch (error) {
        notifyLog(
          logger,
          activeObservers,
          "warn",
          "failed to read GitHub issue in dry-run mode; using synthetic issue data",
          { err: error },
        );
      }

      notifyPhase("decomposition", { dryRun: true });
      const decompositionPlan = buildDryRunDecompositionPlan({
        branch: `agent/issue-${input.issue}/${slug(issueTitle)}`,
        cfg,
        issueBody,
        issueNumber: input.issue,
        issueTitle,
        repo: `${owner}/${repoName}`,
      });

      safeSetRunStatus("completed");
      return {
        aborted: false,
        decompositionPlan,
        runId: fallbackRunId,
        status: "completed",
        timedOut: false,
      };
    }

    if (!deps.db) {
      throw new RunExecutionFailure(
        "db_missing",
        "dashboard db module is required outside dry-run mode",
      );
    }
    const db = deps.db;

    const anthropicClient = deps.anthropicClient;
    if (!anthropicClient) {
      throw new RunExecutionFailure(
        "anthropic_client_missing",
        "Anthropic client is required outside dry-run mode",
      );
    }

    notifyPhase("preflight");
    let preflight: Awaited<ReturnType<typeof runPreflight>>;
    try {
      preflight = await deps.runPreflight({
        anthropicClient,
        issueN: input.issue,
        octokit,
        owner,
        repo: repoName,
      });
    } catch (error) {
      throw new RunExecutionFailure("preflight_failed", errorMessageFromUnknown(error));
    }
    const baseBranch = resolveBaseBranch(cfg.pr.base, preflight.github.defaultBranch);
    throwIfAborted(sessionController.signal);

    notifyPhase("environment");
    const cachedAgentState = await deps.readAgentState();
    const environment = await deps.ensureEnvironment(anthropicClient, cachedAgentState);
    await deps.seedAgentPrompts({ db, logger });
    const prompts = await deps.loadAgentPrompts({ db, logger });
    const agents = await deps.ensureAgents(anthropicClient, {
      cfg,
      childPrompt: prompts.child,
      environmentId: environment.environmentId,
      forceRecreate: deps.forceRecreate,
      parentPrompt: prompts.parent,
      parentTools: [...deps.parentTools],
    });
    throwIfAborted(sessionController.signal);

    notifyPhase("lock");
    await deps.acquireRunLock();
    cleanup.register(async () => {
      await deps.releaseRunLock();
    });
    throwIfAborted(sessionController.signal);

    notifyPhase("vault");
    let credentialId: string | undefined;
    let managedCredential = false;
    let managedVault = false;
    let vaultId: string | undefined;

    const vault = await deps.ensureVault(anthropicClient, {
      configVaultId: input.vaultId ?? cfg.vaultId,
      githubToken,
    });
    vaultId = vault.vaultId;
    managedVault = vault.managedByUs;
    cleanup.register(async () => {
      if (!vaultId) {
        return;
      }

      await deps.releaseVault(anthropicClient, {
        credentialId,
        managedCredential,
        managedVault,
        vaultId,
      });
    });

    const credential = await deps.ensureGitHubCredential(anthropicClient, {
      githubToken,
      vaultId: vault.vaultId,
    });
    credentialId = credential.credentialId;
    managedCredential = credential.managedByUs;
    throwIfAborted(sessionController.signal);

    const { issue, subIssues } = await deps.readIssue(octokit, owner, repoName, input.issue);
    const branch = `agent/issue-${input.issue}/${slug(issue.title)}`;
    runState = {
      branch,
      issueNumber: input.issue,
      repo: `${owner}/${repoName}`,
      runId: fallbackRunId,
      sessionIds: [],
      startedAt: new Date().toISOString(),
      subIssues: [],
      vaultId: vault.vaultId,
    };

    safeSetRunStatus("running");
    await writeAndSyncRunState();

    notifyPhase("session_start");
    const parentSession = await anthropicClient.beta.sessions.create({
      agent: agents.parentAgentId,
      environment_id: environment.environmentId,
      resources: [
        {
          authorization_token: githubToken,
          checkout: { name: branch, type: "branch" },
          mount_path: `/workspace/${repoName}`,
          type: "github_repository",
          url: `https://github.com/${owner}/${repoName}`,
        },
      ],
      vault_ids: [vault.vaultId],
    });
    notifySession({ kind: "created", payload: { role: "parent" }, sessionId: parentSession.id });
    runState.sessionIds = [...runState.sessionIds, parentSession.id];
    await writeAndSyncRunState();
    try {
      db.insertSessionPlaceholder(fallbackRunId, parentSession.id);
    } catch (error) {
      logger.warn(
        { err: error, runId: fallbackRunId, sessionId: parentSession.id },
        "failed to record parent session placeholder",
      );
    }
    cleanup.register(async () => {
      await anthropicClient.beta.sessions.delete(parentSession.id);
    });

    const parentPromptText = deps.buildParentPrompt({
      baseBranch,
      branch,
      commitStyle: cfg.commitStyle,
      git: cfg.git,
      maxSubIssues: cfg.maxSubIssues,
      parentIssueNumber: issue.number,
      repoName,
      repoOwner: owner,
    });

    await anthropicClient.beta.sessions.events.send(parentSession.id, {
      events: [
        {
          content: [{ text: parentPromptText, type: "text" }],
          type: "user.message",
        },
      ],
    });
    notifySession({ kind: "prompt_sent", sessionId: parentSession.id });
    throwIfAborted(sessionController.signal);

    const handlers = {
      create_final_pr: async (args: unknown) => {
        notifyPhase("finalize_pr");
        const finalPrOutcome = await deps.handleCreateFinalPr(
          {
            baseBranch,
            cfg,
            octokit,
            owner,
            parentIssueNumber: input.issue,
            repo: repoName,
            runState: runState as RunState,
          },
          args,
        );

        if (finalPrOutcome.success) {
          runState = { ...(runState as RunState), prUrl: finalPrOutcome.prUrl };
          await writeAndSyncRunState();
        }

        return finalPrOutcome;
      },
      create_sub_issue: async (args: unknown) => {
        notifyPhase("decomposition");
        const previousSubIssues = (runState as RunState).subIssues;
        const createSubIssueResult = await deps.handleCreateSubIssue(
          {
            cfg,
            existingSubIssues: subIssues,
            octokit,
            owner,
            parentIssueId: issue.id,
            parentIssueNumber: input.issue,
            repo: repoName,
            runState: runState as RunState,
            writeRunState: deps.writeRunState,
          },
          args,
        );

        if ((runState as RunState).subIssues !== previousSubIssues) {
          await syncRunToDb();
        }

        if (createSubIssueResult.success) {
          const changeKind = createSubIssueResult.reused ? "updated" : "created";
          notifySubIssue({
            kind: changeKind,
            payload: buildSubIssueObserverPayload({
              args,
              changeKind,
              repo: `${owner}/${repoName}`,
              result: createSubIssueResult,
              runState: runState as RunState,
            }),
          });
        }

        return createSubIssueResult;
      },
      spawn_child_task: async (args: unknown) => {
        notifyPhase("child_execution");
        const childResult = await deps.handleSpawnChildTask(
          {
            anthropicClient: anthropicClient as Parameters<
              typeof handleSpawnChildTask
            >[0]["anthropicClient"],
            baseBranch,
            cfg,
            childAgentId: agents.childAgentId,
            environmentId: environment.environmentId,
            githubToken,
            logger,
            onSessionCreated: async (childSessionId) => {
              runState = {
                ...(runState as RunState),
                sessionIds: [...(runState as RunState).sessionIds, childSessionId],
              };
              await writeAndSyncRunState();
              try {
                db.insertSessionPlaceholder(fallbackRunId, childSessionId);
              } catch (error) {
                logger.warn(
                  { childSessionId, err: error, runId: fallbackRunId },
                  "failed to record child session placeholder",
                );
              }
              notifySession({
                kind: "created",
                payload: { role: "child" },
                sessionId: childSessionId,
              });
            },
            registerCleanup: (cleanupFn) => cleanup.register(cleanupFn),
            repo: { name: repoName, owner },
            runId: fallbackRunId,
            signal: sessionController.signal,
            vaultId: vault.vaultId,
          },
          args,
        );

        try {
          db.insertChildTaskResult(fallbackRunId, buildChildTaskResultForDb(childResult));
        } catch (error) {
          logger.warn(
            { err: error, runId: fallbackRunId, taskId: childResult.taskId },
            "failed to sync child task result to SQLite",
          );
        }

        return childResult;
      },
    };

    const sessionResult = await deps.runSession(anthropicClient, {
      handlers,
      logger,
      sessionId: parentSession.id,
      signal: sessionController.signal,
      timeouts: {
        maxWallClockMs: cfg.maxRunMinutes * 60 * 1000,
      },
    });
    notifySession({ kind: "completed", payload: sessionResult, sessionId: parentSession.id });

    try {
      db.insertSession(fallbackRunId, sessionResult);
    } catch (error) {
      logger.warn({ err: error, runId: fallbackRunId }, "failed to sync session result to SQLite");
    }

    if (sessionController.signal.aborted || sessionResult.aborted) {
      notifyPhase("aborted");
      safeSetRunStatus("aborted");
      await triggerCleanup();
      return {
        aborted: true,
        runId: fallbackRunId,
        status: "aborted",
        timedOut: sessionResult.timedOut,
      };
    }

    if (sessionResult.errored) {
      throw new RunExecutionFailure("session_error", "Session stream failed before completion");
    }

    if (sessionResult.timedOut) {
      throw new RunExecutionFailure("timeout", "Session timed out before completion");
    }

    if (!runState.prUrl) {
      throw new RunExecutionFailure(
        "final_pr_missing",
        "Final PR URL was not recorded in run state",
      );
    }

    safeSetRunStatus("completed");
    await triggerCleanup();
    return {
      aborted: false,
      prUrl: runState.prUrl,
      runId: fallbackRunId,
      status: "completed",
      timedOut: false,
    };
  } catch (error) {
    const wasAborted = error instanceof RunExecutionAborted || sessionController.signal.aborted;
    const errored = categorizeError(error);
    const status: RunStatus = wasAborted ? "aborted" : "failed";

    if (wasAborted) {
      notifyPhase("aborted");
    }

    safeSetRunStatus(status);
    notifyLog(logger, activeObservers, "error", "run orchestration failed", {
      err: error,
      type: errored.type,
    });
    await triggerCleanup();

    return {
      aborted: wasAborted,
      errored,
      runId: fallbackRunId,
      status,
      timedOut: errored.type === "timeout",
    };
  } finally {
    if (deps.signal && externalAbortListener) {
      deps.signal.removeEventListener("abort", externalAbortListener);
    }
  }
}
