import { connect as netConnect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentEventNotificationParams,
  EventEnvelope,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  RpcFault,
  RpcMethod,
  RpcParams,
  RpcResult,
  SubscriptionFilter,
} from "@forge/protocol";
import {
  AGENT_EVENT_METHOD,
  CORE_EVENT_METHOD,
  RPC_PROTOCOL_VERSION,
  V2_RPC_METHODS,
  isRpcFault,
  rpcFault,
} from "@forge/protocol";
import {
  createEventSubscription,
  type EventSubscription,
  type SubscribeOptions,
  type SubscriptionTransport,
} from "./subscription.js";

export type {
  EventSubscription,
  SubscribeOptions,
  SubscriptionTransport,
} from "./subscription.js";
export {
  createEventSubscription,
  matchesEventFilter,
} from "./subscription.js";
export {
  REQUIRED_EXECUTION_FEATURE,
  agentEventFromEnvelope,
  createWorkbenchDaemonApi,
  isTerminalRunState,
  simpleRunSpec,
  supportsExecutionKernel,
  waitForWorkbenchRun,
  type SimpleRunInput,
  type WorkbenchDaemonApi,
} from "./workbench-api.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  requestId: string;
  legacyOnEvent?: (event: AgentEvent) => void;
  onNotification?: (event: EventEnvelope) => void;
  cleanup: () => void;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onNotification?: (event: EventEnvelope) => void;
}

export class DaemonRpcError extends Error {
  readonly name = "DaemonRpcError";

  constructor(readonly fault: RpcFault) {
    super(fault.message);
  }
}

export interface DaemonClient {
  onEvent(handler: (event: AgentEvent) => void): void;
  onClose(handler: () => void): void;
  onNotification(handler: (event: EventEnvelope) => void): () => void;
  subscribe(
    filter: SubscriptionFilter,
    handler: (event: EventEnvelope) => void | Promise<void>,
    options?: SubscribeOptions,
  ): EventSubscription;
  request<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    options?: RequestOptions,
  ): Promise<RpcResult<M>>;
  /** Temporary bridge until Workbench, CLI, Mobile and Channel use v2 contracts. */
  request(
    method: string,
    params?: unknown,
    legacyOnEvent?: (event: AgentEvent) => void,
  ): Promise<unknown>;
  close(): void;
}

const V2_RPC_METHOD_SET: ReadonlySet<string> = new Set(V2_RPC_METHODS);
const CANCEL_REQUEST_METHOD = "$/cancelRequest";

