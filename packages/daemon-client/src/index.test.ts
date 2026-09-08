import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_EVENT_METHOD,
  CORE_EVENT_METHOD,
  type EventEnvelope,
  type RpcResult,
} from "@forge/protocol";
import { connectDaemon, DaemonRpcError } from "./index.js";

const servers: Server[] = [];
const socketPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  for (const socketPath of socketPaths.splice(0)) {
    if (process.platform !== "win32" && existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  }
});

describe("connectDaemon", () => {
  it("keeps request event handlers scoped when responses arrive out of order", async () => {
    const socketPath = socketName();
    socketPaths.push(socketPath);
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line) as { id: number; params: { label: string } };
          const delay = request.params.label === "first" ? 20 : 1;
          setTimeout(() => {
            socket.write(
              JSON.stringify({
                jsonrpc: "2.0",
                method: AGENT_EVENT_METHOD,
                params: {
                  requestId: request.id,
                  event: { type: "warning", message: request.params.label },
                },
              }) + "\n",
            );
            socket.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: request.params.label,
              }) + "\n",
            );
          }, delay);
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const client = await connectDaemon(socketPath);
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    try {
      const [first, second] = await Promise.all([
        client.request("run", { label: "first" }, (event) => {
          if (event.type === "warning") firstEvents.push(event.message);
        }),
        client.request("run", { label: "second" }, (event) => {
          if (event.type === "warning") secondEvents.push(event.message);
        }),
      ]);

      expect(first).toBe("first");
      expect(second).toBe("second");
      expect(firstEvents).toEqual(["first"]);
      expect(secondEvents).toEqual(["second"]);
    } finally {
      client.close();
    }
  });

  it("rejects a timed out request and ignores its late response and notification", async () => {
    let requestCount = 0;
    const socketPath = await startServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line) as {
            id?: number;
            method: string;
            requestId?: string;
          };
          if (request.method === "$/cancelRequest" || request.id === undefined) {
            continue;
          }
          requestCount += 1;
          if (requestCount === 1) {
            const event: EventEnvelope<{ late: true }> = {
              eventId: "event-late",
              sequence: 1,
              type: "request.late",
              subject: { kind: "request", id: request.requestId ?? "missing" },
              correlationId: request.requestId ?? "missing",
              occurredAt: "2026-08-31T00:00:00.000Z",
              schemaVersion: 1,
              data: { late: true },
            };
            setTimeout(() => {
              socket.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: CORE_EVENT_METHOD,
                  params: event,
                }) + "\n",
              );
              socket.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { ok: true, version: "late", build: "late" },
                }) + "\n",
              );
            }, 30);
            continue;
          }
          socket.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: { ok: true, version: "2.0.0", build: "test" },
            }) + "\n",
          );
        }
      });
    });

    const client = await connectDaemon(socketPath);
    const notifications: EventEnvelope[] = [];
    try {
      await expect(
        client.request("system.ping", {}, {
          timeoutMs: 5,
          onNotification: (event) => notifications.push(event),
        }),
      ).rejects.toMatchObject({
        fault: { code: "CORE_TIMEOUT", retryable: true },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const result: RpcResult<"system.ping"> = await client.request(
        "system.ping",
        {},
        { timeoutMs: 100 },
      );
      expect(result).toEqual({ ok: true, version: "2.0.0", build: "test" });
      expect(notifications).toEqual([]);
    } finally {
      client.close();
    }
  });

  it("sends a cancellation notification when AbortSignal fires", async () => {
    let resolveFrames: ((frames: Array<Record<string, unknown>>) => void) | undefined;
    const receivedFrames = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveFrames = resolve;
    });
    const socketPath = await startServer((socket) => {
      let buffer = "";
      const frames: Array<Record<string, unknown>> = [];
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          frames.push(JSON.parse(line) as Record<string, unknown>);
          if (frames.length === 2) resolveFrames?.(frames);
        }
      });
    });

    const client = await connectDaemon(socketPath);
    const controller = new AbortController();
    try {
      const pending = client.request("system.ping", {}, {
        signal: controller.signal,
      });
      controller.abort();

      await expect(withTestDeadline(pending, "abort did not reject")).rejects.toMatchObject({
        fault: { code: "CORE_CANCELLED", retryable: false },
      });
      const [request, cancel] = await withTestDeadline(
        receivedFrames,
        "cancel notification was not sent",
      );
      expect(request).toMatchObject({
        jsonrpc: "2.0",
        method: "system.ping",
        protocolVersion: 2,
        requestId: expect.any(String),
      });
      expect(cancel).toEqual({
        jsonrpc: "2.0",
        method: "$/cancelRequest",
        params: { id: request.id, requestId: request.requestId },
      });
    } finally {
      client.close();
    }
  });

  it("preserves a valid structured RPC fault", async () => {
    const fault = {
      code: "WORKSPACE_CONFLICT" as const,
      message: "workspace is busy",
      retryable: true,
      correlationId: "corr-1",
      detailsRef: "details/1",
    };
    const socketPath = await startServer((socket) => {
      replyToFirstRequest(socket, (id) => ({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: "request failed",
          data: { fault },
        },
      }));
    });

    const client = await connectDaemon(socketPath);
    try {
      const error = await client.request("system.ping", {}).catch((caught) => caught);
      expect(error).toBeInstanceOf(DaemonRpcError);
      expect(error).toMatchObject({ fault });
    } finally {
      client.close();
    }
  });

  it("converts malformed RPC error data into a safe internal fault", async () => {
    const socketPath = await startServer((socket) => {
      replyToFirstRequest(socket, (id) => ({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: "Error: safe legacy message",
          data: {
            fault: {
              code: "ROOT_SHELL_ESCAPE",
              message: "do not expose",
              retryable: true,
              stack: "secret stack",
            },
          },
        },
      }));
    });

    const client = await connectDaemon(socketPath);
    try {
      const error = await client.request("system.ping", {}).catch((caught) => caught);
      expect(error).toBeInstanceOf(DaemonRpcError);
      expect(error).toMatchObject({
        fault: {
          code: "INTERNAL_ERROR",
          message: "safe legacy message",
          retryable: false,
        },
      });
      expect(error.fault).not.toHaveProperty("stack");
      expect(error.fault).not.toHaveProperty("detailsRef");
    } finally {
      client.close();
    }
  });
});

async function startServer(
  onConnection: (socket: Socket) => void,
): Promise<string> {
  const socketPath = socketName();
  socketPaths.push(socketPath);
  const server = createServer(onConnection);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

function replyToFirstRequest(
  socket: Socket,
  response: (id: number) => Record<string, unknown>,
): void {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as { id?: number };
      if (request.id === undefined) continue;
      socket.write(JSON.stringify(response(request.id)) + "\n");
      return;
    }
  });
}

function withTestDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), 250);
    }),
  ]);
}

function socketName(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\forge-client-${randomUUID()}`
    : join("/private/tmp", `forge-client-${randomUUID()}.sock`);
}
