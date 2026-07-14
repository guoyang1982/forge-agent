import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  WorkspaceGuard,
  createWorkspaceSnapshot,
  gitBranchInfo,
  gitSwitchBranch,
  gitDiffSummary,
  gitStatusLine,
  isGitRepository,
  restoreWorkspaceSnapshot,
} from "./index.js";

describe("git helpers", () => {
  function runGit(cwd: string, args: string[]) {
    const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
    }
  }

  it("reports non-repo without spawning failing status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-nogit-"));
    mkdirSync(dir, { recursive: true });
    const guard = await WorkspaceGuard.ensure(dir);

    expect(await isGitRepository(guard)).toBe(false);
    expect(await gitStatusLine(guard)).toBe("(not a git repository)");
    expect(await gitDiffSummary(guard)).toBe("(not a git repository)");
    await expect(gitBranchInfo(guard)).resolves.toEqual({
      isRepo: false,
      current: null,
      detached: false,
      branches: [],
    });
  });

  it("reports the unborn current branch in a new git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-git-unborn-"));
    runGit(dir, ["init", "-b", "main"]);
    const guard = await WorkspaceGuard.ensure(dir);

    await expect(gitBranchInfo(guard)).resolves.toEqual({
      isRepo: true,
      current: "main",
      detached: false,
      branches: ["main"],
    });
  });

  it("lists local branches and switches branches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-git-branches-"));
    runGit(dir, ["init", "-b", "main"]);
    writeFileSync(join(dir, "README.md"), "# test\n");
    runGit(dir, ["add", "README.md"]);
    runGit(dir, ["-c", "user.name=Forge", "-c", "user.email=forge@example.com", "commit", "-m", "init"]);
    runGit(dir, ["branch", "feature/demo"]);
    const guard = await WorkspaceGuard.ensure(dir);

    await expect(gitBranchInfo(guard)).resolves.toEqual({
      isRepo: true,
      current: "main",
      detached: false,
      branches: ["feature/demo", "main"],
    });

    await expect(gitSwitchBranch(guard, "feature/demo")).resolves.toEqual({
      ok: true,
      current: "feature/demo",
    });
    expect((await gitBranchInfo(guard)).current).toBe("feature/demo");
  });
});

describe("workspace checkpoints", () => {
  function runGit(cwd: string, args: string[]) {
    const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
    }
  }

  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "forge-checkpoint-"));
    runGit(dir, ["init", "-b", "main"]);
    runGit(dir, ["config", "user.email", "t@t"]);
    runGit(dir, ["config", "user.name", "t"]);
    return dir;
  }

  it("snapshots and restores tracked, modified, and new files", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "a.txt"), "v1\n");
    runGit(dir, ["add", "-A"]);
    runGit(dir, ["commit", "-m", "init"]);
    // Uncommitted state at snapshot time: a modified + an untracked file.
    writeFileSync(join(dir, "a.txt"), "v2\n");
    writeFileSync(join(dir, "untracked.txt"), "keep me\n");
    const guard = await WorkspaceGuard.ensure(dir);

    const snap = await createWorkspaceSnapshot(guard);
    expect(snap.ok).toBe(true);
    expect(snap.sha).toMatch(/^[0-9a-f]{40}$/);
    // Snapshot must not touch worktree, index, or HEAD.
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("v2\n");
    // Snapshot is gc-protected via refs/forge.
    const refs = spawnSync(
      "git",
      ["for-each-ref", "--format=%(objectname)", "refs/forge/checkpoints"],
      { cwd: dir, encoding: "utf-8" },
    );
    expect(refs.stdout).toContain(snap.sha);

    // The "agent" wrecks the worktree: edits, deletes, creates.
    writeFileSync(join(dir, "a.txt"), "v3-broken\n");
    rmSync(join(dir, "untracked.txt"));
    writeFileSync(join(dir, "created-later.txt"), "should disappear\n");

    const res = await restoreWorkspaceSnapshot(guard, snap.sha!);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("v2\n");
    expect(readFileSync(join(dir, "untracked.txt"), "utf-8")).toBe("keep me\n");
    expect(existsSync(join(dir, "created-later.txt"))).toBe(false);
  });

  it("refuses to restore an unknown sha and non-repos", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "a.txt"), "x\n");
    runGit(dir, ["add", "-A"]);
    runGit(dir, ["commit", "-m", "init"]);
    const guard = await WorkspaceGuard.ensure(dir);
    const bad = await restoreWorkspaceSnapshot(guard, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(bad.ok).toBe(false);

    const plain = mkdtempSync(join(tmpdir(), "forge-nogit2-"));
    const guard2 = await WorkspaceGuard.ensure(plain);
    const snap = await createWorkspaceSnapshot(guard2);
    expect(snap.ok).toBe(false);
  });
});
