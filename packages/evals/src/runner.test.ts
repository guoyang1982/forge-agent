import { describe, expect, it } from "vitest";
import type { RunSpec } from "@forge/protocol";
import { EvalRunner } from "./runner.js";
import type { EvalSuite } from "./types.js";

describe("EvalRunner", () => {
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
