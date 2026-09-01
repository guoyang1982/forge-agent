import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@forge/protocol";
import { buildTrace } from "@forge/execution";
import { createRegressionCandidate } from "./regression-case.js";

describe("createRegressionCandidate", () => {
  it("redacts a failed trace before creating a regression candidate", () => {
    const candidate = createRegressionCandidate({
      suiteId: "suite-1",
      caseId: "case-1",
      trace: buildTrace(sensitiveFailedTrace()),
      validators: ["validator.output", "validator.policy"],
      failureReason: "tool output mismatch",
      sensitiveData: {
        apiKey: "secret-token-123",
        nested: { authorization: "Bearer secret-token" },
      },
    });

    expect(JSON.stringify(candidate)).not.toContain("secret-token");
    expect(candidate.validators.length).toBeGreaterThan(0);
    expect((candidate.redactedPayload.sensitiveData as Record<string, unknown>).apiKey).toBe(
      "[REDACTED]",
    );
    expect(candidate.traceFixture.runId).toBe("run-1");
  });
});

function sensitiveFailedTrace(): EventEnvelope[] {
  return [
    event(1, "run.created", { objective: "ship feature", apiKey: "secret-token" }),
    event(2, "step.started", { kind: "test.script", tool: "publish" }),
    event(3, "step.failed", { reason: "secret-token leaked" }),
    event(4, "run.failed", {}),
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
    stepId: type.startsWith("step.") ? "step-1" : undefined,
    attemptId: type.startsWith("step.") ? "attempt-1" : undefined,
    occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
    schemaVersion: 1,
    data,
  };
}
