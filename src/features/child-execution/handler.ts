import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsTextBlock,
  BetaManagedAgentsUserCustomToolResultEvent,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { Logger } from "pino";
import type { z } from "zod";

import { buildChildPrompt } from "@/shared/agents/prompts/child";
import type { Config } from "@/shared/config";
import { runSession, type SessionClient } from "@/shared/session";
import { SpawnChildTaskInput, SpawnChildTaskOutput } from "./schemas";

export type HandleSpawnChildTaskContext = {
  anthropicClient: Anthropic;
  cfg: Config;
  githubToken: string;
  vaultId: string;
  childAgentId: string;
  environmentId: string;
  runId: string;
  repo: { owner: string; name: string };
  baseBranch: string;
  logger: Logger;
  registerCleanup: (cleanupFn: () => Promise<void>) => void;
  signal?: AbortSignal;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
  /**
   * Repository-specific instructions appended to the child runtime prompt.
   * Pass null/undefined for repos without an override.
   */
  repoPrompt?: string | null;
};

export type HandleSpawnChildTaskOutput = z.infer<typeof SpawnChildTaskOutput>;

type FailureOutput = HandleSpawnChildTaskOutput & {
  error: NonNullable<HandleSpawnChildTaskOutput["error"]> & {
    details?: unknown;
  };
  success: false;
};

type ResultCandidateEvent =
  | BetaManagedAgentsAgentMessageEvent
  | BetaManagedAgentsUserCustomToolResultEvent;

const LIST_LIMIT = 50;
const PREVIEW_CHAR_LIMIT = 240;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bestEffortTaskId(value: unknown): string {
  if (!isRecord(value) || typeof value.taskId !== "string") {
    return "unknown";
  }

  const trimmedTaskId = value.taskId.trim();
  return trimmedTaskId.length > 0 ? trimmedTaskId : "unknown";
}

function schemaErrorMessage(issues: readonly { message: string; path: PropertyKey[] }[]): string {
  const issueMessages = issues.map((issue) => {
    const issuePath = issue.path.length > 0 ? issue.path.join(".") : "input";
    return `${issuePath}: ${issue.message}`;
  });

  return issueMessages.join("; ");
}

function failureOutput(
  taskId: string,
  type: string,
  message: string,
  details?: unknown,
): FailureOutput {
  return {
    error: typeof details === "undefined" ? { message, type } : { details, message, type },
    success: false,
    taskId,
  };
}

function textPreview(
  blocks: readonly BetaManagedAgentsTextBlock[] | undefined,
): string | undefined {
  const firstText = blocks?.find((block) => block.type === "text")?.text;
  if (typeof firstText !== "string") {
    return undefined;
  }

  return firstText.slice(0, PREVIEW_CHAR_LIMIT);
}

function textBlocksFromContent(event: ResultCandidateEvent): BetaManagedAgentsTextBlock[] {
  const textBlocks: BetaManagedAgentsTextBlock[] = [];

  for (const contentBlock of event.content ?? []) {
    if (contentBlock.type === "text") {
      textBlocks.push(contentBlock);
    }
  }

  return textBlocks;
}

function extractJsonFromText(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const fencedMatch = /```(?:json)?\r?\n([\s\S]*?)```/.exec(text);
    if (!fencedMatch || typeof fencedMatch[1] !== "string") {
      return null;
    }

    try {
      return JSON.parse(fencedMatch[1]);
    } catch {
      return null;
    }
  }
}

function extractResultJson(event: ResultCandidateEvent): unknown | null {
  const contentBlocks = event.content ?? [];

  for (const contentBlock of contentBlocks) {
    if (contentBlock.type !== "text") {
      continue;
    }

    const parsedJson = extractJsonFromText(contentBlock.text);
    if (parsedJson !== null) {
      return parsedJson;
    }
  }

  return null;
}

function resultCandidateFromEvent(
  event: BetaManagedAgentsSessionEvent,
): ResultCandidateEvent | null {
  if (event.type === "agent.message" || event.type === "user.custom_tool_result") {
    return event;
  }

  return null;
}

