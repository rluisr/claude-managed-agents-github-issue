import { describe, expect, test } from "bun:test";

import { D1HttpClient, type D1Parameter } from "@/shared/persistence/d1-http-client";

const ACCOUNT_ID = "account-123";
const DATABASE_ID = "database-456";
const API_TOKEN = "token-789";
const QUERY_URL =
  "https://api.cloudflare.com/client/v4/accounts/account-123/d1/database/database-456/query";

type FetchCall = {
  init: RequestInit;
  url: string;
};

type MockFetch = {
  calls: FetchCall[];
  fetch: typeof fetch;
};

type MockD1Result = {
  meta?: Record<string, unknown>;
  results?: unknown[];
  success?: boolean;
};

function createClient(mockFetch: MockFetch): D1HttpClient {
  return new D1HttpClient({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    databaseId: DATABASE_ID,
    fetch: mockFetch.fetch,
  });
}

function createFetch(...responses: Response[]): MockFetch {
  const calls: FetchCall[] = [];
  const responseQueue = [...responses];
  const fetchStub: typeof fetch = async (input, init) => {
    calls.push({ init: init ?? {}, url: requestUrl(input) });
    const response = responseQueue.shift();

    if (response === undefined) {
      throw new Error("mock fetch response queue exhausted");
    }

    return response;
  };

  return { calls, fetch: fetchStub };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function d1JsonResponse(results: MockD1Result[], init: ResponseInit = {}): Response {
  return new Response(
    JSON.stringify({
      errors: [],
      messages: [],
      result: results.map((result) => ({
        meta: result.meta ?? {},
        results: result.results ?? [],
        success: result.success ?? true,
      })),
      success: true,
    }),
    {
      headers: { "Content-Type": "application/json" },
      status: 200,
      ...init,
    },
  );
}

function d1ErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      errors: [{ code: status * 10, message }],
      messages: [],
      result: [],
      success: false,
    }),
    {
      headers: { "Content-Type": "application/json" },
      status,
    },
  );
}

function onlyCall(calls: FetchCall[]): FetchCall {
  const call = calls[0];

  if (call === undefined) {
    throw new Error("expected one fetch call");
  }

  return call;
}

function requestBody(call: FetchCall): unknown {
  if (typeof call.init.body !== "string") {
    throw new Error("expected JSON string request body");
  }

  return JSON.parse(call.init.body) as unknown;
}

function singleQueryBody(call: FetchCall): { params: D1Parameter[]; sql: string } {
  const body = requestBody(call);

  if (!isRecord(body) || typeof body.sql !== "string" || !Array.isArray(body.params)) {
    throw new Error("expected single-query D1 request body");
  }

  return {
    params: body.params.map((param) => param as D1Parameter),
    sql: body.sql,
  };
}

function batchBody(call: FetchCall): Array<{ params: D1Parameter[]; sql: string }> {
  const body = requestBody(call);

  if (!isRecord(body) || !Array.isArray(body.batch)) {
    throw new Error("expected D1 batch request body");
  }

  return body.batch.map((entry) => {
    if (!isRecord(entry) || typeof entry.sql !== "string" || !Array.isArray(entry.params)) {
      throw new Error("expected D1 batch entry");
    }

    return {
      params: entry.params.map((param) => param as D1Parameter),
      sql: entry.sql,
    };
  });
}

