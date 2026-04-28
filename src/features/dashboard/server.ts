/** @jsxImportSource hono/jsx */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { type Context, Hono } from "hono";
import type { FC } from "hono/jsx";
import { jsx, jsxs } from "hono/jsx/jsx-runtime";
import type { Logger } from "pino";
import { z } from "zod";
import { Layout } from "@/features/dashboard/components/layout";
import { createLiveTailStream } from "@/features/dashboard/live-tail";
import {
  PromptDetailPage,
  type PromptDetailPageProps,
  type PromptRevisionView,
} from "@/features/dashboard/pages/prompt-detail";
import { type PromptListEntry, PromptsListPage } from "@/features/dashboard/pages/prompts-list";
import { RepositoriesPage } from "@/features/dashboard/pages/repositories";
import { RunDetailPage, type RunDetailPageProps } from "@/features/dashboard/pages/run-detail";
import { RunLivePage, type RunLivePageProps } from "@/features/dashboard/pages/run-live";
import { RunNewPage } from "@/features/dashboard/pages/run-new";
import { RunsPage, type RunSummary as RunsPageRunSummary } from "@/features/dashboard/pages/runs";
import { RunStartInputSchema } from "@/features/run-api/schemas";
import {
  type EditablePromptKey,
  EditablePromptKeySchema,
  type PromptKey,
  PromptKeySchema,
  type PromptRevisionRow,
  PromptSaveInputSchema,
} from "@/shared/persistence/schemas";
import { getDefaultPrompt } from "@/shared/prompts/defaults";
import type { SessionClient } from "@/shared/session";
import type { RunStatus } from "@/shared/types";

type DbModule = ReturnType<typeof import("@/shared/persistence/db").createDbModule>;
type DeferredModuleReference<TPath extends string, TFactory extends string> = {
  readonly modulePath?: TPath;
  readonly factoryName?: TFactory;
};
type RunQueueModule = Pick<
  ReturnType<typeof import("@/features/run-queue/handler").createRunQueueModule>,
  "enqueue"
>;
type RunEventsModule = DeferredModuleReference<
  "@/features/run-events/handler",
  "createRunEventsModule"
>;
type RunExecutionModule = DeferredModuleReference<
  "@/features/run-execution/handler",
  "createRunExecutionModule"
>;

const PROMPT_KEYS: PromptKey[] = [
  "parent.system",
  "child.system",
  "parent.runtime",
  "child.runtime",
];
const RestoreRevisionIdSchema = z.coerce.number().int().positive();

type PromptWithBody = {
  body: string;
  currentRevisionId: number;
  promptKey: PromptKey;
  updatedAt: string;
};

export type CreateAppOptions = {
  db: DbModule;
  anthropicClient?: SessionClient;
  logger?: Logger;
  runEvents?: RunEventsModule;
  runExecution?: RunExecutionModule;
  runQueue?: RunQueueModule;
  staticAssetsDir?: string;
};

const ASSETS_ROUTE_PREFIX = "/assets/";
const RUN_LIST_LIMIT = 10_000;

function renderDocument(jsx: unknown): string {
  return `<!doctype html>${String(jsx)}`;
}

function runSummary(
  db: DbModule,
  runId: string,
): ReturnType<DbModule["listRuns"]>[number] | undefined {
  return db.listRuns({ limit: RUN_LIST_LIMIT }).find((run) => run.runId === runId);
}

function runStatus(db: DbModule, runId: string): RunStatus | undefined {
  return runSummary(db, runId)?.status;
}

function runsPageSummary(
  db: DbModule,
  run: ReturnType<DbModule["listRuns"]>[number],
): RunsPageRunSummary {
  const childResults = db.getChildTaskResultsByRun(run.runId);
  const runState = db.getRunById(run.runId);

  return {
    ...run,
    failedChildResultCount: childResults.filter((result) => !result.success).length,
    subIssueCount: runState?.subIssues.length ?? 0,
  };
}

function repositoriesResponse(c: Context, db: DbModule): Response | Promise<Response> {
  const repositories = db.listRepositories();
  const jsx = RepositoriesPage({ repositories });
  return c.html(renderDocument(jsx));
}

function contentTypeForAsset(filePath: string): string | undefined {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }

  return undefined;
}

