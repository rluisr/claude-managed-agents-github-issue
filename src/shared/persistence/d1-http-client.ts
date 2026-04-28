const D1_QUERY_ENDPOINT_BASE = "https://api.cloudflare.com/client/v4/accounts";
const MAX_ATTEMPTS = 2;

/**
 * JSON-bindable value accepted by this D1 REST client.
 *
 * D1's REST documentation at
 * https://developers.cloudflare.com/api/operations/cloudflare-d1-query-database describes query
 * params as JSON values carried in the `params` array. Integers and reals are sent as JSON
 * numbers, `NULL` is sent as `null`, text is sent as a string, and BLOB values are represented as
 * base64-encoded strings. The base64 representation keeps the request body pure JSON and avoids
 * guessing a hex literal convention at the client layer.
 */
export type D1Parameter = string | number | null;

/**
 * Metadata returned by Cloudflare D1 for each statement result.
 *
 * The REST API may add fields over time, so unknown metadata keys are preserved while the fields
 * used by the SQLite-compatible `run()` result (`changes` and `last_row_id`) are surfaced with
 * explicit types.
 */
export type D1QueryMeta = {
  changed_db?: boolean;
  changes?: number;
  duration?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
  served_by_colo?: string;
  served_by_primary?: boolean;
  served_by_region?: string;
  size_after?: number;
  timings?: {
    sql_duration_ms?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/**
 * Result returned from `prepare(sql).run(...)`.
 *
 * `changes` and `lastInsertRowid` mirror Bun SQLite's commonly used mutation metadata, while the
 * raw D1 `meta` object remains available for callers that need fields such as `rows_written` or
 * `served_by_region`.
 */
export type D1RunResult = {
  changes: number;
  lastInsertRowid: number;
  meta: D1QueryMeta;
  success: boolean;
};

/**
 * Constructor options for {@link D1HttpClient}.
 *
 * `fetch` is injectable so unit tests can provide canned Cloudflare responses without making real
 * network calls. When omitted, the global Bun/Node `fetch` implementation is used.
 */
export type D1HttpClientOptions = {
  accountId: string;
  apiToken: string;
  databaseId: string;
  fetch?: typeof fetch;
};

/**
 * Prepared statement facade matching the subset of Bun SQLite statements needed by the persistence
 * layer.
 *
 * The methods are asynchronous because Cloudflare D1 is reached over HTTP. They keep the Bun
 * SQLite method names (`run`, `all`, `get`, and `values`) so Phase 1 can wire this client through a
 * DI seam without introducing a query-builder dependency.
 */
export type D1PreparedStatement = {
  /** Execute a mutating or DDL statement and return SQLite-style mutation metadata. */
  run(...params: D1Parameter[]): Promise<D1RunResult>;
  /** Execute a query and return all result rows as objects keyed by selected column names. */
  all<Row extends Record<string, unknown> = Record<string, unknown>>(
    ...params: D1Parameter[]
  ): Promise<Row[]>;
  /** Execute a query and return the first row, or `null` when the result set is empty. */
  get<Row extends Record<string, unknown> = Record<string, unknown>>(
    ...params: D1Parameter[]
  ): Promise<Row | null>;
  /** Execute a query and return each row as a positional value array. */
  values<Row extends readonly unknown[] = readonly unknown[]>(
    ...params: D1Parameter[]
  ): Promise<Row[]>;
};

type D1ResponseInfo = {
  code?: number;
  documentation_url?: string;
  message?: string;
  source?: unknown;
  [key: string]: unknown;
};

type D1QueryResult = {
  meta: D1QueryMeta;
  results: unknown[];
  success?: boolean;
  [key: string]: unknown;
};

type D1ApiResponse = {
  errors: D1ResponseInfo[];
  messages: D1ResponseInfo[];
  result: D1QueryResult[];
  success: boolean;
};

type D1SingleQueryBody = {
  params: D1Parameter[];
  sql: string;
};

type D1BatchQuery = {
  params: D1Parameter[];
  sql: string;
};

type D1RequestBody = D1SingleQueryBody | { batch: D1BatchQuery[] };

type QueuedStatement<Result> = {
  params: D1Parameter[];
  promise: Promise<Result>;
  reject(error: unknown): void;
  resolve(entry: D1QueryResult): void;
  sql: string;
};

type TransactionContext = {
  promises: Set<Promise<unknown>>;
  statements: QueuedStatement<unknown>[];
};

class D1HttpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1HttpClientError";
  }
}

class D1HttpStatement implements D1PreparedStatement {
  constructor(
    private readonly client: D1HttpClient,
    private readonly sql: string,
  ) {}

  run(...params: D1Parameter[]): Promise<D1RunResult> {
    return this.client.executeStatement(this.sql, params, toRunResult);
  }

