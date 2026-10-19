import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSpec } from "@forge/protocol";
import { EvalRunner } from "./runner.js";
import type { EvalSuite } from "./types.js";

describe("EvalRunner", () => {
  afterEach(() => vi.useRealTimers());

  it("times out a hanging case, aborts it, and continues with unknown cost", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let signal: AbortSignal | undefined;
    let rejectLate: ((reason: Error) => void) | undefined;
    const runner = new EvalRunner({ executeCase: async (input) => {
      if (input.evalCase.id === "case-a") {
        signal = input.signal;
        return new Promise((_, reject) => { rejectLate = reject; });
      }
      return scriptedExecutor([true])();
    } });
    const pending = runner.runSuite({ ...suiteFixture({ repeats: 1 }),
      cases: [caseFixture("case-a"), caseFixture("case-b")] });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result.results.map((entry) => entry.passed)).toEqual([false, true]);
    expect(result.results[0]).toMatchObject({ durationMs: 1_000,
      failureReason: "duration budget exceeded", costKnown: false,
      toolCorrect: false, policyCompliant: false });
    expect(result.metrics.unknownCostCount).toBe(1);
    expect(result.metrics.totalCostMinor).toBe(1n);
    expect(result.metrics.successRate).toBe(0.5);
    expect(vi.getTimerCount()).toBe(0);
    rejectLate?.(new Error("late rejection"));
    await Promise.resolve();
  });

  it("enforces timeout with real timers and proceeds to the next case", async () => {
    let signal: AbortSignal | undefined;
    const first = caseFixture("case-a");
    first.budget.maxDurationMs = 10;
    const runner = new EvalRunner({ executeCase: async (input) => {
      if (input.evalCase.id === first.id) {
        signal = input.signal;
        return new Promise(() => {});
      }
      return scriptedExecutor([true])();
    } });
    const result = await runner.runSuite({ ...suiteFixture({ repeats: 1 }),
      cases: [first, caseFixture("case-b")] });
    expect(result.results.map((entry) => entry.passed)).toEqual([false, true]);
    expect(signal?.aborted).toBe(true);
    expect(result.results[0]?.durationMs).toBeGreaterThan(0);
  });

  it("records executor exceptions and still executes the next case", async () => {
    const runner = new EvalRunner({ executeCase: (input) => {
      if (input.evalCase.id === "case-a") throw new Error("executor failed");
      return scriptedExecutor([true])();
    } });
    const result = await runner.runSuite({ ...suiteFixture({ repeats: 1 }),
      cases: [caseFixture("case-a"), caseFixture("case-b")] });
    expect(result.results.map((entry) => entry.passed)).toEqual([false, true]);
    expect(result.results[0]?.failureReason).toBe("executor failed");
    expect(result.metrics.toolCorrectnessRate).toBe(0.5);
    expect(result.metrics.policyComplianceRate).toBe(0.5);
  });

  it("measures elapsed duration even when the executor underreports it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const runner = new EvalRunner({ executeCase: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { passed: true, durationMs: 1, costMinor: 1n,
        toolCorrect: true, policyCompliant: true };
    } });
    const pending = runner.runSuite(suiteFixture({ repeats: 1 }));
    await vi.advanceTimersByTimeAsync(50);
    expect((await pending).results[0]?.durationMs).toBe(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects evaluation without an executor instead of reporting success", async () => {
    await expect(new EvalRunner().runSuite(suiteFixture({ repeats: 1 })))
      .rejects.toThrow("eval executor required");
  });
  it("reports success rate and instability across repeated cases", async () => {
    const runner = new EvalRunner({
      executeCase: scriptedExecutor([true, false, true]),
    });
    const result = await runner.runSuite(suiteFixture({ repeats: 3 }));
    expect(result.metrics.successRate).toBeCloseTo(2 / 3);
    expect(result.metrics.unstableCaseIds).toEqual(["case-1"]);
  });

  it("isolates repeats so one failure does not leak into the next case", async () => {
    const runner = new EvalRunner({
      executeCase: scriptedExecutor([false, true]),
    });
    const result = await runner.runSuite({
      ...suiteFixture({ repeats: 1 }),
      cases: [
        caseFixture("case-a"),
        caseFixture("case-b"),
      ],
    });
    expect(result.results.map((entry) => entry.passed)).toEqual([false, true]);
  });

  it("stops on cost budget violations", async () => {
    const runner = new EvalRunner({
      executeCase: async () => ({
        passed: true,
        durationMs: 5,
        costMinor: 200n,
        toolCorrect: true,
        policyCompliant: true,
      }),
    });
    const result = await runner.runSuite(suiteFixture({ repeats: 1 }));
    expect(result.results[0]?.passed).toBe(false);
    expect(result.results[0]?.failureReason).toBe("cost budget exceeded");
  });

  it("stops on duration budget violations", async () => {
    const runner = new EvalRunner({
      executeCase: async () => ({
        passed: true,
        durationMs: 2_000,
        costMinor: 1n,
        toolCorrect: true,
        policyCompliant: true,
      }),
    });
    const result = await runner.runSuite(suiteFixture({ repeats: 1 }));
    expect(result.results[0]?.passed).toBe(false);
    expect(result.results[0]?.failureReason).toBe("duration budget exceeded");
  });

  it("pins harness and model versions on the run result", async () => {
    const runner = new EvalRunner({
      executeCase: scriptedExecutor([true]),
    });
    const result = await runner.runSuite({
      ...suiteFixture({ repeats: 1 }),
      harnessVersion: "harness-2",
      modelVersion: "gpt-test",
    });
    expect(result.pinnedVersions).toEqual({
      harnessVersion: "harness-2",
      modelVersion: "gpt-test",
    });
  });
});

function suiteFixture(options: { repeats: number }): EvalSuite {
  return {
    id: "suite-1",
    name: "test suite",
    repeats: options.repeats,
    harnessVersion: "h1",
    cases: [caseFixture("case-1")],
  };
}

function caseFixture(id: string) {
  return {
    id,
    workspaceFixtureRef: "fixture-1",
    runSpec: minimalRunSpec(),
    allowedTools: ["echo"],
    validatorIds: ["validator.pass"],
    budget: { maxCostMinor: 100n, maxDurationMs: 1_000 },
    tags: ["smoke"],
  };
}

function minimalRunSpec(): RunSpec {
  return {
    id: "run-spec-1",
    requestedBy: { kind: "user", id: "eval-user" },
    actingSubject: { kind: "agent_profile", id: "forge-default" },
    objective: "eval objective",
    steps: [],
    policyContext: {},
    correlationId: "corr-1",
  };
}

function scriptedExecutor(outcomes: boolean[]) {
  let index = 0;
  return async () => {
    const passed = outcomes[index] ?? false;
    index += 1;
    return {
      passed,
      durationMs: 10,
      costMinor: 1n,
      toolCorrect: passed,
      policyCompliant: true,
    };
  };
}
