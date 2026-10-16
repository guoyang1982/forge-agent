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
import {
  CompanyService,
  OrganizationService,
  WorkGates,
  WorkService,
} from "@forge/company-domain";
import { CancelService } from "../services/cancel-service.js";
import { RpcFaultError, TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";
import { createExecutionModule, registerExecutionHandlers } from "./execution-module.js";

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

  it("rejects run.create for a company work item without an accepted plan", async () => {
    const { router, context } = executionRouterFixture();
    const { item } = createCompanyWorkItem(context);

    await expect(
      router.handle(
        "run.create",
        {
          ...singleStepRunSpec(),
          policyContext: { companyWorkItemId: item.id },
        },
        rpcContext(),
      ),
    ).rejects.toMatchObject({
      fault: {
        code: "POLICY_DENIED",
        message: expect.stringMatching(/plan not accepted/),
      },
    });
  });

  it("links a company-gated run to its accepted plan", async () => {
    const { router, context } = executionRouterFixture();
    const { item, employee } = createCompanyWorkItem(context);
    const plan = context.company.gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "Implement the durable run",
      actorId: employee.id,
    });
    context.company.gates.acceptArtifact({
      artifactId: plan.id,
      actorId: employee.id,
    });
    context.store.db
      .prepare(
        `INSERT INTO company_run_links
          (id, company_id, work_item_id, run_id, plan_artifact_id, created_at)
        VALUES (?, ?, ?, '', ?, ?)`,
      )
      .run(
        "run-link-placeholder",
        plan.companyId,
        item.id,
        plan.id,
        context.executionClock.now(),
      );

    const result = await router.handle(
      "run.create",
      {
        ...singleStepRunSpec(),
        policyContext: { companyWorkItemId: item.id },
      },
      rpcContext(),
    );
    const links = context.store.db
      .prepare(
        `SELECT work_item_id AS workItemId, run_id AS runId,
          plan_artifact_id AS planArtifactId
        FROM company_run_links
        WHERE work_item_id = ?`,
      )
      .all(item.id);
    const linkedItem = context.store.db
      .prepare("SELECT state FROM company_work_items WHERE id = ?")
      .get(item.id);

    expect(result).toEqual({ runId: "run-1", state: "running" });
    expect(links).toEqual([
      {
        workItemId: item.id,
        runId: "run-1",
        planArtifactId: plan.id,
      },
    ]);
    expect(linkedItem).toEqual({ state: "in_progress" });
  });

  it("maps unexpected company gate failures to INTERNAL_ERROR", async () => {
    const { router, context } = executionRouterFixture();
    const { item } = createCompanyWorkItem(context);
    context.company.gates.assertImplementationRunAllowed = () => {
      throw new Error("database is locked");
    };

    await expect(
      router.handle(
        "run.create",
        {
          ...singleStepRunSpec(),
          policyContext: { companyWorkItemId: item.id },
        },
        rpcContext(),
      ),
    ).rejects.toMatchObject({
      fault: {
        code: "INTERNAL_ERROR",
        message: "Internal RPC error",
      },
    });
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

  it("cancels only the session bound to the requested run", async () => {
    const { router, context } = executionRouterFixture();
    const runA = context.cancelService.registerRun("session-a");
    const runB = context.cancelService.registerRun("session-b");
    await router.handle(
      "run.create",
      singleStepRunSpec({
        id: "run-a",
        sessionId: "session-a",
      }),
      rpcContext(),
    );
    await router.handle(
      "run.create",
      singleStepRunSpec({
        id: "run-b",
        sessionId: "session-b",
      }),
      rpcContext(),
    );

    await router.handle(
      "run.cancel",
      { runId: "run-a", reason: "user stop" },
      rpcContext(),
    );

    expect(runA.signal.aborted).toBe(true);
    expect(runB.signal.aborted).toBe(false);
    expect(context.executionStore.getRun("run-a")?.state).toBe("cancelled");
    expect(context.executionStore.getRun("run-b")?.state).toBe("running");
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

  it("returns a trace tree for a created run", async () => {
    const { router, context } = executionRouterFixture();
    await router.handle("run.create", singleStepRunSpec(), rpcContext());
    context.eventStore.append({
      eventId: "span-1",
      type: "span.started",
      subject: { kind: "agent_profile", id: "forge-default" },
      correlationId: "corr-1",
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-missing",
      occurredAt: "2026-01-01T00:00:00.000Z",
      data: {
        spanId: "turn-1",
        parentSpanId: "attempt:attempt-missing",
        kind: "turn",
        name: "turn 1",
      },
    });

    const result = await router.handle(
      "trace.get",
      { runId: "run-1" },
      rpcContext(),
    );

    expect(result.runId).toBe("run-1");
    expect(result.tree.kind).toBe("run");
    expect(result.tree.name).toBe("fix it");
  });

  it("resolves the workbench session from run events when the spec has none", async () => {
    const { router, context } = executionRouterFixture();
    await router.handle("run.create", singleStepRunSpec(), rpcContext());
    context.eventStore.append({
      eventId: "agent-session-1",
      type: "agent.event",
      subject: { kind: "agent_profile", id: "forge-default" },
      correlationId: "corr-1",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      data: { sessionId: "sess-from-event" },
    });

    const result = await router.handle(
      "trace.get",
      { runId: "run-1" },
      rpcContext(),
    );

    expect(result.sessionId).toBe("sess-from-event");
  });

  it("recovers interrupted attempts before reclaiming expired workspace leases", async () => {
    const { context } = executionRouterFixture();
    const order: string[] = [];
    context.workspaceLeases = {
      reclaimExpired: () => {
        order.push("reclaim");
        return [];
      },
      reclaimOrphaned: () => {
        order.push("reclaim-orphaned");
        return [];
      },
    } as ForgeDaemonContext["workspaceLeases"];
    context.executionRecovery = {
      recoverOnStartup: async () => {
        order.push("recover");
      },
    } as ForgeDaemonContext["executionRecovery"];
    context.wakeExecutor = () => {
      order.push("wake");
    };

    await createExecutionModule().start?.(context);

    expect(order).toEqual(["recover", "reclaim", "reclaim-orphaned", "wake"]);
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
  const company = {
    companies: new CompanyService(forgeStore.db, clock),
    org: new OrganizationService(forgeStore.db, clock),
    work: new WorkService(forgeStore.db, clock),
    gates: new WorkGates(forgeStore.db, clock),
  };
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
    company,
    automationGovernance: {} as ForgeDaemonContext["automationGovernance"],
    workspaceLeases: { reclaimExpired: () => [] } as ForgeDaemonContext["workspaceLeases"],
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

function createCompanyWorkItem(context: ForgeDaemonContext) {
  const company = context.company.companies.create({ name: "Forge Test Co" });
  const department = context.company.org.createDepartment({
    companyId: company.id,
    name: "Engineering",
  });
  const template = context.company.org.createPositionTemplate({
    companyId: company.id,
    name: "Engineer",
    charter: "Implement accepted plans",
  });
  const position = context.company.org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "Engineer",
  });
  const employee = context.company.org.hire({
    companyId: company.id,
    displayName: "Test Engineer",
    positionId: position.id,
    autonomyLevel: 2,
  });
  const item = context.company.work.createWorkItem({
    companyId: company.id,
    type: "implementation",
    title: "Create a run",
    problem: "No run exists",
    expectedOutcome: "A durable run exists",
    ownerId: employee.id,
  });
  return { item, employee };
}

function singleStepRunSpec(input?: { id?: string; sessionId?: string }): RunSpec {
  const id = input?.id ?? "run-1";
  return {
    id,
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
        input: {
          cwd: "/repo",
          message: "fix it",
          ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
        },
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
    emitAgentEvent: () => {},
  };
}
