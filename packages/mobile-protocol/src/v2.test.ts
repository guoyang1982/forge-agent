import { describe, expect, it } from "vitest";
import {
  isMobileV2Method,
  isMobileV2OnlyMethod,
  mobileRunResumeParamsV2Schema,
  parseMobileRpcFrameV2,
} from "./v2.js";

describe("mobile protocol v2", () => {
  it("accepts v2-only run.resume requests", () => {
    const frame = parseMobileRpcFrameV2(
      JSON.stringify({
        type: "rpc.request",
        id: "request_12345678",
        protocolVersion: 2,
        method: "run.resume",
        params: {
          runId: "run_12345678",
          cursor: 12,
          subscriptionId: "subscription_12345678",
        },
      }),
    );
    expect(frame).toMatchObject({ method: "run.resume" });
    expect(isMobileV2OnlyMethod("run.resume")).toBe(true);
    expect(isMobileV2Method("status.get")).toBe(true);
    expect(isMobileV2Method("get_config")).toBe(false);
  });

  it("validates resume params and event cursor envelopes", () => {
    expect(
      mobileRunResumeParamsV2Schema.parse({
        runId: "run_12345678",
        cursor: 12,
        subscriptionId: "subscription_12345678",
      }).cursor,
    ).toBe(12);
    expect(
      parseMobileRpcFrameV2(
        JSON.stringify({
          type: "rpc.event",
          protocolVersion: 2,
          subscriptionId: "subscription_12345678",
          seq: 0,
          cursor: 13,
          event: { sequence: 13, type: "run.updated" },
        }),
      ),
    ).toMatchObject({ cursor: 13 });
  });
});
