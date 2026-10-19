import { describe, expect, it } from "vitest";
import { parseCursorModelListText } from "./cursor-runtime.js";

describe("cursor-agent model catalog", () => {
  it("skips the header and keeps id plus display name", () => {
    const models = parseCursorModelListText(`
Available models

auto - Auto (current, default)
gpt-5.6-sol-high - GPT-5.6 Sol 1M High
composer-2.5 - Composer 2.5
claude-fable-5-thinking-high - Claude Fable 5 1M Thinking (NO ZDR)
composer (default)
`);
    expect(models.map((model) => model.model)).toEqual([
      "auto",
      "composer",
      "gpt-5.6-sol-high",
      "composer-2.5",
      "claude-fable-5-thinking-high",
    ]);
    expect(models[0]).toMatchObject({ displayName: "Auto", isDefault: true });
    expect(models.find((model) => model.model === "composer")).toMatchObject({
      displayName: "composer",
      isDefault: true,
    });
    expect(models.find((model) => model.model === "claude-fable-5-thinking-high")).toMatchObject({
      displayName: "Claude Fable 5 1M Thinking (NO ZDR)",
      isDefault: false,
    });
    expect(models.some((model) => model.model === "Available models")).toBe(false);
  });
});