  all<Row extends Record<string, unknown> = Record<string, unknown>>(
    ...params: D1Parameter[]
  ): Promise<Row[]> {
    return this.client.executeStatement(this.sql, params, (entry) => rowsFromEntry<Row>(entry));
  }

  get<Row extends Record<string, unknown> = Record<string, unknown>>(
    ...params: D1Parameter[]
  ): Promise<Row | null> {
    return this.client.executeStatement(this.sql, params, (entry) => {
      const rows = rowsFromEntry<Row>(entry);
      return rows[0] ?? null;
    });
  }

  values<Row extends readonly unknown[] = readonly unknown[]>(
    ...params: D1Parameter[]
  ): Promise<Row[]> {
    return this.client.executeStatement(this.sql, params, (entry) => valuesFromEntry<Row>(entry));
  }
}

/**
 * Cloudflare D1 HTTP REST client with a Bun SQLite-inspired API surface.
 *
 * The client posts to the documented D1 `/query` endpoint, not `/raw`. Single statements use the
 * documented `{ "sql": "...", "params": [...] }` body. Transactions use the same `/query`
 * endpoint's documented `{ "batch": [...] }` body instead of concatenating all SQL into one
 * string; this preserves per-statement parameter arrays and still sends `BEGIN`, queued statements,
 * and `COMMIT`/`ROLLBACK` in one HTTP request.
 */
export class D1HttpClient {
  private activeTransaction: TransactionContext | null = null;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  /**
   * Create a D1 REST client for one account/database pair.
   *
   * @param options Cloudflare account id, D1 database id, API token, and optional fetch override.
   * @returns A client whose prepared statements execute against the configured D1 database.
   */
  constructor(options: D1HttpClientOptions) {
    this.endpoint = `${D1_QUERY_ENDPOINT_BASE}/${encodeURIComponent(
      options.accountId,
    )}/d1/database/${encodeURIComponent(options.databaseId)}/query`;
    this.fetchImpl = options.fetch ?? fetch;
    this.apiToken = options.apiToken;
  }

  private readonly apiToken: string;

  /**
   * Prepare a statement for repeated execution.
   *
   * @param sql SQL statement to execute through D1.
   * @returns A reusable statement with `run`, `all`, `get`, and `values` methods.
   */
  prepare(sql: string): D1PreparedStatement {
    return new D1HttpStatement(this, sql);
  }

  /**
   * Alias for {@link prepare} matching the `db.query(sql)` call sites in `db.ts`.
   *
   * @param sql SQL statement to execute through D1.
   * @returns A reusable statement with `run`, `all`, `get`, and `values` methods.
   */
  query(sql: string): D1PreparedStatement {
    return this.prepare(sql);
  }

  /**
   * Execute DDL, PRAGMA-equivalent, or other multi-statement SQL with no bound params.
   *
   * @param sql One SQL string. D1 REST supports multiple statements joined by semicolons.
   * @returns Mutation metadata for every statement result returned by D1.
   */
  async exec(sql: string): Promise<D1RunResult[]> {
    const response = await this.postToD1({ params: [], sql });
    return response.result.map((entry) => toRunResult(entry));
  }

