import { describe, expect, it } from "vitest";
import { buildModelPatch, formatProvidersList, getProvider } from "./providers.js";

describe("MODEL_PROVIDERS", () => {
  it("includes deepseek v4 models", () => {
    const p = getProvider("deepseek");
    expect(p?.baseUrl).toBe("https://api.deepseek.com");
    expect(p?.models.map((m) => m.id)).toContain("deepseek-v4-pro");
    expect(p?.models.map((m) => m.id)).toContain("deepseek-v4-flash");
  });

  it("buildModelPatch sets provider baseUrl and thinking for v4-pro", () => {
    const patch = buildModelPatch("deepseek", "deepseek-v4-pro");
    expect(patch.provider).toBe("deepseek");
    expect(patch.name).toBe("deepseek-v4-pro");
    expect(patch.options?.thinking?.type).toBe("enabled");
    expect(patch.options?.reasoning_effort).toBe("high");
  });

  it("includes dashscope qwen3.7-plus", () => {
    const p = getProvider("dashscope");
    expect(p?.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(p?.models.map((m) => m.id)).toContain("qwen3.7-plus");
    const patch = buildModelPatch("dashscope", "qwen3.7-plus");
    expect(patch.name).toBe("qwen3.7-plus");
  });

  it("formatProvidersList includes provider id", () => {
    const text = formatProvidersList("deepseek");
    expect(text).toContain("deepseek");
    expect(text).toContain("deepseek-v4-flash");
  });
});
