import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type {
  AgentEvent,
  AgentEventNotificationParams,
  EventEnvelope,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  RpcFault,
} from "@forge/protocol";
import {
  AGENT_EVENT_METHOD,
  CORE_EVENT_METHOD,
  isRpcFault,
  rpcFault,
} from "@forge/protocol";

export { connectDaemon, type DaemonClient } from "@forge/daemon-client";
export { CORE_EVENT_METHOD } from "@forge/protocol";

export interface RpcRequestContext {
  requestId: string;
  correlationId: string;
}

export type RpcHandler = (
  method: string,
  params: unknown,
  emit: (event: AgentEvent) => void,
  context: RpcRequestContext,
) => Promise<unknown>;

type RequestWithCorrelation = JsonRpcRequest & {
  requestId?: unknown;
};

function serializeAgentEvent(requestId: JsonRpcId, event: AgentEvent): string {
  const params: AgentEventNotificationParams = { requestId, event };
  const note: JsonRpcNotification = {
    jsonrpc: "2.0",
    method: AGENT_EVENT_METHOD,
    params,
  };
  return JSON.stringify(note) + "\n";
}

export function serializeCoreEvent(event: EventEnvelope): string {
  const note: JsonRpcNotification = {
    jsonrpc: "2.0",
    method: CORE_EVENT_METHOD,
    params: event,
  };
  return JSON.stringify(note) + "\n";
}

export class DaemonServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    private socketPath: string,
    private handler: RpcHandler,
  ) {}

  start(): Promise<void> {
    if (existsSync(this.socketPath)) {
      unlinkSyncSafe(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => {
        chmodSocketOwnerOnly(this.socketPath);
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    unlinkSyncSafe(this.socketPath);
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line) as RequestWithCorrelation;
          if (req.id === undefined) continue;
          void this.handleRequest(socket, req);
        } catch {
          /* ignore bad json */
        }
      }
    });
  }

  private async handleRequest(socket: Socket, req: JsonRpcRequest): Promise<void> {
    if (req.id === undefined) return;
    const requestId = req.id;
    const emit = (event: AgentEvent) => {
      if (!socket.destroyed) {
        socket.write(serializeAgentEvent(requestId, event));
      }
    };
    const respond = (response: JsonRpcResponse) => {
      if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
    };

    try {
      const correlationId = requestCorrelationId(req);
      const result = await this.handler(req.method, req.params, emit, {
        requestId: correlationId,
        correlationId,
      });
      respond({ jsonrpc: "2.0", id: requestId, result });
    } catch (error) {
      const fault = faultForResponse(error, requestCorrelationId(req));
      respond({
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: -32000,
          message: fault.message,
          data: { fault },
        },
      });
    }
  }
}

function faultForResponse(error: unknown, correlationId: string): RpcFault {
  const explicitFault = extractRpcFault(error);
  if (explicitFault) {
    return explicitFault.correlationId
      ? explicitFault
      : { ...explicitFault, correlationId };
  }
  return rpcFault("INTERNAL_ERROR", "Internal RPC error", { correlationId });
}

function extractRpcFault(error: unknown): RpcFault | undefined {
  if (isRpcFault(error)) return error;
  if (!isRecord(error)) return undefined;
  return isRpcFault(error.fault) ? error.fault : undefined;
}

function requestCorrelationId(req: RequestWithCorrelation): string {
  return typeof req.requestId === "string" && req.requestId.length > 0
    ? req.requestId
    : String(req.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unlinkSyncSafe(p: string): void {
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function chmodSocketOwnerOnly(p: string): void {
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best effort; Windows or restrictive filesystems may not support chmod */
  }
}
