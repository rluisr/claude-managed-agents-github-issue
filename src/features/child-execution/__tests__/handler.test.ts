import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsSessionStatusRunningEvent,
  BetaManagedAgentsUserCustomToolResultEvent,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import pino from "pino";

import type { Config } from "@/shared/config";
import { createFakeAnthropicSessions } from "../../../../test/fixtures/fake-anthropic-sessions";
import { type HandleSpawnChildTaskContext, handleSpawnChildTask } from "../handler";

const PROCESSED_AT = "2026-04-23T00:00:00.000Z";

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    commitStyle: "conventional",
    git: {
      authorEmail: "claude-agent@users.noreply.github.com",
      authorName: "claude-agent[bot]",
    },
    maxChildMinutes: 30,
    maxRunMinutes: 120,
    maxSubIssues: 10,
    models: {
      child: "claude-sonnet-4-6",
      parent: "claude-opus-4-7",
    },
    pr: {
      draft: true,
    },
    ...overrides,
  };
}

function buildArgs(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    acceptanceCriteria: ["adds tests", "cleans up session"],
    branch: "feat/x",
    description: "Implement the delegated task.",
    priorCommits: [{ message: "seed work", sha: "abc123" }],
    taskId: "task-22",
    title: "Implement spawn child task",
    ...overrides,
  };
}

function createRunningEvent(id: string): BetaManagedAgentsSessionStatusRunningEvent {
  return {
    id,
    processed_at: PROCESSED_AT,
    type: "session.status_running",
  };
}

function createIdleEvent(id: string): BetaManagedAgentsSessionStatusIdleEvent {
  return {
    id,
    processed_at: PROCESSED_AT,
    stop_reason: { type: "end_turn" },
    type: "session.status_idle",
  };
}

function createAgentMessageEvent(id: string, text: string): BetaManagedAgentsAgentMessageEvent {
  return {
    content: [{ text, type: "text" }],
    id,
    processed_at: PROCESSED_AT,
    type: "agent.message",
  };
}

function getUserMessageText(params: EventSendParams): string {
  const firstEvent = params.events[0];
  if (!firstEvent || firstEvent.type !== "user.message") {
    throw new Error("Expected a user.message event");
  }

  const firstBlock = firstEvent.content[0];
  if (!firstBlock || firstBlock.type !== "text") {
    throw new Error("Expected a text block in user.message");
  }

  return firstBlock.text;
}

function buildContext(
  anthropicClient: Anthropic,
  overrides: Partial<HandleSpawnChildTaskContext> = {},
): { cleanupFns: Array<() => Promise<void>>; ctx: HandleSpawnChildTaskContext } {
  const cleanupFns: Array<() => Promise<void>> = [];

  return {
    cleanupFns,
    ctx: {
      anthropicClient,
      baseBranch: overrides.baseBranch ?? "main",
      cfg: overrides.cfg ?? buildConfig(),
      childAgentId: overrides.childAgentId ?? "agent-child-1",
      environmentId: overrides.environmentId ?? "env-1",
      githubToken: overrides.githubToken ?? "inline-secret-token",
      logger: overrides.logger ?? pino({ level: "silent" }),
      onSessionCreated: overrides.onSessionCreated,
      registerCleanup:
        overrides.registerCleanup ??
        ((cleanupFn: () => Promise<void>) => {
          cleanupFns.push(cleanupFn);
        }),
      repo: overrides.repo ?? { name: "widgets", owner: "acme" },
      runId: overrides.runId ?? "run-123",
      signal: overrides.signal,
      vaultId: overrides.vaultId ?? "vault-1",
    },
  };
}

async function runHappyPath(
  overrides: {
    cfg?: Config;
    githubToken?: string;
    listEvent?: BetaManagedAgentsAgentMessageEvent | BetaManagedAgentsUserCustomToolResultEvent;
    logger?: HandleSpawnChildTaskContext["logger"];
  } = {},
) {
  const finalEvent =
    overrides.listEvent ??
    createAgentMessageEvent(
      "evt-message-1",
      JSON.stringify({
        commitSha: "abc123",
        filesChanged: ["src/features/child-execution/handler.ts"],
        success: true,
        taskId: "task-22",
        testOutput: "bun test",
      }),
    );
  const fakeAnthropic = createFakeAnthropicSessions({
    listScripts: [[finalEvent]],
    streamScripts: [[createRunningEvent("evt-running-1"), createIdleEvent("evt-idle-1")]],
  });
  const { cleanupFns, ctx } = buildContext(fakeAnthropic.client as unknown as Anthropic, {
    cfg: overrides.cfg,
    githubToken: overrides.githubToken,
    logger: overrides.logger,
  });
  const handlerOutput = await handleSpawnChildTask(ctx, buildArgs());

  return { calls: fakeAnthropic.calls, cleanupFns, handlerOutput };
}

