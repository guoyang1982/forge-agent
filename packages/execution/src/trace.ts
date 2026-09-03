import type { EventEnvelope, TraceNode } from "@forge/protocol";
import { SPAN_ENDED, SPAN_STARTED } from "./span-recorder.js";
import type { ActivitySpanKind } from "./span-recorder.js";

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
  activities: ActivitySpan[];
}

export interface ActivitySpan {
  spanId: string;
  parentSpanId: string;
  kind: ActivitySpanKind | string;
  name: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  costMinor?: number;
  usageEstimated?: boolean;
  contextTokens?: number;
  contextSize?: number;
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
  totalPromptTokens: number;
  totalCompletionTokens: number;
  contextTokens: number;
  contextSize: number;
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
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let contextTokens = 0;
  let contextSize = 0;
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
      if (event.type !== SPAN_STARTED && event.type !== "agent.event") {
        totalCostMinor += BigInt(Math.trunc(payload.costMinor));
      }
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
        activities: [],
      };
      attempts.set(event.attemptId, attempt);
      step.attempts.push(attempt);
    }

    if (event.type === SPAN_STARTED || event.type === SPAN_ENDED) {
      const usage = applyActivityEvent(event, payload, attempt, tools);
      if (event.type === SPAN_ENDED) {
        totalPromptTokens += usage.promptTokens;
        totalCompletionTokens += usage.completionTokens;
        if (usage.contextTokens > contextTokens) contextTokens = usage.contextTokens;
        if (usage.contextSize > contextSize) contextSize = usage.contextSize;
      }
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
      totalPromptTokens,
      totalCompletionTokens,
      contextTokens,
      contextSize,
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

export function toTraceTree(trace: TraceContext): TraceNode {
  const nodes = new Map<string, TraceNode>();
  const root = nodeFrom(
    trace.root.spanId,
    undefined,
    "run",
    trace.root.objective ?? trace.root.runId,
    trace.root.state,
    trace.root.startedAt,
    trace.root.finishedAt,
  );
  nodes.set(root.spanId, root);

  for (const step of trace.steps) {
    const stepNode = nodeFrom(
      step.spanId,
      step.parentSpanId,
      "step",
      step.kind ?? step.stepId,
      step.state,
    );
    nodes.set(stepNode.spanId, stepNode);
    for (const attempt of step.attempts) {
      const attemptNode = nodeFrom(
        attempt.spanId,
        attempt.parentSpanId,
        "attempt",
        attempt.attemptId,
        attempt.state,
        attempt.startedAt,
        attempt.finishedAt,
      );
      nodes.set(attemptNode.spanId, attemptNode);
      for (const activity of attempt.activities) {
        const activityNode = nodeFrom(
          activity.spanId,
          activity.parentSpanId,
          activity.kind,
          activity.name,
          activity.status,
          activity.startedAt,
          activity.finishedAt,
          activity.durationMs,
          activity.summary,
          {
            promptTokens: activity.promptTokens,
            completionTokens: activity.completionTokens,
            cachedTokens: activity.cachedTokens,
            costMinor:
              activity.costMinor != null ? Number(activity.costMinor) : undefined,
            usageEstimated: activity.usageEstimated,
            contextTokens: activity.contextTokens,
            contextSize: activity.contextSize,
          },
        );
        nodes.set(activityNode.spanId, activityNode);
      }
    }
  }

  for (const node of nodes.values()) {
    if (!node.parentSpanId) continue;
    const parent = nodes.get(node.parentSpanId);
    if (parent) parent.children.push(node);
    else root.children.push(node);
  }
  rollupUsage(root);
  return root;
}

function applyActivityEvent(
  event: EventEnvelope,
  payload: Record<string, unknown>,
  attempt: AttemptSpan,
  tools: Set<string>,
): { promptTokens: number; completionTokens: number; contextTokens: number; contextSize: number } {
  const spanId = typeof payload.spanId === "string" ? payload.spanId : event.eventId;
  let activity = attempt.activities.find((item) => item.spanId === spanId);
  if (!activity) {
    activity = {
      spanId,
      parentSpanId:
        typeof payload.parentSpanId === "string"
          ? payload.parentSpanId
          : attempt.spanId,
      kind: typeof payload.kind === "string" ? payload.kind : "span",
      name: typeof payload.name === "string" ? payload.name : "span",
    };
    attempt.activities.push(activity);
  }
  if (typeof payload.name === "string") activity.name = payload.name;
  if (typeof payload.kind === "string") activity.kind = payload.kind;
  if (typeof payload.parentSpanId === "string") {
    activity.parentSpanId = payload.parentSpanId;
  }
  if (typeof payload.summary === "string") activity.summary = payload.summary;
  if (typeof payload.durationMs === "number") activity.durationMs = payload.durationMs;
  if (typeof payload.promptTokens === "number") {
    activity.promptTokens = payload.promptTokens;
  }
  if (typeof payload.completionTokens === "number") {
    activity.completionTokens = payload.completionTokens;
  }
  if (typeof payload.cachedTokens === "number") {
    activity.cachedTokens = payload.cachedTokens;
  }
  if (typeof payload.costMinor === "number" && Number.isFinite(payload.costMinor)) {
    activity.costMinor = payload.costMinor;
  }
  if (payload.usageEstimated === true) activity.usageEstimated = true;
  if (typeof payload.contextTokens === "number") {
    activity.contextTokens = payload.contextTokens;
  }
  if (typeof payload.contextSize === "number") {
    activity.contextSize = payload.contextSize;
  }
  if (event.type === SPAN_STARTED) {
    activity.startedAt = event.occurredAt;
    activity.status = "running";
  }
  if (event.type === SPAN_ENDED) {
    activity.finishedAt = event.occurredAt;
    activity.status =
      typeof payload.status === "string" ? payload.status : "succeeded";
  }
  if (activity.kind === "tool") tools.add(activity.name);
  return {
    promptTokens: activity.kind === "llm" ? (activity.promptTokens ?? 0) : 0,
    completionTokens: activity.kind === "llm" ? (activity.completionTokens ?? 0) : 0,
    contextTokens: activity.kind === "llm" ? (activity.contextTokens ?? 0) : 0,
    contextSize: activity.kind === "llm" ? (activity.contextSize ?? 0) : 0,
  };
}

function nodeFrom(
  spanId: string,
  parentSpanId: string | undefined,
  kind: string,
  name: string,
  status?: string,
  startedAt?: string,
  endedAt?: string,
  durationMs?: number,
  summary?: string,
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    costMinor?: number;
    usageEstimated?: boolean;
    contextTokens?: number;
    contextSize?: number;
  },
): TraceNode {
  return {
    spanId,
    parentSpanId,
    kind,
    name,
    status,
    startedAt,
    endedAt,
    durationMs:
      durationMs ??
      (startedAt && endedAt
        ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
        : undefined),
    summary,
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
    cachedTokens: usage?.cachedTokens,
    costMinor: usage?.costMinor,
    usageEstimated: usage?.usageEstimated,
    contextTokens: usage?.contextTokens,
    contextSize: usage?.contextSize,
    children: [],
  };
}

