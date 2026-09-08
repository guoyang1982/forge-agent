import { describe, expect, it } from "vitest";
import {
  SpanRecorder,
  SPAN_ENDED,
  SPAN_STARTED,
  summarizeSpanPayload,
  type ActivitySpanRecord,
  type SpanRecorderLinks,
} from "./span-recorder.js";

describe("SpanRecorder", () => {
  it("nests llm and tool spans under a turn", () => {
    const emitted: Array<{ type: string; span: ActivitySpanRecord }> = [];
    const recorder = new SpanRecorder({
      now: clock(),
      id: ids("s"),
      emit: (type, span) => emitted.push({ type, span }),
    });
    const links = sampleLinks();

    recorder.onAgentEvent({ type: "step_start", step: 1, maxSteps: 8 }, links);
    recorder.onAgentEvent({ type: "llm_start", model: "gpt-test" }, links);
    recorder.onAgentEvent(
      {
        type: "llm_end",
        model: "gpt-test",
        durationMs: 12,
        promptTokens: 1200,
        completionTokens: 80,
        cachedTokens: 200,
        costMinor: 18_000,
        usageSource: "api",
      },
      links,
    );
    recorder.onAgentEvent(
      { type: "tool_start", callId: "c1", name: "read_file", args: { path: "a.ts" } },
      links,
    );
    recorder.onAgentEvent(
      { type: "tool_end", callId: "c1", name: "read_file", result: '{"ok":true}' },
      links,
    );
    recorder.onAgentEvent({ type: "done", sessionId: "sess-1" }, links);

    const started = emitted.filter((row) => row.type === SPAN_STARTED).map((row) => row.span);
    const ended = emitted.filter((row) => row.type === SPAN_ENDED).map((row) => row.span);
    const turn = started.find((span) => span.kind === "turn");
    const llm = started.find((span) => span.kind === "llm");
    const tool = started.find((span) => span.kind === "tool");

    expect(turn?.parentSpanId).toBe("attempt:attempt-1");
    expect(llm?.parentSpanId).toBe(turn?.spanId);
    expect(tool?.parentSpanId).toBe(turn?.spanId);
    expect(tool?.summary).toContain("a.ts");
    expect(ended.map((span) => span.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    const llmEnded = ended.find((span) => span.kind === "llm");
    expect(llmEnded?.promptTokens).toBe(1200);
    expect(llmEnded?.completionTokens).toBe(80);
    expect(llmEnded?.costMinor).toBe(18_000);
    expect(llmEnded?.summary).toContain("$0.018");
    expect(llmEnded?.summary).toContain("1.2k → 80");
  });

  it("truncates tool payloads and marks failed tools", () => {
    expect(summarizeSpanPayload("x".repeat(10), 4)).toBe("xxxx…");
    const emitted: ActivitySpanRecord[] = [];
    const recorder = new SpanRecorder({
      now: clock(),
      id: ids("f"),
      emit: (type, span) => {
        if (type === SPAN_ENDED) emitted.push(span);
      },
    });
    recorder.onAgentEvent(
      { type: "tool_start", callId: "boom", name: "write_file", args: { path: "x" } },
      sampleLinks(),
    );
    recorder.onAgentEvent(
      {
        type: "tool_end",
        callId: "boom",
        name: "write_file",
        result: JSON.stringify({ ok: false, error: "EACCES" }),
      },
      sampleLinks(),
    );
    expect(emitted[0]?.status).toBe("failed");
    expect(emitted[0]?.summary).toContain("EACCES");
  });

  it("records Cursor ACP context usage and runtime tools", () => {
    const ended: ActivitySpanRecord[] = [];
    const recorder = new SpanRecorder({
      now: clock(),
      id: ids("c"),
      emit: (type, span) => {
        if (type === SPAN_ENDED) ended.push(span);
      },
    });
    const links = sampleLinks();
    recorder.onAgentEvent({ type: "llm_start", model: "cursor" }, links);
    recorder.onAgentEvent(
      {
        type: "context_usage",
        estimatedTokens: 53000,
        maxContextTokens: 200000,
        costMinor: 45_000,
      },
      links,
    );
    recorder.onAgentEvent(
      {
        type: "runtime_activity",
        runtime: "cursor",
        activityKind: "file",
        status: "running",
        callId: "edit-1",
        name: "Edit File",
        path: "game.html",
      },
      links,
    );
    recorder.onAgentEvent(
      {
        type: "runtime_activity",
        runtime: "cursor",
        activityKind: "file",
        status: "done",
        callId: "edit-1",
        name: "Edit File",
        path: "game.html",
      },
      links,
    );
    recorder.onAgentEvent(
      {
        type: "llm_end",
        model: "cursor",
        contextTokens: 53000,
        contextSize: 200000,
        costMinor: 45_000,
      },
      links,
    );
    const llm = ended.find((span) => span.kind === "llm");
    const tool = ended.find((span) => span.kind === "tool");
    expect(llm?.contextTokens).toBe(53000);
    expect(llm?.contextSize).toBe(200000);
    expect(llm?.costMinor).toBe(45_000);
    expect(llm?.summary).toContain("53k/200k ctx");
    expect(tool?.name).toBe("Edit File");
    expect(tool?.status).toBe("succeeded");
  });
});

function sampleLinks(): SpanRecorderLinks {
  return { runId: "run-1", stepId: "step-1", attemptId: "attempt-1" };
}

function clock(): () => string {
  let n = 0;
  return () => `2026-01-01T00:00:0${n++}.000Z`;
}

function ids(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}
