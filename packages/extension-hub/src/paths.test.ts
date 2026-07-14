import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentTargetPath } from "./paths.js";

describe("resolveAgentTargetPath", () => {
  it("expands ~ for user scope instead of joining onto cwd", () => {
    const p = resolveAgentTargetPath("forge", "plugin", "user", "demo", "/some/cwd");
    expect(p).toBe(join(homedir(), ".forge-agent/plugins/demo"));
    expect(p).not.toContain("~");
    expect(p).not.toContain("/some/cwd");
  });

  it("joins relative project roots onto cwd", () => {
    const p = resolveAgentTargetPath("cursor", "plugin", "project", "demo", "/some/cwd");
    expect(p).toBe(join("/some/cwd", ".cursor/plugins/local/demo"));
  });

  it("resolves user-scope skills under the home directory", () => {
    const p = resolveAgentTargetPath("claude-code", "skill", "user", "sk");
    expect(p).toBe(join(homedir(), ".claude/skills/sk"));
  });
});
