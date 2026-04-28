import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsTextBlock,
  EventListParams,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { Logger } from "pino";

export type ToolHandler = (args: unknown) => Promise<unknown>;
export type ToolHandlerMap = Record<string, ToolHandler>;

export type SessionTimeouts = {
  idleGraceMs?: number;
  maxWallClockMs: number;
};

export type SessionResult = {
  aborted: boolean;
  durationMs: number;
  errored: boolean;
  eventsProcessed: number;
  idleReached: boolean;
  lastEventId: string | undefined;
  sessionId: string;
  timedOut: boolean;
  toolErrors: number;
  toolInvocations: number;
};

export type SessionClient = {
  beta: {
    sessions: {
      events: {
        stream(sessionId: string): PromiseLike<AsyncIterable<BetaManagedAgentsStreamSessionEvents>>;
        list(
          sessionId: string,
          params?: EventListParams,
        ): AsyncIterable<BetaManagedAgentsSessionEvent>;
        send(sessionId: string, params: EventSendParams): PromiseLike<unknown>;
      };
    };
  };
};

export type RunSessionOptions = {
  handlers: ToolHandlerMap;
  logger: Logger;
  sessionId: string;
  signal?: AbortSignal;
  timeouts: SessionTimeouts;
};

const ABORTED_ITERATION = Symbol("ABORTED_ITERATION");
const MAX_CUSTOM_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_RECONNECT_ATTEMPTS = 3;
const PREVIEW_CHAR_LIMIT = 2_048;

type SessionLoopEvent = BetaManagedAgentsSessionEvent | BetaManagedAgentsStreamSessionEvents;
type PreparedToolResult = {
  isError: boolean;
  text: string;
};

class SessionReconnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionReconnectError";
  }
}

function previewAgentMessageText(event: BetaManagedAgentsAgentMessageEvent): {
  preview: string;
  truncated: boolean;
} | null {
  const messageContent = event.content;
  if (!Array.isArray(messageContent) || messageContent.length === 0) {
    return null;
  }

  const textBlocks: BetaManagedAgentsTextBlock[] = [];
  for (const contentBlock of messageContent) {
    if (contentBlock.type === "text") {
      textBlocks.push(contentBlock);
    }
  }

  if (textBlocks.length === 0) {
    return null;
  }

  const concatenatedText = textBlocks.map((textBlock) => textBlock.text).join("\n");
  if (concatenatedText.length === 0) {
    return null;
  }

  if (concatenatedText.length <= PREVIEW_CHAR_LIMIT) {
    return { preview: concatenatedText, truncated: false };
  }

  return {
    preview: `${concatenatedText.slice(0, PREVIEW_CHAR_LIMIT)}…`,
    truncated: true,
  };
}

function buildHandlerErrorPayload(error: unknown) {
  if (error instanceof Error) {
    return {
      error: {
        ...(error.stack ? { stack: error.stack } : {}),
        message: error.message,
        type: "handler_error",
      },
      success: false,
    };
  }

  return {
    error: {
      message: "Handler execution failed",
      type: "handler_error",
    },
    success: false,
  };
}

function buildSerializationErrorPayload(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown serialization failure";

  return {
    error: {
      message: `Failed to serialize custom tool result: ${message}`,
      type: "serialization_error",
    },
    success: false,
  };
}

function buildUnknownToolPayload(toolName: string) {
  return {
    error: {
      message: `No handler registered for custom tool "${toolName}"`,
      type: "unknown_tool",
    },
    success: false,
  };
}

function prepareToolResultPayload(
  payload: unknown,
  logger: Logger,
  eventId: string,
  toolName: string,
): PreparedToolResult {
  let serializedPayload: string | undefined;

  try {
    serializedPayload = JSON.stringify(payload);
  } catch (error) {
    return {
      isError: true,
      text: JSON.stringify(buildSerializationErrorPayload(error)),
    };
  }

  if (typeof serializedPayload !== "string") {
    return {
      isError: true,
      text: JSON.stringify(
        buildSerializationErrorPayload(new Error("JSON.stringify returned a non-string result")),
      ),
    };
  }

  const payloadSize = Buffer.byteLength(serializedPayload, "utf8");
  if (payloadSize < MAX_CUSTOM_TOOL_RESULT_BYTES) {
    return {
      isError: false,
      text: serializedPayload,
    };
  }

  logger.warn(
    { actualSize: payloadSize, eventId, sizeLimit: MAX_CUSTOM_TOOL_RESULT_BYTES, toolName },
    "custom tool result exceeded payload cap",
  );

  return {
    isError: true,
    text: JSON.stringify({
      error: {
        actualSize: payloadSize,
        message: `Handler result exceeds 64KB (was ${payloadSize} bytes)`,
        sizeLimit: MAX_CUSTOM_TOOL_RESULT_BYTES,
        type: "payload_too_large",
      },
      preview: serializedPayload.slice(0, PREVIEW_CHAR_LIMIT),
      success: false,
      truncated: true,
    }),
  };
}

