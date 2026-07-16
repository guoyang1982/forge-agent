import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_EVENT_METHOD } from "@forge/protocol";
import { connectDaemon } from "./index.js";

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
});

function socketName(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\forge-client-${randomUUID()}`
    : join("/private/tmp", `forge-client-${randomUUID()}.sock`);
}
