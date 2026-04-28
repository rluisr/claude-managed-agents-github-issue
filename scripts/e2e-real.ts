import { rm } from "node:fs/promises";
import process from "node:process";

const TEST_REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 200;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_CHARS = 60_000;

type RuntimeConfig = {
  anthropicApiKey: string;
  dbPath: string;
  githubToken: string;
  host: string;
  issue: number;
  port: number;
  repo: string;
  timeoutMs: number;
};

type ProcessDiagnostics = {
  stderr: string;
  stdout: string;
};

type SseMessage = {
  data: string;
  event?: string;
  id?: string;
};

type HarnessResult = {
  prUrl: string;
};

type SpawnedServer = ReturnType<typeof Bun.spawn>;

class HarnessFailure extends Error {
  constructor(
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "HarnessFailure";
  }
}

function shouldRun(env: NodeJS.ProcessEnv): true | { skipReason: string } {
  if (env.E2E !== "1") {
    return { skipReason: "E2E=1 not set; refusing to run integration harness" };
  }

  const repo = env.TEST_REPO?.trim();
  if (!repo || !TEST_REPO_PATTERN.test(repo)) {
    return { skipReason: "TEST_REPO=<owner>/<repo> required" };
  }

  const issue = Number.parseInt(env.TEST_ISSUE ?? "", 10);
  if (!Number.isInteger(issue) || issue <= 0) {
    return { skipReason: "TEST_ISSUE=<positive int> required" };
  }

  if (!env.ANTHROPIC_API_KEY) {
    return { skipReason: "ANTHROPIC_API_KEY required" };
  }

  if (!env.GITHUB_TOKEN) {
    return { skipReason: "GITHUB_TOKEN required" };
  }

  return true;
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const port = parsePositiveInteger(
    "E2E_PORT",
    env.E2E_PORT,
    30_000 + Math.floor(Math.random() * 1000),
  );
  const timeoutMs = parsePositiveInteger("E2E_TIMEOUT_MS", env.E2E_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    dbPath: `/tmp/e2e-real-${Date.now()}-${port}.db`,
    githubToken: env.GITHUB_TOKEN ?? "",
    host: DEFAULT_HOST,
    issue: Number.parseInt(env.TEST_ISSUE ?? "", 10),
    port,
    repo: env.TEST_REPO?.trim() ?? "",
    timeoutMs,
  };
}

function createChildEnv(env: NodeJS.ProcessEnv, config: RuntimeConfig): Record<string, string> {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  return {
    ...childEnv,
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    DB_PATH: config.dbPath,
    GITHUB_TOKEN: config.githubToken,
    HOST: config.host,
    PORT: String(config.port),
  };
}

function appendCaptured(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_DIAGNOSTIC_CHARS ? next : next.slice(-MAX_DIAGNOSTIC_CHARS);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function abortMessage(signal: AbortSignal): string {
  if (signal.reason instanceof Error) {
    return signal.reason.message;
  }

  if (typeof signal.reason === "string") {
    return signal.reason;
  }

  return "operation aborted";
}

function diagnosticsText(diagnostics: ProcessDiagnostics): string {
  return [
    "--- server stdout ---",
    diagnostics.stdout.trimEnd() || "<empty>",
    "--- server stderr ---",
    diagnostics.stderr.trimEnd() || "<empty>",
  ].join("\n");
}

function failWithDiagnostics(error: unknown, diagnostics: ProcessDiagnostics): never {
  throw new HarnessFailure(formatError(error), diagnosticsText(diagnostics));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function collectStream(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (stream === null) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      onChunk(decoder.decode(value, { stream: true }));
    }

    const tail = decoder.decode();
    if (tail.length > 0) {
      onChunk(tail);
    }
  } catch (error) {
    onChunk(`\n[stream read failed: ${formatError(error)}]\n`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(abortMessage(signal)));
      return;
    }

    let abortListener: (() => void) | undefined;
    const timeout = setTimeout(() => {
      if (abortListener !== undefined) {
        signal?.removeEventListener("abort", abortListener);
      }
      resolve();
    }, ms);

    abortListener = () => {
      clearTimeout(timeout);
      reject(new Error(signal === undefined ? "operation aborted" : abortMessage(signal)));
    };
    signal?.addEventListener("abort", abortListener, { once: true });
  });
}

function spawnServer(config: RuntimeConfig, env: NodeJS.ProcessEnv): {
  diagnostics: ProcessDiagnostics;
  proc: SpawnedServer;
} {
  const diagnostics: ProcessDiagnostics = { stderr: "", stdout: "" };
  const proc = Bun.spawn(["bun", "run", "index.ts"], {
    env: createChildEnv(env, config),
    stderr: "pipe",
    stdout: "pipe",
  });

  void collectStream(proc.stdout, (chunk) => {
    diagnostics.stdout = appendCaptured(diagnostics.stdout, chunk);
  });
  void collectStream(proc.stderr, (chunk) => {
    diagnostics.stderr = appendCaptured(diagnostics.stderr, chunk);
  });

  return { diagnostics, proc };
}