function getAssetPath(requestPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  if (!decodedPath.startsWith(ASSETS_ROUTE_PREFIX)) {
    return null;
  }

  const assetPath = decodedPath.slice(ASSETS_ROUTE_PREFIX.length);
  if (assetPath.length === 0 || assetPath.startsWith("/")) {
    return null;
  }

  if (assetPath.split("/").some((segment) => segment === "..")) {
    return null;
  }

  return assetPath;
}

function createStaticAssetHandler(staticAssetsDir: string) {
  const root = resolve(staticAssetsDir);

  return async (c: Context) => {
    const assetPath = getAssetPath(c.req.path);
    if (assetPath === null) {
      return c.notFound();
    }

    const filePath = resolve(root, assetPath);
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return c.notFound();
    }

    const fileBody = await readFile(filePath).catch(() => null);
    if (fileBody === null) {
      return c.notFound();
    }

    const contentType = contentTypeForAsset(filePath);
    if (contentType !== undefined) {
      c.header("Content-Type", contentType);
    }

    return c.body(fileBody);
  };
}

function isEditablePromptKey(key: PromptKey): key is EditablePromptKey {
  return EditablePromptKeySchema.safeParse(key).success;
}

function getPromptWithFallback(db: DbModule, key: PromptKey): PromptWithBody {
  return (
    db.getPrompt(key) ?? {
      body: getDefaultPrompt(key),
      currentRevisionId: 0,
      promptKey: key,
      updatedAt: new Date().toISOString(),
    }
  );
}

function getPromptRevisionCount(db: DbModule, key: PromptKey, prompt: PromptWithBody): number {
  if (isEditablePromptKey(key)) {
    return db.getPromptRevisions(key).length;
  }

  return prompt.currentRevisionId > 0 ? 1 : 0;
}

function toPromptRevisionView(revision: PromptRevisionRow): PromptRevisionView {
  return {
    body: revision.body,
    createdAt: revision.createdAt,
    id: revision.id,
    source: revision.source,
  };
}

function getNoChangeNotice(
  noChange: string | undefined,
  alreadyCurrent: string | undefined,
): PromptDetailPageProps["noChangeNotice"] {
  if (noChange === "1") {
    return { kind: "no_change" };
  }

  if (alreadyCurrent === "1") {
    return { kind: "already_current" };
  }

  return undefined;
}

const NotFoundPage: FC<{ message: string }> = ({ message }) =>
  Layout({
    children: jsxs("div", {
      class: "empty-state",
      style: "padding-top: var(--space-12);",
      children: [
        jsx("div", { class: "empty-state-icon", children: "404" }),
        jsx("div", { class: "empty-state-title", children: "Not Found" }),
        jsx("div", { class: "empty-state-hint", children: message }),
        jsx("p", {
          style: "margin-top: var(--space-4);",
          children: jsx("a", {
            href: "/",
            children: "← back to repositories",
          }),
        }),
      ],
    }),
    title: "not found",
  });

const BadRequestPage: FC<{ message: string }> = ({ message }) =>
  Layout({
    children: jsxs("div", {
      class: "empty-state",
      style: "padding-top: var(--space-12);",
      children: [
        jsx("div", { class: "empty-state-icon", children: "400" }),
        jsx("div", { class: "empty-state-title", children: "Bad Request" }),
        jsx("div", { class: "empty-state-hint", children: message }),
        jsx("p", {
          style: "margin-top: var(--space-4);",
          children: jsx("a", {
            href: "/prompts",
            children: "← back to prompts",
          }),
        }),
      ],
    }),
    title: "bad request",
  });

