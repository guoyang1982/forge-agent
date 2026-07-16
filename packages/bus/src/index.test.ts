import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@forge/protocol";
import { connectDaemon, DaemonServer } from "./index.js";

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
