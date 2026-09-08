import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_METHODS } from "@forge/protocol";
import { DaemonServer } from "@forge/bus";
import { ForgeBridge } from "./forge-bridge.js";

const servers: DaemonServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

describe("ForgeBridge", () => {
  it("keeps concurrent run events attached to the originating run", async () => {
    const completionOrder: string[] = [];
    const { socketPath } = await startV2WorkbenchServer(completionOrder);
    const bridge = new ForgeBridge(socketPath);
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];

    try {
      const [first, second] = await Promise.all([
        bridge.run(
          { cwd: "/workspace", message: "first" },
          (event) => {
            if (event.type === "warning") firstEvents.push(event.message);
          },
        ),
        bridge.run(
          { cwd: "/workspace", message: "second" },
          (event) => {
            if (event.type === "warning") secondEvents.push(event.message);
          },
        ),
      ]);
      expect(first.sessionId).toBe("session-first");
      expect(second.sessionId).toBe("session-second");
      expect(firstEvents).toEqual(["first:start", "first:done"]);
      expect(secondEvents).toEqual(["second:start", "second:done"]);
      expect(completionOrder).toEqual(["second", "first"]);
    } finally {
      bridge.close();
    }
  });
});

async function startV2WorkbenchServer(completionOrder: string[]): Promise<{
  socketPath: string;
}> {
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\forge-gateway-${randomUUID()}`
      : join("/private/tmp", `forge-gateway-${randomUUID()}.sock`);
  const server = new DaemonServer(socketPath, async (method, params, emit) => {
    if (method !== DAEMON_METHODS.RUN) {
      throw new Error(`unsupported mock method: ${method}`);
    }
    const request = params as { message: string };
    const delay = request.message === "first" ? 20 : 1;
    emit({ type: "warning", message: `${request.message}:start` });
    await new Promise((resolve) => setTimeout(resolve, delay));
    emit({ type: "warning", message: `${request.message}:done` });
    completionOrder.push(request.message);
    return {
      sessionId: `session-${request.message}`,
      finalText: request.message,
    };
  });

  await server.start();
  servers.push(server);
  return { socketPath };
}