  /**
   * Create a higher-order transaction helper.
   *
   * The returned function records statement method calls made by `fn`, then sends one `/query`
   * request containing `BEGIN`, the recorded statements, and `COMMIT`. If `fn` throws, the request
   * contains `BEGIN`, the recorded statements, and `ROLLBACK`, and the original exception is
   * rethrown after the rollback request completes. Transactions are not atomic across separate D1
   * HTTP requests; batching the boundary statements into one request is what provides atomicity.
   *
   * Statement promises created inside `fn` settle after the transaction batch returns. Do not await
   * them inside `fn`; capture them and await after the returned transaction function resolves when
   * you need per-statement results.
   *
   * @param fn Callback that enqueues prepared statement calls.
   * @returns A callable that executes `fn` within one batched D1 transaction request.
   */
  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result | Promise<Result>,
  ): (...args: Args) => Promise<Awaited<Result>> {
    return async (...args: Args): Promise<Awaited<Result>> => {
      if (this.activeTransaction !== null) {
        throw new Error("Nested D1 transactions are not supported");
      }

      const context: TransactionContext = { promises: new Set(), statements: [] };
      this.activeTransaction = context;

      try {
        const callbackResult = fn(...args);

        if (callbackResult instanceof Promise && context.promises.has(callbackResult)) {
          await this.commitTransaction(context);
          return await callbackResult;
        }

        const resolvedResult = await callbackResult;
        await this.commitTransaction(context);
        return resolvedResult;
      } catch (error) {
        await this.rollbackTransaction(context, error);
        throw error;
      } finally {
        this.activeTransaction = null;
      }
    };
  }

  /**
   * Close the database facade.
   *
   * @returns Nothing. The HTTP client owns no sockets or local resources, so this is a no-op kept
   * for compatibility with Bun SQLite's `Database.close()` surface.
   */
  close(): void {}

  executeStatement<Result>(
    sql: string,
    params: readonly D1Parameter[],
    mapResult: (entry: D1QueryResult) => Result,
  ): Promise<Result> {
    const normalizedParams = normalizeParams(params);

    if (this.activeTransaction !== null) {
      return this.enqueueTransactionStatement(sql, normalizedParams, mapResult);
    }

    return this.executeSingleStatement(sql, normalizedParams, mapResult);
  }

  private async executeSingleStatement<Result>(
    sql: string,
    params: D1Parameter[],
    mapResult: (entry: D1QueryResult) => Result,
  ): Promise<Result> {
    const response = await this.postToD1({ params, sql });
    const entry = response.result[0];

    if (entry === undefined) {
      throw new D1HttpClientError(`Cloudflare D1 returned no result entry for SQL: ${sql}`);
    }

    return mapResult(entry);
  }

  private enqueueTransactionStatement<Result>(
    sql: string,
    params: D1Parameter[],
    mapResult: (entry: D1QueryResult) => Result,
  ): Promise<Result> {
    const context = this.activeTransaction;

    if (context === null) {
      throw new Error("Cannot enqueue a D1 statement without an active transaction");
    }

    let resolveQueued: (entry: D1QueryResult) => void = () => undefined;
    let rejectQueued: (error: unknown) => void = () => undefined;
    const promise = new Promise<Result>((resolve, reject) => {
      resolveQueued = (entry) => {
        try {
          resolve(mapResult(entry));
        } catch (error) {
          reject(error);
        }
      };
      rejectQueued = reject;
    });

    void promise.catch(() => undefined);
    context.promises.add(promise);
    context.statements.push({
      params,
      promise,
      reject: rejectQueued,
      resolve: resolveQueued,
      sql,
    });

    return promise;
  }

  private async commitTransaction(context: TransactionContext): Promise<void> {
    const response = await this.postToD1({
      batch: [
        { params: [], sql: "BEGIN" },
        ...context.statements.map((statement) => ({
          params: statement.params,
          sql: statement.sql,
        })),
        { params: [], sql: "COMMIT" },
      ],
    }).catch((error: unknown) => {
      rejectQueuedStatements(context, error);
      throw error;
    });

    resolveQueuedStatements(context, response, "COMMIT");
  }

  private async rollbackTransaction(
    context: TransactionContext,
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.postToD1({
        batch: [
          { params: [], sql: "BEGIN" },
          ...context.statements.map((statement) => ({
            params: statement.params,
            sql: statement.sql,
          })),
          { params: [], sql: "ROLLBACK" },
        ],
      });
    } catch (rollbackError) {
      rejectQueuedStatements(context, rollbackError);
      throw new D1HttpClientError(
        `D1 rollback failed after transaction callback error: original=${messageFromUnknown(
          originalError,
        )}; rollback=${messageFromUnknown(rollbackError)}`,
      );
    }

    rejectQueuedStatements(context, originalError);
  }

  private async postToD1(body: D1RequestBody): Promise<D1ApiResponse> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await this.fetchImpl(this.endpoint, {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const responseText = await response.text();

      if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
        continue;
      }

      if (!response.ok) {
        throw new D1HttpClientError(
          `Cloudflare D1 HTTP ${response.status} response: ${responseText}`,
        );
      }

      const parsedBody = parseJson(responseText);
      const apiResponse = parseApiResponse(parsedBody, responseText);

      if (!apiResponse.success) {
        throw new D1HttpClientError(`Cloudflare D1 query failed: ${stringifyForError(parsedBody)}`);
      }

      const failedResult = apiResponse.result.find((entry) => entry.success === false);
      if (failedResult !== undefined) {
        throw new D1HttpClientError(
          `Cloudflare D1 statement failed: ${stringifyForError(parsedBody)}`,
        );
      }

      return apiResponse;
    }

    throw new D1HttpClientError("Cloudflare D1 request failed without returning a response");
  }
}

function normalizeParams(params: readonly D1Parameter[]): D1Parameter[] {
  return params.map((param) => {
    if (param === null || typeof param === "string") {
      return param;
    }

    if (typeof param === "number" && Number.isFinite(param)) {
      return param;
    }

    throw new TypeError(`Unsupported D1 parameter: ${String(param)}`);
  });
}

function parseJson(responseText: string): unknown {
  try {
    return JSON.parse(responseText) as unknown;
  } catch (error) {
    throw new D1HttpClientError(
      `Cloudflare D1 returned malformed JSON: ${messageFromUnknown(error)}; body=${responseText}`,
    );
  }
}

