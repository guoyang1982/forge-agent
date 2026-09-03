import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { ManualTestClock } from "./clock.js";
import {
  type StepExecutor,
  StepExecutorRegistry,
  succeeded,
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

describe("ExecutionRecovery startup", () => {
  it("reconciles idempotent side effects when executor supports it", async () => {
    const clock = new ManualTestClock();
    const { store, recovery } = recoveryFixture(clock, {
      idempotencyKey: "publish-once",
      reconcileOutcome: succeeded("artifact:reconciled"),
    });
    const attemptId = seedRunningAttempt(store, clock.now());
    await recovery.recoverOnStartup();
    expect(store.getStep("run-1", "publish")?.state).toBe("succeeded");
    expect(store.getAttempt(attemptId)?.state).toBe("succeeded");
  });
});

function recoveryFixture(
  clock: ManualTestClock,
  input: {
    idempotencyKey?: string;
    reconcileOutcome?: ReturnType<typeof succeeded> | "unknown";
  },
): {
  store: ExecutionStore;
  recovery: ExecutionRecovery;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-recovery-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const store = new ExecutionStore(forgeStore.db);
  const registry = new StepExecutorRegistry();
  const executor: StepExecutor = {
    kind: "test.script",
    async execute() {
      return succeeded("unused");
    },
    async reconcile() {
      return input.reconcileOutcome ?? "unknown";
    },
  };
  registry.register(executor);
  const recovery = new ExecutionRecovery(store, registry, clock);
  store.createRun(publishRunSpec(input.idempotencyKey), clock.now());
  return { store, recovery };
}

function seedRunningAttempt(store: ExecutionStore, now: string): string {
  const attempt = store.claimNextStep("run-1", "worker-test", now)!;
  return attempt.id;
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
