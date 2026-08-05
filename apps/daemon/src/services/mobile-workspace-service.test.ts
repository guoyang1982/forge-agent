import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleMobileDiffGet,
  handleMobileFileRead,
  handleMobileFilesList,
  handleMobileGitSwitch,
} from "./mobile-workspace-service.js";

const tempDirs: string[] = [];

function createRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "forge-mobile-workspace-"));
  tempDirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd });
  execFileSync("git", ["checkout", "-qb", "main"], { cwd });
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "a.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd });
  execFileSync("git", ["branch", "other"], { cwd });
  return cwd;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("mobile workspace service", () => {
  it("rejects a symlink that escapes the workspace", async () => {
    const cwd = createRepository();
    const outside = mkdtempSync(join(tmpdir(), "forge-mobile-secret-"));
    tempDirs.push(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(cwd, "escape"));

    await expect(handleMobileFileRead({ cwd, path: "escape/secret.txt" }))
      .rejects.toThrow(/escapes workspace|not allowed/i);
  });

  it("requires confirmation before switching a dirty worktree", async () => {
    const cwd = createRepository();
    writeFileSync(join(cwd, "dirty.txt"), "dirty");

    await expect(handleMobileGitSwitch({ cwd, branch: "other" })).resolves.toEqual({
      ok: false,
      message: "WORKTREE_DIRTY",
    });
  });

  it("does not switch branches while a run is active", async () => {
    const cwd = createRepository();

    await expect(
      handleMobileGitSwitch({ cwd, branch: "other", running: true }),
    ).resolves.toEqual({
      ok: false,
      message: "RUN_ACTIVE",
    });
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim(),
    ).toBe("main");
  });

  it("returns bounded read-only file and diff payloads", async () => {
    const cwd = createRepository();
    writeFileSync(join(cwd, "src", "a.ts"), "export const value = 2;\n");

    const preview = await handleMobileFileRead({ cwd, path: "src/a.ts" });
    expect(preview).toMatchObject({
      path: "src/a.ts",
      kind: "text",
      truncated: false,
    });
    expect(preview.kind === "text" ? preview.content.length : 0).toBeLessThanOrEqual(200_000);

    const diff = await handleMobileDiffGet({ cwd, path: "src/a.ts" });
    expect(diff.path).toBe("src/a.ts");
    expect(diff.unifiedDiff).toContain("diff --git");
  });

  it("returns a bounded workspace image as a mobile-renderable data URL", async () => {
    const cwd = createRepository();
    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    writeFileSync(join(cwd, "result.png"), png);

    await expect(handleMobileFileRead({ cwd, path: "result.png" })).resolves.toEqual({
      path: "result.png",
      kind: "image",
      mime: "image/png",
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      size: png.length,
      truncated: false,
    });
  });

  it("lists workspace root files even when process.cwd is a subdirectory", async () => {
    const cwd = createRepository();
    const nested = join(cwd, "apps", "daemon");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), '{"name":"daemon"}\n');
    const previous = process.cwd();
    process.chdir(nested);
    try {
      const listed = await handleMobileFilesList({ cwd, path: "." });
      expect(listed.entries.some((entry) => entry.name === "src" && entry.kind === "directory")).toBe(true);
      expect(listed.entries.some((entry) => entry.path === "apps")).toBe(true);
      const preview = await handleMobileFileRead({ cwd, path: "src/a.ts" });
      expect(preview.path).toBe("src/a.ts");
    } finally {
      process.chdir(previous);
    }
  });
});
