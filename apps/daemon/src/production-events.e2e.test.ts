import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DurableExecutor,
  ExecutionStore,
  LegacyForgeStepExecutor,
  StepExecutorRegistry,
} from "@forge/execution";
import { EventStore } from "@forge/event-store";
import type { EventEnvelope, RunSpec } from "@forge/protocol";
import { ForgeStore } from "@forge/store";
import { TypedRouter } from "./host/router.js";
import type { ForgeDaemonContext } from "./modules/context.js";
import { createExecutionModule } from "./modules/execution-module.js";
import { createProductionEventSink } from "./services/core-event-sink.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production v2 events", () => {
  it("persists and broadcasts the same ordered envelopes for a daemon run.create", async () => {
    const fx = productionRunFixture();

    const created = await fx.router.handle("run.create", fx.spec, rpcContext());
    await fx.executor.tick();

    const recorded = fx.events.readAfter({
      sequence: 0,
      filter: { runId: created.runId },
      limit: 20,
    });
    expect(recorded.map((event) => event.type)).toEqual([
      "run.created",
      "step.started",
      "agent.event",
      "agent.event",
      "agent.event",
      "step.succeeded",
      "run.succeeded",
    ]);
    expect(recorded.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(
      fx.events
        .readAfter({ sequence: 2, filter: { runId: created.runId }, limit: 20 })
        .map((event) => event.eventId),
    ).toEqual(recorded.slice(2).map((event) => event.eventId));
    expect(fx.store.getRun(created.runId)?.state).toBe("succeeded");
    expect(recorded[4]).toMatchObject({
      data: {
        compatibility: true,
        legacyEventType: "done",
        sessionId: "session-pong",
        finalText: "pong",
      },
    });
    expect(fx.broadcasted).toEqual(recorded);
  });

  it("does not broadcast a legacy event when persistence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-production-event-failure-"));
    fixtureRoots.push(root);
    const forgeStore = ForgeStore.open({
      dbPath: join(root, "data.db"),
      migrationsDir,
      owner: "test",
    });
    const events = new EventStore(forgeStore.db);
    const broadcasted: EventEnvelope[] = [];
    const sink = createProductionEventSink({
      events,
      getCorrelationId: () => "corr-pong",
      broadcast: (event) => broadcasted.push(event),
    });
    vi.spyOn(events, "append").mockImplementation(() => {
      throw new Error("database unavailable");
    });

    expect(() =>
      sink.emitLegacyAgentEvent(
        { type: "done", sessionId: "session-pong", finalText: "pong" },
        { runId: "run-pong", stepId: "reply", attemptId: "attempt-pong" },
      ),
    ).toThrow("database unavailable");
    expect(broadcasted).toEqual([]);
  });
});

function productionRunFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-production-events-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const events = new EventStore(forgeStore.db);
  const broadcasted: EventEnvelope[] = [];
  const store = new ExecutionStore(forgeStore.db);
  const sink = createProductionEventSink({
    events,
    getCorrelationId: (runId) => store.getRun(runId)?.correlationId,
    broadcast: (event) => broadcasted.push(event),
  });
  const persistedStore = new ExecutionStore(forgeStore.db, sink.appendInTransaction);
  const executors = new StepExecutorRegistry();
  executors.register(
    new LegacyForgeStepExecutor({
      emitLegacyAgentEvent: sink.emitLegacyAgentEvent,
      run: async (_request, emit) => {
        emit({ type: "status", phase: "model", message: "replying" });
        emit({ type: "text_delta", sessionId: "session-pong", delta: "pong" });
        emit({ type: "done", sessionId: "session-pong", finalText: "pong" });
        return { sessionId: "session-pong", finalText: "pong" };
      },
    }),
  );
  const clock = { now: () => "2026-01-01T00:00:00.000Z", nowMs: () => 0 };
  const executor = new DurableExecutor(persistedStore, executors, clock);
  const context = {
    executionStore: persistedStore,
    executionClock: clock,
    wakeExecutor: () => undefined,
  } as ForgeDaemonContext;
  const router = new TypedRouter();
  createExecutionModule().register(router, context);

  return {
    router,
    executor,
    events,
    store: persistedStore,
    broadcasted,
    spec: pongRunSpec(),
  };
}

function pongRunSpec(): RunSpec {
  return {
    id: "run-pong",
    requestedBy: { kind: "human", id: "user-1" },
    actingSubject: { kind: "agent_profile", id: "forge-default" },
    objective: "reply pong",
    correlationId: "corr-pong",
    policyContext: {},
    steps: [
      {
        id: "reply",
        kind: "forge.agent",
        dependsOn: [],
        input: { cwd: "/repo", message: "reply pong" },
        retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
        timeoutMs: 60_000,
      },
    ],
  };
}

function rpcContext() {
  return {
    requestId: "request-pong",
    correlationId: "corr-pong",
    emitLegacyAgentEvent: () => {},
  };
}
