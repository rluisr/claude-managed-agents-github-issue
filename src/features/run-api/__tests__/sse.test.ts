import { describe, expect, test } from "bun:test";

import { formatSseEvent, mergeAsyncIterables, withHeartbeat } from "@/features/run-api/sse";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function* delayedValues<T>(values: Array<{ delayMs: number; value: T }>): AsyncIterable<T> {
  for (const item of values) {
    await sleep(item.delayMs);
    yield item.value;
  }
}

function createNeverIterable<T>(): AsyncIterable<T> {
  let pendingResolve: ((result: IteratorResult<T>) => void) | undefined;

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          return new Promise((resolve) => {
            pendingResolve = resolve;
          });
        },
        async return(): Promise<IteratorResult<T>> {
          pendingResolve?.({ done: true, value: undefined });
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe("SSE helpers", () => {
  test("formatSseEvent formats id, event, and JSON data", () => {
    expect(formatSseEvent({ data: { phase: "preflight" }, event: "phase", id: "evt-1" })).toBe(
      'id: evt-1\nevent: phase\ndata: {"phase":"preflight"}\n\n',
    );
  });

  test("formatSseEvent omits optional id and event fields", () => {
    expect(formatSseEvent({ data: { ok: true } })).toBe('data: {"ok":true}\n\n');
  });

  test("mergeAsyncIterables yields whichever source is ready next", async () => {
    const merged = mergeAsyncIterables(
      delayedValues([
        { delayMs: 20, value: "a-1" },
        { delayMs: 20, value: "a-2" },
      ]),
      delayedValues([
        { delayMs: 5, value: "b-1" },
        { delayMs: 20, value: "b-2" },
      ]),
    );

    const values: string[] = [];
    for await (const value of merged) {
      values.push(value);
    }

    expect(values).toEqual(["b-1", "a-1", "b-2", "a-2"]);
  });

  test("withHeartbeat emits heartbeat comments at the configured interval", async () => {
    const abortController = new AbortController();
    const iterator = withHeartbeat(createNeverIterable<string>(), 5, abortController.signal)[
      Symbol.asyncIterator
    ]();

    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: { __heartbeat: true } });

    abortController.abort();
    await iterator.return?.();
  });
});
