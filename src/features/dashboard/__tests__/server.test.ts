import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { type CreateAppOptions, createApp } from "@/features/dashboard/server";
import { createDbModule } from "@/shared/persistence/db";
import type { SessionClient, SessionResult } from "@/shared/session";
import type { ChildTaskResult, RunState } from "@/shared/types";

type DbModule = ReturnType<typeof createDbModule>;

const openDbs: DbModule[] = [];

const PROCESSED_AT = "2026-04-27T00:00:00.000Z";

function createIdleEvent(
  id: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.status_idle" }> {
  return {
    id,
    processed_at: PROCESSED_AT,
    stop_reason: { type: "end_turn" },
    type: "session.status_idle",
  };
}

function createAgentMessageEvent(
  id: string,
  text: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "agent.message" }> {
  return {
    content: [{ text, type: "text" }],
    id,
    processed_at: PROCESSED_AT,
    type: "agent.message",
  };
}

function asyncIterableOf<TEvent>(events: ReadonlyArray<TEvent>): AsyncIterable<TEvent> {
  return {
    [Symbol.asyncIterator]() {
      let cursorIndex = 0;
      return {
        async next(): Promise<IteratorResult<TEvent>> {
          if (cursorIndex >= events.length) {
            return { done: true, value: undefined };
          }
          const nextEvent = events[cursorIndex];
          cursorIndex += 1;
          if (typeof nextEvent === "undefined") {
            return { done: true, value: undefined };
          }
          return { done: false, value: nextEvent };
        },
        async return(): Promise<IteratorResult<TEvent>> {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function createFakeSessionClient(opts: {
  history?: ReadonlyArray<BetaManagedAgentsSessionEvent>;
  live?: ReadonlyArray<BetaManagedAgentsStreamSessionEvents>;
}): SessionClient {
  return {
    beta: {
      sessions: {
        events: {
          list() {
            return asyncIterableOf(opts.history ?? []);
          },
          async send() {
            return { ok: true };
          },
          async stream() {
            return asyncIterableOf(opts.live ?? []);
          },
        },
      },
    },
  };
}

function createRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    branch: "agent/issue-42/fix-login-flow",
    issueNumber: 42,
    repo: "acme/widgets",
    runId: "run-1",
    sessionIds: [],
    startedAt: "2026-04-24T10:00:00.000Z",
    subIssues: [],
    ...overrides,
  };
}

function createSessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    aborted: false,
    durationMs: 12_345,
    errored: false,
    eventsProcessed: 25,
    idleReached: true,
    lastEventId: "evt_123",
    sessionId: "session-1",
    timedOut: false,
    toolErrors: 1,
    toolInvocations: 8,
    ...overrides,
  };
}

function createChildTaskResult(overrides: Partial<ChildTaskResult> = {}): ChildTaskResult {
  return {
    commitSha: "abc1234def5678",
    filesChanged: ["src/features/dashboard/server.ts"],
    success: true,
    taskId: "task-1",
    testOutput: "bun test",
    ...overrides,
  };
}

function createAppWithSeededDb(
  seed?: (db: DbModule) => void,
  appOpts: Partial<Omit<CreateAppOptions, "db">> = {},
) {
  const db = createDbModule(":memory:");
  openDbs.push(db);
  db.initDb();
  seed?.(db);
  return { app: createApp({ db, ...appOpts }), db };
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe("createApp", () => {
  test("GET / returns 200 HTML containing repositories", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState());
    });

    const response = await app.request("/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('href="/repos/acme/widgets"');
  });

  test("GET / returns empty state when no runs exist", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("No runs yet");
  });

  test("GET /repositories returns 200 HTML containing repositories", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState());
    });

    const response = await app.request("/repositories");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('href="/repos/acme/widgets"');
  });

  test("GET /runs returns 200 HTML containing all runs", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-all-1" }));
      db.insertRun(createRunState({ repo: "acme/other", runId: "run-all-2" }));
    });

    const response = await app.request("/runs");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("run-all-");
    expect(body).toContain("acme/widgets");
    expect(body).toContain("acme/other");
  });

  test("GET /assets/dashboard.css serves static assets from the configured directory", async () => {
    const staticAssetsDir = await mkdtemp(join(tmpdir(), "dashboard-assets-"));
    const css = ".dashboard { color: red; }\n";

    try {
      await writeFile(join(staticAssetsDir, "dashboard.css"), css);

      const { app } = createAppWithSeededDb(undefined, { staticAssetsDir });
      const response = await app.request("/assets/dashboard.css");
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/css");
      expect(body).toBe(css);
    } finally {
      await rm(staticAssetsDir, { force: true, recursive: true });
    }
  });

  test("GET /repos/:owner/:name returns runs for that repo", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(
        createRunState({
          branch: "agent/issue-42/foo",
          subIssues: [{ issueId: 101, issueNumber: 43, taskId: "task-1" }],
        }),
      );
      db.setRunStatus("run-1", "running");
      db.insertRun(
        createRunState({
          repo: "acme/other",
          runId: "run-other",
          startedAt: "2026-04-24T11:00:00.000Z",
        }),
      );
    });

    const response = await app.request("/repos/acme/widgets");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("agent/issue-42/foo");
    expect(body).toContain("#42");
    expect(body).toContain("in-progress");
    expect(body).toContain('class="px-4 py-3 font-mono text-neutral-900">1</td>');
    expect(body).not.toContain("run-other");
  });

  test("GET /repos/:owner/:name returns empty state for unknown repos", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/repos/acme/widgets");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("No runs for acme/widgets");
  });

  test("GET /runs/:runId returns run detail", async () => {
    const { app } = createAppWithSeededDb((db) => {
      const run = createRunState({
        runId: "run-detail-1",
        sessionIds: ["session-1"],
        subIssues: [{ issueId: 101, issueNumber: 43, taskId: "task-1" }],
      });

      db.insertRun(run);
      db.insertSession(
        run.runId,
        createSessionResult({
          sessionId: "session-1",
        }),
      );
      db.insertChildTaskResult(
        run.runId,
        createChildTaskResult({
          commitSha: "abc1234def5678",
          taskId: "task-1",
        }),
      );
    });

    const response = await app.request("/runs/run-detail-1");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("session metrics");
    expect(body).toContain("sub issues (1)");
    expect(body).toContain("task-1");
    expect(body).toContain("abc1234");
    expect(body).toContain("files changed (1)");
  });

  test("GET /runs/:runId/live returns live view with EventSource script", async () => {
    const { app } = createAppWithSeededDb((db) => {
      const run = createRunState({
        runId: "run-live-1",
        sessionIds: ["session-1"],
        subIssues: [{ issueId: 101, issueNumber: 43, taskId: "task-1" }],
      });

      db.insertRun(run);
    });

    const response = await app.request("/runs/run-live-1/live");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("live run");
    expect(body).toContain("run-live-1");
    expect(body).toContain("EventSource('/api/runs/' + encodeURIComponent(runId) + '/events')");
    expect(body).toContain("addEventListener('phase'");
    expect(body).toContain("addEventListener('session'");
    expect(body).toContain("addEventListener('subIssue'");
    expect(body).toContain("addEventListener('log'");
    expect(body).toContain("addEventListener('complete'");
    expect(body).toContain("addEventListener('error'");
  });

  test("GET /runs/:runId/live shows stop button when persisted status is running", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-live-2" }));
      db.setRunStatus("run-live-2", "running");
    });

    const response = await app.request("/runs/run-live-2/live");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('action="/api/runs/run-live-2/stop"');
    expect(body).toContain("stop this run");
    expect(body).toContain('style="display:block"');
    expect(body).toContain('id="run-status-badge"');
  });

  test("GET /runs/:runId/live hides stop button and shows PR URL when status is completed", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(
        createRunState({
          prUrl: "https://github.com/acme/widgets/pull/1",
          runId: "run-live-3",
        }),
      );
      db.setRunStatus("run-live-3", "completed");
    });

    const response = await app.request("/runs/run-live-3/live");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('style="display:none"');
    expect(body).toContain('id="pr-url-container"');
    expect(body).toContain('style="display:flex"');
    expect(body).toContain("acme/widgets/pull/1");
  });

  test("GET /runs/:runId/live returns 404 for unknown run", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/runs/nonexistent/live");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Not Found");
    expect(body).toContain("nonexistent");
    expect(body).toContain("not found");
  });

  test("GET /runs/nonexistent returns 404", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/runs/nonexistent");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Not Found");
    expect(body).toContain("nonexistent");
    expect(body).toContain("not found");
  });

  test("GET /unknown-path returns 404 with Not Found page", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/random/path");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Not Found");
    expect(body).toContain("/random/path");
    expect(body).toContain("not found");
    expect(body).toContain("back to repositories");
  });

  test("GET /runs/new returns form HTML with all 5 fields", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/runs/new");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('name="issue"');
    expect(body).toContain('name="repo"');
    expect(body).toContain('name="dryRun"');
    expect(body).toContain('name="vaultId"');
    expect(body).toContain('name="configPath"');
  });

  test("POST /runs/new with valid body redirects to /runs/:id/live", async () => {
    const { app } = createAppWithSeededDb(undefined, {
      runQueue: {
        enqueue: () => ({ position: 1, runId: "run-new-1" }),
      },
    });

    const formData = new URLSearchParams();
    formData.append("issue", "42");
    formData.append("repo", "acme/widgets");
    formData.append("dryRun", "on");

    const response = await app.request("/runs/new", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/runs/run-new-1/live");
  });

  test("POST /runs/new with invalid body returns 400 with inline error", async () => {
    const { app } = createAppWithSeededDb(undefined, {
      runQueue: {
        enqueue: () => ({ position: 1, runId: "run-new-2" }),
      },
    });

    const formData = new URLSearchParams();
    formData.append("repo", "acme/widgets");

    const response = await app.request("/runs/new", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Expected number, received nan");
    expect(body).toContain('value="acme/widgets"');
  });

  test("POST /runs/new without runQueue dep returns 503", async () => {
    const { app } = createAppWithSeededDb();

    const formData = new URLSearchParams();
    formData.append("issue", "42");
    formData.append("repo", "acme/widgets");

    const response = await app.request("/runs/new", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("runQueue is not configured for this dashboard");
  });

  test("GET /runs/:runId/sessions/:sessionId/events/stream returns 404 for unknown run", async () => {
    const anthropicClient = createFakeSessionClient({});
    const { app } = createAppWithSeededDb(undefined, { anthropicClient });

    const response = await app.request("/runs/nonexistent/sessions/sesn-1/events/stream");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect((body as { error: string }).error).toContain("nonexistent");
  });

  test("GET /runs/:runId/sessions/:sessionId/events/stream returns 404 when session is not part of run", async () => {
    const anthropicClient = createFakeSessionClient({});
    const { app } = createAppWithSeededDb(
      (db) => {
        db.insertRun(
          createRunState({
            runId: "run-stream-1",
            sessionIds: ["sesn-known"],
          }),
        );
        db.insertSession("run-stream-1", createSessionResult({ sessionId: "sesn-known" }));
      },
      { anthropicClient },
    );

    const response = await app.request("/runs/run-stream-1/sessions/sesn-other/events/stream");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect((body as { error: string }).error).toContain("sesn-other");
    expect((body as { error: string }).error).toContain("run-stream-1");
  });

  test("GET /runs/:runId/sessions/:sessionId/events/stream returns 503 when no anthropic client is configured", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(
        createRunState({
          runId: "run-stream-2",
          sessionIds: ["sesn-1"],
        }),
      );
      db.insertSession("run-stream-2", createSessionResult({ sessionId: "sesn-1" }));
    });

    const response = await app.request("/runs/run-stream-2/sessions/sesn-1/events/stream");
    const body = await response.json();

    expect(response.status).toBe(503);
    expect((body as { error: string }).error).toContain("live tail unavailable");
  });

  test("GET /runs/:runId/sessions/:sessionId/events/stream streams SSE events ending with idle", async () => {
    const anthropicClient = createFakeSessionClient({
      history: [createAgentMessageEvent("evt-h-1", "history hello")],
      live: [createAgentMessageEvent("evt-l-1", "live hello"), createIdleEvent("evt-idle")],
    });
    const { app } = createAppWithSeededDb(
      (db) => {
        db.insertRun(
          createRunState({
            runId: "run-stream-3",
            sessionIds: ["sesn-tail"],
          }),
        );
        db.insertSession("run-stream-3", createSessionResult({ sessionId: "sesn-tail" }));
      },
      { anthropicClient },
    );

    const response = await app.request("/runs/run-stream-3/sessions/sesn-tail/events/stream");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("Cache-Control")).toContain("no-cache");

    const text = await response.text();
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { phase: string });
    const phases = dataLines.map((line) => line.phase);

    expect(phases).toContain("history");
    expect(phases).toContain("live");
    expect(phases[phases.length - 1]).toBe("end");
  });

  test("GET /runs/:runId returns liveTailEnabled=true UI elements when client is configured", async () => {
    const anthropicClient = createFakeSessionClient({});
    const { app } = createAppWithSeededDb(
      (db) => {
        db.insertRun(
          createRunState({
            runId: "run-stream-4",
            sessionIds: ["sesn-tail"],
            subIssues: [{ issueId: 101, issueNumber: 43, taskId: "task-1" }],
          }),
        );
        db.insertSession("run-stream-4", createSessionResult({ sessionId: "sesn-tail" }));
      },
      { anthropicClient },
    );

    const response = await app.request("/runs/run-stream-4");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("live tail");
    expect(body).toContain('data-live-tail-session="sesn-tail"');
    expect(body).not.toContain("ANTHROPIC_API_KEY was not configured");
  });

  test("GET /runs/:runId without anthropic client shows live tail unavailable notice", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(
        createRunState({
          runId: "run-stream-5",
          sessionIds: ["sesn-tail"],
          subIssues: [{ issueId: 101, issueNumber: 43, taskId: "task-1" }],
        }),
      );
      db.insertSession("run-stream-5", createSessionResult({ sessionId: "sesn-tail" }));
    });

    const response = await app.request("/runs/run-stream-5");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("live tail");
    expect(body).toContain("ANTHROPIC_API_KEY was not configured");
  });

  test("GET /runs/:runId shows stop button when persisted status is running", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-stop-1" }));
      db.setRunStatus("run-stop-1", "running");
    });

    const response = await app.request("/runs/run-stop-1");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('action="/api/runs/run-stop-1/stop"');
    expect(body).toContain("stop this run");
  });

  test("GET /runs/:runId hides stop button when persisted status is completed", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-stop-2" }));
      db.setRunStatus("run-stop-2", "completed");
    });

    const response = await app.request("/runs/run-stop-2");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('action="/api/runs/run-stop-2/stop"');
  });

  test("GET /runs/:runId hides stop button when run already has a PR url", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(
        createRunState({
          prUrl: "https://github.com/acme/widgets/pull/1",
          runId: "run-stop-3",
        }),
      );
      db.setRunStatus("run-stop-3", "completed");
    });

    const response = await app.request("/runs/run-stop-3");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('action="/api/runs/run-stop-3/stop"');
  });

  test("GET /runs/:runId?stop=stopped ignores legacy stop notice query", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-stop-4" }));
    });

    const response = await app.request("/runs/run-stop-4?stop=stopped");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("stop-notice-success");
    expect(body).not.toContain("orchestrator process exited");
  });

  test("GET /runs/:runId?stop=still_running_after_signal ignores legacy stop notice query", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-stop-5" }));
    });

    const response = await app.request("/runs/run-stop-5?stop=still_running_after_signal");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("stop-notice-error");
    expect(body).not.toContain("did not exit after SIGTERM");
  });

  test("POST /runs/:runId/stop forwards legacy stop posts to the API endpoint", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/runs/missing/stop", {
      method: "POST",
      redirect: "manual",
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/api/runs/missing/stop");
  });
});