export function connectDaemon(socketPath: string): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
    let socket = netConnect(socketPath);
    let buffer = "";
    let nextId = 1;
    let eventHandler: ((event: AgentEvent) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    let connected = false;
    const pending = new Map<JsonRpcId, PendingRequest>();
    const notificationListeners = new Set<(event: EventEnvelope) => void>();
    const closeListeners = new Set<() => void>();
    let reconnectPromise: Promise<void> | null = null;
    let intentionalReconnect = false;
    const getSocket = (): Socket => socket;

    const notifyClose = () => {
      if (intentionalReconnect) return;
      closeHandler?.();
      for (const listener of closeListeners) {
        listener();
      }
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse & JsonRpcNotification;
          if (msg.method === AGENT_EVENT_METHOD && msg.params) {
            routeAgentEvent(msg.params, pending, eventHandler);
            continue;
          }
          if (msg.method === CORE_EVENT_METHOD && msg.params) {
            routeCoreEvent(msg.params, pending, notificationListeners);
            continue;
          }
          if (msg.method && msg.params && routeNotification(msg.params, pending)) {
            continue;
          }
          if (msg.id === undefined) continue;
          const entry = pending.get(msg.id);
          if (!entry) continue;
          pending.delete(msg.id);
          entry.cleanup();
          if (msg.error) {
            entry.reject(toDaemonRpcError(msg.error));
          } else {
            entry.resolve(msg.result);
          }
        } catch {
          // Ignore malformed daemon frames. A valid pending request remains active.
        }
      }
    };

    const rejectAll = (err: Error) => {
      for (const entry of pending.values()) {
        entry.cleanup();
        entry.reject(err);
      }
      pending.clear();
    };

    const attachSocket = (activeSocket: Socket) => {
      activeSocket.on("data", onData);
      activeSocket.on("error", (error) => {
        rejectAll(error);
        if (!connected) reject(error);
      });
      activeSocket.on("close", () => {
        rejectAll(new Error("Daemon connection closed"));
        notifyClose();
      });
    };

    const reconnect = async (): Promise<void> => {
      if (reconnectPromise) {
        return reconnectPromise;
      }
      reconnectPromise = new Promise<void>((resolveReconnect, rejectReconnect) => {
        intentionalReconnect = true;
        socket.removeAllListeners();
        socket.destroy();
        buffer = "";
        const replacement = netConnect(socketPath);
        replacement.once("connect", () => {
          socket = replacement;
          intentionalReconnect = false;
          attachSocket(replacement);
          resolveReconnect();
        });
        replacement.once("error", (error) => {
          intentionalReconnect = false;
          rejectReconnect(error);
        });
      }).finally(() => {
        reconnectPromise = null;
      });
      return reconnectPromise;
    };

    socket.once("connect", () => {
      connected = true;
      attachSocket(socket);
      const client = createClient(getSocket, pending, () => nextId++, {
        setEventHandler: (handler) => {
          eventHandler = handler;
        },
        setCloseHandler: (handler) => {
          closeHandler = handler;
        },
      });
      const transport: SubscriptionTransport = {
        request: (method, params, options) => client.request(method, params, options),
        addNotificationListener: (listener) => {
          notificationListeners.add(listener);
          return () => notificationListeners.delete(listener);
        },
        addCloseListener: (listener) => {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
        reconnect,
      };
      resolve({
        ...client,
        onNotification: (listener) => {
          notificationListeners.add(listener);
          return () => notificationListeners.delete(listener);
        },
        subscribe: (filter, handler, options) =>
          createEventSubscription(transport, filter, handler, options),
      });
    });
    socket.on("error", (error) => {
      rejectAll(error);
      if (!connected) reject(error);
    });
  });
}

type BaseDaemonClient = Pick<
  DaemonClient,
  "onEvent" | "onClose" | "request" | "close"
>;

function createClient(
  getSocket: () => Socket,
  pending: Map<JsonRpcId, PendingRequest>,
  allocateId: () => JsonRpcId,
  handlers: {
    setEventHandler: (handler: (event: AgentEvent) => void) => void;
    setCloseHandler: (handler: () => void) => void;
  },
): BaseDaemonClient {
  function request<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    options?: RequestOptions,
  ): Promise<RpcResult<M>>;
  function request(
    method: string,
    params?: unknown,
    legacyOnEvent?: (event: AgentEvent) => void,
  ): Promise<unknown>;
  function request(
    method: string,
    params?: unknown,
    optionsOrLegacyOnEvent?: RequestOptions | ((event: AgentEvent) => void),
  ): Promise<unknown> {
    const id = allocateId();
    const requestId = randomUUID();
    const isV2Method = V2_RPC_METHOD_SET.has(method);
    const frame: JsonRpcRequest & {
      protocolVersion?: typeof RPC_PROTOCOL_VERSION;
      requestId?: string;
    } = {
      jsonrpc: "2.0",
      id,
      method,
      params,
      ...(isV2Method
        ? { protocolVersion: RPC_PROTOCOL_VERSION, requestId }
        : {}),
    };
    const legacyOnEvent =
      typeof optionsOrLegacyOnEvent === "function"
        ? optionsOrLegacyOnEvent
        : undefined;
    const options =
      typeof optionsOrLegacyOnEvent === "function"
        ? undefined
        : optionsOrLegacyOnEvent;

    return new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(
          new DaemonRpcError(
            rpcFault("CORE_CANCELLED", "RPC request cancelled", {
              correlationId: requestId,
            }),
          ),
        );
        return;
      }

      let timeout: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;
      const entry: PendingRequest = {
        resolve,
        reject,
        requestId,
        legacyOnEvent,
        onNotification: options?.onNotification,
        cleanup: () => {
          if (timeout) clearTimeout(timeout);
          if (abortHandler && options?.signal) {
            options.signal.removeEventListener("abort", abortHandler);
          }
        },
      };
      const cancel = (fault: RpcFault) => {
        if (pending.get(id) !== entry) return;
        pending.delete(id);
        entry.cleanup();
        sendCancellation(getSocket(), id, requestId);
        reject(new DaemonRpcError(fault));
      };

      pending.set(id, entry);
      if (options?.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cancel(
            rpcFault("CORE_TIMEOUT", "RPC request timed out", {
              retryable: true,
              correlationId: requestId,
            }),
          );
        }, options.timeoutMs);
      }
      if (options?.signal) {
        abortHandler = () => {
          cancel(
            rpcFault("CORE_CANCELLED", "RPC request cancelled", {
              correlationId: requestId,
            }),
          );
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      getSocket().write(JSON.stringify(frame) + "\n", (error) => {
        if (!error || pending.get(id) !== entry) return;
        pending.delete(id);
        entry.cleanup();
        reject(error);
      });
    });
  }

  return {
    onEvent: handlers.setEventHandler,
    onClose: handlers.setCloseHandler,
    request,
    close: () => getSocket().end(),
  };
}

