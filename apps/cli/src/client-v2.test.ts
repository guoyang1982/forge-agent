import { describe, expect, it } from "vitest";
import type { DaemonClient, EventSubscription } from "@forge/daemon-client";
import { REQUIRED_EXECUTION_FEATURE } from "@forge/daemon-client";
import type { CapabilityManifest, RunState } from "@forge/protocol";
import { RPC_PROTOCOL_VERSION } from "@forge/protocol";
import { createCliDaemonApi } from "./client-v2.js";

describe("createCliDaemonApi", () => {
  it("returns a typed simple run result without casting unknown", async () => {
    const api = createCliDaemonApi(fakeClient());
    await expect(api.startSimpleRun(runInput())).resolves.toMatchObject({
      runId: "r1",
    });
  });

  it("refuses startup when required v2 capabilities are absent", async () => {
    const api = createCliDaemonApi(fakeClient({ features: {} }));
    await expect(api.assertCompatible()).rejects.toThrow(
      REQUIRED_EXECUTION_FEATURE,
    );
  });
});

function runInput() {
  return {
    cwd: "/repo",
    message: "fix it",
  };
}

function fakeClient(
  capabilities: Partial<CapabilityManifest> = {},
): DaemonClient {
  const manifest: CapabilityManifest = {
    protocolVersion: RPC_PROTOCOL_VERSION,
    serverVersion: "0.2.0-test",
    methods: ["system.capabilities", "run.create", "run.cancel", "run.get", "events.read"],
    eventTypes: ["run.succeeded"],
    features: {
      [REQUIRED_EXECUTION_FEATURE]: { version: 1, enabled: true },
    },
    ...capabilities,
  };

  return {
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
      if (method === "system.capabilities") {
        return Promise.resolve(manifest);
      }
      if (method === "run.create") {
        return Promise.resolve({ runId: "r1", state: "running" as RunState });
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
      if (method === "events.read") {
        return Promise.resolve({
          events: [
            {
              sequence: 1,
              type: "run.succeeded",
              eventId: "event-1",
              runId: "r1",
              data: {
                compatibility: true,
                legacyEventType: "done",
                sessionId: "session-1",
                finalText: "ok",
              },
            },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected method: ${method}`));
    },
    close() {},
  };
}
