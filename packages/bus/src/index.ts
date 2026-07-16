import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type {
  AgentEvent,
  AgentEventNotificationParams,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@forge/protocol";
import { AGENT_EVENT_METHOD } from "@forge/protocol";

export { connectDaemon, type DaemonClient } from "@forge/daemon-client";

export type RpcHandler = (
  method: string,
  params: unknown,
  emit: (event: AgentEvent) => void,
) => Promise<unknown>;

function serializeAgentEvent(requestId: JsonRpcId, event: AgentEvent): string {
  const params: AgentEventNotificationParams = { requestId, event };
  const note: JsonRpcNotification = {
    jsonrpc: "2.0",
    method: AGENT_EVENT_METHOD,
    params,
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
          const req = JSON.parse(line) as JsonRpcRequest;
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
      const result = await this.handler(req.method, req.params, emit);
      respond({ jsonrpc: "2.0", id: requestId, result });
    } catch (error) {
      respond({
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32000, message: String(error) },
      });
    }
  }
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
