import { describe, expect, it } from "vitest";
import { DaemonSessionStore } from "./daemon-session-store.js";

describe("DaemonSessionStore", () => {
  it("creates and loads sessions through typed v2 RPC", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const store = new DaemonSessionStore({
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "session.create") return { sessionId: "session-1" };
        if (method === "session.get") {
          return {
            sessionId: "session-1",
            cwd: "/workspace/a",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            messageCount: 0,
          };
        }
        return { ok: true };
      },
    });

    await expect(store.create("/workspace/a")).resolves.toEqual({ sessionId: "session-1" });
    await expect(store.get("session-1")).resolves.toMatchObject({ cwd: "/workspace/a" });
    await store.appendMessage({
      sessionId: "session-1",
      role: "user",
      content: "hello",
    });

    expect(calls.map((call) => call.method)).toEqual([
      "session.create",
      "session.get",
      "session.appendMessage",
    ]);
  });
});
