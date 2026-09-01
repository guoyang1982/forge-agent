import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "@forge/event-store";
import { ForgeStore } from "@forge/store";
import {
  DurableExecutor,
  ExecutionRecovery,
  ExecutionStore,
  ManualTestClock,
  succeeded,
  StepExecutorRegistry,
  type RunSpec,
  type StepExecutor,
} from "@forge/execution";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("durable restart e2e", () => {
  it("resumes a waiting run after daemon restart", async () => {
    const fx = await daemonRestartFixture();
    const runId = await fx.createWaitingRun();
    expect(fx.store.getStep(runId, "approve")?.state).toBe("waiting");

    await fx.restart();
    await fx.resume(runId, { approved: true });
    expect(await fx.waitForState(runId, "succeeded")).toBe("succeeded");
    expect(fx.sideEffects()).toBe(1);
  });

  it("recovers an interrupted idempotent attempt without duplicate side effects", async () => {
    const fx = await daemonRestartFixture({ idempotencyKey: "publish-once" });
    const runId = await fx.createInterruptedRun();
    expect(fx.store.listRunningAttempts()).toHaveLength(1);

    await fx.restart();
    await fx.executor.tick();
    expect(await fx.waitForState(runId, "succeeded")).toBe("succeeded");
    expect(fx.sideEffects()).toBe(1);
  });
});

async function daemonRestartFixture(input?: { idempotencyKey?: string }) {
  const root = mkdtempSync(join(tmpdir(), "forge-daemon-restart-e2e-"));
  fixtureRoots.push(root);
  const clock = new ManualTestClock();
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const store = new ExecutionStore(forgeStore.db);
  const events = new EventStore(forgeStore.db);
  let sideEffects = 0;

  const createRuntime = () => {
    const registry = new StepExecutorRegistry();
    const executor: StepExecutor = {
      kind: "test.approval",
      async execute() {
        sideEffects += 1;
        return succeeded("artifact:effect-1");
      },
    };
    registry.register(executor);
    return {
      registry,
      executor: new DurableExecutor(store, registry, clock, { workerId: "worker-a" }),
      recovery: new ExecutionRecovery(store, registry, clock),
    };
  };

  let runtime = createRuntime();

  return {
    store,
    events,
    get executor() {
      return runtime.executor;
    },
    sideEffects: () => sideEffects,
    async createWaitingRun() {
      store.createRun(waitingRunSpec(input?.idempotencyKey), clock.now());
      const attempt = store.claimNextStep("run-1", "worker-a", clock.now())!;
      store.abandonAttemptForManualReview(attempt.id, clock.now());
      return "run-1";
    },
    async createInterruptedRun() {
      store.createRun(waitingRunSpec(input?.idempotencyKey), clock.now());
      store.claimNextStep("run-1", "worker-a", clock.now());
      return "run-1";
    },
    async restart() {
      runtime = createRuntime();
      await runtime.recovery.recoverOnStartup();
    },
    async resume(runId: string, payload: unknown) {
      const wait = store.getActiveWait(runId, "approve");
      if (!wait) {
        throw new Error(`no active wait for ${runId}`);
      }
      runtime.executor.resumeWait(wait.id, payload);
      await runtime.executor.tick();
    },
    async waitForState(runId: string, state: string) {
      return store.getRun(runId)?.state;
    },
  };
}

function waitingRunSpec(idempotencyKey?: string): RunSpec {
  return {
    id: "run-1",
    requestedBy: { kind: "human", id: "user-1" },
    actingSubject: { kind: "agent_profile", id: "forge-default" },
    objective: "await approval",
    correlationId: "corr-restart-1",
    policyContext: {},
    steps: [
      {
        id: "approve",
        kind: "test.approval",
        dependsOn: [],
        input: {},
        idempotencyKey,
        retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
        timeoutMs: 60_000,
      },
    ],
  };
}