function requestHeaders(call: FetchCall): Record<string, string> {
  const headers = call.init.headers;

  if (!isRecord(headers)) {
    throw new Error("expected object headers");
  }

  const authorization = headers.Authorization;
  const contentType = headers["Content-Type"];

  if (typeof authorization !== "string" || typeof contentType !== "string") {
    throw new Error("expected auth and content-type headers");
  }

  return { Authorization: authorization, "Content-Type": contentType };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("D1HttpClient", () => {
  test("prepare(sql).get returns a successful single-row SELECT", async () => {
    const mockFetch = createFetch(
      d1JsonResponse([{ results: [{ answer: 42 }], meta: { rows_read: 1 } }]),
    );
    const client = createClient(mockFetch);

    const row = await client.prepare("SELECT 42 AS answer").get<{ answer: number }>();

    expect(row).toEqual({ answer: 42 });
  });

  test("prepare(sql).all returns multi-row SELECT results", async () => {
    const mockFetch = createFetch(
      d1JsonResponse([{ results: [{ id: 1 }, { id: 2 }, { id: 3 }], meta: { rows_read: 3 } }]),
    );
    const client = createClient(mockFetch);

    const rows = await client.prepare("SELECT id FROM widgets ORDER BY id").all<{ id: number }>();

    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  test("prepare(sql).values returns positional row arrays", async () => {
    const mockFetch = createFetch(
      d1JsonResponse([
        {
          results: [
            { first: "alpha", second: 1 },
            { first: "beta", second: 2 },
          ],
        },
      ]),
    );
    const client = createClient(mockFetch);

    const rows = await client
      .prepare("SELECT first, second FROM widgets")
      .values<readonly [string, number]>();

    expect(rows).toEqual([
      ["alpha", 1],
      ["beta", 2],
    ]);
  });

  test("parameterized INSERT exposes the auto-incremented row id from meta.last_row_id", async () => {
    const mockFetch = createFetch(
      d1JsonResponse([{ meta: { changes: 1, last_row_id: 123, rows_written: 1 } }]),
    );
    const client = createClient(mockFetch);

    const result = await client.prepare("INSERT INTO widgets (name) VALUES (?1)").run("alpha");

    expect(result.meta.last_row_id).toBe(123);
    expect(result.lastInsertRowid).toBe(123);
    expect(result.changes).toBe(1);
  });

  test("UPDATE returns meta.changes", async () => {
    const mockFetch = createFetch(d1JsonResponse([{ meta: { changes: 2, rows_written: 2 } }]));
    const client = createClient(mockFetch);

    const result = await client
      .prepare("UPDATE widgets SET active = ?1 WHERE active = ?2")
      .run(1, 0);

    expect(result.meta.changes).toBe(2);
    expect(result.changes).toBe(2);
  });

  test("DELETE returns meta.changes", async () => {
    const mockFetch = createFetch(d1JsonResponse([{ meta: { changes: 3, rows_written: 3 } }]));
    const client = createClient(mockFetch);

    const result = await client.prepare("DELETE FROM widgets WHERE archived = ?1").run(1);

    expect(result.meta.changes).toBe(3);
    expect(result.changes).toBe(3);
  });

  test("binds null, integer, real, text, base64 blob text, and 1 MB text parameters", async () => {
    const mockFetch = createFetch(d1JsonResponse([{ meta: { changes: 1 } }]));
    const client = createClient(mockFetch);
    const largeText = "x".repeat(1024 * 1024);
    const base64Blob = "AQIDBA==";

    await client
      .prepare("INSERT INTO edge_cases VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .run(null, 42, 1.5, "hello", base64Blob, largeText);

    expect(singleQueryBody(onlyCall(mockFetch.calls)).params).toEqual([
      null,
      42,
      1.5,
      "hello",
      base64Blob,
      largeText,
    ]);
  });

  test("4xx error response throws with the Cloudflare error body included", async () => {
    const mockFetch = createFetch(d1ErrorResponse(400, "SQL compilation error"));
    const client = createClient(mockFetch);

    await expect(client.prepare("SELECT * FROM missing").all()).rejects.toThrow(
      "SQL compilation error",
    );
  });

  test("5xx error response is retried once and then throws", async () => {
    const mockFetch = createFetch(
      d1ErrorResponse(500, "primary unavailable"),
      d1ErrorResponse(502, "gateway still unavailable"),
    );
    const client = createClient(mockFetch);

    await expect(client.prepare("SELECT 1").all()).rejects.toThrow("gateway still unavailable");
    expect(mockFetch.calls).toHaveLength(2);
  });

  test("malformed JSON response throws", async () => {
    const mockFetch = createFetch(new Response("not-json", { status: 200 }));
    const client = createClient(mockFetch);

    await expect(client.prepare("SELECT 1").get()).rejects.toThrow("malformed JSON");
  });

  test("transaction wraps statements in a single BEGIN/COMMIT request", async () => {
    const mockFetch = createFetch(
      d1JsonResponse([
        { meta: {} },
        { meta: { changes: 1, last_row_id: 10 } },
        { meta: { changes: 1 } },
        { meta: {} },
      ]),
    );
    const client = createClient(mockFetch);
    const insert = client.prepare("INSERT INTO widgets (name) VALUES (?1)");
    const update = client.prepare("UPDATE counters SET value = value + ?1");
    const tx = client.transaction(() => {
      insert.run("alpha");
      update.run(1);
    });

    await tx();

    expect(mockFetch.calls).toHaveLength(1);
    expect(batchBody(onlyCall(mockFetch.calls))).toEqual([
      { params: [], sql: "BEGIN" },
      { params: ["alpha"], sql: "INSERT INTO widgets (name) VALUES (?1)" },
      { params: [1], sql: "UPDATE counters SET value = value + ?1" },
      { params: [], sql: "COMMIT" },
    ]);
  });

  test("transaction exposes queued statement results after commit", async () => {
    const mockFetch = createFetch(
      d1JsonResponse([{ meta: {} }, { meta: { changes: 1, last_row_id: 55 } }, { meta: {} }]),
    );
    const client = createClient(mockFetch);
    let insertResult: Promise<unknown> | undefined;
    const tx = client.transaction(() => {
      insertResult = client.prepare("INSERT INTO widgets (name) VALUES (?1)").run("alpha");
    });

    await tx();

    if (insertResult === undefined) {
      throw new Error("expected queued insert result promise");
    }
    await expect(insertResult).resolves.toMatchObject({ changes: 1, lastInsertRowid: 55 });
  });

  test("transaction failure sends ROLLBACK in the request payload", async () => {
    const mockFetch = createFetch(
      d1JsonResponse([{ meta: {} }, { meta: { changes: 1 } }, { meta: {} }]),
    );
    const client = createClient(mockFetch);
    const tx = client.transaction(() => {
      client.prepare("INSERT INTO widgets (name) VALUES (?1)").run("alpha");
      throw new Error("callback exploded");
    });

    await expect(tx()).rejects.toThrow("callback exploded");

    expect(batchBody(onlyCall(mockFetch.calls))).toEqual([
      { params: [], sql: "BEGIN" },
      { params: ["alpha"], sql: "INSERT INTO widgets (name) VALUES (?1)" },
      { params: [], sql: "ROLLBACK" },
    ]);
  });

  test("prepare(sql).run is reusable across multiple invocations with different params", async () => {
    const mockFetch = createFetch(
      d1JsonResponse([{ meta: { changes: 1, last_row_id: 1 } }]),
      d1JsonResponse([{ meta: { changes: 1, last_row_id: 2 } }]),
    );
    const client = createClient(mockFetch);
    const statement = client.prepare("INSERT INTO widgets (name) VALUES (?1)");

    await statement.run("alpha");
    await statement.run("beta");

    const firstCall = mockFetch.calls[0];
    const secondCall = mockFetch.calls[1];

    if (firstCall === undefined || secondCall === undefined) {
      throw new Error("expected two fetch calls");
    }

    expect(singleQueryBody(firstCall).params).toEqual(["alpha"]);
    expect(singleQueryBody(secondCall).params).toEqual(["beta"]);
  });

  test("request targets the Cloudflare query endpoint and sets authorization headers", async () => {
    const mockFetch = createFetch(d1JsonResponse([{ results: [{ ok: 1 }] }]));
    const client = createClient(mockFetch);

    await client.prepare("SELECT 1 AS ok").get();

    const call = onlyCall(mockFetch.calls);
    expect(call.url).toBe(QUERY_URL);
    expect(requestHeaders(call)).toEqual({
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    });
  });

  test("exec sends multi-statement SQL in one query body", async () => {
    const mockFetch = createFetch(
      d1JsonResponse([{ meta: { changes: 0 } }, { meta: { changes: 0 } }]),
    );
    const client = createClient(mockFetch);
    const sql = "CREATE TABLE widgets (id INTEGER PRIMARY KEY); PRAGMA table_info(widgets);";

    const results = await client.exec(sql);

    expect(results).toHaveLength(2);
    expect(singleQueryBody(onlyCall(mockFetch.calls))).toEqual({ params: [], sql });
  });

  test("query(sql) aliases prepare(sql) for the current db.ts DI surface", async () => {
    const mockFetch = createFetch(d1JsonResponse([{ results: [{ answer: 1 }] }]));
    const client = createClient(mockFetch);

    const row = await client.query("SELECT 1 AS answer").get<{ answer: number }>();

    expect(row).toEqual({ answer: 1 });
  });
});
