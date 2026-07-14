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
});