function rollupUsage(node: TraceNode): void {
  for (const child of node.children) rollupUsage(child);
  const hasOwn =
    node.kind === "llm" &&
    (typeof node.promptTokens === "number" ||
      typeof node.costMinor === "number" ||
      typeof node.contextTokens === "number");
  if (hasOwn) return;
  let prompt = 0;
  let completion = 0;
  let cost = 0;
  let contextTokens = 0;
  let contextSize = 0;
  let hasUsage = false;
  for (const child of node.children) {
    if (typeof child.promptTokens === "number") {
      prompt += child.promptTokens;
      hasUsage = true;
    }
    if (typeof child.completionTokens === "number") {
      completion += child.completionTokens;
      hasUsage = true;
    }
    if (typeof child.costMinor === "number") {
      cost += child.costMinor;
      hasUsage = true;
    }
    if (typeof child.contextTokens === "number" && child.contextTokens > contextTokens) {
      contextTokens = child.contextTokens;
      hasUsage = true;
    }
    if (typeof child.contextSize === "number" && child.contextSize > contextSize) {
      contextSize = child.contextSize;
      hasUsage = true;
    }
  }
  if (!hasUsage) return;
  if (prompt > 0 || completion > 0) {
    node.promptTokens = prompt;
    node.completionTokens = completion;
  }
  if (cost > 0) node.costMinor = cost;
  if (contextTokens > 0) node.contextTokens = contextTokens;
  if (contextSize > 0) node.contextSize = contextSize;
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
