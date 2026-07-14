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
});
