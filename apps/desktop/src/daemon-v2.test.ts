import { describe, expect, it } from "vitest";
import type { DaemonClient, EventSubscription } from "@forge/daemon-client";
import { REQUIRED_EXECUTION_FEATURE } from "@forge/daemon-client";
import type {
  CapabilityManifest,
  EventEnvelope,
  RunState,
} from "@forge/protocol";
import { RPC_PROTOCOL_VERSION } from "@forge/protocol";
import {
  createWorkbenchDaemonApi,
  simpleRunSpec,
} from "./daemon-v2.js";

describe("createWorkbenchDaemonApi", () => {
  it("refuses startup when required v2 capabilities are absent", async () => {
    const api = createWorkbenchDaemonApi(fakeClient({ features: {} }));
    await expect(api.assertCompatible()).rejects.toThrow(
      REQUIRED_EXECUTION_FEATURE,
    );
  });

  it("creates a typed run without casting unknown", async () => {
    const api = createWorkbenchDaemonApi(fakeClient());
    await expect(
      api.createRun(simpleRunSpec({ cwd: "/repo", message: "fix it" })),
    ).resolves.toEqual({ runId: "r1", state: "running" });
  });

  it("subscribes to run events with a typed filter", async () => {
    const events: EventEnvelope[] = [];
    const api = createWorkbenchDaemonApi(fakeClient());
    const subscription = await api.subscribeRun("r1", (event) => {
      events.push(event);
    });
    await subscription.close();
    expect(events).toEqual([]);
  });

  it("cancels a run through typed RPC", async () => {
    const client = fakeClient();
    const api = createWorkbenchDaemonApi(client);
    await api.cancelRun("r1", "user stop");
    expect(client.calls).toContainEqual({
      method: "run.cancel",
      params: { runId: "r1", reason: "user stop" },
    });
  });
});

function fakeClient(
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
    subscribe(
      _filter,
      _handler,
      _options?,
    ): EventSubscription {
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