export function dashboardWebRoutes(opts: CreateAppOptions): Hono {
  const { anthropicClient, db, logger } = opts;
  const app = new Hono();

  app.get("/", (c) => {
    return repositoriesResponse(c, db);
  });

  app.get("/repositories", (c) => {
    return repositoriesResponse(c, db);
  });

  app.get("/runs", (c) => {
    const runs = db.listRuns({ limit: RUN_LIST_LIMIT }).map((run) => runsPageSummary(db, run));
    const jsx = RunsPage({ runs });
    return c.html(renderDocument(jsx));
  });

  app.get("/repos/:owner/:name", (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = `${owner}/${name}`;
    const enrichedRuns = db
      .listRuns({ limit: RUN_LIST_LIMIT, repo })
      .map((run) => runsPageSummary(db, run));
    const jsx = RunsPage({ repo, runs: enrichedRuns });
    return c.html(renderDocument(jsx));
  });

  app.get("/prompts", (c) => {
    c.header("Cache-Control", "no-store");

    const prompts = PROMPT_KEYS.map((key): PromptListEntry => {
      const prompt = getPromptWithFallback(db, key);
      return {
        editable: isEditablePromptKey(key),
        promptKey: key,
        revisionCount: getPromptRevisionCount(db, key, prompt),
        updatedAt: prompt.currentRevisionId > 0 ? prompt.updatedAt : null,
      };
    });
    const jsx = PromptsListPage({ prompts });
    return c.html(renderDocument(jsx));
  });

  app.get("/prompts/:key", (c) => {
    c.header("Cache-Control", "no-store");

    const parsedKey = PromptKeySchema.safeParse(c.req.param("key"));
    if (!parsedKey.success) {
      return c.notFound();
    }

    const promptKey = parsedKey.data;
    const prompt = getPromptWithFallback(db, promptKey);
    const editable = isEditablePromptKey(promptKey);
    const revisionRows = editable ? db.getPromptRevisions(promptKey) : [];
    const prevRevisionRow = revisionRows[1];

    const jsx = PromptDetailPage({
      body: prompt.body,
      currentRevisionId: prompt.currentRevisionId,
      editable,
      noChangeNotice: getNoChangeNotice(c.req.query("no_change"), c.req.query("already_current")),
      prevRevision:
        prevRevisionRow === undefined ? undefined : toPromptRevisionView(prevRevisionRow),
      promptKey,
      revisions: revisionRows.map(toPromptRevisionView),
    });
    return c.html(renderDocument(jsx));
  });

  app.post("/prompts/:key", async (c) => {
    c.header("Cache-Control", "no-store");

    const parsedKey = EditablePromptKeySchema.safeParse(c.req.param("key"));
    if (!parsedKey.success) {
      return c.html(
        renderDocument(BadRequestPage({ message: "editable prompt key required" })),
        400,
      );
    }

    const form = await c.req.parseBody();
    const rawBody = form.body;
    if (typeof rawBody !== "string") {
      return c.html(renderDocument(BadRequestPage({ message: "prompt body is required" })), 400);
    }

    const normalizedBody = rawBody.replace(/\r\n/g, "\n");
    const parsedInput = PromptSaveInputSchema.safeParse({ body: normalizedBody });
    if (!parsedInput.success || normalizedBody.trim().length < 10) {
      return c.html(renderDocument(BadRequestPage({ message: "invalid prompt body" })), 400);
    }

    const result = db.savePromptRevision({
      body: normalizedBody,
      key: parsedKey.data,
      source: "edit",
    });
    const redirectUrl = result.isNoChange
      ? `/prompts/${parsedKey.data}?no_change=1`
      : `/prompts/${parsedKey.data}`;
    return c.redirect(redirectUrl, 302);
  });

  app.post("/prompts/:key/restore", async (c) => {
    c.header("Cache-Control", "no-store");

    const parsedKey = EditablePromptKeySchema.safeParse(c.req.param("key"));
    if (!parsedKey.success) {
      return c.html(
        renderDocument(BadRequestPage({ message: "editable prompt key required" })),
        400,
      );
    }

    const form = await c.req.parseBody();
    const parsedRevisionId = RestoreRevisionIdSchema.safeParse(form.revision_id);
    if (!parsedRevisionId.success) {
      return c.html(
        renderDocument(BadRequestPage({ message: "valid revision_id is required" })),
        400,
      );
    }

    const revision = db.getPromptRevision(parsedKey.data, parsedRevisionId.data);
    if (revision === null) {
      return c.html(
        renderDocument(NotFoundPage({ message: `revision ${parsedRevisionId.data} not found` })),
        404,
      );
    }

    const result = db.restorePromptToRevision(parsedKey.data, parsedRevisionId.data);
    const redirectUrl = result.alreadyCurrent
      ? `/prompts/${parsedKey.data}?already_current=1`
      : `/prompts/${parsedKey.data}`;
    return c.redirect(redirectUrl, 302);
  });

  app.get("/favicon.ico", (c) => c.body(null, 204));

  app.get("/runs/new", (c) => {
    return c.html(renderDocument(RunNewPage({})));
  });

  app.post("/runs/new", async (c) => {
    if (!opts.runQueue) {
      return c.html(
        renderDocument(
          RunNewPage({
            errors: { _form: "runQueue is not configured for this dashboard" },
          }),
        ),
        503,
      );
    }

    const form = await c.req.parseBody();
    const issue = Number(form.issue);
    const repo = String(form.repo ?? "");
    const dryRun = form.dryRun === "on";
    const vaultId = form.vaultId ? String(form.vaultId) : undefined;
    const configPath = form.configPath ? String(form.configPath) : undefined;

    const parsed = RunStartInputSchema.safeParse({
      issue,
      repo,
      dryRun,
      vaultId,
      configPath,
    });

    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const err of parsed.error.errors) {
        if (err.path[0]) {
          errors[err.path[0].toString()] = err.message;
        }
      }
      return c.html(
        renderDocument(
          RunNewPage({
            values: {
              issue: form.issue as string,
              repo: form.repo as string,
              dryRun,
              vaultId: form.vaultId as string,
              configPath: form.configPath as string,
            },
            errors,
          }),
        ),
        400,
      );
    }

    const { runId } = opts.runQueue.enqueue(parsed.data);
    return c.redirect(`/runs/${runId}/live`, 303);
  });

  app.get("/runs/:runId", (c) => {
    const runId = c.req.param("runId");
    const run = db.getRunById(runId);

    if (!run) {
      return c.html(renderDocument(NotFoundPage({ message: `run "${runId}" not found` })), 404);
    }

    const status = runStatus(db, runId);
    if (status === undefined) {
      return c.html(renderDocument(NotFoundPage({ message: `run "${runId}" not found` })), 404);
    }

    const props: RunDetailPageProps = {
      childResults: db.getChildTaskResultsByRun(runId),
      liveTailEnabled: anthropicClient !== undefined,
      run,
      sessions: db.getSessionsByRun(runId),
      status,
    };

    return c.html(renderDocument(RunDetailPage(props)));
  });

  app.get("/runs/:runId/live", (c) => {
    const runId = c.req.param("runId");
    const run = db.getRunById(runId);

    if (!run) {
      return c.html(renderDocument(NotFoundPage({ message: `run "${runId}" not found` })), 404);
    }

    const status = runStatus(db, runId);
    if (status === undefined) {
      return c.html(renderDocument(NotFoundPage({ message: `run "${runId}" not found` })), 404);
    }

    const props: RunLivePageProps = {
      childResults: db.getChildTaskResultsByRun(runId),
      run,
      sessions: db.getSessionsByRun(runId),
      status,
    };

    return c.html(renderDocument(RunLivePage(props)));
  });

  app.post("/runs/:runId/stop", (c) => {
    const runId = c.req.param("runId");
    return c.redirect(`/api/runs/${runId}/stop`, 307);
  });

  app.get("/runs/:runId/sessions/:sessionId/events/stream", (c) => {
    const runId = c.req.param("runId");
    const sessionId = c.req.param("sessionId");
    const run = db.getRunById(runId);

    if (!run) {
      return c.json({ error: `run "${runId}" not found` }, 404);
    }

    if (!run.sessionIds.includes(sessionId)) {
      return c.json({ error: `session "${sessionId}" is not part of run "${runId}"` }, 404);
    }

    if (!anthropicClient) {
      return c.json(
        {
          error:
            "live tail unavailable: Anthropic client not configured (set ANTHROPIC_API_KEY before running serve)",
        },
        503,
      );
    }

    const stream = createLiveTailStream({
      client: anthropicClient,
      logger,
      sessionId,
      signal: c.req.raw.signal,
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}

export function createApp(opts: CreateAppOptions): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.get("Cache-Control")) {
      c.header("Cache-Control", "no-store");
    }
  });

  if (opts.staticAssetsDir !== undefined) {
    app.get("/assets/*", createStaticAssetHandler(opts.staticAssetsDir));
  }

  app.route("/", dashboardWebRoutes(opts));

  app.notFound((c) => {
    return c.html(renderDocument(NotFoundPage({ message: `page "${c.req.path}" not found` })), 404);
  });

  return app;
}
