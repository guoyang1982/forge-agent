import { describe, expect, it } from "vitest";
import { hasPassedDeliveryLayers } from "./delivery-validation.js";

describe("delivery validation", () => {
  it("requires result, process, and answer to pass", () => {
    expect(hasPassedDeliveryLayers([
      { layer: "result", status: "passed" },
      { layer: "process", status: "passed" },
    ])).toBe(false);
    expect(hasPassedDeliveryLayers([
      { layer: "result", status: "passed" },
      { layer: "process", status: "passed" },
      { layer: "answer", status: "passed" },
    ])).toBe(true);
  });
});
