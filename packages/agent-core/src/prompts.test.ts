import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompts.js";

describe("buildSystemPrompt automation notifications", () => {
  it("tells Forge to execute whitelisted git inspection commands itself", () => {
    const prompt = buildSystemPrompt({
      cwd: "/tmp/proj",
      agentsMd: "",
      gitStatus: " M package.json",
    });

    expect(prompt).toContain("git status/diff/branch/log/fetch");
    expect(prompt).toContain("Do not ask the user to run these commands");
  });

  it("requires image generation requests to create a concrete file path", () => {
    const prompt = buildSystemPrompt({
      cwd: "/tmp/proj",
      agentsMd: "",
      gitStatus: "(not a git repository)",
    });

    expect(prompt).toContain("generate/create an image");
    expect(prompt).toContain("actual image file");
    expect(prompt).toContain("Do not say an image was generated unless a concrete file path exists");
  });

  it("prefers direct Computer Use MCP tools over the skill's node_repl transport", () => {
    const prompt = buildSystemPrompt({
      cwd: "/tmp/proj",
      agentsMd: "",
      gitStatus: "(not a git repository)",
    });

    expect(prompt).toContain("mcp_computer_use_list_apps");
    expect(prompt).toContain("Do not use node_repl for Computer Use");
    expect(prompt).toContain("direct MCP tools are present");
    expect(prompt).toContain("do not switch to Chrome/Browser skills");
    expect(prompt).toContain("cannot import plugin browser-client modules");
    expect(prompt).toContain("mcp__node_repl__js");
    expect(prompt).toContain("save_screenshot_to");
    expect(prompt).toContain("Never substitute macOS screencapture");
    expect(prompt).toContain("full-desktop screenshot");
  });

  it("tells automation runs with iLink notification not to set up push services", () => {
    const prompt = buildSystemPrompt({
      cwd: "/tmp/proj",
      agentsMd: "",
      gitStatus: "(not a git repository)",
      automationRun: {
        name: "AI news",
        notification: { channelKind: "ilink" },
      },
    });

    expect(prompt).toContain("Forge will send the final result to ilink");
    expect(prompt).toContain("Do NOT set up or ask for PushPlus");
    expect(prompt).toContain("Do NOT claim the notification has already been sent");
  });

  it("requires a standalone final conclusion separate from mid-turn process narration", () => {
    const prompt = buildSystemPrompt({
      cwd: "/tmp/proj",
      agentsMd: "",
      gitStatus: "(not a git repository)",
    });

    expect(prompt).toContain("Turn output contract");
    expect(prompt).toContain("activity stream");
    expect(prompt).toContain("standalone final answer");
    expect(prompt).toContain("结论");
    expect(prompt).toContain("Do not bury the lasting answer only in mid-turn text");
  });
});
