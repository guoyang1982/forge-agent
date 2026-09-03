import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableExecutor,
  ExecutionRecovery,
  ExecutionStore,
  ManualTestClock,
  StepExecutorRegistry,
} from "@forge/execution";
import { EventStore } from "@forge/event-store";
import { ForgeStore } from "@forge/store";
import { RpcFaultError, TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";
import { registerEventHandlers } from "./event-module.js";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "migrations",
);
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("event module", () => {
  it("reads events strictly after cursor", async () => {
    const { router, eventStore } = eventRouterFixture();
    appendSampleEvents(eventStore);

    const all = await router.handle(
      "events.read",
      { cursor: 0, limit: 50, filter: { runId: "run-1" } },
      rpcContext(),
    );
    const firstSequence = all.events[0]?.sequence ?? 0;
    const result = await router.handle(
      "events.read",
      { cursor: firstSequence, limit: 50, filter: { runId: "run-1" } },
      rpcContext(),
    );

    expect(all.events.length).toBeGreaterThan(1);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.sequence > firstSequence)).toBe(
      true,
    );
    expect(result.events.every((event) => event.runId === "run-1")).toBe(true);
  });

  it("caps read limits at 500 events", async () => {
    const { router, eventStore } = eventRouterFixture();
    for (let index = 0; index < 3; index += 1) {
      appendSampleEvents(eventStore, index);
    }

    const result = await router.handle(
      "events.read",
      { cursor: 0, limit: 10_000, filter: {} },
      rpcContext(),
    );

    expect(result.events.length).toBeLessThanOrEqual(500);
  });

  it("acks a consumer cursor monotonically", async () => {
    const { router, eventStore } = eventRouterFixture();
    appendSampleEvents(eventStore);

    await router.handle(
      "events.cursor.ack",
      { consumerId: "desktop-1", sequence: 2 },
      rpcContext(),
    );
    const advanced = await router.handle(
      "events.cursor.ack",
      { consumerId: "desktop-1", sequence: 1 },
      rpcContext(),
    );

    expect(advanced).toEqual({ ok: true, cursor: 2 });
    expect(eventStore.getCursor("desktop-1")).toBe(2);
  });

  it("rejects invalid read params", async () => {
    const { router } = eventRouterFixture();
    const error = await router
      .handle(
        "events.read",
        { cursor: -1, limit: 10, filter: {} },
        rpcContext(),
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(RpcFaultError);
    expect(error.fault.code).toBe("INVALID_REQUEST");
  });

  it("rejects cursor acknowledgments beyond the stored stream maximum", async () => {
    const { router, eventStore } = eventRouterFixture();
    appendSampleEvents(eventStore);
    const maxSequence = eventStore.getMaxSequence();
    expect(maxSequence).toBeGreaterThan(0);

    await expect(
      router.handle(
        "events.cursor.ack",
        { consumerId: "desktop-1", sequence: maxSequence + 1 },
        rpcContext(),
      ),
    ).rejects.toMatchObject({
      fault: {
        code: "INVALID_REQUEST",
        message: expect.stringMatching(/stream maximum/i),
      },
    });
  });

  it("reports METHOD_NOT_FOUND before handlers are registered", async () => {
    const router = new TypedRouter();
    const error = await router
      .handle(
        "events.read",
        { cursor: 0, limit: 10, filter: {} },
        rpcContext(),
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(RpcFaultError);
    expect(error.fault.code).toBe("METHOD_NOT_FOUND");
  });
});

function eventRouterFixture(): {
  router: TypedRouter;
  eventStore: EventStore;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-event-module-"));
  fixtureRoots.push(root);
  const clock = new ManualTestClock();
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const eventStore = new EventStore(forgeStore.db);
  const executionStore = new ExecutionStore(forgeStore.db);
  const stepExecutors = new StepExecutorRegistry();
  const executor = new DurableExecutor(executionStore, stepExecutors, clock);
  const executionRecovery = new ExecutionRecovery(
    executionStore,
    stepExecutors,
    clock,
  );
  const context = {
    socketPath: join(root, "daemon.sock"),
    store: forgeStore,
    serverVersion: "0.2.0-test",
    build: "event-module-test",
    dataDir: root,
    monorepoRoot: root,
    sessions: {} as ForgeDaemonContext["sessions"],
    automationStore: {} as ForgeDaemonContext["automationStore"],
    channelStore: {} as ForgeDaemonContext["channelStore"],
    cancelService: {} as ForgeDaemonContext["cancelService"],
    firstPartyRuns: {
      start: async () => ({ sessionId: "", finalText: "" }),
      cancel: () => ({ ok: true as const, canceled: false }),
    } as ForgeDaemonContext["firstPartyRuns"],
    schedulerHost: {} as ForgeDaemonContext["schedulerHost"],
    channelGatewayHost: {} as ForgeDaemonContext["channelGatewayHost"],
    executionStore,
    eventStore,
    workspaceGroups: {} as ForgeDaemonContext["workspaceGroups"],
    approvals: {} as ForgeDaemonContext["approvals"],
    budgetLedger: {} as ForgeDaemonContext["budgetLedger"],
    agentProfiles: {} as ForgeDaemonContext["agentProfiles"],
    artifacts: {} as ForgeDaemonContext["artifacts"],
    validations: {} as ForgeDaemonContext["validations"],
    automationGovernance: {} as ForgeDaemonContext["automationGovernance"],
    executor,
    executionRecovery,
    executionClock: clock,
    wakeExecutor: () => {},
    getRuntime: async () => {
      throw new Error("not implemented in fixture");
    },
    reloadRuntime: async () => ({ ok: true, skills: 0, plugins: 0 }),
    shutdownRuntime: async () => {},
  } satisfies ForgeDaemonContext;

  const router = new TypedRouter();
  registerEventHandlers(router, context);
  return { router, eventStore };
}

function appendSampleEvents(eventStore: EventStore, suffix = 0): void {
  const now = `2026-01-01T00:00:0${suffix}.000Z`;
  eventStore.append({
    eventId: `event-created-${suffix}`,
    type: "run.created",
    subject: { kind: "agent_profile", id: "forge-default" },
    correlationId: "corr-1",
    runId: "run-1",
    occurredAt: now,
    data: { objective: "fix it" },
  });
  eventStore.append({
    eventId: `event-started-${suffix}`,
    type: "step.started",
    subject: { kind: "agent_profile", id: "forge-default" },
    correlationId: "corr-1",
    runId: "run-1",
    stepId: "step-1",
    occurredAt: now,
    data: {},
  });
}

function rpcContext() {
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    emitLegacyAgentEvent: () => {},
  };
}
