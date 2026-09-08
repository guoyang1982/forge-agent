import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableExecutor,
  ExecutionStore,
  ManualTestClock,
  StepExecutorRegistry,
  retryable,
  succeeded,
} from "@forge/execution";
import { ForgeStore } from "@forge/store";
import { createExecutorPump } from "./executor-pump.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("createExecutorPump", () => {
  it("keeps ticking while a batch is full and schedules the next due wake", async () => {
    const ticks: number[] = [];
    const timers: Array<{ due: number; fn: () => void }> = [];
    let nowMs = 0;
    const pump = createExecutorPump({
      tick: async () => {
        ticks.push(1);
        return ticks.length === 1 ? 10 : 0;
      },
      nextDueAt: () => (ticks.length >= 2 ? "2026-01-01T00:00:05.000Z" : undefined),
      nowMs: () => nowMs,
      setTimer: (fn, delayMs) => {
        timers.push({ due: nowMs + delayMs, fn });
        return () => {};
      },
    });

    pump.wake();
    await pump.idle();
    expect(ticks).toHaveLength(2);

    nowMs = 5_000;
    timers[0]!.fn();
    await pump.idle();
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    pump.stop();
  });

  it("keeps draining when a retry becomes due during a partial batch", async () => {
    const ticks: number[] = [];
    let nowMs = 0;
    const pump = createExecutorPump({
      tick: async () => {
        ticks.push(nowMs);
        if (ticks.length === 1) {
          nowMs = 100;
          return 1;
        }
        return 0;
      },
      nextDueAt: () =>
        nowMs >= 100 && ticks.length === 1
          ? "1970-01-01T00:00:00.100Z"
          : undefined,
      nowMs: () => nowMs,
      setTimer: () => () => {},
    });

    pump.wake();
    await pump.idle();
    expect(ticks).toEqual([0, 100]);
    pump.stop();
  });

  it("wakes a retry that becomes due while another step is executing", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-executor-pump-retry-"));
    fixtureRoots.push(root);
    const clock = new ManualTestClock("2026-01-01T00:00:00.000Z");
    const forgeStore = ForgeStore.open({
      dbPath: join(root, "data.db"),
      migrationsDir,
      owner: "test",
    });
    const store = new ExecutionStore(forgeStore.db);
    const registry = new StepExecutorRegistry();
    registry.register({
      kind: "test.slow",
      async execute() {
        clock.advanceBy(15_000);
        return succeeded("slow-done");
      },
    });
    let retryAttempts = 0;
    registry.register({
      kind: "test.retry",
      async execute() {
        retryAttempts += 1;
        if (retryAttempts === 1) {
          return retryable("transient");
        }
        return succeeded("retry-done");
      },
    });
    const executor = new DurableExecutor(store, registry, clock);
    store.createRun(
      {
        id: "run-retry",
        requestedBy: { kind: "user", id: "u1" },
        actingSubject: { kind: "agent", id: "a1" },
        objective: "retry later",
        correlationId: "corr-retry",
        policyContext: {},
        steps: [
          {
            id: "step-retry",
            kind: "test.retry",
            dependsOn: [],
            input: {},
            retry: { maxAttempts: 2, backoffMs: 10_000, maxBackoffMs: 10_000 },
            timeoutMs: 60_000,
          },
        ],
      },
      clock.now(),
    );
    await executor.tick();
    expect(store.getStep("run-retry", "step-retry")?.state).toBe("waiting");

    store.createRun(
      {
        id: "run-slow",
        requestedBy: { kind: "user", id: "u1" },
        actingSubject: { kind: "agent", id: "a1" },
        objective: "run long enough to cross the retry instant",
        correlationId: "corr-slow",
        policyContext: {},
        steps: [
          {
            id: "step-slow",
            kind: "test.slow",
            dependsOn: [],
            input: {},
            retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
            timeoutMs: 60_000,
          },
        ],
      },
      clock.now(),
    );

    const timers: Array<{ delayMs: number; fn: () => void }> = [];
    const pump = createExecutorPump({
      tick: (limit) => executor.tick(limit),
      nextDueAt: () => store.nextDueAt(clock.now()),
      nowMs: () => clock.nowMs(),
      setTimer: (fn, delayMs) => {
        timers.push({ delayMs, fn });
        return () => {};
      },
    });

    pump.wake();
    await pump.idle();
    for (const timer of timers.splice(0)) {
      if (timer.delayMs === 0) {
        timer.fn();
        await pump.idle();
      }
    }

    expect(store.getRun("run-retry")?.state).toBe("succeeded");
    expect(store.getRun("run-slow")?.state).toBe("succeeded");
    pump.stop();
  });
});
