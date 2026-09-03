import { describe, expect, it } from "vitest";
import type { DaemonClient, EventSubscription } from "./index.js";
import {
  REQUIRED_EXECUTION_FEATURE,
  createWorkbenchDaemonApi,
  simpleRunSpec,
  waitForWorkbenchRun,
} from "./workbench-api.js";
import type {
  CapabilityManifest,
  EventEnvelope,
  RunState,
} from "@forge/protocol";
import { RPC_PROTOCOL_VERSION } from "@forge/protocol";

describe("createWorkbenchDaemonApi", () => {
  it("refuses startup when required v2 capabilities are absent", async () => {
    const api = createWorkbenchDaemonApi(kernelClient({ features: {} }));
    await expect(api.assertCompatible()).rejects.toThrow(
      REQUIRED_EXECUTION_FEATURE,
    );
  });

  it("creates a typed run without casting unknown", async () => {
    const api = createWorkbenchDaemonApi(kernelClient());
    await expect(
      api.createRun(simpleRunSpec({ cwd: "/repo", message: "fix it" })),
    ).resolves.toEqual({ runId: "r1", state: "running" });
  });

  it("subscribes to run events with a typed filter", async () => {
    const events: EventEnvelope[] = [];
    const api = createWorkbenchDaemonApi(kernelClient());
    const subscription = await api.subscribeRun("r1", (event) => {
      events.push(event);
    });
    await subscription.close();
    expect(events).toEqual([]);
  });

  it("cancels a run through typed RPC", async () => {
    const client = kernelClient();
    const api = createWorkbenchDaemonApi(client);
    await api.cancelRun("r1", "user stop");
    expect(client.calls).toContainEqual({
      method: "run.cancel",
      params: { runId: "r1", reason: "user stop" },
    });
  });
});

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

function kernelClient(
  capabilities: Partial<CapabilityManifest> = {},
): DaemonClient & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const manifest: CapabilityManifest = {
    protocolVersion: RPC_PROTOCOL_VERSION,
    serverVersion: "0.2.0-test",
    methods: ["system.capabilities", "run.create", "run.cancel", "run.get"],
    eventTypes: ["run.succeeded"],
    features: {
      [REQUIRED_EXECUTION_FEATURE]: { version: 1, enabled: true },
    },
    ...capabilities,
  };

  return {
    calls,
    onEvent() {},
    onClose() {},
    onNotification: () => () => {},
    subscribe(): EventSubscription {
      return {
        id: "sub-1",
        cursor: 0,
        close: async () => {},
      };
    },
    request(method: string, params?: unknown) {
      calls.push({ method, params });
      if (method === "system.capabilities") {
        return Promise.resolve(manifest);
      }
      if (method === "run.create") {
        return Promise.resolve({ runId: "r1", state: "running" as RunState });
      }
      if (method === "run.cancel") {
        return Promise.resolve({
          ok: true as const,
          runId: String((params as { runId?: string }).runId ?? "r1"),
          state: "cancelled" as RunState,
        });
      }
      if (method === "run.get") {
        return Promise.resolve({
          runId: "r1",
          state: "succeeded" as RunState,
          objective: "fix it",
          correlationId: "corr-1",
          steps: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      return Promise.reject(new Error(`unexpected method: ${method}`));
    },
    close() {},
  };
}

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
