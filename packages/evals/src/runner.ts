import { randomUUID } from "node:crypto";
import type {
  EvalCaseExecutionInput,
  EvalCaseExecutionOutput,
  EvalCaseResult,
  EvalRunMetrics,
  EvalRunResult,
  EvalSuite,
  PinnedVersions,
} from "./types.js";

export interface EvalRunnerOptions {
  executeCase?: (input: EvalCaseExecutionInput) => Promise<EvalCaseExecutionOutput>;
}

export class EvalRunner {
  constructor(private readonly options: EvalRunnerOptions = {}) {}

  async runSuite(suite: EvalSuite): Promise<EvalRunResult> {
    const repeats = Math.max(1, suite.repeats ?? 1);
    const execute = this.options.executeCase ?? defaultExecuteCase;
    const results: EvalCaseResult[] = [];

    for (const evalCase of suite.cases) {
      for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
        const startedAt = Date.now();
        const output = await execute({ suite, evalCase, repeatIndex });
        const elapsed = Date.now() - startedAt;

        if (output.durationMs > evalCase.budget.maxDurationMs) {
          results.push({
            caseId: evalCase.id,
            repeatIndex,
            passed: false,
            durationMs: output.durationMs,
            costMinor: output.costMinor,
            toolCorrect: output.toolCorrect,
            policyCompliant: output.policyCompliant,
            traceFixture: output.traceFixture,
            failureReason: output.failureReason ?? "duration budget exceeded",
          });
          continue;
        }

        if (output.costMinor > evalCase.budget.maxCostMinor) {
          results.push({
            caseId: evalCase.id,
            repeatIndex,
            passed: false,
            durationMs: output.durationMs,
            costMinor: output.costMinor,
            toolCorrect: output.toolCorrect,
            policyCompliant: output.policyCompliant,
            traceFixture: output.traceFixture,
            failureReason: output.failureReason ?? "cost budget exceeded",
          });
          continue;
        }

        results.push({
          caseId: evalCase.id,
          repeatIndex,
          passed: output.passed,
          durationMs: output.durationMs || elapsed,
          costMinor: output.costMinor,
          toolCorrect: output.toolCorrect,
          policyCompliant: output.policyCompliant,
          traceFixture: output.traceFixture,
          failureReason: output.failureReason,
        });
      }
    }

    return {
      suiteId: suite.id,
      runId: randomUUID(),
      results,
      metrics: computeMetrics(results, suite),
      pinnedVersions: pinnedVersionsFromSuite(suite),
      criticalCaseIds: suite.cases.filter((evalCase) => evalCase.critical).map((evalCase) => evalCase.id),
    };
  }
}

async function defaultExecuteCase(
  input: EvalCaseExecutionInput,
): Promise<EvalCaseExecutionOutput> {
  void input;
  return {
    passed: true,
    durationMs: 0,
    costMinor: 0n,
    toolCorrect: true,
    policyCompliant: true,
  };
}

function pinnedVersionsFromSuite(suite: EvalSuite): PinnedVersions {
  return {
    harnessVersion: suite.harnessVersion,
    modelVersion: suite.modelVersion,
    promptVersion: suite.promptVersion,
    skillVersion: suite.skillVersion,
    profileVersion: suite.profileVersion,
  };
}

function computeMetrics(results: EvalCaseResult[], suite: EvalSuite): EvalRunMetrics {
  const passedCount = results.filter((result) => result.passed).length;
  const toolCorrectCount = results.filter((result) => result.toolCorrect).length;
  const policyCompliantCount = results.filter((result) => result.policyCompliant).length;
  const durations = results.map((result) => result.durationMs).sort((left, right) => left - right);
  const totalCostMinor = results.reduce((sum, result) => sum + result.costMinor, 0n);

  const unstableCaseIds = suite.cases
    .filter((evalCase) => {
      const caseResults = results.filter((result) => result.caseId === evalCase.id);
      if (caseResults.length <= 1) {
        return false;
      }
      const allPassed = caseResults.every((result) => result.passed);
      const allFailed = caseResults.every((result) => !result.passed);
      return !allPassed && !allFailed;
    })
    .map((evalCase) => evalCase.id);

  return {
    successRate: results.length === 0 ? 0 : passedCount / results.length,
    toolCorrectnessRate: results.length === 0 ? 0 : toolCorrectCount / results.length,
    policyComplianceRate: results.length === 0 ? 0 : policyCompliantCount / results.length,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    totalCostMinor,
    unstableCaseIds,
  };
}

function percentile(sortedValues: number[], quantile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
  );
  return sortedValues[index] ?? 0;
}

export { computeMetrics, pinnedVersionsFromSuite };
