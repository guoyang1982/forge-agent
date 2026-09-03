import { mkdtempSync, rmSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionStore } from "@forge/execution";
import type { EventAppendFn } from "@forge/execution";
import { connectDaemon } from "@forge/bus";
import { EventStore } from "@forge/event-store";
import type { EventEnvelope, RunSpec } from "@forge/protocol";
import { ForgeStore } from "@forge/store";
import { DaemonHost } from "./host/daemon-host.js";
import type { DaemonContext } from "./host/types.js";
import { createEventModule, type EventModuleContext } from "./modules/event-module.js";
import {
  createExecutionModule,
  type ExecutionModuleContext,
} from "./modules/execution-module.js";
import { createProductionEventSink } from "./services/core-event-sink.js";
import { createProductionExecutionComposition } from "./services/production-execution-composition.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production v2 events", () => {
  it("persists and broadcasts the same ordered envelopes for a daemon run.create", async () => {
    const fx = await productionDaemonFixture();
    const live: EventEnvelope[] = [];
    const removeListener = fx.client.onNotification((event) => live.push(event));
    try {
      const created = await fx.client.request("run.create", fx.spec);
      await waitFor(() =>
        fx.events.readAfter({ sequence: 0, filter: { runId: created.runId }, limit: 20 })
          .some((event) => event.type === "run.succeeded"),
      );
      await waitFor(() => live.some((event) => event.type === "run.succeeded"));

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
      expect(recorded.filter((event) => event.type === "agent.event")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ subject: fx.spec.actingSubject }),
        ]),
      );
      expect(
        fx.events
          .readAfter({ sequence: 2, filter: { runId: created.runId }, limit: 20 })
          .map((event) => event.eventId),
      ).toEqual(recorded.slice(2).map((event) => event.eventId));
      expect(fx.executionStore.getRun(created.runId)?.state).toBe("succeeded");
      expect(recorded[4]).toMatchObject({
        data: {
          compatibility: true,
          legacyEventType: "done",
          sessionId: "session-pong",
          finalText: "pong",
        },
      });
      expect(live).toEqual(recorded);
    } finally {
      removeListener();
      fx.client.close();
      await fx.host.stop();
    }
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
      getActingSubject: () => ({ kind: "agent", id: "agent-pong" }),
      broadcast: (event) => broadcasted.push(event),
    });
    vi.spyOn(events, "append").mockImplementation(() => {
      throw new Error("database unavailable");
    });

    expect(() =>
      sink.emitAgentEvent(
        { type: "done", sessionId: "session-pong", finalText: "pong" },
        { runId: "run-pong", stepId: "reply", attemptId: "attempt-pong" },
      ),
    ).toThrow("database unavailable");
    expect(broadcasted).toEqual([]);
  });

  it("does not broadcast events rolled back after a later transaction failure", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-production-event-rollback-"));
    fixtureRoots.push(root);
    const forgeStore = ForgeStore.open({
      dbPath: join(root, "data.db"),
      migrationsDir,
      owner: "test",
    });
    const events = new EventStore(forgeStore.db);
    const broadcasted: EventEnvelope[] = [];
    let store!: ExecutionStore;
    const sink = createProductionEventSink({
      events,
      getCorrelationId: (runId) => store.getRun(runId)?.correlationId,
      getActingSubject: (runId) => store.getRun(runId)?.spec.actingSubject,
      broadcast: (event) => broadcasted.push(event),
    });
    const appendEvent: EventAppendFn = (db, event) => {
      const stored = sink.appendInTransaction(db, event);
      if (event.type === "run.succeeded") {
        throw new Error("force rollback after step.succeeded");
      }
      return stored;
    };
    store = new ExecutionStore(forgeStore.db, appendEvent, {
      onCommitted: sink.flush,
      onRolledBack: sink.discard,
    });
    const now = "2026-01-01T00:00:00.000Z";
    store.createRun(pongRunSpec(), now);
    const attempt = store.claimNextStep("run-pong", "worker-pong", now)!;
    const committed = events.readAfter({ sequence: 0, filter: {}, limit: 20 });

    expect(() =>
      store.finishAttempt(
        attempt.id,
        { state: "succeeded", outputRef: "artifact:pong" },
        now,
      ),
    ).toThrow("force rollback after step.succeeded");
    expect(events.readAfter({ sequence: 0, filter: {}, limit: 20 })).toEqual(committed);
    expect(broadcasted).toEqual(committed);
  });

  it("keeps run.create successful when post-commit delivery fails", async () => {
    const failures: EventEnvelope[] = [];
    const fx = await productionDaemonFixture({
      autoExecute: false,
      onDeliveryFailure: (failure) => {
        failures.push(failure.event);
      },
    });
    const peer = netConnect(fx.socketPath);
    await new Promise<void>((resolve, reject) => {
      peer.once("connect", resolve);
      peer.once("error", reject);
    });
    try {
      peer.destroy();
      await expect(fx.client.request("run.create", fx.spec)).resolves.toEqual({
        runId: "run-pong",
        state: "running",
      });
      expect(fx.executionStore.getRun("run-pong")?.state).toBe("running");
      expect(fx.wakeCount()).toBe(1);
      await waitFor(() => failures.length === 1);
      expect(failures).toHaveLength(1);
      expect(failures).toMatchObject([{ type: "run.created", runId: "run-pong" }]);
    } finally {
      peer.destroy();
      fx.client.close();
      await fx.host.stop();
    }
  });
});