async function listRecentEvents(
  anthropicClient: Anthropic,
  sessionId: string,
): Promise<BetaManagedAgentsSessionEvent[]> {
  const recentEvents: BetaManagedAgentsSessionEvent[] = [];

  for await (const sessionEvent of anthropicClient.beta.sessions.events.list(sessionId, {
    limit: LIST_LIMIT,
    order: "desc",
  })) {
    recentEvents.push(sessionEvent);
    if (recentEvents.length >= LIST_LIMIT) {
      break;
    }
  }

  return recentEvents;
}

async function parseChildResult(
  anthropicClient: Anthropic,
  sessionId: string,
  taskId: string,
): Promise<HandleSpawnChildTaskOutput> {
  const recentEvents = await listRecentEvents(anthropicClient, sessionId);
  let lastEventType: string | undefined = recentEvents[0]?.type;
  let preview: string | undefined;

  for (const sessionEvent of recentEvents) {
    const resultCandidate = resultCandidateFromEvent(sessionEvent);
    if (!resultCandidate) {
      continue;
    }

    lastEventType = resultCandidate.type;
    preview = textPreview(textBlocksFromContent(resultCandidate));

    const parsedJson = extractResultJson(resultCandidate);
    if (parsedJson !== null) {
      const parsedOutput = SpawnChildTaskOutput.safeParse(parsedJson);
      if (parsedOutput.success) {
        return {
          ...parsedOutput.data,
          taskId,
        };
      }

      return failureOutput(
        taskId,
        "malformed_response",
        "Child did not emit a parseable ChildTaskResult",
        {
          details: parsedOutput.error.issues,
          lastEventType,
          preview,
        },
      );
    }

    return failureOutput(
      taskId,
      "malformed_response",
      "Child did not emit a parseable ChildTaskResult",
      {
        lastEventType,
        preview,
      },
    );
  }

  return failureOutput(
    taskId,
    "malformed_response",
    "Child did not emit a parseable ChildTaskResult",
    {
      lastEventType,
      preview,
    },
  );
}

async function safeDeleteSession(
  anthropicClient: Anthropic,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  try {
    await anthropicClient.beta.sessions.delete(sessionId);
    logger.debug({ sessionId }, "child session deleted");
  } catch (error) {
    logger.warn({ err: error, sessionId }, "failed to delete child session");
  }
}

function createSessionCleanup(
  anthropicClient: Anthropic,
  sessionId: string,
  logger: Logger,
): () => Promise<void> {
  let deletePromise: Promise<void> | undefined;

  return async () => {
    deletePromise ??= safeDeleteSession(anthropicClient, sessionId, logger);
    await deletePromise;
  };
}

