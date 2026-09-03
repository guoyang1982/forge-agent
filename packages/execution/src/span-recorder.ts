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
          this.closeKey(key, "succeeded", event.model);
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
        this.closeKey(
          `thinking:${links.attemptId}`,
          "succeeded",
          `${event.charCount} chars`,
        );
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
          summarizeSpanPayload(event.result),
        );
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

  private closeKey(
    key: string,
    status: ActivitySpanRecord["status"],
    summary?: string,
  ): void {
    const open = this.open.get(key);
    if (!open) return;
    this.open.delete(key);
    const endedAt = this.options.now();
    const startedMs = Date.parse(open.span.startedAt);
    const endedMs = Date.parse(endedAt);
    const finished: ActivitySpanRecord = {
      ...open.span,
      status,
      endedAt,
      durationMs:
        Number.isFinite(startedMs) && Number.isFinite(endedMs)
          ? Math.max(0, endedMs - startedMs)
          : undefined,
      summary: summary ?? open.span.summary,
    };
    this.options.emit(SPAN_ENDED, finished, open.links);
  }
}