interface ProductionDaemonTestContext
  extends DaemonContext,
    ExecutionModuleContext,
    EventModuleContext {}

async function productionDaemonFixture(
  options: {
    autoExecute?: boolean;
    onDeliveryFailure?: (failure: { event: EventEnvelope; error: Error }) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "forge-production-events-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const clock = { now: () => "2026-01-01T00:00:00.000Z", nowMs: () => 0 };
  let wakeCount = 0;
  let host: DaemonHost<ProductionDaemonTestContext> | undefined;
  const productionExecution = createProductionExecutionComposition({
    db: forgeStore.db,
    clock,
    broadcast: (event) => {
      if (!host) throw new Error("host is not ready for CoreEvent broadcast");
      host.broadcastCoreEvent(event);
    },
    onDeliveryFailure: options.onDeliveryFailure,
    run: async (_request, emit) => {
      emit({ type: "status", phase: "model", message: "replying" });
      emit({ type: "text_delta", sessionId: "session-pong", delta: "pong" });
      emit({ type: "done", sessionId: "session-pong", finalText: "pong" });
      return { sessionId: "session-pong", finalText: "pong" };
    },
  });
  const context: ProductionDaemonTestContext = {
    socketPath: join(root, "daemon.sock"),
    store: forgeStore,
    serverVersion: "0.2.0-test",
    build: "production-composition-test",
    eventTypes: ["agent.event", "run.created", "run.succeeded"],
    executionStore: productionExecution.executionStore,
    eventStore: productionExecution.eventStore,
    executionClock: clock,
    executor: productionExecution.executor,
    executionRecovery: productionExecution.executionRecovery,
    wakeExecutor: () => {
      wakeCount += 1;
      if (options.autoExecute ?? true) {
        void productionExecution.executor.tick();
      }
    },
  };
  host = new DaemonHost(
    [
      createExecutionModule<ProductionDaemonTestContext>(),
      createEventModule<ProductionDaemonTestContext>(),
    ],
    context,
  );
  productionExecution.observeDeliveryFailures(host);
  await host.start();
  const client = await connectDaemon(context.socketPath);

  return {
    host,
    client,
    socketPath: context.socketPath,
    events: productionExecution.eventStore,
    executionStore: productionExecution.executionStore,
    wakeCount: () => wakeCount,
    spec: pongRunSpec(),
  };
}

function pongRunSpec(): RunSpec {
  return {
    id: "run-pong",
    requestedBy: { kind: "human", id: "user-1" },
    actingSubject: { kind: "agent", id: "agent-pong" },
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