async function settleAbortAwareDelay(
  signal: AbortSignal,
  waitMs: number,
): Promise<"aborted" | "completed"> {
  if (waitMs <= 0) {
    return signal.aborted ? "aborted" : "completed";
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  try {
    const winner = await Promise.race([
      new Promise<"completed">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("completed"), waitMs);
      }),
      new Promise<"aborted">((resolve) => {
        if (signal.aborted) {
          resolve("aborted");
          return;
        }

        abortListener = () => resolve("aborted");
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);

    return winner;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function nextFromIterator<TEvent>(
  iterator: AsyncIterator<TEvent>,
  signal: AbortSignal,
): Promise<IteratorResult<TEvent> | typeof ABORTED_ITERATION> {
  if (signal.aborted) {
    return ABORTED_ITERATION;
  }

  let abortListener: (() => void) | undefined;

  try {
    const nextResult = await Promise.race([
      iterator.next(),
      new Promise<typeof ABORTED_ITERATION>((resolve) => {
        abortListener = () => resolve(ABORTED_ITERATION);
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);

    return nextResult;
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function promiseWithAbort<TValue>(
  promiseLike: PromiseLike<TValue>,
  signal: AbortSignal,
): Promise<TValue | typeof ABORTED_ITERATION> {
  if (signal.aborted) {
    return ABORTED_ITERATION;
  }

  let abortListener: (() => void) | undefined;

  try {
    return await Promise.race([
      Promise.resolve(promiseLike),
      new Promise<typeof ABORTED_ITERATION>((resolve) => {
        abortListener = () => resolve(ABORTED_ITERATION);
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export async function runSession(
  client: SessionClient,
  options: RunSessionOptions,
): Promise<SessionResult> {
  const sessionLogger = options.logger.child({ sessionId: options.sessionId });
  const controller = new AbortController();
  const idleGraceMs = Math.max(0, options.timeouts.idleGraceMs ?? 0);
  const processedEventIds = new Set<string>();
  const startedAt = Date.now();

  let aborted = false;
  let errored = false;
  let eventsProcessed = 0;
  let idleReached = false;
  let lastEventId: string | undefined;
  let reconnectAttempts = 0;
  let reconnectNeedsReplay = false;
  let reconnectResetPending = false;
  let timedOut = false;
  let toolErrors = 0;
  let toolInvocations = 0;
  let toolResultSentSinceStreamStart = false;

  const handleExternalAbort = () => {
    aborted = true;
    controller.abort();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      handleExternalAbort();
    } else {
      options.signal.addEventListener("abort", handleExternalAbort, { once: true });
    }
  }

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    sessionLogger.error(
      { eventsProcessed, maxWallClockMs: options.timeouts.maxWallClockMs },
      "session timeout",
    );
    controller.abort();
  }, options.timeouts.maxWallClockMs);

  function markProcessed(event: SessionLoopEvent): void {
    processedEventIds.add(event.id);
    lastEventId = event.id;
    eventsProcessed += 1;

    if (reconnectResetPending) {
      reconnectAttempts = 0;
      reconnectResetPending = false;
      reconnectNeedsReplay = false;
    }
  }

  async function sendToolResult(
    event: BetaManagedAgentsAgentCustomToolUseEvent,
    payload: unknown,
    forceError = false,
  ): Promise<boolean> {
    const preparedPayload = prepareToolResultPayload(payload, sessionLogger, event.id, event.name);
    const isError = forceError || preparedPayload.isError;
    const params: EventSendParams = {
      events: [
        {
          content: [{ text: preparedPayload.text, type: "text" }],
          custom_tool_use_id: event.id,
          is_error: isError ? true : undefined,
          type: "user.custom_tool_result",
        },
      ],
    };

    await client.beta.sessions.events.send(options.sessionId, params);
    return isError;
  }

  async function dispatchToolUse(event: BetaManagedAgentsAgentCustomToolUseEvent): Promise<void> {
    toolInvocations += 1;
    toolResultSentSinceStreamStart = true;

    const handler = options.handlers[event.name];
    if (!handler) {
      toolErrors += 1;
      await sendToolResult(event, buildUnknownToolPayload(event.name), true);
      return;
    }

    try {
      const handlerOutput = await handler(event.input);
      const sendWasError = await sendToolResult(event, handlerOutput);
      if (sendWasError) {
        toolErrors += 1;
      }
    } catch (error) {
      toolErrors += 1;
      sessionLogger.error(
        { err: error, eventId: event.id, toolName: event.name },
        "handler failed",
      );
      await sendToolResult(event, buildHandlerErrorPayload(error), true);
    }
  }

  async function processEvent(event: SessionLoopEvent): Promise<"continue" | "stop"> {
    sessionLogger.debug({ eventId: event.id, eventType: event.type }, "event received");

    if (processedEventIds.has(event.id)) {
      return "continue";
    }

    if (event.type === "session.error") {
      markProcessed(event);
      sessionLogger.error({ err: event.error, eventId: event.id }, "session error event received");
      throw new SessionReconnectError(event.error.message);
    }

    if (event.type === "agent.message") {
      const messagePreview = previewAgentMessageText(event);
      if (messagePreview !== null) {
        sessionLogger.info(
          {
            eventId: event.id,
            preview: messagePreview.preview,
            previewCharLimit: PREVIEW_CHAR_LIMIT,
            truncated: messagePreview.truncated,
          },
          "agent message",
        );
      }
      markProcessed(event);
      return controller.signal.aborted ? "stop" : "continue";
    }

    if (event.type === "agent.custom_tool_use") {
      await dispatchToolUse(event);
      markProcessed(event);
      return controller.signal.aborted ? "stop" : "continue";
    }

    if (event.type === "session.status_idle") {
      markProcessed(event);

      if (toolResultSentSinceStreamStart) {
        sessionLogger.debug({ eventId: event.id }, "idle after tool result; reopening stream");
        return "stop";
      }

      if ((await settleAbortAwareDelay(controller.signal, idleGraceMs)) === "aborted") {
        return "stop";
      }

      idleReached = true;
      return "stop";
    }

    markProcessed(event);
    return controller.signal.aborted ? "stop" : "continue";
  }

  async function closeIterator<TEvent>(iterator: AsyncIterator<TEvent>): Promise<void> {
    if (!iterator.return) {
      return;
    }

    try {
      await iterator.return();
    } catch (closeError) {
      sessionLogger.debug({ err: closeError }, "iterator.return() failed; best-effort cleanup");
    }
  }

  async function consumeIterable(
    iterable: AsyncIterable<SessionLoopEvent>,
  ): Promise<"continue" | "stop"> {
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      while (true) {
        const nextResult = await nextFromIterator(iterator, controller.signal);
        if (nextResult === ABORTED_ITERATION) {
          return "stop";
        }

        if (nextResult.done) {
          return "continue";
        }

        const processOutcome = await processEvent(nextResult.value);
        if (processOutcome === "stop") {
          return "stop";
        }
      }
    } finally {
      await closeIterator(iterator);
    }
  }

  try {
    while (!controller.signal.aborted && !idleReached && !errored) {
      try {
        if (reconnectNeedsReplay && lastEventId) {
          const replayOutcome = await consumeIterable(
            client.beta.sessions.events.list(options.sessionId),
          );
          if (replayOutcome === "stop") {
            break;
          }

          reconnectNeedsReplay = false;
        } else if (reconnectNeedsReplay) {
          reconnectNeedsReplay = false;
        }

        if (controller.signal.aborted || idleReached) {
          break;
        }

        const stream = await promiseWithAbort(
          client.beta.sessions.events.stream(options.sessionId),
          controller.signal,
        );
        if (stream === ABORTED_ITERATION) {
          break;
        }

        toolResultSentSinceStreamStart = false;
        const streamOutcome = await consumeIterable(stream);
        if (streamOutcome === "stop" && (idleReached || controller.signal.aborted)) {
          break;
        }

        if (streamOutcome === "stop") {
          continue;
        }

        if (!reconnectNeedsReplay) {
          break;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          break;
        }

        reconnectAttempts += 1;
        reconnectNeedsReplay = true;
        reconnectResetPending = true;

        sessionLogger.warn({ attempt: reconnectAttempts, lastEventId }, "stream reconnect");
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          sessionLogger.error(
            { attempts: reconnectAttempts, err: error, lastEventId },
            "stream reconnect attempts exhausted",
          );
          errored = true;
          break;
        }
      }
    }
  } finally {
    clearTimeout(timeoutHandle);

    if (options.signal) {
      options.signal.removeEventListener("abort", handleExternalAbort);
    }
  }

  return {
    aborted,
    durationMs: Date.now() - startedAt,
    errored,
    eventsProcessed,
    idleReached,
    lastEventId,
    sessionId: options.sessionId,
    timedOut,
    toolErrors,
    toolInvocations,
  };
}
