import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@forge/protocol";
import { applyRequestedModel } from "./profiles.js";

function cfgWithProfiles() {
  return {
    ...DEFAULT_CONFIG,
    activeProfile: "dashscope",
    model: {
      ...DEFAULT_CONFIG.model,
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "dash-key",
      name: "qwen3.7-plus",
    },
    profiles: {
      dashscope: {
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "dash-key",
        name: "qwen3.7-plus",
      },
      deepseek: {
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKey: "ds-key",
        name: "deepseek-v4-flash",
      },
    },
  };
}

describe("applyRequestedModel", () => {
  it("switches to the matching profile by model name", () => {
    const next = applyRequestedModel(cfgWithProfiles(), "deepseek-v4-flash");
    expect(next.activeProfile).toBe("deepseek");
    expect(next.model.name).toBe("deepseek-v4-flash");
    expect(next.model.baseUrl).toBe("https://api.deepseek.com");
    expect(next.model.apiKey).toBe("ds-key");
  });

  it("switches to a profile by id", () => {
    const next = applyRequestedModel(cfgWithProfiles(), "deepseek");
    expect(next.activeProfile).toBe("deepseek");
    expect(next.model.name).toBe("deepseek-v4-flash");
    expect(next.model.apiKey).toBe("ds-key");
  });

  it("overrides only the model name when no profile matches", () => {
    const next = applyRequestedModel(cfgWithProfiles(), "gpt-4o");
    expect(next.activeProfile).toBe("dashscope");
    expect(next.model.name).toBe("gpt-4o");
    expect(next.model.baseUrl).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
  });

  it("keeps the current config when the override is empty", () => {
    const cfg = cfgWithProfiles();
    expect(applyRequestedModel(cfg, "")).toBe(cfg);
    expect(applyRequestedModel(cfg, undefined)).toBe(cfg);
  });
});
