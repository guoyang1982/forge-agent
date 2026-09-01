import { describe, expect, it } from "vitest";
import { compareEvalRuns } from "./comparison.js";
import type { EvalRunResult } from "./types.js";

describe("compareEvalRuns", () => {
  it("reports paired deltas between baseline and candidate runs", () => {
    const baseline = runResult("baseline", {
      successRate: 1,
      p50DurationMs: 10,
      p95DurationMs: 20,
      totalCostMinor: 10n,
    });
    const candidate = runResult("candidate", {
      successRate: 0.5,
      p50DurationMs: 15,
      p95DurationMs: 30,
      totalCostMinor: 12n,
    });

    const comparison = compareEvalRuns(baseline, candidate);
    expect(comparison.deltas.successRate).toBeCloseTo(-0.5);
    expect(comparison.deltas.p50DurationMs).toBe(5);
    expect(comparison.deltas.p95DurationMs).toBe(10);
    expect(comparison.deltas.totalCostMinor).toBe(2n);
    expect(comparison.regressions).toEqual(["case-1"]);
  });

  it("marks only critical regressions as blocking", () => {
    const baseline = runResult("baseline", { successRate: 1 }, [
      { caseId: "critical-case", passed: true },
      { caseId: "experimental-case", passed: true },
    ]);
    const candidate = runResult(
      "candidate",
      { successRate: 0 },
      [
        { caseId: "critical-case", passed: false },
        { caseId: "experimental-case", passed: false },
      ],
      ["critical-case"],
    );

    const comparison = compareEvalRuns(baseline, candidate);
    expect(comparison.regressions).toEqual(["critical-case", "experimental-case"]);
    expect(comparison.blockingRegressions).toEqual(["critical-case"]);
  });
});

function runResult(
  runId: string,
  metrics: {
    successRate: number;
    p50DurationMs?: number;
    p95DurationMs?: number;
    totalCostMinor?: bigint;
  },
  results: Array<{ caseId: string; passed: boolean }> = [
    { caseId: "case-1", passed: metrics.successRate === 1 },
  ],
  criticalCaseIds: string[] = [],
): EvalRunResult {
  return {
    suiteId: "suite-1",
    runId,
    results: results.map((entry, repeatIndex) => ({
      caseId: entry.caseId,
      repeatIndex,
      passed: entry.passed,
      durationMs: metrics.p50DurationMs ?? 10,
      costMinor: metrics.totalCostMinor ?? 1n,
      toolCorrect: entry.passed,
      policyCompliant: true,
    })),
    metrics: {
      successRate: metrics.successRate,
      toolCorrectnessRate: metrics.successRate,
      policyComplianceRate: 1,
      p50DurationMs: metrics.p50DurationMs ?? 10,
      p95DurationMs: metrics.p95DurationMs ?? 20,
      totalCostMinor: metrics.totalCostMinor ?? 1n,
      unstableCaseIds: [],
    },
    pinnedVersions: {
      harnessVersion: "h1",
      modelVersion: "gpt-test",
    },
    criticalCaseIds,
  };
}
