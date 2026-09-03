import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@forge/protocol";
import { buildTrace, exportTraceEvalFixture, toTraceTree } from "./trace.js";

describe("buildTrace", () => {
  it("links run, step and attempt spans", () => {
    const trace = buildTrace(runEventsFixture());
    expect(trace.root.runId).toBe("run-1");
    expect(trace.steps[0]?.parentSpanId).toBe(trace.root.spanId);
    expect(trace.steps[0]?.attempts[0]?.parentSpanId).toBe(trace.steps[0]?.spanId);
  });

  it("collects model, tool, version and artifact summaries", () => {
    const trace = buildTrace(runEventsFixture());
    expect(trace.summaries.models).toEqual(["gpt-test"]);
    expect(trace.summaries.tools).toEqual(["publish"]);
    expect(trace.summaries.versions).toEqual(["v2"]);
    expect(trace.summaries.totalCostMinor).toBe(42n);
    expect(trace.steps[0]?.attempts[0]?.outputRef).toBe("artifact:output-1");
  });

  it("exports a redacted eval fixture without raw event payloads", () => {
    const fixture = exportTraceEvalFixture(buildTrace(runEventsFixture()));
    expect(fixture).toEqual({
      runId: "run-1",
      correlationId: "corr-1",
      state: "succeeded",
      stepCount: 1,
      attemptCount: 1,
      summaries: {
        models: ["gpt-test"],
        tools: ["publish"],
        versions: ["v2"],
        totalCostMinor: 42,
      },
      artifactRefs: ["artifact:output-1"],
    });
    expect(JSON.stringify(fixture)).not.toContain("secret-token");
  });

  it("nests activity spans under the attempt", () => {
    const events = [
      ...runEventsFixture(),
      event(5, "span.started", {
        spanId: "turn-1",
        parentSpanId: "attempt:attempt-1",
        kind: "turn",
        name: "turn 1",
        status: "running",
      }),
      event(6, "span.started", {
        spanId: "llm-1",
        parentSpanId: "turn-1",
        kind: "llm",
        name: "gpt-test",
        status: "running",
      }),
      event(7, "span.ended", {
        spanId: "llm-1",
        parentSpanId: "turn-1",
        kind: "llm",
        name: "gpt-test",
        status: "succeeded",
        durationMs: 12,
      }),
    ];
    const tree = toTraceTree(buildTrace(events));
    const attempt = tree.children[0]?.children[0];
    const turn = attempt?.children.find((node) => node.kind === "turn");
    expect(turn?.children.some((node) => node.kind === "llm")).toBe(true);
  });
});

function runEventsFixture(): EventEnvelope[] {
  return [
    event(1, "run.created", { objective: "ship feature" }),
    event(2, "step.started", {
      kind: "test.script",
      model: "gpt-test",
      tool: "publish",
      version: "v2",
      costMinor: 42,
    }),
    event(3, "step.succeeded", { outputRef: "artifact:output-1" }),
    event(4, "run.succeeded", {}),
  ];
}

function event(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): EventEnvelope {
  return {
    eventId: `event-${sequence}`,
    sequence,
    type,
    subject: { kind: "agent_profile", id: "forge-default" },
    correlationId: "corr-1",
    runId: "run-1",
    stepId: type.startsWith("step.") || type.startsWith("span.") ? "step-1" : undefined,
    attemptId: type.startsWith("step.") || type.startsWith("span.") ? "attempt-1" : undefined,
    occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
    schemaVersion: 1,
    data,
  };
}
