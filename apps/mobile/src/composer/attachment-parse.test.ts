import { describe, expect, it } from "vitest";
import { stripDataUrlBase64 } from "./attachment-types.js";
import { textForSpeech } from "../voice/speech-text.js";

describe("clipboard image parsing", () => {
  it("parses data URLs", () => {
    expect(stripDataUrlBase64("data:image/png;base64,abc123")).toEqual({
      mimeType: "image/png",
      base64: "abc123",
    });
  });

  it("accepts raw base64 payloads", () => {
    const raw = "a".repeat(40);
    expect(stripDataUrlBase64(raw)).toEqual({ mimeType: "image/png", base64: raw });
  });

  it("rejects garbage", () => {
    expect(stripDataUrlBase64("hello")).toBeNull();
  });
});

describe("textForSpeech", () => {
  it("softens markdown for TTS", () => {
    expect(textForSpeech("**你好** 看 `code`")).toContain("你好");
    expect(textForSpeech("```ts\nconst a=1\n```\n完成")).toContain("代码块");
    expect(textForSpeech("完成")).toBe("完成");
  });
});
