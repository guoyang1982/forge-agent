import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { rpcFault, type AgentEvent } from "@forge/protocol";
import { DaemonRpcError } from "@forge/daemon-client";
import { connectDaemon, DaemonServer, type RpcHandler } from "./index.js";

const servers: DaemonServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

describe("DaemonServer event isolation", () => {
  it("does not expose one socket's events to another socket", async () => {
    const { socketPath } = await startTestServer();
    const clientA = await connectDaemon(socketPath);
    const clientB = await connectDaemon(socketPath);
    const eventsA: string[] = [];
    const eventsB: string[] = [];
    const unexpectedOnB: AgentEvent[] = [];
    clientB.onEvent((event) => unexpectedOnB.push(event));

    try {
      await Promise.all([
        clientA.request("run", { label: "A", delayMs: 15 }, (event) => {
          if (event.type === "warning") eventsA.push(event.message);
        }),
        clientB.request("run", { label: "B", delayMs: 1 }, (event) => {
          if (event.type === "warning") eventsB.push(event.message);
        }),
      ]);

      expect(eventsA).toEqual(["A:start", "A:done"]);
      expect(eventsB).toEqual(["B:start", "B:done"]);
      expect(unexpectedOnB).toEqual([]);
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  it("routes concurrent requests on one socket to request-specific handlers", async () => {
    const { socketPath, completionOrder } = await startTestServer();
    const client = await connectDaemon(socketPath);
    const eventsA: string[] = [];
    const eventsB: string[] = [];

    try {
      await Promise.all([
        client.request("run", { label: "A", delayMs: 20 }, (event) => {
          if (event.type === "warning") eventsA.push(event.message);
        }),
        client.request("run", { label: "B", delayMs: 1 }, (event) => {
          if (event.type === "warning") eventsB.push(event.message);
        }),
      ]);

      expect(eventsA).toEqual(["A:start", "A:done"]);
      expect(eventsB).toEqual(["B:start", "B:done"]);
      expect(completionOrder).toEqual(["B", "A"]);
    } finally {
      client.close();
    }
  });
});

describe("DaemonServer fault serialization", () => {
  it("preserves a valid fault and correlates it with the v2 request", async () => {
    const socketPath = await startServerWithHandler(async () => {
      throw {
        fault: rpcFault("WORKSPACE_CONFLICT", "workspace is busy", {
          retryable: true,
        }),
      };
    });
    const response = await requestRaw(socketPath, {
      jsonrpc: "2.0",
      id: "jsonrpc-7",
      protocolVersion: 2,
      requestId: "request-7",
      method: "system.ping",
      params: {},
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "jsonrpc-7",
      error: {
        code: -32000,
        message: "workspace is busy",
        data: {
          fault: {
            code: "WORKSPACE_CONFLICT",
            message: "workspace is busy",
            retryable: true,
            correlationId: "request-7",
          },
        },
      },
    });
  });

  it("replaces unknown failures with a safe structured fault", async () => {
    const socketPath = await startServerWithHandler(async () => {
      const failure = new Error("database failed at /Users/private/data.db");
      failure.stack = "secret stack";
      throw failure;
    });
    const client = await connectDaemon(socketPath);

    try {
      const error = await client.request("system.ping", {}).catch((caught) => caught);
      expect(error).toBeInstanceOf(DaemonRpcError);
      expect(error).toMatchObject({
        fault: {
          code: "INTERNAL_ERROR",
          message: "Internal RPC error",
          retryable: false,
          correlationId: expect.any(String),
        },
      });
      expect(JSON.stringify(error.fault)).not.toContain("/Users/private");
      expect(error.fault).not.toHaveProperty("stack");
    } finally {
      client.close();
    }
  });
});

async function startTestServer(): Promise<{
  server: DaemonServer;
  socketPath: string;
  completionOrder: string[];
}> {
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\forge-bus-${randomUUID()}`
      : join("/private/tmp", `forge-bus-${randomUUID()}.sock`);
  const completionOrder: string[] = [];
  const server = new DaemonServer(socketPath, async (_method, params, emit) => {
    const input = params as { label: string; delayMs: number };
    emit({ type: "warning", message: `${input.label}:start` });
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    emit({ type: "warning", message: `${input.label}:done` });
    completionOrder.push(input.label);
    return { label: input.label };
  });
  await server.start();
  servers.push(server);
  return { server, socketPath, completionOrder };
}

async function startServerWithHandler(handler: RpcHandler): Promise<string> {
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\forge-bus-${randomUUID()}`
      : join("/private/tmp", `forge-bus-${randomUUID()}.sock`);
  const server = new DaemonServer(socketPath, handler);
  await server.start();
  servers.push(server);
  return socketPath;
}

function requestRaw(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      socket.end();
      resolve(response);
    });
  });
}
