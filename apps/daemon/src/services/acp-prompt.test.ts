import { describe, expect, it } from "vitest";
import { buildAcpPromptBlocks, expandRunPromptText } from "./acp-prompt.js";
import type { RunRequest } from "@forge/protocol";

function request(message: string): RunRequest {
  return {
    sessionId: "s1",
    cwd: "/tmp/project",
    message,
  };
}

describe("acp-prompt", () => {
  it("injects image generation file rules into ACP prompt blocks", () => {
    const blocks = buildAcpPromptBlocks(request("生成个小花图片"));
    const text = blocks.find((block) => block.type === "text")?.text ?? "";

    expect(text).toContain("create a real image file in the workspace");
    expect(text).toContain("include its relative path in the final answer");
    expect(text).toContain("Do not say an image was generated unless");
    expect(text).toContain("生成个小花图片");
  });

  it("injects image generation file rules into expanded Codex text prompts", () => {
    const text = expandRunPromptText(request("生成个小花图片"));

    expect(text).toContain("create a real image file in the workspace");
    expect(text).toContain("include its relative path in the final answer");
  });

  it("allows external runtimes to use direct Computer Use MCP tools", () => {
    const text = expandRunPromptText(request("打开终端并查看当前状态"));

    expect(text).toContain("Computer Use compatibility");
    expect(text).toContain("use them directly");
    expect(text).toContain("do not refuse merely because node_repl is absent");
  });

  it("emits every attached image as its own ACP image block", () => {
    const blocks = buildAcpPromptBlocks({
      ...request("请对比这两张图"),
      attachments: [
        {
          kind: "image",
          name: "a.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,aaa",
        },
        {
          kind: "image",
          name: "b.jpeg",
          mimeType: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,bbb",
        },
        {
          kind: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          text: "plain notes",
        },
      ],
    });
    const images = blocks.filter((block) => block.type === "image");
    expect(images).toEqual([
      { type: "image", mimeType: "image/png", data: "aaa" },
      { type: "image", mimeType: "image/jpeg", data: "bbb" },
    ]);
    const text = blocks.find((block) => block.type === "text")?.text ?? "";
    expect(text).toContain("请对比这两张图");
    expect(text).toContain("notes.txt");
    expect(text).toContain("plain notes");
    expect(text).toContain("[Image attached: a.png");
    expect(text).toContain("[Image attached: b.jpeg");
  });

  it("requires a standalone final conclusion separate from mid-turn process narration", () => {
    const text = expandRunPromptText(request("分析一下这个方案"));

    expect(text).toContain("Turn output contract");
    expect(text).toContain("standalone final answer");
    expect(text).toContain("结论");
    expect(text).toContain("分析一下这个方案");
  });
});
