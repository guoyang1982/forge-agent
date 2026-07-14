import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type {
  AgentEvent,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@forge/protocol";
import { AGENT_EVENT_METHOD } from "@forge/protocol";

export type RpcHandler = (
  method: string,
  params: unknown,
  emit: (event: AgentEvent) => void,
) => Promise<unknown>;

function serializeAgentEvent(event: AgentEvent): string {
  const note: JsonRpcNotification = {
    jsonrpc: "2.0",
    method: AGENT_EVENT_METHOD,
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
    this.sockets.clear();
    unlinkSyncSafe(this.socketPath);
  }

  private broadcast(event: AgentEvent): void {
    const frame = serializeAgentEvent(event);
    for (const socket of this.sockets) {
      try {
        socket.write(frame);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));

    const emit = (event: AgentEvent) => {
      this.broadcast(event);
    };

    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line) as JsonRpcRequest;
          if (req.id === undefined) continue;

          const respond = (res: JsonRpcResponse) => {
            socket.write(JSON.stringify(res) + "\n");
          };

          try {
            const result = await this.handler(req.method, req.params, emit);
            respond({ jsonrpc: "2.0", id: req.id, result });
          } catch (e) {
            respond({
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32000, message: String(e) },
            });
          }
        } catch {
          /* ignore bad json */
        }
      }
    });
  }
}

export function connectDaemon(
  socketPath: string,
): Promise<{
  onEvent: (handler: (e: AgentEvent) => void) => void;
  onClose: (handler: () => void) => void;
  request: (
    method: string,
    params?: unknown,
    onEvent?: (e: AgentEvent) => void,
  ) => Promise<unknown>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    let buffer = "";
    let nextId = 1;
    let eventHandler: ((e: AgentEvent) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    const pending = new Map<
      JsonRpcId,
      { resolve: (value: unknown) => void; reject: (err: Error) => void }
    >();

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse & JsonRpcNotification;
          if (msg.method === AGENT_EVENT_METHOD && msg.params) {
            eventHandler?.(msg.params as AgentEvent);
            continue;
          }
          if (msg.id === undefined) continue;
          const entry = pending.get(msg.id);
          if (!entry) continue;
          pending.delete(msg.id);
          if (msg.error) {
            const m = msg.error.message ?? "Unknown RPC error";
            entry.reject(
              new Error(m.startsWith("Error:") ? m.slice(6).trim() : m),
            );
          } else {
            entry.resolve(msg.result);
          }
        } catch (e) {
          /* ignore malformed daemon frames */
        }
      }
    };

    const rejectAll = (err: Error) => {
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
    };

    socket.on("connect", () => {
      socket.on("data", onData);
      resolve({
        onEvent: (handler: (e: AgentEvent) => void) => {
          eventHandler = handler;
        },
        onClose: (handler: () => void) => {
          closeHandler = handler;
        },
        request: (method, params, onEvent) => {
          if (onEvent) eventHandler = onEvent;
          const id = nextId++;
          const req: JsonRpcRequest = {
            jsonrpc: "2.0",
            id,
            method,
            params,
          };
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            socket.write(JSON.stringify(req) + "\n");
          });
        },
        close: () => socket.end(),
      });
    });
    socket.on("error", (e) => {
      rejectAll(e);
      reject(e);
    });
    socket.on("close", () => {
      rejectAll(new Error("Daemon connection closed"));
      closeHandler?.();
    });
  });
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
