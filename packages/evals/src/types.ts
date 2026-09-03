import type { RunSpec } from "@forge/protocol";
import type { EvalTraceFixture } from "@forge/execution";

export interface EvalCase {
  id: string;
  workspaceFixtureRef: string;
  runSpec: RunSpec;
  allowedTools: string[];
  validatorIds: string[];
  budget: { maxCostMinor: bigint; maxDurationMs: number };
  tags: string[];
  /** When true, failures block CI comparison gates. */
  critical?: boolean;
}

export interface EvalSuite {
  id: string;
  name: string;
  cases: EvalCase[];
  repeats?: number;
  harnessVersion: string;
  modelVersion?: string;
  promptVersion?: string;
  skillVersion?: string;
  profileVersion?: string;
}

export interface PinnedVersions {
  harnessVersion: string;
  modelVersion?: string;
  promptVersion?: string;
  skillVersion?: string;
  profileVersion?: string;
}

export interface EvalCaseResult {
  caseId: string;
  repeatIndex: number;
  passed: boolean;
  durationMs: number;
  costMinor: bigint;
  toolCorrect: boolean;
  policyCompliant: boolean;
  traceFixture?: EvalTraceFixture;
  failureReason?: string;
}

export interface EvalRunMetrics {
  successRate: number;
  toolCorrectnessRate: number;
  policyComplianceRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  totalCostMinor: bigint;
  unstableCaseIds: string[];
}

export interface EvalRunResult {
  suiteId: string;
  runId: string;
  results: EvalCaseResult[];
  metrics: EvalRunMetrics;
  pinnedVersions: PinnedVersions;
  criticalCaseIds: string[];
}

export interface EvalCaseExecutionInput {
  suite: EvalSuite;
  evalCase: EvalCase;
  repeatIndex: number;
}

export interface EvalCaseExecutionOutput {
  passed: boolean;
  durationMs: number;
  costMinor: bigint;
  toolCorrect: boolean;
  policyCompliant: boolean;
  traceFixture?: EvalTraceFixture;
  failureReason?: string;
}

export interface EvalRunComparison {
  baselineRunId: string;
  candidateRunId: string;
  pinnedVersions: {
    baseline: PinnedVersions;
    candidate: PinnedVersions;
  };
  deltas: {
    successRate: number;
    toolCorrectnessRate: number;
    policyComplianceRate: number;
    p50DurationMs: number;
    p95DurationMs: number;
    totalCostMinor: bigint;
  };
  regressions: string[];
  blockingRegressions: string[];
}

export interface RegressionCandidate {
  suiteId: string;
  caseId: string;
  traceFixture: EvalTraceFixture;
  validators: string[];
  failureSummary: string;
  redactedPayload: Record<string, unknown>;
}
