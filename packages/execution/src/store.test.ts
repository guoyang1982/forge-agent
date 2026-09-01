import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "@forge/event-store";
import { ForgeStore } from "@forge/store";
import { ExecutionStore, type EventAppendFn } from "./store.js";
import type { RunSpec } from "./types.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];
const clock = {
  now: () => "2026-01-01T00:00:00.000Z",
  tick: () => "2026-01-01T00:00:01.000Z",
};

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ExecutionStore", () => {
  it("claims one runnable step once", () => {
    const { store } = executionFixture();
    store.createRun(twoStepRunSpec(), clock.now());
    const first = store.claimNextStep("run-1", "worker-a", clock.now());
    const second = store.claimNextStep("run-1", "worker-b", clock.now());
    expect(first?.stepId).toBe("research");
    expect(second).toBeNull();
  });

  it("makes dependent step runnable after success", () => {
    const { store } = executionFixture();
    store.createRun(twoStepRunSpec(), clock.now());
    const attempt = store.claimNextStep("run-1", "worker-a", clock.now())!;
    store.finishAttempt(
      attempt.id,
      { state: "succeeded", outputRef: "artifact:a1" },
      clock.tick(),
    );
    expect(store.getStep("run-1", "report")?.state).toBe("runnable");
  });

  it("persists the immutable run spec and dependency rows", () => {
    const { store } = executionFixture();
    const spec = twoStepRunSpec();
    store.createRun(spec, clock.now());

    const run = store.getRun("run-1");
    expect(run?.spec).toEqual(spec);
    expect(store.getStep("run-1", "research")?.state).toBe("runnable");
    expect(store.getStep("run-1", "report")?.state).toBe("pending");
  });

  it("marks the run succeeded when all steps succeed", () => {
    const { store } = executionFixture();
    store.createRun(twoStepRunSpec(), clock.now());

    const first = store.claimNextStep("run-1", "worker-a", clock.now())!;
    store.finishAttempt(
      first.id,
      { state: "succeeded", outputRef: "artifact:research" },
      clock.tick(),
    );

    const second = store.claimNextStep("run-1", "worker-b", clock.tick())!;
    store.finishAttempt(
      second.id,
      { state: "succeeded", outputRef: "artifact:report" },
      clock.tick(),
    );

    expect(store.getRun("run-1")?.state).toBe("succeeded");
  });

  it("skips blocked dependents and fails the run when a prerequisite fails", () => {
    const { store } = executionFixture();
    store.createRun(twoStepRunSpec(), clock.now());

    const first = store.claimNextStep("run-1", "worker-a", clock.now())!;
    store.finishAttempt(
      first.id,
      { state: "failed", error: { code: "RESEARCH_FAILED" } },
      clock.tick(),
    );

    expect(store.getStep("run-1", "research")?.state).toBe("failed");
    expect(store.getStep("run-1", "report")?.state).toBe("skipped");
    expect(store.getRun("run-1")?.state).toBe("failed");
  });

  it("rejects cyclic run specs before insert", () => {
    const { store } = executionFixture();
    expect(() =>
      store.createRun(
        {
          ...singleStepRunSpec(),
          steps: [
            {
              id: "a",
              kind: "legacy.run",
              dependsOn: ["b"],
              input: {},
              retry: defaultRetry(),
              timeoutMs: 60_000,
            },
            {
              id: "b",
              kind: "legacy.run",
              dependsOn: ["a"],
              input: {},
              retry: defaultRetry(),
              timeoutMs: 60_000,
            },
          ],
        },
        clock.now(),
      ),
    ).toThrow(/cycle detected/i);
  });

  it("reloads recoverable runs with in-flight work", () => {
    const { store } = executionFixture();
    store.createRun(twoStepRunSpec(), clock.now());
    store.claimNextStep("run-1", "worker-a", clock.now());

    const recoverable = store.loadRecoverableRuns();
    expect(recoverable.map((run) => run.id)).toEqual(["run-1"]);
    expect(recoverable[0]?.state).toBe("running");
  });

  it("rolls back run state when event append fails", () => {
    const { store } = executionFixture({ failEventAppend: true });
    expect(() => store.createRun(singleStepRunSpec(), clock.now())).toThrow(
      /event append failed/i,
    );
    expect(store.getRun("run-1")).toBeNull();
  });

  it("writes correlation, run, step and attempt ids to domain events", () => {
    const { store, events } = executionFixture();
    store.createRun(singleStepRunSpec(), clock.now());
    const attempt = store.claimNextStep("run-1", "worker-a", clock.tick())!;
    store.finishAttempt(
      attempt.id,
      { state: "succeeded", outputRef: "artifact:only" },
      clock.tick(),
    );

    const recorded = events.readAfter({ sequence: 0, filter: {}, limit: 20 });
    expect(recorded[0]).toMatchObject({
      type: "run.created",
      runId: "run-1",
      correlationId: "corr-1",
    });
    expect(recorded.some((event) => event.type === "step.started")).toBe(true);
    expect(recorded.some((event) => event.type === "step.succeeded")).toBe(true);
    expect(recorded.some((event) => event.type === "run.succeeded")).toBe(true);
    expect(
      recorded.find((event) => event.type === "step.started"),
    ).toMatchObject({
      runId: "run-1",
      stepId: "only",
      attemptId: attempt.id,
      correlationId: "corr-1",
    });
  });
});

function executionFixture(options?: { failEventAppend?: boolean }): {
  store: ExecutionStore;
  events: EventStore;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-execution-store-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const events = new EventStore(forgeStore.db);
  const appendEvent: EventAppendFn = options?.failEventAppend
    ? () => {
        throw new Error("event append failed");
      }
    : EventStore.appendInTransaction;
  return {
    store: new ExecutionStore(forgeStore.db, appendEvent),
    events,
  };
}

function twoStepRunSpec(): RunSpec {
  return {
    id: "run-1",
    requestedBy: subject("user", "user-1"),
    actingSubject: subject("agent", "agent-1"),
    objective: "research then report",
    correlationId: "corr-1",
    policyContext: {},
    steps: [
      {
        id: "research",
        kind: "legacy.run",
        dependsOn: [],
        input: { topic: "market" },
        retry: defaultRetry(),
        timeoutMs: 60_000,
      },
      {
        id: "report",
        kind: "legacy.run",
        dependsOn: ["research"],
        input: { format: "memo" },
        retry: defaultRetry(),
        timeoutMs: 60_000,
      },
    ],
  };
}

function singleStepRunSpec(): RunSpec {
  return {
    id: "run-1",
    requestedBy: subject("user", "user-1"),
    actingSubject: subject("agent", "agent-1"),
    objective: "single step",
    correlationId: "corr-1",
    policyContext: {},
    steps: [
      {
        id: "only",
        kind: "legacy.run",
        dependsOn: [],
        input: {},
        retry: defaultRetry(),
        timeoutMs: 60_000,
      },
    ],
  };
}

function subject(kind: string, id: string) {
  return { kind, id };
}

function defaultRetry() {
  return { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 };
}
