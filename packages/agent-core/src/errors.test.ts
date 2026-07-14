import { describe, it, expect } from "vitest";
import { AgentMaxStepsError } from "./errors.js";

describe("AgentMaxStepsError", () => {
  it("carries messages", () => {
    const msgs = [{ role: "user" as const, content: "hi" }];
    const e = new AgentMaxStepsError(msgs);
    expect(e.messages).toEqual(msgs);
    expect(e.message).toContain("最大步数");
  });
});