describe("handleSpawnChildTask", () => {
  test("parses input; rejects invalid", async () => {
    const fakeAnthropic = createFakeAnthropicSessions({ listScripts: [], streamScripts: [] });
    const { ctx } = buildContext(fakeAnthropic.client as unknown as Anthropic);

    const handlerOutput = await handleSpawnChildTask(ctx, { taskId: "" });

    expect(handlerOutput.success).toBe(false);
    expect(handlerOutput.taskId).toBe("unknown");
    expect(handlerOutput.error?.type).toBe("schema");
    expect(fakeAnthropic.calls.creates).toEqual([]);
  });

  test("creates child session with checkout.name set to baseBranch (not the feature branch)", async () => {
    const { calls } = await runHappyPath();
    const createCall = calls.creates[0];
    const resource = createCall?.resources?.[0];
    if (!resource || resource.type !== "github_repository" || !resource.checkout) {
      throw new Error("Expected a GitHub repository resource with checkout details");
    }

    if (resource.checkout.type !== "branch") {
      throw new Error("Expected branch checkout");
    }

    expect(resource.checkout.name).toBe("main");
    expect("branch" in resource.checkout).toBe(false);
    expect("branch" in resource).toBe(false);
  });

  test("creates child session with authorization_token inline and vault_ids", async () => {
    const { calls } = await runHappyPath({ githubToken: "inline-secret-token" });
    const createCall = calls.creates[0];
    const resource = createCall?.resources?.[0];
    if (!resource || resource.type !== "github_repository") {
      throw new Error("Expected a GitHub repository resource");
    }

    expect(resource.authorization_token).toBe("inline-secret-token");
    expect(createCall?.vault_ids).toEqual(["vault-1"]);
  });

  test("sends initial user.message with rendered child prompt", async () => {
    const { calls } = await runHappyPath();
    const sendCall = calls.sends[0];
    if (!sendCall) {
      throw new Error("Expected one send call");
    }

    const promptText = getUserMessageText(sendCall.params);
    expect(promptText).toContain("Implement spawn child task");
    expect(promptText).toContain("feat/x");
  });

  test("streams child via runSession until session.status_idle", async () => {
    const { calls, handlerOutput } = await runHappyPath();

    expect(calls.streamCalls).toEqual(["sess-1"]);
    expect(handlerOutput.success).toBe(true);
  });

  test("captures final agent.message JSON as ChildTaskResult", async () => {
    const fakeAnthropic = createFakeAnthropicSessions({
      listScripts: [
        [
          createAgentMessageEvent(
            "evt-message-2",
            JSON.stringify({
              commitSha: "abc",
              filesChanged: [
                "src/features/child-execution/handler.ts",
                "src/features/child-execution/__tests__/handler.test.ts",
              ],
              success: true,
              taskId: "different-task-id",
              testOutput: "bun test src/features/child-execution/__tests__/handler.test.ts",
            }),
          ),
        ],
      ],
      streamScripts: [[createRunningEvent("evt-running-2"), createIdleEvent("evt-idle-2")]],
    });
    const { ctx } = buildContext(fakeAnthropic.client as unknown as Anthropic);

    const handlerOutput = await handleSpawnChildTask(ctx, buildArgs());

    expect(handlerOutput).toEqual({
      commitSha: "abc",
      filesChanged: [
        "src/features/child-execution/handler.ts",
        "src/features/child-execution/__tests__/handler.test.ts",
      ],
      success: true,
      taskId: "task-22",
      testOutput: "bun test src/features/child-execution/__tests__/handler.test.ts",
    });
  });

  test("uses the most recent result candidate without falling back to older JSON", async () => {
    const fakeAnthropic = createFakeAnthropicSessions({
      listScripts: [
        [
          createAgentMessageEvent("evt-message-latest", "not json"),
          createAgentMessageEvent(
            "evt-message-older",
            JSON.stringify({
              commitSha: "older-sha",
              success: true,
              taskId: "task-22",
            }),
          ),
        ],
      ],
      streamScripts: [[createRunningEvent("evt-running-3"), createIdleEvent("evt-idle-3")]],
    });
    const { ctx } = buildContext(fakeAnthropic.client as unknown as Anthropic);

    const handlerOutput = await handleSpawnChildTask(ctx, buildArgs());

    expect(handlerOutput.success).toBe(false);
    expect(handlerOutput.error?.type).toBe("malformed_response");
  });

  test("timeout: child wall-clock exceeds maxChildMinutes → error.type === 'timeout' + session deleted", async () => {
    const fakeAnthropic = createFakeAnthropicSessions({
      listScripts: [],
      streamScripts: [[{ kind: "pending" }]],
    });
    const { ctx } = buildContext(fakeAnthropic.client as unknown as Anthropic, {
      cfg: buildConfig({ maxChildMinutes: 0.001 }),
    });

    const handlerOutput = await handleSpawnChildTask(ctx, buildArgs());

    expect(handlerOutput.success).toBe(false);
    expect(handlerOutput.error?.type).toBe("timeout");
    expect(fakeAnthropic.calls.deletes).toEqual(["sess-1"]);
  });

  test("cleanup on success: sessions.delete called exactly once", async () => {
    const { calls } = await runHappyPath();

    expect(calls.deletes).toEqual(["sess-1"]);
  });

  test("registered cleanup is once-only after explicit success cleanup", async () => {
    const { calls, cleanupFns } = await runHappyPath();
    const registeredCleanup = cleanupFns[0];
    if (!registeredCleanup) {
      throw new Error("Expected one registered cleanup callback");
    }

    await registeredCleanup();

    expect(calls.deletes).toEqual(["sess-1"]);
  });

  test("invokes onSessionCreated with the new child session id", async () => {
    const finalEvent = createAgentMessageEvent(
      "evt-message-cb",
      JSON.stringify({
        commitSha: "abc123",
        filesChanged: ["src/features/child-execution/handler.ts"],
        success: true,
        taskId: "task-22",
        testOutput: "bun test",
      }),
    );
    const fakeAnthropic = createFakeAnthropicSessions({
      listScripts: [[finalEvent]],
      streamScripts: [[createRunningEvent("evt-running-cb"), createIdleEvent("evt-idle-cb")]],
    });
    const observedSessionIds: string[] = [];
    const { ctx } = buildContext(fakeAnthropic.client as unknown as Anthropic, {
      onSessionCreated: (sessionId) => {
        observedSessionIds.push(sessionId);
      },
    });

    const handlerOutput = await handleSpawnChildTask(ctx, buildArgs());

    expect(handlerOutput.success).toBe(true);
    expect(observedSessionIds).toEqual(["sess-1"]);
  });

  test("does not fail the task when onSessionCreated throws", async () => {
    const finalEvent = createAgentMessageEvent(
      "evt-message-cb-fail",
      JSON.stringify({
        commitSha: "abc123",
        filesChanged: ["src/features/child-execution/handler.ts"],
        success: true,
        taskId: "task-22",
        testOutput: "bun test",
      }),
    );
    const fakeAnthropic = createFakeAnthropicSessions({
      listScripts: [[finalEvent]],
      streamScripts: [
        [createRunningEvent("evt-running-cb-fail"), createIdleEvent("evt-idle-cb-fail")],
      ],
    });
    const { ctx } = buildContext(fakeAnthropic.client as unknown as Anthropic, {
      onSessionCreated: () => {
        throw new Error("placeholder insert exploded");
      },
    });

    const handlerOutput = await handleSpawnChildTask(ctx, buildArgs());

    expect(handlerOutput.success).toBe(true);
    expect(handlerOutput.taskId).toBe("task-22");
  });

  test("authorization_token never appears in emitted log records", async () => {
    const logChunks: string[] = [];
    const logStream = new PassThrough();
    logStream.on("data", (chunk) => {
      logChunks.push(chunk.toString());
    });

    const logger: HandleSpawnChildTaskContext["logger"] = pino({ level: "debug" }, logStream);
    await runHappyPath({ githubToken: "plain-inline-token-value", logger });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logChunks.join("")).not.toContain("plain-inline-token-value");
  });
});
