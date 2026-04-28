export type SseEventInput = {
  data: unknown;
  event?: string;
  id?: string;
};

export type HeartbeatEvent = { __heartbeat: true };

type IndexedIteratorResult<T> = {
  index: number;
  result: IteratorResult<T>;
};

type AbortableDelay = {
  cancel: () => void;
  promise: Promise<"aborted" | "heartbeat">;
};

export function formatSseEvent(input: SseEventInput): string {
  const lines: string[] = [];

  if (input.id !== undefined) {
    lines.push(`id: ${input.id}`);
  }

  if (input.event !== undefined) {
    lines.push(`event: ${input.event}`);
  }

  lines.push(`data: ${JSON.stringify(input.data)}`);

  return `${lines.join("\n")}\n\n`;
}

export async function* mergeAsyncIterables<T>(...streams: AsyncIterable<T>[]): AsyncIterable<T> {
  const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<IndexedIteratorResult<T>>>();

  const queueNext = (index: number): void => {
    const iterator = iterators[index];
    if (iterator === undefined) {
      return;
    }

    pending.set(
      index,
      iterator.next().then((result) => ({ index, result })),
    );
  };

  try {
    for (const index of iterators.keys()) {
      queueNext(index);
    }

    while (pending.size > 0) {
      const { index, result } = await Promise.race(pending.values());
      pending.delete(index);

      if (result.done === true) {
        continue;
      }

      yield result.value;
      queueNext(index);
    }
  } finally {
    await Promise.allSettled(
      iterators.map(async (iterator) => {
        await iterator.return?.();
      }),
    );
  }
}

function createHeartbeatDelay(intervalMs: number, signal: AbortSignal): AbortableDelay {
  let abortListener: (() => void) | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<"aborted" | "heartbeat">((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }

    abortListener = () => resolve("aborted");
    signal.addEventListener("abort", abortListener, { once: true });
    timeoutHandle = setTimeout(() => resolve("heartbeat"), Math.max(0, intervalMs));
  });

  return {
    cancel() {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }

      if (abortListener !== undefined) {
        signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    },
    promise,
  };
}

export async function* withHeartbeat<T>(
  stream: AsyncIterable<T>,
  intervalMs: number,
  signal: AbortSignal,
): AsyncIterable<T | HeartbeatEvent> {
  const iterator = stream[Symbol.asyncIterator]();
  let pendingNext = iterator.next();

  try {
    while (!signal.aborted) {
      const heartbeatDelay = createHeartbeatDelay(intervalMs, signal);

      try {
        const winner = await Promise.race([
          pendingNext.then((result) => ({ result, type: "event" }) as const),
          heartbeatDelay.promise.then((type) => ({ type }) as const),
        ]);

        if (winner.type !== "event") {
          if (winner.type === "heartbeat") {
            yield { __heartbeat: true };
            continue;
          }

          return;
        }

        if (winner.result.done === true) {
          return;
        }

        yield winner.result.value;
        pendingNext = iterator.next();
      } finally {
        heartbeatDelay.cancel();
      }
    }
  } finally {
    await iterator.return?.();
  }
}
