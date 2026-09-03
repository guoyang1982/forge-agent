import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@forge/protocol";

export const SPAN_STARTED = "span.started";
export const SPAN_ENDED = "span.ended";
export const SUMMARY_MAX_CHARS = 500;

export type ActivitySpanKind = "turn" | "llm" | "tool" | "thinking";

export interface ActivitySpanRecord {
  spanId: string;
  parentSpanId: string;
  kind: ActivitySpanKind;
  name: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  endedAt?: string;
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

export interface SpanRecorderLinks {
  runId: string;
  stepId: string;
  attemptId: string;
}

export type SpanRecorderEmit = (
  type: typeof SPAN_STARTED | typeof SPAN_ENDED,
  span: ActivitySpanRecord,
  links: SpanRecorderLinks,
) => void;

export interface SpanRecorderOptions {
  emit: SpanRecorderEmit;
  now: () => string;
  id?: () => string;
}

interface OpenSpan {
  key: string;
  span: ActivitySpanRecord;
  links: SpanRecorderLinks;
}

function attemptParentId(attemptId: string): string {
  return `attempt:${attemptId}`;
}

export function summarizeSpanPayload(value: unknown, max = SUMMARY_MAX_CHARS): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function toolFailed(result: string): boolean {
  const trimmed = result.trim();
  if (!trimmed.startsWith("{")) {
    return /error|traceback|failed/i.test(trimmed.slice(0, 200));
  }
  try {
    const parsed = JSON.parse(trimmed) as { ok?: unknown; error?: unknown };
    return parsed.ok === false || typeof parsed.error === "string";
  } catch {
    return false;
  }
}

/**
 * Turns live AgentEvents into nested span.started / span.ended records.
 * Parent of each turn is the durable attempt; LLM / tool / thinking nest under the turn.
 */
export class SpanRecorder {
  private readonly id: () => string;
  private readonly open = new Map<string, OpenSpan>();
  private readonly turnByAttempt = new Map<string, string>();
  private readonly activeLlmByAttempt = new Map<string, string>();
  private seq = 0;

  constructor(private readonly options: SpanRecorderOptions) {
    this.id = options.id ?? (() => randomUUID());
  }

  onAgentEvent(event: AgentEvent, links: SpanRecorderLinks): void {
    switch (event.type) {
      case "step_start":
        this.closeKey(`turn:${links.attemptId}`, "succeeded");
        this.start(
          `turn:${links.attemptId}`,
          {
            kind: "turn",
            name: `turn ${event.step}`,
            parentSpanId: attemptParentId(links.attemptId),
            summary: `${event.step}/${event.maxSteps}`,
          },
          links,
        );
        break;
      case "llm_start": {
        const key = `llm:${links.attemptId}:${++this.seq}`;
        this.start(
          key,
          {
            kind: "llm",
            name: event.model ?? "llm",
            parentSpanId: this.turnParent(links.attemptId),
            summary: event.model,
          },
          links,
        );
        this.activeLlmByAttempt.set(links.attemptId, key);
        break;
      }
      case "llm_end": {
        const key = this.activeLlmByAttempt.get(links.attemptId);
        if (key) {
          this.activeLlmByAttempt.delete(links.attemptId);
          this.closeKey(key, "succeeded", llmUsagePatch(event));
        }
        break;
      }
      case "thinking_start":
        this.start(
          `thinking:${links.attemptId}`,
          {
            kind: "thinking",
            name: "thinking",
            parentSpanId: this.turnParent(links.attemptId),
          },
          links,
        );
        break;
      case "thinking_end":
        this.closeKey(`thinking:${links.attemptId}`, "succeeded", {
          summary: `${event.charCount} chars`,
        });
        break;
      case "tool_start":
        this.start(
          `tool:${event.callId ?? event.name}`,
          {
            kind: "tool",
            name: event.name,
            parentSpanId: this.turnParent(links.attemptId),
            summary: summarizeSpanPayload(event.args),
          },
          links,
        );
        break;
      case "tool_end":
        this.closeKey(
          `tool:${event.callId ?? event.name}`,
          toolFailed(event.result) ? "failed" : "succeeded",
          { summary: summarizeSpanPayload(event.result) },
        );
        break;
      case "runtime_activity": {
        const key = `tool:${event.callId ?? event.name ?? event.label ?? "acp_tool"}`;
        if (event.status === "running") {
          if (!this.open.has(key)) {
            this.start(
              key,
              {
                kind: "tool",
                name: event.name ?? event.label ?? "tool",
                parentSpanId: this.turnParent(links.attemptId),
                summary: summarizeSpanPayload(event.args ?? event.path ?? event.label),
              },
              links,
            );
          }
          break;
        }
        this.closeKey(
          key,
          event.status === "failed" || event.status === "declined" ? "failed" : "succeeded",
          {
            summary: summarizeSpanPayload(
              event.result ?? event.path ?? event.label ?? event.status,
            ),
          },
        );
        break;
      }
      case "context_usage":
        this.patchOpenLlm(links.attemptId, {
          contextTokens: event.estimatedTokens,
          contextSize: event.maxContextTokens,
          costMinor: event.costMinor,
        });
        break;
      case "done":
        this.flush("succeeded");
        break;
      case "error":
        this.flush("failed");
        break;
      default:
        break;
    }
  }

