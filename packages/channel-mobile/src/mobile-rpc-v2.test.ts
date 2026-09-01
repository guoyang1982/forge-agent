import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@forge/protocol";
import { MobileRpcV2Router } from "./mobile-rpc-v2.js";

function event(sequence: number): EventEnvelope {
  return {
    eventId: `event-${sequence}`,
    sequence,
    type: "run.updated",
    subject: { kind: "run", id: "r1" },
    correlationId: "corr-1",
    runId: "r1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    data: {},
  };
}

describe("MobileRpcV2Router", () => {
  it("resumes mobile events from the last sequence", async () => {
    const emitted: number[] = [];
    const router = new MobileRpcV2Router({
      daemon: {
        async request(method, params) {
          expect(method).toBe("events.read");
          expect(params).toMatchObject({
            cursor: 12,
            filter: { runId: "run_12345678" },
          });
          return { events: [event(13), event(14)] };
        },
      },
    });

    const result = await router.resumeRun(
      {
        runId: "run_12345678",
        cursor: 12,
        subscriptionId: "subscription_12345678",
      },
      (frame) => {
        if (typeof frame.cursor === "number") emitted.push(frame.cursor);
      },
    );

    expect(result.sequences).toEqual([13, 14]);
    expect(emitted).toEqual([13, 14]);
  });
});
