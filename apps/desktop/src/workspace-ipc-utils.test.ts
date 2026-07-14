import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
