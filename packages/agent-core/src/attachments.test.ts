import { describe, expect, it } from "vitest";
import {
  buildUserMessageContent,
  modelSupportsVision,
  normalizeImageDataUrl,
  resolveSupportsVision,
} from "./attachments.js";

describe("modelSupportsVision", () => {
  it("detects common vision models", () => {
    expect(modelSupportsVision("gpt-4o")).toBe(true);
    expect(modelSupportsVision("gpt-5.5")).toBe(true);
    expect(modelSupportsVision("claude-sonnet-4")).toBe(true);
    expect(modelSupportsVision("deepseek-v4-pro")).toBe(true);
    expect(modelSupportsVision("qwen3.7-plus")).toBe(true);
    expect(modelSupportsVision("deepseek-chat")).toBe(false);
  });

  it("respects config override", () => {
    expect(resolveSupportsVision("deepseek-chat", true)).toBe(true);
    expect(resolveSupportsVision("gpt-4o", false)).toBe(false);
  });
});

describe("buildUserMessageContent", () => {
  it("normalizes raw base64 to data URL", () => {
    expect(normalizeImageDataUrl("abc123", "image/jpeg")).toBe(
      "data:image/jpeg;base64,abc123",
    );
  });

  it("builds multimodal parts when vision is supported", () => {
    const content = buildUserMessageContent(
      "what is this",
      [
        {
          kind: "image",
          name: "a.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,abc",
        },
      ],
      true,
    );
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual(
      expect.arrayContaining([
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc", detail: "auto" } },
      ]),
    );
  });

  it("defaults prompt when only document files attached", () => {
    const content = buildUserMessageContent(
      "",
      [
        {
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          text: "Chapter 1\nHello",
        },
      ],
      false,
    );
    expect(typeof content).toBe("string");
    expect(content).toContain("Attached document");
    expect(content).toContain("请分析以上附件文档");
  });

  it("keeps every image and document in one turn", () => {
    const content = buildUserMessageContent(
      "compare these",
      [
        {
          kind: "image",
          name: "a.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,aaa",
        },
        {
          kind: "image",
          name: "b.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,bbb",
        },
        {
          kind: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          text: "hello notes",
        },
        {
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          text: "chapter one",
        },
      ],
      true,
    );
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<Record<string, unknown>>;
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2);
    const text = String(parts.find((p) => p.type === "text")?.text ?? "");
    expect(text).toContain("compare these");
    expect(text).toContain("Attached document: notes.txt");
    expect(text).toContain("Attached document: report.pdf");
    expect(text).toContain("hello notes");
    expect(text).toContain("chapter one");
  });

  it("notes skipped images when vision unsupported", () => {
    const content = buildUserMessageContent(
      "hi",
      [
        {
          kind: "image",
          name: "a.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,abc",
        },
      ],
      false,
    );
    expect(typeof content).toBe("string");
    expect(content).toContain("未启用视觉");
  });
});
