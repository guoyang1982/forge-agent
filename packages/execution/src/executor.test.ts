import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "@forge/event-store";
import { ForgeStore } from "@forge/store";
import { ManualTestClock } from "./clock.js";
import { DurableExecutor } from "./executor.js";
import {
  retryable,
  succeeded,
  type StepExecutor,
  type StepOutcome,
  StepExecutorRegistry,
} from "./executor-types.js";
import { ExecutionRecovery } from "./recovery.js";
import { ExecutionStore } from "./store.js";
import type { RunSpec } from "./types.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("DurableExecutor", () => {
  it("retries a retryable failure with capped backoff", async () => {
    const fx = executorFixture({
      outcomes: [retryable("network"), succeeded("a1")],
      retry: { maxAttempts: 2, backoffMs: 1000, maxBackoffMs: 5000 },
    });
    fx.store.createRun(fx.runSpec, fx.clock.now());
    await fx.executor.tick();
    fx.clock.advanceBy(1000);
    await fx.executor.tick();
    expect(fx.store.getRun("run-1")?.state).toBe("succeeded");
    expect(fx.store.listAttempts("run-1", "step-1")).toHaveLength(2);
  });

  it("cancels a run and stops further execution", async () => {
    const fx = executorFixture({
      outcomes: [succeeded("ignored")],
    });
    fx.store.createRun(fx.runSpec, fx.clock.now());
    fx.executor.cancelRun("run-1", "user requested");
    await fx.executor.tick();
    expect(fx.store.getRun("run-1")?.state).toBe("cancelled");
    expect(fx.store.listAttempts("run-1", "step-1")).toHaveLength(0);
  });

  it("fails permanently after retry budget is exhausted", async () => {
    const fx = executorFixture({
      outcomes: [retryable("network"), retryable("network")],
      retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
    });
    fx.store.createRun(fx.runSpec, fx.clock.now());
    await fx.executor.tick();
    await fx.executor.tick();
    expect(fx.store.getRun("run-1")?.state).toBe("failed");
    expect(fx.store.getStep("run-1", "step-1")?.state).toBe("failed");
  });

  it("executes one side effect for duplicate idempotency keys", async () => {
    const { store, clock } = baseFixture();
    const registry = new StepExecutorRegistry();
    let sideEffects = 0;
    registry.register({
      kind: "test.idempotent",
      async execute() {
        sideEffects += 1;
        return succeeded("artifact:published");
      },
    });
    const executor = new DurableExecutor(store, registry, clock);
    const first = {
      ...singleStepRunSpec(),
      steps: [{ ...singleStepRunSpec().steps[0]!, kind: "test.idempotent", idempotencyKey: "publish-once" }],
    };
    const second = { ...first, id: "run-2", correlationId: "corr-2" };
    store.createRun(first, clock.now());
    store.createRun(second, clock.now());

    await executor.tick(2);

    expect(sideEffects).toBe(1);
    expect(store.getRun("run-1")?.state).toBe("succeeded");
    expect(store.getRun("run-2")?.state).toBe("succeeded");
  });

  it("aborts active execution and keeps a cancelled run terminal", async () => {
    const { store, clock } = baseFixture();
    const registry = new StepExecutorRegistry();
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    registry.register({
      kind: "test.blocking",
      async execute(_input, signal) {
        observedSignal = signal;
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        return succeeded("late-result");
      },
    });
    const executor = new DurableExecutor(store, registry, clock);
    store.createRun(
      {
        ...singleStepRunSpec(),
        steps: [{ ...singleStepRunSpec().steps[0]!, kind: "test.blocking" }],
      },
      clock.now(),
    );

    const ticking = executor.tick();
    await didStart;
    executor.cancelRun("run-1", "user requested");
    await ticking;

    expect(observedSignal?.aborted).toBe(true);
    expect(store.getRun("run-1")?.state).toBe("cancelled");
    expect(store.getStep("run-1", "step-1")?.state).toBe("cancelled");
  });
});

describe("ExecutionRecovery", () => {
  it("marks interrupted non-idempotent attempts for review", async () => {
    const fx = interruptedFixture({ idempotencyKey: undefined });
    await fx.recovery.recoverOnStartup();
    expect(fx.store.getStep("run-1", "publish")?.state).toBe("waiting");
    expect(fx.store.getAttempt(fx.attemptId)?.state).toBe("abandoned");
  });

  it("retries interrupted idempotent attempts safely", async () => {
    const fx = interruptedFixture({ idempotencyKey: "publish-once" });
    await fx.recovery.recoverOnStartup();
    expect(fx.store.getStep("run-1", "publish")?.state).toBe("runnable");
    expect(fx.store.getAttempt(fx.attemptId)?.state).toBe("abandoned");
  });
});

function executorFixture(input: {
  outcomes: StepOutcome[];
  retry?: RunSpec["steps"][number]["retry"];
}) {
  const { store, clock } = baseFixture();
  const registry = new StepExecutorRegistry();
  registry.register(scriptExecutor("test.script", input.outcomes));
  const executor = new DurableExecutor(store, registry, clock, {
    workerId: "worker-test",
  });
  const recovery = new ExecutionRecovery(store, registry, clock);
  const runSpec = singleStepRunSpec(input.retry);
  return { store, clock, registry, executor, recovery, runSpec };
}

function interruptedFixture(input: { idempotencyKey?: string }) {
  const { store, clock } = baseFixture();
  const registry = new StepExecutorRegistry();
  registry.register(scriptExecutor("test.script", [succeeded("never")]));
  const recovery = new ExecutionRecovery(store, registry, clock);
  const runSpec = publishRunSpec(input.idempotencyKey);
  store.createRun(runSpec, clock.now());
  const attempt = store.claimNextStep("run-1", "worker-test", clock.now())!;
  return { store, clock, registry, recovery, attemptId: attempt.id };
}

function baseFixture(): { store: ExecutionStore; clock: ManualTestClock; events: EventStore } {
  const root = mkdtempSync(join(tmpdir(), "forge-executor-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  return {
    store: new ExecutionStore(forgeStore.db),
    clock: new ManualTestClock(),
    events: new EventStore(forgeStore.db),
  };
}

function scriptExecutor(kind: string, outcomes: StepOutcome[]): StepExecutor {
  const queue = [...outcomes];
  return {
    kind,
    async execute() {
      const next = queue.shift();
      if (!next) {
        throw new Error("no scripted outcome remaining");
      }
      return next;
    },
  };
}

function singleStepRunSpec(
  retry = { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
): RunSpec {
  return {
    id: "run-1",
    requestedBy: { kind: "user", id: "user-1" },
    actingSubject: { kind: "agent", id: "agent-1" },
    objective: "execute one step",
    correlationId: "corr-1",
    policyContext: {},
    steps: [
      {
        id: "step-1",
        kind: "test.script",
        dependsOn: [],
        input: {},
        retry,
        timeoutMs: 60_000,
      },
    ],
  };
}

function publishRunSpec(idempotencyKey?: string): RunSpec {
  return {
    id: "run-1",
    requestedBy: { kind: "user", id: "user-1" },
    actingSubject: { kind: "agent", id: "agent-1" },
    objective: "publish content",
    correlationId: "corr-1",
    policyContext: {},
    steps: [
      {
        id: "publish",
        kind: "test.script",
        dependsOn: [],
        input: {},
        idempotencyKey,
        retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
        timeoutMs: 60_000,
      },
    ],
  };
}