async function waitForServerReady(baseUrl: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "server did not return 200";

  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw new Error(abortMessage(signal));
    }

    try {
      const response = await fetch(`${baseUrl}/`, { signal });
      await response.arrayBuffer().catch(() => undefined);

      if (response.status === 200) {
        return;
      }

      lastError = `GET / returned ${response.status}`;
    } catch (error) {
      if (signal.aborted) {
        throw new Error(abortMessage(signal));
      }

      lastError = formatError(error);
    }

    await sleep(READY_POLL_MS, signal);
  }

  throw new Error(`server readiness timed out after ${READY_TIMEOUT_MS}ms: ${lastError}`);
}

async function postRun(baseUrl: string, config: RuntimeConfig, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${baseUrl}/api/runs`, {
    body: JSON.stringify({ issue: config.issue, repo: config.repo }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal,
  });
  const responseText = await response.text();

  if (response.status !== 200) {
    throw new Error(`POST /api/runs returned ${response.status}: ${responseText}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`POST /api/runs returned invalid JSON: ${formatError(error)}`);
  }

  if (!isRecord(payload) || typeof payload.runId !== "string" || payload.runId.length === 0) {
    throw new Error(`POST /api/runs response missing runId: ${responseText}`);
  }

  return payload.runId;
}

function parseSseFrame(frame: string): SseMessage | undefined {
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let hasField = false;

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }

    hasField = true;
    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    const rawValue = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      event = value;
    } else if (field === "id") {
      id = value;
    }
  }

  if (!hasField) {
    return undefined;
  }

  return { data: dataLines.join("\n"), event, id };
}

function parseJsonPayload(data: string, event: string): unknown {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`SSE ${event} event returned invalid JSON: ${formatError(error)}; data=${data}`);
  }
}

function payloadMessage(payload: unknown): string {
  if (isRecord(payload) && typeof payload.message === "string") {
    return payload.message;
  }

  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }

  return JSON.stringify(payload) ?? String(payload);
}

function inspectSseMessage(message: SseMessage): string | undefined {
  if (message.event === "error") {
    const payload = parseJsonPayload(message.data, "error");
    throw new Error(`run emitted error event: ${payloadMessage(payload)}`);
  }

  if (message.event !== "complete") {
    return undefined;
  }

  const payload = parseJsonPayload(message.data, "complete");
  if (!isRecord(payload)) {
    throw new Error(`complete event payload must be an object: ${message.data}`);
  }

  if (payload.status !== "completed") {
    throw new Error(`complete event status was ${String(payload.status)}, expected completed`);
  }

  if (typeof payload.prUrl !== "string" || payload.prUrl.trim().length === 0) {
    throw new Error(`complete event missing prUrl: ${message.data}`);
  }

  return payload.prUrl;
}

async function waitForCompleteEvent(
  baseUrl: string,
  runId: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
    headers: { Accept: "text/event-stream" },
    signal,
  });

  if (response.status !== 200) {
    throw new Error(`GET /api/runs/${runId}/events returned ${response.status}: ${await response.text()}`);
  }

  if (response.body === null) {
    throw new Error("SSE response body is empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sseLog: string[] = [];
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let separatorIndex = buffer.indexOf("\n\n");

      while (separatorIndex !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const message = parseSseFrame(frame);
        if (message !== undefined) {
          sseLog.push(`${message.id ?? "<no-id>"} ${message.event ?? "message"} ${message.data}`);
          const prUrl = inspectSseMessage(message);
          if (prUrl !== undefined) {
            return prUrl;
          }
        }

        separatorIndex = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`${abortMessage(signal)}; sse_log=${sseLog.join(" | ") || "<empty>"}`);
    }

    throw new Error(`${formatError(error)}; sse_log=${sseLog.join(" | ") || "<empty>"}`);
  } finally {
    reader.releaseLock();
  }

  throw new Error(`SSE stream ended before complete event; sse_log=${sseLog.join(" | ") || "<empty>"}`);
}

async function stopServer(proc: SpawnedServer): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }

  const exited = await Promise.race([
    proc.exited.then(() => "exited" as const),
    sleep(SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const),
  ]);

  if (exited === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch {
      return;
    }

    await Promise.race([proc.exited, sleep(1_000)]);
  }
}

async function removeDatabaseFiles(dbPath: string): Promise<void> {
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
  ]);
}

async function runHarness(config: RuntimeConfig, env: NodeJS.ProcessEnv): Promise<HarnessResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`watchdog timeout after ${config.timeoutMs}ms`));
  }, config.timeoutMs);
  const { diagnostics, proc } = spawnServer(config, env);
  const baseUrl = `http://${config.host}:${config.port}`;

  try {
    await waitForServerReady(baseUrl, controller.signal);
    const runId = await postRun(baseUrl, config, controller.signal);
    const prUrl = await waitForCompleteEvent(baseUrl, runId, controller.signal);
    return { prUrl };
  } catch (error) {
    failWithDiagnostics(error, diagnostics);
  } finally {
    clearTimeout(timeout);
    await stopServer(proc);
    await removeDatabaseFiles(config.dbPath);
  }
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const gate = shouldRun(env);
  if (gate !== true) {
    process.stdout.write(`e2e-real: skipping (${gate.skipReason})\n`);
    process.exit(0);
  }

  try {
    const result = await runHarness(readRuntimeConfig(env), env);
    process.stdout.write(`E2E_REAL_PASS pr_url=${result.prUrl}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`E2E_REAL_FAIL ${formatError(error)}\n`);
    if (error instanceof HarnessFailure && error.details !== undefined) {
      process.stderr.write(`${error.details}\n`);
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.env);
}
