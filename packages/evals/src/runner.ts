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
    const execute = this.options.executeCase;
    if (!execute) throw new Error("eval executor required");
    const results: EvalCaseResult[] = [];

    for (const evalCase of suite.cases) {
      for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
        const startedAt = performance.now();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const budgetMs = evalCase.budget.maxDurationMs;
          if (!Number.isFinite(budgetMs) || budgetMs < 0 || budgetMs > 2_147_483_647) {
            throw new Error("invalid duration budget");
          }
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Reject first: an executor's abort handler may settle its promise.
              reject(new Error("duration budget exceeded"));
              controller.abort();
            }, budgetMs);
          });
          // Promise.race also observes late rejections from uncooperative executors.
          const output = await Promise.race([
            Promise.resolve().then(() => execute({ suite, evalCase, repeatIndex, signal: controller.signal })),
            timeout,
          ]);
          const durationMs = Math.max(performance.now() - startedAt, output.durationMs);
          const budgetFailure = durationMs > budgetMs
            ? "duration budget exceeded"
            : output.costMinor > evalCase.budget.maxCostMinor
              ? "cost budget exceeded"
              : undefined;
          if (durationMs > budgetMs) controller.abort();
          results.push({
            ...output,
            caseId: evalCase.id,
            repeatIndex,
            passed: budgetFailure ? false : output.passed,
            durationMs,
            costKnown: true,
            failureReason: budgetFailure ?? output.failureReason,
          });
        } catch (error) {
          results.push({
            caseId: evalCase.id,
            repeatIndex,
            passed: false,
            durationMs: performance.now() - startedAt,
            costMinor: 0n,
            costKnown: false,
            toolCorrect: false,
            policyCompliant: false,
            failureReason: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
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
    unknownCostCount: results.filter((result) => result.costKnown === false).length,
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
