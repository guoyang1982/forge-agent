import type { SubscriptionFilter } from "@forge/protocol";
import { rpcFault } from "@forge/protocol";
import type { DaemonModule } from "../host/types.js";
import { RpcFaultError, TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";

const MAX_EVENT_READ_LIMIT = 500;

export function createEventModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "events",
    feature: { version: 1, enabled: true },
    register(router, context) {
      router.register("events.read", async (params, rpc) =>
        handleEventsRead(params, context, rpc.correlationId),
      );
      router.register("events.cursor.ack", async (params, rpc) =>
        handleCursorAck(params, context, rpc.correlationId),
      );
    },
  };
}

async function handleEventsRead(
  params: { cursor: number; limit: number; filter: SubscriptionFilter },
  context: ForgeDaemonContext,
  correlationId: string,
) {
  validateReadParams(params, correlationId);
  const events = context.eventStore.readAfter({
    sequence: params.cursor,
    filter: params.filter ?? {},
    limit: Math.min(params.limit, MAX_EVENT_READ_LIMIT),
  });
  return { events };
}

async function handleCursorAck(
  params: { consumerId: string; sequence: number },
  context: ForgeDaemonContext,
  correlationId: string,
) {
  if (!params.consumerId) {
    throw invalidRequest("consumerId is required", correlationId);
  }
  if (!Number.isFinite(params.sequence) || params.sequence < 0) {
    throw invalidRequest("sequence must be a non-negative number", correlationId);
  }
  const now = context.executionClock.now();
  context.eventStore.ackCursor(params.consumerId, params.sequence, now);
  return {
    ok: true as const,
    cursor: context.eventStore.getCursor(params.consumerId),
  };
}

function validateReadParams(
  params: { cursor: number; limit: number; filter: SubscriptionFilter },
  correlationId: string,
): void {
  if (!Number.isFinite(params.cursor) || params.cursor < 0) {
    throw invalidRequest("cursor must be a non-negative number", correlationId);
  }
  if (!Number.isFinite(params.limit) || params.limit <= 0) {
    throw invalidRequest("limit must be a positive number", correlationId);
  }
  if (params.filter !== undefined && !isRecord(params.filter)) {
    throw invalidRequest("filter must be an object", correlationId);
  }
}

function invalidRequest(message: string, correlationId: string): RpcFaultError {
  return new RpcFaultError(
    rpcFault("INVALID_REQUEST", message, { correlationId }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Test helper: register handlers without module lifecycle. */
export function registerEventHandlers(
  router: TypedRouter,
  context: ForgeDaemonContext,
): void {
  createEventModule().register(router, context);
}
