import { describe, it, expect } from "vitest";
import { buildMaxStepsContinueHint } from "./hints.js";

describe("buildMaxStepsContinueHint", () => {
  it("includes user task snippet when provided", () => {
    const hint = buildMaxStepsContinueHint("完善坦克大战游戏");
    expect(hint).toMatch(/继续完成：完善坦克大战游戏/);
    expect(hint).toMatch(/forge config set limits\.maxSteps/);
  });

  it("uses generic continue text when message empty", () => {
    const hint = buildMaxStepsContinueHint("");
    expect(hint).toMatch(/继续完成剩余工作/);
  });
});
