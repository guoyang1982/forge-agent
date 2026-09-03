import type { EvalRunComparison, EvalRunResult } from "./types.js";

export function compareEvalRuns(
  baseline: EvalRunResult,
  candidate: EvalRunResult,
): EvalRunComparison {
  if (baseline.suiteId !== candidate.suiteId) {
    throw new Error("compareEvalRuns requires the same suite id");
  }

  const regressions = findRegressions(baseline, candidate);
  const blockingRegressions = findBlockingRegressions(baseline, candidate, regressions);

  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    pinnedVersions: {
      baseline: baseline.pinnedVersions,
      candidate: candidate.pinnedVersions,
    },
    deltas: {
      successRate: candidate.metrics.successRate - baseline.metrics.successRate,
      toolCorrectnessRate:
        candidate.metrics.toolCorrectnessRate - baseline.metrics.toolCorrectnessRate,
      policyComplianceRate:
        candidate.metrics.policyComplianceRate - baseline.metrics.policyComplianceRate,
      p50DurationMs: candidate.metrics.p50DurationMs - baseline.metrics.p50DurationMs,
      p95DurationMs: candidate.metrics.p95DurationMs - baseline.metrics.p95DurationMs,
      totalCostMinor: candidate.metrics.totalCostMinor - baseline.metrics.totalCostMinor,
    },
    regressions,
    blockingRegressions,
  };
}

function findRegressions(baseline: EvalRunResult, candidate: EvalRunResult): string[] {
  const baselineByCase = aggregateCasePassRate(baseline);
  const candidateByCase = aggregateCasePassRate(candidate);
  const caseIds = new Set([...baselineByCase.keys(), ...candidateByCase.keys()]);
  const regressions: string[] = [];

  for (const caseId of caseIds) {
    const baselineRate = baselineByCase.get(caseId) ?? 0;
    const candidateRate = candidateByCase.get(caseId) ?? 0;
    if (candidateRate < baselineRate) {
      regressions.push(caseId);
    }
  }

  return regressions.sort();
}

function findBlockingRegressions(
  baseline: EvalRunResult,
  candidate: EvalRunResult,
  regressions: string[],
): string[] {
  const criticalCaseIds = new Set([
    ...baseline.criticalCaseIds,
    ...candidate.criticalCaseIds,
  ]);
  return regressions.filter((caseId) => criticalCaseIds.has(caseId));
}

function aggregateCasePassRate(run: EvalRunResult): Map<string, number> {
  const totals = new Map<string, { passed: number; count: number }>();

  for (const result of run.results) {
    const current = totals.get(result.caseId) ?? { passed: 0, count: 0 };
    current.count += 1;
    if (result.passed) {
      current.passed += 1;
    }
    totals.set(result.caseId, current);
  }

  return new Map(
    [...totals.entries()].map(([caseId, stats]) => [
      caseId,
      stats.count === 0 ? 0 : stats.passed / stats.count,
    ]),
  );
}

export { aggregateCasePassRate };
