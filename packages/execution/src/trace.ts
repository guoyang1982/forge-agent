import type { EventEnvelope } from "@forge/protocol";

export interface AttemptSpan {
  spanId: string;
  parentSpanId: string;
  attemptId: string;
  stepId: string;
  state?: string;
  outputRef?: string;
  model?: string;
  tool?: string;
  version?: string;
  costMinor?: bigint;
  startedAt?: string;
  finishedAt?: string;
}

export interface StepSpan {
  spanId: string;
  parentSpanId: string;
  stepId: string;
  kind?: string;
  state?: string;
  attempts: AttemptSpan[];
}

export interface RunSpan {
  spanId: string;
  runId: string;
  correlationId: string;
  objective?: string;
  state?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TraceSummaries {
  models: string[];
  tools: string[];
  versions: string[];
  totalCostMinor: bigint;
}

export interface TraceContext {
  root: RunSpan;
  steps: StepSpan[];
  summaries: TraceSummaries;
}

export interface EvalTraceFixture {
  runId: string;
  correlationId: string;
  state: string;
  stepCount: number;
  attemptCount: number;
  summaries: {
    models: string[];
    tools: string[];
    versions: string[];
    totalCostMinor: number;
  };
  artifactRefs: string[];
}

export function buildTrace(events: EventEnvelope[]): TraceContext {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const runId = inferRunId(ordered);
  if (!runId) {
    throw new Error("trace requires at least one run-scoped event");
  }

  const root: RunSpan = {
    spanId: runSpanId(runId),
    runId,
    correlationId: ordered.find((event) => event.correlationId)?.correlationId ?? runId,
  };

  const steps = new Map<string, StepSpan>();
  const attempts = new Map<string, AttemptSpan>();
  const models = new Set<string>();
  const tools = new Set<string>();
  const versions = new Set<string>();
  let totalCostMinor = 0n;
  const artifactRefs = new Set<string>();

  for (const event of ordered) {
    if (event.runId && event.runId !== runId) {
      continue;
    }

    const payload = asRecord(event.data);
    if (typeof payload.model === "string") models.add(payload.model);
    if (typeof payload.tool === "string") tools.add(payload.tool);
    if (typeof payload.version === "string") versions.add(payload.version);
    if (typeof payload.costMinor === "number" && Number.isFinite(payload.costMinor)) {
      totalCostMinor += BigInt(Math.trunc(payload.costMinor));
    }
    if (typeof payload.outputRef === "string") {
      artifactRefs.add(payload.outputRef);
    }

    switch (event.type) {
      case "run.created":
        root.objective =
          typeof payload.objective === "string" ? payload.objective : root.objective;
        root.startedAt = event.occurredAt;
        root.state = "running";
        break;
      case "run.succeeded":
      case "run.failed":
      case "run.cancelled":
        root.state = event.type.slice("run.".length);
        root.finishedAt = event.occurredAt;
        break;
      default:
        break;
    }

    if (!event.stepId) {
      continue;
    }

    let step = steps.get(event.stepId);
    if (!step) {
      step = {
        spanId: stepSpanId(runId, event.stepId),
        parentSpanId: root.spanId,
        stepId: event.stepId,
        kind: typeof payload.kind === "string" ? payload.kind : undefined,
        attempts: [],
      };
      steps.set(event.stepId, step);
    }

    if (event.type.startsWith("step.")) {
      step.state = event.type.slice("step.".length);
    }

    if (!event.attemptId) {
      continue;
    }

    let attempt = attempts.get(event.attemptId);
    if (!attempt) {
      attempt = {
        spanId: attemptSpanId(event.attemptId),
        parentSpanId: step.spanId,
        attemptId: event.attemptId,
        stepId: event.stepId,
      };
      attempts.set(event.attemptId, attempt);
      step.attempts.push(attempt);
    }

    if (event.type === "step.started") {
      attempt.startedAt = event.occurredAt;
      attempt.state = "running";
    }
    if (
      event.type === "step.succeeded" ||
      event.type === "step.failed" ||
      event.type === "step.cancelled"
    ) {
      attempt.state = event.type.slice("step.".length);
      attempt.finishedAt = event.occurredAt;
    }
    if (typeof payload.outputRef === "string") {
      attempt.outputRef = payload.outputRef;
    }
    if (typeof payload.model === "string") attempt.model = payload.model;
    if (typeof payload.tool === "string") attempt.tool = payload.tool;
    if (typeof payload.version === "string") attempt.version = payload.version;
    if (typeof payload.costMinor === "number" && Number.isFinite(payload.costMinor)) {
      attempt.costMinor = BigInt(Math.trunc(payload.costMinor));
    }
  }

  return {
    root,
    steps: [...steps.values()],
    summaries: {
      models: [...models],
      tools: [...tools],
      versions: [...versions],
      totalCostMinor,
    },
  };
}

export function exportTraceEvalFixture(trace: TraceContext): EvalTraceFixture {
  const artifactRefs = trace.steps.flatMap((step) =>
    step.attempts
      .map((attempt) => attempt.outputRef)
      .filter((value): value is string => Boolean(value)),
  );

  return {
    runId: trace.root.runId,
    correlationId: trace.root.correlationId,
    state: trace.root.state ?? "unknown",
    stepCount: trace.steps.length,
    attemptCount: trace.steps.reduce(
      (count, step) => count + step.attempts.length,
      0,
    ),
    summaries: {
      models: trace.summaries.models,
      tools: trace.summaries.tools,
      versions: trace.summaries.versions,
      totalCostMinor: Number(trace.summaries.totalCostMinor),
    },
    artifactRefs,
  };
}

function inferRunId(events: EventEnvelope[]): string | undefined {
  return events.find((event) => event.runId)?.runId;
}

function runSpanId(runId: string): string {
  return `run:${runId}`;
}

function stepSpanId(runId: string, stepId: string): string {
  return `step:${runId}:${stepId}`;
}

function attemptSpanId(attemptId: string): string {
  return `attempt:${attemptId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