function routeAgentEvent(
  params: unknown,
  pending: Map<JsonRpcId, PendingRequest>,
  fallback?: (event: AgentEvent) => void,
): void {
  if (isScopedEvent(params)) {
    const requestHandler = pending.get(params.requestId)?.legacyOnEvent;
    (requestHandler ?? fallback)?.(params.event);
    return;
  }

  // Compatibility with daemons that emitted the AgentEvent directly.
  fallback?.(params as AgentEvent);
}

function routeCoreEvent(
  params: unknown,
  pending: Map<JsonRpcId, PendingRequest>,
  listeners: Set<(event: EventEnvelope) => void>,
): void {
  if (!isEventEnvelope(params)) return;
  routeNotification(params, pending);
  for (const listener of listeners) {
    listener(params);
  }
}

function routeNotification(
  params: unknown,
  pending: Map<JsonRpcId, PendingRequest>,
): boolean {
  if (!isEventEnvelope(params)) return false;
  for (const entry of pending.values()) {
    if (entry.requestId !== params.correlationId) continue;
    entry.onNotification?.(params);
    return true;
  }
  return false;
}

function sendCancellation(
  socket: Socket,
  id: JsonRpcId,
  requestId: string,
): void {
  if (socket.destroyed || socket.writableEnded) return;
  const notification: JsonRpcNotification = {
    jsonrpc: "2.0",
    method: CANCEL_REQUEST_METHOD,
    params: { id, requestId },
  };
  socket.write(JSON.stringify(notification) + "\n");
}

function toDaemonRpcError(error: unknown): DaemonRpcError {
  const fault = extractRpcFault(error);
  if (fault) return new DaemonRpcError(fault);
  return new DaemonRpcError(
    rpcFault("INTERNAL_ERROR", safeRpcErrorMessage(error)),
  );
}

function extractRpcFault(error: unknown): RpcFault | undefined {
  if (isRpcFault(error)) return error;
  if (!isRecord(error) || !isRecord(error.data)) return undefined;
  return isRpcFault(error.data.fault) ? error.data.fault : undefined;
}

function safeRpcErrorMessage(error: unknown): string {
  if (!isRecord(error) || typeof error.message !== "string") {
    return "Unknown RPC error";
  }
  const message = error.message.startsWith("Error:")
    ? error.message.slice("Error:".length).trim()
    : error.message.trim();
  return message || "Unknown RPC error";
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!isRecord(value) || !isRecord(value.subject)) return false;
  return (
    typeof value.eventId === "string" &&
    value.eventId.length > 0 &&
    Number.isInteger(value.sequence) &&
    typeof value.type === "string" &&
    value.type.length > 0 &&
    typeof value.subject.kind === "string" &&
    value.subject.kind.length > 0 &&
    typeof value.subject.id === "string" &&
    value.subject.id.length > 0 &&
    typeof value.correlationId === "string" &&
    value.correlationId.length > 0 &&
    typeof value.occurredAt === "string" &&
    value.occurredAt.length > 0 &&
    typeof value.schemaVersion === "number" &&
    Number.isInteger(value.schemaVersion) &&
    value.schemaVersion >= 1 &&
    "data" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScopedEvent(value: unknown): value is AgentEventNotificationParams {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgentEventNotificationParams>;
  return (
    (typeof candidate.requestId === "number" ||
      typeof candidate.requestId === "string") &&
    Boolean(candidate.event) &&
    typeof candidate.event === "object"
  );
}