  flush(status: ActivitySpanRecord["status"] = "succeeded"): void {
    for (const key of [...this.open.keys()]) {
      this.closeKey(key, status);
    }
    this.turnByAttempt.clear();
    this.activeLlmByAttempt.clear();
  }

  private turnParent(attemptId: string): string {
    return this.turnByAttempt.get(attemptId) ?? attemptParentId(attemptId);
  }

  private start(
    key: string,
    input: {
      kind: ActivitySpanKind;
      name: string;
      parentSpanId: string;
      summary?: string;
    },
    links: SpanRecorderLinks,
  ): void {
    const span: ActivitySpanRecord = {
      spanId: this.id(),
      parentSpanId: input.parentSpanId,
      kind: input.kind,
      name: input.name,
      status: "running",
      startedAt: this.options.now(),
      summary: input.summary,
    };
    this.open.set(key, { key, span, links });
    if (input.kind === "turn") {
      this.turnByAttempt.set(links.attemptId, span.spanId);
    }
    this.options.emit(SPAN_STARTED, { ...span }, links);
  }

  private patchOpenLlm(
    attemptId: string,
    patch: Partial<ActivitySpanRecord>,
  ): void {
    const key = this.activeLlmByAttempt.get(attemptId);
    if (!key) return;
    const open = this.open.get(key);
    if (!open) return;
    open.span = { ...open.span, ...patch };
  }

  private closeKey(
    key: string,
    status: ActivitySpanRecord["status"],
    patch?: Partial<
      Pick<
        ActivitySpanRecord,
        | "summary"
        | "promptTokens"
        | "completionTokens"
        | "cachedTokens"
        | "costMinor"
        | "usageEstimated"
        | "contextTokens"
        | "contextSize"
      >
    >,
  ): void {
    const open = this.open.get(key);
    if (!open) return;
    this.open.delete(key);
    const endedAt = this.options.now();
    const startedMs = Date.parse(open.span.startedAt);
    const endedMs = Date.parse(endedAt);
    const finished: ActivitySpanRecord = {
      ...open.span,
      ...patch,
      status,
      endedAt,
      durationMs:
        Number.isFinite(startedMs) && Number.isFinite(endedMs)
          ? Math.max(0, endedMs - startedMs)
          : undefined,
      summary: patch?.summary ?? open.span.summary,
    };
    this.options.emit(SPAN_ENDED, finished, open.links);
  }
}

type LlmEndEvent = Extract<AgentEvent, { type: "llm_end" }>;

function llmUsagePatch(event: LlmEndEvent): Partial<ActivitySpanRecord> {
  const patch: Partial<ActivitySpanRecord> = {
    summary: formatLlmUsageSummary(event),
  };
  if (typeof event.promptTokens === "number") patch.promptTokens = event.promptTokens;
  if (typeof event.completionTokens === "number") {
    patch.completionTokens = event.completionTokens;
  }
  if (typeof event.cachedTokens === "number") patch.cachedTokens = event.cachedTokens;
  if (typeof event.costMinor === "number") patch.costMinor = event.costMinor;
  if (event.usageSource === "estimate") patch.usageEstimated = true;
  if (typeof event.contextTokens === "number") patch.contextTokens = event.contextTokens;
  if (typeof event.contextSize === "number") patch.contextSize = event.contextSize;
  return patch;
}

function formatLlmUsageSummary(event: LlmEndEvent): string {
  const parts: string[] = [];
  if (typeof event.promptTokens === "number" || typeof event.completionTokens === "number") {
    const prompt = formatTokenCount(event.promptTokens ?? 0);
    const completion = formatTokenCount(event.completionTokens ?? 0);
    const cached =
      typeof event.cachedTokens === "number" && event.cachedTokens > 0
        ? ` (${formatTokenCount(event.cachedTokens)} cached)`
        : "";
    parts.push(`${prompt} → ${completion}${cached}`);
  } else if (
    typeof event.contextTokens === "number" ||
    typeof event.contextSize === "number"
  ) {
    parts.push(
      `${formatTokenCount(event.contextTokens ?? 0)}/${formatTokenCount(event.contextSize ?? 0)} ctx`,
    );
  }
  if (typeof event.costMinor === "number") {
    parts.push(formatMicroUsd(event.costMinor));
  }
  if (event.usageSource === "estimate") parts.push("est.");
  if (parts.length === 0) return event.model ?? "llm";
  return parts.join(" · ");
}

function formatTokenCount(count: number): string {
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}

function formatMicroUsd(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) {
    return `$${usd.toFixed(3)}`.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
  if (usd > 0) {
    return `$${usd.toFixed(6)}`.replace(/0+$/, "").replace(/\.$/, "");
  }
  return "$0";
}
