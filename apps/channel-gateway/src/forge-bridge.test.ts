import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RPC_PROTOCOL_VERSION,
  type EventEnvelope,
  type RunSpec,
  type RunState,
} from "@forge/protocol";
import { DaemonServer } from "@forge/bus";
import { REQUIRED_EXECUTION_FEATURE } from "@forge/daemon-client";
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

type MockRun = {
  state: RunState;
  message: string;
  sessionId: string;
  finalText: string;
};

async function startV2WorkbenchServer(completionOrder: string[]): Promise<{
  socketPath: string;
}> {
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\forge-gateway-${randomUUID()}`
      : join("/private/tmp", `forge-gateway-${randomUUID()}.sock`);
  const runs = new Map<string, MockRun>();
  const events: EventEnvelope[] = [];
  let sequence = 0;

  const appendEvent = (event: Omit<EventEnvelope, "sequence">) => {
    sequence += 1;
    const envelope = { ...event, sequence } as EventEnvelope;
    events.push(envelope);
    return envelope;
  };

  const server = new DaemonServer(socketPath, async (method, params) => {
    if (method === "system.capabilities") {
      return {
        protocolVersion: RPC_PROTOCOL_VERSION,
        features: {
          [REQUIRED_EXECUTION_FEATURE]: { version: 1, enabled: true },
        },
      };
    }

    if (method === "run.create") {
      const spec = params as RunSpec;
      const message = readRunMessage(spec);
      const runId = spec.id;
      runs.set(runId, {
        state: "running",
        message,
        sessionId: `session-${message}`,
        finalText: message,
      });
      void executeMockRun(server, runId, message, {
        appendEvent,
        completionOrder,
        runs,
      });
      return { runId, state: "running" as const };
    }

    if (method === "run.get") {
      const { runId } = params as { runId: string };
      const run = runs.get(runId);
      return {
        runId,
        state: run?.state ?? ("failed" as const),
        objective: run?.message ?? "",
        correlationId: runId,
        steps: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      };
    }

    if (method === "events.read") {
      const { cursor, limit, filter } = params as {
        cursor: number;
        limit: number;
        filter?: { runId?: string };
      };
      const page = events
        .filter(
          (event) =>
            event.sequence > cursor &&
            (!filter?.runId || event.runId === filter.runId),
        )
        .slice(0, limit);
      return { events: page };
    }

    if (method === "events.cursor.ack") {
      const { sequence: ackSequence } = params as { sequence: number };
      return { ok: true as const, cursor: ackSequence };
    }

    throw new Error(`unsupported mock method: ${method}`);
  });

  await server.start();
  servers.push(server);
  return { socketPath };
}

async function executeMockRun(
  server: DaemonServer,
  runId: string,
  message: string,
  deps: {
    appendEvent: (event: Omit<EventEnvelope, "sequence">) => EventEnvelope;
    completionOrder: string[];
    runs: Map<string, MockRun>;
  },
): Promise<void> {
  const delay = message === "first" ? 20 : 1;
  const base = {
    subject: { kind: "agent_profile" as const, id: "forge-default" },
    correlationId: runId,
    runId,
    stepId: "agent",
    attemptId: `${runId}:attempt:1`,
    occurredAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1 as const,
  };

  for (const suffix of ["start", "done"] as const) {
    const envelope = deps.appendEvent({
      eventId: `${runId}:${suffix}`,
      type: "agent.event",
      ...base,
      data: {
        compatibility: true,
        legacyEventType: "warning",
        message: `${message}:${suffix}`,
      },
    });
    server.broadcastCoreEvent(envelope);
    if (suffix === "start") {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  deps.appendEvent({
    eventId: `${runId}:terminal`,
    type: "agent.event",
    ...base,
    data: {
      compatibility: true,
      legacyEventType: "done",
      sessionId: `session-${message}`,
      finalText: message,
    },
  });
  const terminal = deps.appendEvent({
    eventId: `${runId}:succeeded`,
    type: "run.succeeded",
    ...base,
    data: {},
  });
  server.broadcastCoreEvent(terminal);

  const run = deps.runs.get(runId);
  if (run) {
    run.state = "succeeded";
  }
  deps.completionOrder.push(message);
}

function readRunMessage(spec: RunSpec): string {
  const step = spec.steps[0];
  const input =
    step?.input && typeof step.input === "object" && !Array.isArray(step.input)
      ? (step.input as Record<string, unknown>)
      : undefined;
  return typeof input?.message === "string" ? input.message : "unknown";
}
