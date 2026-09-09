import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentEventFromCoreNotification } from "./core-event-bridge.js";
import type { EventEnvelope } from "@forge/protocol";

const here = dirname(fileURLToPath(import.meta.url));

function envelope(type: string, data: Record<string, unknown>): EventEnvelope {
  return {
    eventId: "e1",
    sequence: 1,
    type,
    subject: { kind: "human", id: "local-user" },
    correlationId: "c1",
    runId: "run-1",
    occurredAt: "2026-09-09T06:51:25.000Z",
    schemaVersion: 1,
    data,
  };
}

describe("agentEventFromCoreNotification", () => {
  it("unwraps durable agent.event envelopes for the desktop live stream", () => {
    const ev = agentEventFromCoreNotification(
      envelope("agent.event", {
        compatibility: true,
        legacyEventType: "text_delta",
        sessionId: "sess-1",
        delta: "好的",
        runId: "run-1",
        stepId: "step-1",
        attemptId: "att-1",
        correlationId: "c1",
      }),
    );

    expect(ev).toMatchObject({
      type: "text_delta",
      sessionId: "sess-1",
      delta: "好的",
    });
  });

  it("ignores non-agent CoreEvents", () => {
    expect(
      agentEventFromCoreNotification(
        envelope("run.created", { compatibility: true, legacyEventType: "status" }),
      ),
    ).toBeNull();
  });
});

describe("desktop daemon event subscriber", () => {
  it("forwards CoreEvent agent.event notifications onto the renderer stream", () => {
    const source = readFileSync(join(here, "main.ts"), "utf8");
    expect(source).toContain("agentEventFromCoreNotification");
    expect(source).toContain("client.onNotification");
    const subscriber =
      source.match(
        /async function ensureDaemonEventSubscriber[\s\S]*?\n}\n/,
      )?.[0] ?? "";
    expect(subscriber).toContain("onNotification");
    expect(subscriber).toContain("agentEventFromCoreNotification");
    expect(subscriber).toContain("sendAgentEvent");
  });
});
