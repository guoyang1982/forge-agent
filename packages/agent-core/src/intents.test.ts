import { describe, expect, it } from "vitest";
import { looksLikeCodingTask } from "./intents.js";

describe("looksLikeCodingTask", () => {
  it("detects file paths and action verbs", () => {
    expect(looksLikeCodingTask("给我处理下 TankBattle_new.py")).toBe(true);
    expect(looksLikeCodingTask("继续完成优化")).toBe(true);
    expect(looksLikeCodingTask("@src/foo.ts fix bug")).toBe(true);
  });

  it("ignores casual chat", () => {
    expect(looksLikeCodingTask("你好")).toBe(false);
    expect(looksLikeCodingTask("谢谢")).toBe(false);
  });
});
