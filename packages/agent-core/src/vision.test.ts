import { describe, expect, it } from "vitest";
import {
  prepareAttachmentsForVision,
  resolveSupportsNativeImageUrl,
  resolveVisionMode,
} from "./vision.js";

describe("resolveVisionMode", () => {
  it("defaults to auto", () => {
    expect(resolveVisionMode({} as never)).toBe("auto");
  });

  it("maps legacy proxy to auto", () => {
    expect(resolveVisionMode({ visionMode: "proxy" } as never)).toBe("auto");
  });
});

describe("resolveSupportsNativeImageUrl", () => {
  it("follows model name heuristic", () => {
    expect(resolveSupportsNativeImageUrl("deepseek-v4-pro")).toBe(true);
    expect(resolveSupportsNativeImageUrl("deepseek-chat")).toBe(false);
  });

  it("respects vision: true override", () => {
    expect(
      resolveSupportsNativeImageUrl("deepseek-chat", undefined, { vision: true }),
    ).toBe(true);
  });
});

describe("prepareAttachmentsForVision", () => {
  it("skips images for non-vision models", () => {
    const r = prepareAttachmentsForVision(
      {
        model: {
          baseUrl: "https://api.example.com/v1",
          apiKey: "k",
          name: "deepseek-chat",
        },
        limits: { maxSteps: 10, toolResultMaxChars: 1000, maxContextTokens: 1000 },
        daemon: { socketPath: "", dataDir: "" },
      },
      [
        {
          kind: "image",
          name: "a.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,ab",
        },
      ],
    );
    expect(r.strategy).toBe("skipped");
    expect(r.skipReason).toContain("未标记为支持视觉");
  });
});
