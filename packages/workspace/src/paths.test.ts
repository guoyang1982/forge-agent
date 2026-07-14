import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceGuard } from "./index.js";
import {
  normalizeAgentFilePath,
  normalizeCommandForWorkspace,
  stripMistakenWorkspacePrefix,
  toWorkspaceRelativePath,
} from "./paths.js";

describe("normalizeAgentFilePath", () => {
  it("restores leading slash on macOS-style Users paths", () => {
    expect(normalizeAgentFilePath("Users/alice/.forge-agent/foo.md")).toBe(
      "/Users/alice/.forge-agent/foo.md",
    );
  });
});

describe("stripMistakenWorkspacePrefix", () => {
  it("removes cwd wrongly prepended to a home-absolute path", () => {
    const cwd = "/Users/alice/Projects/demo";
    const wrong =
      "/Users/alice/Projects/demo/Users/alice/.forge-agent/plugins/superpowers/vendor/superpowers/skills/brainstorming/SKILL.md";
    expect(stripMistakenWorkspacePrefix(cwd, wrong)).toBe(
      "/Users/alice/.forge-agent/plugins/superpowers/vendor/superpowers/skills/brainstorming/SKILL.md",
    );
  });
});

describe("toWorkspaceRelativePath", () => {
  it("maps mistaken absolute path to workspace file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-path-"));
    writeFileSync(join(dir, "TankBattle_new.py"), "print('ok')\n", "utf-8");
    const guard = await WorkspaceGuard.ensure(dir);
    const rel = toWorkspaceRelativePath(
      guard,
      "/work_space/test/TankBattle_new.py",
    );
    expect(rel).toBe("TankBattle_new.py");
  });

  it("resolves relative paths against skill roots", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-ws2-"));
    const outside = mkdtempSync(join(tmpdir(), "forge-skill-"));
    const script = join(outside, "scripts", "run.sh");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, "#!/bin/sh\n", "utf-8");
    const guard = await WorkspaceGuard.ensure(workspace);
    guard.setSkillRoots([outside]);
    const rel = toWorkspaceRelativePath(guard, "scripts/run.sh", {
      skillRoots: [outside],
    });
    expect(rel).toBe(resolve(script));
    expect(guard.resolveSafe(rel)).toBe(resolve(script));
  });

  it("fixes cwd-glued absolute paths from model read_file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-ws-glued-"));
    const skillDir = mkdtempSync(join(tmpdir(), "forge-path-test-"));
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "# test\n", "utf-8");
    const guard = await WorkspaceGuard.ensure(workspace);
    const wrong = `${workspace.replace(/\/$/, "")}${skillPath}`;
    const rel = toWorkspaceRelativePath(guard, wrong);
    expect(rel).toBe(resolve(skillPath));
    guard.setSkillRoots([skillDir]);
    expect(guard.resolveSafe(wrong)).toBe(resolve(skillPath));
  });

  it("resolves Users/ paths missing a leading slash outside workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-ws3-"));
    const outside = mkdtempSync(join(tmpdir(), "forge-skill-abs-"));
    const skillPath = join(outside, "SKILL.md");
    writeFileSync(skillPath, "# Skill\n", "utf-8");
    const guard = await WorkspaceGuard.ensure(workspace);
    const broken = skillPath.replace(/^\//, "");
    guard.setSkillRoots([outside]);
    const rel = toWorkspaceRelativePath(guard, broken, { skillRoots: [outside] });
    expect(rel).toBe(resolve(skillPath));
    expect(guard.resolveSafe(broken)).toBe(resolve(skillPath));
  });

  it("keeps existing absolute paths outside the workspace when allowed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "forge-out-"));
    const skillPath = join(outside, "SKILL.md");
    writeFileSync(skillPath, "# Skill\n", "utf-8");
    const guard = await WorkspaceGuard.ensure(workspace, {
      allowedRoots: [outside],
    });
    const rel = toWorkspaceRelativePath(guard, skillPath, {
      allowedRoots: guard.allowedRootsList,
    });
    expect(rel).toBe(resolve(skillPath));
    expect(guard.resolveSafe(rel)).toBe(resolve(skillPath));
  });
});

describe("normalizeCommandForWorkspace", () => {
  it("strips leading cd && prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-cmd-"));
    const guard = await WorkspaceGuard.ensure(dir);
    const cmd = normalizeCommandForWorkspace(
      guard,
      'cd /Users/alice/Projects/demo && python3 -c "print(1)"',
    );
    expect(cmd).toBe('python3 -c "print(1)"');
  });
});
