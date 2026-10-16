import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  collectWorkspaceTurnDiffs,
  gitDiffArgs,
  parseUnifiedDiffByFile,
  resolveRealWorkspaceFile,
  resolveWorkspaceImageFile,
} from "./workspace-ipc-utils.js";

describe("workspace IPC guards", () => {
  it("accepts full Git object IDs and rejects option injection", () => {
    const sha = "a".repeat(40);
    expect(gitDiffArgs(sha)).toEqual(expect.arrayContaining(["--end-of-options", sha]));
    expect(() => gitDiffArgs("--output=/tmp/owned")).toThrow("非法 Git 基准版本");
    expect(() => gitDiffArgs("HEAD~1")).toThrow("非法 Git 基准版本");
  });

  it("rejects workspace symlinks that resolve outside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "forge-outside-"));
    mkdirSync(join(root, "images"));
    writeFileSync(join(outside, "secret.png"), "secret");
    symlinkSync(join(outside, "secret.png"), join(root, "images", "preview.png"));

    expect(() => resolveRealWorkspaceFile(root, "images/preview.png")).toThrow(
      "非法文件路径",
    );
    expect(resolveRealWorkspaceFile(root, "images")).toBe(realpathSync(join(root, "images")));
    expect(() => resolveRealWorkspaceFile(root, join(outside, "secret.png"))).toThrow(
      "非法文件路径",
    );
  });

  it("parses quoted Unicode and escaped Git diff paths", () => {
    const parsed = parseUnifiedDiffByFile(
      'diff --git "a/中文 file.txt" "b/中文 file.txt"\n--- "a/中文 file.txt"\n+++ "b/中文 file.txt"\n',
    );
    expect(parsed[0]?.path).toBe("中文 file.txt");

    const unquoted = parseUnifiedDiffByFile(
      "diff --git a/file with spaces.txt b/file with spaces.txt\n--- a/file with spaces.txt\n+++ b/file with spaces.txt\n",
    );
    expect(unquoted[0]?.path).toBe("file with spaces.txt");

    const binary = parseUnifiedDiffByFile(
      "diff --git a/image file.png b/image file.png\nBinary files a/image file.png and b/image file.png differ\n",
    );
    expect(binary[0]?.path).toBe("image file.png");
  });

  it("accepts supported image files and rejects missing or unsupported files", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-images-"));
    writeFileSync(join(root, "preview.PNG"), "image");
    writeFileSync(join(root, "notes.txt"), "text");
    const supported = new Set(["png", "jpg"]);

    expect(resolveWorkspaceImageFile(root, "preview.PNG", supported)).toMatchObject({
      extension: "png",
    });
    expect(() => resolveWorkspaceImageFile(root, "missing.png", supported)).toThrow();
    expect(() => resolveWorkspaceImageFile(root, "notes.txt", supported)).toThrow(
      "不是支持的图片文件",
    );
  });
});

describe("turn-scoped workspace diffs", () => {
  function runGit(cwd: string, args: string[]) {
    const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
    }
    return res.stdout.trim();
  }

  async function snapshotWorktree(cwd: string): Promise<string> {
    const tmpIndex = join(tmpdir(), `forge-turn-diff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const env = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndex,
      GIT_AUTHOR_NAME: "forge",
      GIT_AUTHOR_EMAIL: "forge@local",
      GIT_COMMITTER_NAME: "forge",
      GIT_COMMITTER_EMAIL: "forge@local",
    };
    const git = (args: string[]) => {
      const res = spawnSync("git", args, { cwd, encoding: "utf-8", env });
      if (res.status !== 0) throw new Error(res.stderr || res.stdout);
      return res.stdout.trim();
    };
    try {
      const head = runGit(cwd, ["rev-parse", "HEAD"]);
      git(["read-tree", head]);
      git(["add", "-A"]);
      const tree = git(["write-tree"]);
      return git(["commit-tree", tree, "-p", head, "-m", "forge checkpoint"]);
    } finally {
      rmSync(tmpIndex, { force: true });
    }
  }

  it("keeps only files changed after the turn checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-turn-diff-"));
    runGit(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "Tracked.java"), "class Tracked {}\n");
    runGit(root, ["add", "Tracked.java"]);
    runGit(root, ["-c", "user.name=Forge", "-c", "user.email=forge@example.com", "commit", "-m", "init"]);
    writeFileSync(join(root, "Tracked.java"), "class Tracked { int before; }\n");
    writeFileSync(join(root, "AlreadyDirty.java"), "class AlreadyDirty { int before; }\n");
    runGit(root, ["add", "AlreadyDirty.java"]);
    runGit(root, ["-c", "user.name=Forge", "-c", "user.email=forge@example.com", "commit", "-m", "seed dirty"]);
    writeFileSync(join(root, "AlreadyDirty.java"), "class AlreadyDirty { int leftover; }\n");
    mkdirSync(join(root, "output"));
    writeFileSync(join(root, "output", "old.html"), "<p>old</p>\n");

    const sha = await snapshotWorktree(root);
    writeFileSync(join(root, "Tracked.java"), "class Tracked { int before; int after; }\n");
    writeFileSync(join(root, "Generated.md"), "# this turn\n");

    const scoped = await collectWorkspaceTurnDiffs(root, sha);
    expect(scoped.ok).toBe(true);
    expect(scoped.files.map((file) => file.path).sort()).toEqual(["Generated.md", "Tracked.java"]);
    expect(scoped.files.find((file) => file.path === "Generated.md")?.unifiedDiff).toContain("+# this turn");

    const wholeTree = await collectWorkspaceTurnDiffs(root);
    expect(wholeTree.files).toEqual([]);
  });
});
