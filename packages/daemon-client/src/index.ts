import { connect as netConnect, type Socket } from "node:net";
import type {
  AgentEvent,
  AgentEventNotificationParams,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@forge/protocol";
import { AGENT_EVENT_METHOD } from "@forge/protocol";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onEvent?: (event: AgentEvent) => void;
}

export interface DaemonClient {
  onEvent(handler: (event: AgentEvent) => void): void;
  onClose(handler: () => void): void;
  request(
    method: string,
    params?: unknown,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<unknown>;
  close(): void;
}

export function connectDaemon(socketPath: string): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    let buffer = "";
    let nextId = 1;
    let eventHandler: ((event: AgentEvent) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    let connected = false;
    const pending = new Map<JsonRpcId, PendingRequest>();

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
          if (msg.id === undefined) continue;
          const entry = pending.get(msg.id);
          if (!entry) continue;
          pending.delete(msg.id);
          if (msg.error) {
            const message = msg.error.message ?? "Unknown RPC error";
            entry.reject(
              new Error(
                message.startsWith("Error:")
                  ? message.slice("Error:".length).trim()
                  : message,
              ),
            );
          } else {
            entry.resolve(msg.result);
          }
        } catch {
          // Ignore malformed daemon frames. A valid pending request remains active.
        }
      }
    };

    const rejectAll = (err: Error) => {
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
    };

    socket.once("connect", () => {
      connected = true;
      socket.on("data", onData);
      resolve(createClient(socket, pending, () => nextId++, {
        setEventHandler: (handler) => {
          eventHandler = handler;
        },
        setCloseHandler: (handler) => {
          closeHandler = handler;
        },
      }));
    });
    socket.on("error", (error) => {
      rejectAll(error);
      if (!connected) reject(error);
    });
    socket.on("close", () => {
      rejectAll(new Error("Daemon connection closed"));
      closeHandler?.();
    });
  });
}

function createClient(
  socket: Socket,
  pending: Map<JsonRpcId, PendingRequest>,
  allocateId: () => JsonRpcId,
  handlers: {
    setEventHandler: (handler: (event: AgentEvent) => void) => void;
    setCloseHandler: (handler: () => void) => void;
  },
): DaemonClient {
  return {
    onEvent: handlers.setEventHandler,
    onClose: handlers.setCloseHandler,
    request: (method, params, onEvent) => {
      const id = allocateId();
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onEvent });
        socket.write(JSON.stringify(request) + "\n", (error) => {
          if (!error) return;
          pending.delete(id);
          reject(error);
        });
      });
    },
    close: () => socket.end(),
  };
}

function routeAgentEvent(
  params: unknown,
  pending: Map<JsonRpcId, PendingRequest>,
  fallback?: (event: AgentEvent) => void,
): void {
  if (isScopedEvent(params)) {
    const requestHandler = pending.get(params.requestId)?.onEvent;
    (requestHandler ?? fallback)?.(params.event);
    return;
  }

  // Compatibility with daemons that emitted the AgentEvent directly.
  fallback?.(params as AgentEvent);
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