export async function handleSpawnChildTask(
  ctx: HandleSpawnChildTaskContext,
  args: unknown,
): Promise<HandleSpawnChildTaskOutput> {
  const parsedInput = SpawnChildTaskInput.safeParse(args);
  if (!parsedInput.success) {
    return failureOutput(
      bestEffortTaskId(args),
      "schema",
      schemaErrorMessage(parsedInput.error.issues),
      parsedInput.error.issues,
    );
  }

  const parsedArgs = parsedInput.data;
  const mountPath = `/workspace/${ctx.repo.name}`;
  const renderedChildPrompt = buildChildPrompt({
    baseBranch: ctx.baseBranch,
    branch: parsedArgs.branch,
    commitStyle: ctx.cfg.commitStyle,
    git: ctx.cfg.git,
    priorCommits: parsedArgs.priorCommits,
    repoName: ctx.repo.name,
    repoOwner: ctx.repo.owner,
    repoPrompt: ctx.repoPrompt ?? null,
    task: {
      acceptanceCriteria: parsedArgs.acceptanceCriteria,
      description: parsedArgs.description,
      id: parsedArgs.taskId,
      title: parsedArgs.title,
    },
  });
  const taskLogger = ctx.logger.child({ parentTaskId: parsedArgs.taskId, runId: ctx.runId });

  let cleanupChildSession: (() => Promise<void>) | undefined;
  let childSessionId: string | undefined;

  try {
    taskLogger.info(
      {
        branch: parsedArgs.branch,
        childAgentId: ctx.childAgentId,
        environmentId: ctx.environmentId,
        mountPath,
      },
      "creating child session",
    );

    const childSession = await ctx.anthropicClient.beta.sessions.create({
      agent: ctx.childAgentId,
      environment_id: ctx.environmentId,
      metadata: {
        parentTaskId: parsedArgs.taskId,
        role: "child",
        runId: ctx.runId,
      },
      resources: [
        {
          authorization_token: ctx.githubToken,
          checkout: { name: ctx.baseBranch, type: "branch" },
          mount_path: mountPath,
          type: "github_repository",
          url: `https://github.com/${ctx.repo.owner}/${ctx.repo.name}`,
        },
      ],
      vault_ids: [ctx.vaultId],
    });
    childSessionId = childSession.id;
    const sessionCleanup = createSessionCleanup(ctx.anthropicClient, childSession.id, taskLogger);
    cleanupChildSession = sessionCleanup;

    ctx.registerCleanup(async () => {
      await sessionCleanup();
    });

    taskLogger.info(
      {
        branch: parsedArgs.branch,
        childAgentId: ctx.childAgentId,
        childSessionId: childSession.id,
        environmentId: ctx.environmentId,
        mountPath,
      },
      "child session created",
    );

    if (ctx.onSessionCreated) {
      try {
        await ctx.onSessionCreated(childSession.id);
      } catch (notifyError) {
        taskLogger.warn(
          { childSessionId: childSession.id, err: notifyError },
          "onSessionCreated callback failed; continuing",
        );
      }
    }

    await ctx.anthropicClient.beta.sessions.events.send(childSession.id, {
      events: [
        {
          content: [{ text: renderedChildPrompt, type: "text" }],
          type: "user.message",
        },
      ],
    });

    taskLogger.info({ childSessionId: childSession.id }, "child prompt sent, starting session");

    const sessionResult = await runSession(ctx.anthropicClient as unknown as SessionClient, {
      handlers: {},
      logger: taskLogger.child({ childSessionId: childSession.id }),
      sessionId: childSession.id,
      signal: ctx.signal,
      timeouts: {
        maxWallClockMs: ctx.cfg.maxChildMinutes * 60 * 1000,
      },
    });

    taskLogger.info(
      {
        aborted: sessionResult.aborted,
        childSessionId: childSession.id,
        durationMs: sessionResult.durationMs,
        errored: sessionResult.errored,
        eventsProcessed: sessionResult.eventsProcessed,
        idleReached: sessionResult.idleReached,
        timedOut: sessionResult.timedOut,
        toolErrors: sessionResult.toolErrors,
        toolInvocations: sessionResult.toolInvocations,
      },
      "child session completed",
    );

    if (sessionResult.timedOut) {
      return failureOutput(
        parsedArgs.taskId,
        "timeout",
        `Child wall-clock exceeded ${ctx.cfg.maxChildMinutes} minutes`,
      );
    }

    if (sessionResult.aborted) {
      return failureOutput(
        parsedArgs.taskId,
        "aborted",
        "Child session was aborted before completion",
      );
    }

    if (sessionResult.errored) {
      return failureOutput(
        parsedArgs.taskId,
        "stream_error",
        "Child session stream failed before reaching idle",
      );
    }

    const childResult = await parseChildResult(
      ctx.anthropicClient,
      childSession.id,
      parsedArgs.taskId,
    );

    taskLogger.info(
      { childSessionId: childSession.id, success: childResult.success, taskId: childResult.taskId },
      "child result parsed",
    );

    return childResult;
  } catch (error) {
    taskLogger.error(
      {
        childSessionId,
        err: error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "child session handler failed",
    );

    return failureOutput(
      parsedArgs.taskId,
      "stream_error",
      error instanceof Error ? error.message : "Child session failed unexpectedly",
    );
  } finally {
    if (typeof childSessionId === "string" && cleanupChildSession) {
      await cleanupChildSession();
    }
  }
}
