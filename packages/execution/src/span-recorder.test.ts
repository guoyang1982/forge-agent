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
    recorder.onAgentEvent({ type: "llm_end", model: "gpt-test", durationMs: 12 }, links);
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
