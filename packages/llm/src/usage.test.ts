import { describe, expect, it } from "vitest";
import {
  estimateLlmCostMicroUsd,
  estimateLlmUsage,
  formatUsdFromMicro,
  parseLlmUsage,
} from "./usage.js";

describe("parseLlmUsage", () => {
  it("reads OpenAI-style usage including cached tokens", () => {
    expect(
      parseLlmUsage({
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        prompt_tokens_details: { cached_tokens: 400 },
        completion_tokens_details: { reasoning_tokens: 20 },
      }),
    ).toEqual({
      promptTokens: 1200,
      completionTokens: 80,
      totalTokens: 1280,
      cachedTokens: 400,
      reasoningTokens: 20,
      source: "api",
    });
  });

  it("accepts input_tokens / output_tokens aliases", () => {
    expect(parseLlmUsage({ input_tokens: 10, output_tokens: 4 })).toMatchObject({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      source: "api",
    });
  });

  it("returns undefined when no token counts are present", () => {
    expect(parseLlmUsage({ foo: 1 })).toBeUndefined();
  });
});

describe("estimateLlmCostMicroUsd", () => {
  it("prices billed prompt and completion against a known model", () => {
    const cost = estimateLlmCostMicroUsd("deepseek-chat", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
      source: "api",
    });
    expect(cost).toBe(Math.round(0.27 * 1_000_000 + 1.1 * 1_000_000));
  });

  it("charges cached tokens at the discounted input rate", () => {
    const cost = estimateLlmCostMicroUsd("gpt-4o-mini", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
      cachedTokens: 1_000_000,
      source: "api",
    });
    expect(cost).toBe(Math.round(0.15 * 0.5 * 1_000_000));
  });

  it("returns undefined for unknown models", () => {
    expect(
      estimateLlmCostMicroUsd("mystery-local", estimateLlmUsage(40, 8)),
    ).toBeUndefined();
  });
});

describe("formatUsdFromMicro", () => {
  it("formats sub-cent costs without rounding them to zero", () => {
    expect(formatUsdFromMicro(42)).toBe("$0.000042");
    expect(formatUsdFromMicro(1_800)).toBe("$0.0018");
    expect(formatUsdFromMicro(18_000)).toBe("$0.018");
  });
});
