import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunSpec } from "@forge/protocol";
import {
  DurableExecutor,
  ExecutionRecovery,
  ExecutionStore,
  StepExecutorRegistry,
  ManualTestClock,
} from "@forge/execution";
import { EventStore } from "@forge/event-store";
import { ForgeStore } from "@forge/store";
import { CancelService } from "../services/cancel-service.js";
import { RpcFaultError, TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";
import { registerExecutionHandlers } from "./execution-module.js";

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

describe("execution module", () => {
  it("creates a run and returns its durable id", async () => {
    const { router, context } = executionRouterFixture();
    const spec = singleStepRunSpec();

    const result = await router.handle("run.create", spec, rpcContext());

    expect(result).toEqual({ runId: "run-1", state: "running" });
    expect(context.executionStore.getRun("run-1")?.state).toBe("running");
  });

  it("returns run details including step states", async () => {
    const { router } = executionRouterFixture();
    const spec = singleStepRunSpec();
    await router.handle("run.create", spec, rpcContext());

    const result = await router.handle(
      "run.get",
      { runId: "run-1" },
      rpcContext(),
    );

    expect(result).toMatchObject({
      runId: "run-1",
      state: "running",
      objective: "fix it",
      steps: [{ id: "step-1", kind: "forge.agent", state: "runnable" }],
    });
  });

  it("cancels an active run", async () => {
    const { router } = executionRouterFixture();
    await router.handle("run.create", singleStepRunSpec(), rpcContext());

    const result = await router.handle(
      "run.cancel",
      { runId: "run-1", reason: "user stop" },
      rpcContext(),
    );

    expect(result).toEqual({ ok: true, runId: "run-1", state: "cancelled" });
  });

  it("rejects invalid run specs at the module boundary", async () => {
    const { router } = executionRouterFixture();
    const error = await router
      .handle(
        "run.create",
        { ...singleStepRunSpec(), id: "" } as RunSpec,
        rpcContext(),
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(RpcFaultError);
    expect(error).toMatchObject({
      fault: { code: "INVALID_REQUEST", message: "run spec id is required" },
    });
  });

  it("reports METHOD_NOT_FOUND before handlers are registered", async () => {
    const router = new TypedRouter();
    const error = await router
      .handle("run.create", singleStepRunSpec(), rpcContext())
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(RpcFaultError);
    expect(error.fault.code).toBe("METHOD_NOT_FOUND");
  });
});

function executionRouterFixture(): {
  router: TypedRouter;
  context: ForgeDaemonContext;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-execution-module-"));
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
  let tickScheduled = false;
  const context = {
    socketPath: join(root, "daemon.sock"),
    store: forgeStore,
    serverVersion: "0.2.0-test",
    build: "execution-module-test",
    dataDir: root,
    monorepoRoot: root,
    sessions: {} as ForgeDaemonContext["sessions"],
    automationStore: {} as ForgeDaemonContext["automationStore"],
    channelStore: {} as ForgeDaemonContext["channelStore"],
    cancelService: new CancelService(),
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
    wakeExecutor: () => {
      tickScheduled = true;
    },
    getRuntime: async () => {
      throw new Error("not implemented in fixture");
    },
    reloadRuntime: async () => ({ ok: true, skills: 0, plugins: 0 }),
    shutdownRuntime: async () => {},
  } satisfies ForgeDaemonContext;

  const router = new TypedRouter();
  registerExecutionHandlers(router, context);
  expect(tickScheduled).toBe(false);
  return { router, context };
}

function singleStepRunSpec(): RunSpec {
  return {
    id: "run-1",
    requestedBy: { kind: "human", id: "user-1" },
    actingSubject: { kind: "agent_profile", id: "forge-default" },
    objective: "fix it",
    correlationId: "corr-1",
    policyContext: {},
    steps: [
      {
        id: "step-1",
        kind: "forge.agent",
        dependsOn: [],
        input: { cwd: "/repo", message: "fix it" },
        retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
        timeoutMs: 60_000,
      },
    ],
  };
}

function rpcContext() {
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    emitLegacyAgentEvent: () => {},
  };
}