function parseApiResponse(payload: unknown, rawBody: string): D1ApiResponse {
  if (!isRecord(payload)) {
    throw new D1HttpClientError(`Cloudflare D1 response was not an object: ${rawBody}`);
  }

  const success = payload.success === true;
  const resultValue = payload.result;

  if (!Array.isArray(resultValue) && success) {
    throw new D1HttpClientError(`Cloudflare D1 response result was not an array: ${rawBody}`);
  }

  return {
    errors: responseInfoArray(payload.errors),
    messages: responseInfoArray(payload.messages),
    result: Array.isArray(resultValue)
      ? resultValue.map((entry) => parseQueryResult(entry, rawBody))
      : [],
    success,
  };
}

function parseQueryResult(value: unknown, rawBody: string): D1QueryResult {
  if (!isRecord(value)) {
    throw new D1HttpClientError(`Cloudflare D1 result entry was not an object: ${rawBody}`);
  }

  const results = value.results;
  if (results !== undefined && !Array.isArray(results)) {
    throw new D1HttpClientError(`Cloudflare D1 result rows were not an array: ${rawBody}`);
  }

  return {
    ...value,
    meta: parseMeta(value.meta),
    results: results ?? [],
    success: typeof value.success === "boolean" ? value.success : undefined,
  };
}

function parseMeta(value: unknown): D1QueryMeta {
  if (!isRecord(value)) {
    return {};
  }

  const meta: D1QueryMeta = {};
  for (const [key, entry] of Object.entries(value)) {
    meta[key] = entry;
  }

  copyNumber(value, meta, "changes");
  copyNumber(value, meta, "duration");
  copyNumber(value, meta, "last_row_id");
  copyNumber(value, meta, "rows_read");
  copyNumber(value, meta, "rows_written");
  copyNumber(value, meta, "size_after");
  copyBoolean(value, meta, "changed_db");
  copyBoolean(value, meta, "served_by_primary");
  copyString(value, meta, "served_by_colo");
  copyString(value, meta, "served_by_region");

  if (isRecord(value.timings)) {
    const timings: D1QueryMeta["timings"] = {};
    for (const [key, entry] of Object.entries(value.timings)) {
      timings[key] = entry;
    }
    copyTimingNumber(value.timings, timings, "sql_duration_ms");
    meta.timings = timings;
  }

  return meta;
}

function copyNumber(source: Record<string, unknown>, target: D1QueryMeta, key: string): void {
  const value = source[key];
  if (typeof value === "number") {
    target[key] = value;
  }
}

function copyBoolean(source: Record<string, unknown>, target: D1QueryMeta, key: string): void {
  const value = source[key];
  if (typeof value === "boolean") {
    target[key] = value;
  }
}

function copyString(source: Record<string, unknown>, target: D1QueryMeta, key: string): void {
  const value = source[key];
  if (typeof value === "string") {
    target[key] = value;
  }
}

function copyTimingNumber(
  source: Record<string, unknown>,
  target: NonNullable<D1QueryMeta["timings"]>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "number") {
    target[key] = value;
  }
}

function responseInfoArray(value: unknown): D1ResponseInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((entry) => {
    const info: D1ResponseInfo = {};
    for (const [key, field] of Object.entries(entry)) {
      info[key] = field;
    }
    return info;
  });
}

function toRunResult(entry: D1QueryResult): D1RunResult {
  return {
    changes: metaNumber(entry.meta, "changes"),
    lastInsertRowid: metaNumber(entry.meta, "last_row_id"),
    meta: entry.meta,
    success: entry.success !== false,
  };
}

function metaNumber(meta: D1QueryMeta, key: string): number {
  const value = meta[key];
  return typeof value === "number" ? value : 0;
}

function rowsFromEntry<Row extends Record<string, unknown>>(entry: D1QueryResult): Row[] {
  return entry.results.map((row) => row as Row);
}

function valuesFromEntry<Row extends readonly unknown[]>(entry: D1QueryResult): Row[] {
  return entry.results.map((row) => {
    if (Array.isArray(row)) {
      return row as unknown as Row;
    }

    if (isRecord(row)) {
      return Object.values(row) as unknown as Row;
    }

    return [row] as unknown as Row;
  });
}

function resolveQueuedStatements(
  context: TransactionContext,
  response: D1ApiResponse,
  terminalSql: string,
): void {
  for (const [index, statement] of context.statements.entries()) {
    const resultIndex = index + 1;
    const entry = response.result[resultIndex];

    if (entry === undefined) {
      statement.reject(
        new D1HttpClientError(
          `Cloudflare D1 transaction response missing result ${resultIndex} before ${terminalSql}`,
        ),
      );
      continue;
    }

    statement.resolve(entry);
  }
}

function rejectQueuedStatements(context: TransactionContext, error: unknown): void {
  for (const statement of context.statements) {
    statement.reject(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyForError(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
