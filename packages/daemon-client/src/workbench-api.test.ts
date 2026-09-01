import { describe, expect, it } from "vitest";
import type { DaemonClient, EventSubscription } from "./index.js";
import { waitForWorkbenchRun } from "./workbench-api.js";
import type { EventEnvelope, RunState } from "@forge/protocol";

describe("waitForWorkbenchRun", () => {
  it("returns the terminal result from durable v2 events without an agent.event notification", async () => {
    const client = durableResultClient();

    await expect(waitForWorkbenchRun(client, "run-pong")).resolves.toEqual({
      state: "succeeded",
      sessionId: "session-pong",
      finalText: "pong",
    });
    expect(client.calls).toContainEqual({
      method: "events.read",
      params: {
        cursor: 0,
        limit: 500,
        filter: { runId: "run-pong" },
      },
    });
  });
});

function durableResultClient(): DaemonClient & {
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    onEvent() {},
    onClose() {},
    onNotification: () => () => {},
    subscribe(): EventSubscription {
      return {
        id: "sub-pong",
        cursor: 0,
        close: async () => {},
      };
    },
    request(method: string, params?: unknown) {
      calls.push({ method, params });
      if (method === "run.get") {
        return Promise.resolve({
          runId: "run-pong",
          state: "succeeded" as RunState,
          objective: "reply pong",
          correlationId: "corr-pong",
          steps: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        });
      }
      if (method === "events.read") {
        return Promise.resolve({ events: [durableDoneEvent()] });
      }
      if (method === "events.cursor.ack") {
        return Promise.resolve({ ok: true as const, cursor: 1 });
      }
      return Promise.reject(new Error(`unexpected method: ${method}`));
    },
    close() {},
  };
}

function durableDoneEvent(): EventEnvelope {
  return {
    eventId: "event-done",
    sequence: 3,
    type: "agent.event",
    subject: { kind: "agent_profile", id: "forge-default" },
    correlationId: "corr-pong",
    runId: "run-pong",
    stepId: "reply",
    attemptId: "attempt-pong",
    occurredAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    data: {
      compatibility: true,
      legacyEventType: "done",
      sessionId: "session-pong",
      finalText: "pong",
    },
  };
}
