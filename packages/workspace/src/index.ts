import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve, normalize, sep } from "node:path";
import { parseRgJson, type GrepResult } from "./grep.js";
import { canAccessPath, safeRealpath } from "./permissions.js";
import {
  absolutePathCandidates,
  normalizeAgentFilePath,
  stripMistakenWorkspacePrefix,
} from "./paths.js";

export { parseRgJson, type GrepResult } from "./grep.js";
export {
  canAccessPath,
  expandTildePath,
  isSensitivePath,
  isUnderRoot,
  safeRealpath,
} from "./permissions.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  "target",
]);

export type WorkspaceGuardOptions = {
  /** Expanded absolute paths for personal directories (read/write). */
  allowedRoots?: string[];
};

export class WorkspaceGuard {
  private skillRoots: string[] = [];

  constructor(
    private cwd: string,
    private allowedRoots: string[] = [],
  ) {
    this.cwd = resolve(cwd);
    this.allowedRoots = allowedRoots.map((r) => resolve(r));
  }

  /** Create workspace directory if missing (for greenfield tasks). */
  static async ensure(
    cwd: string,
    options?: WorkspaceGuardOptions,
  ): Promise<WorkspaceGuard> {
    const abs = resolve(cwd);
    if (!existsSync(abs)) {
      await mkdir(abs, { recursive: true });
    }
    return new WorkspaceGuard(abs, options?.allowedRoots);
  }

  setSkillRoots(roots: string[]): void {
    this.skillRoots = [...new Set(roots.map((r) => resolve(r)))];
  }

  get allowedRootsList(): string[] {
    return this.allowedRoots;
  }

  private assertAccessible(abs: string, intent: "read" | "write"): void {
    if (
      !canAccessPath({
        abs,
        cwd: this.cwd,
        allowedRoots: this.allowedRoots,
        skillRoots: this.skillRoots,
        intent,
      })
    ) {
      throw new Error(`Path not allowed: ${abs}`);
    }
    if (!existsSync(abs)) return;
    const realAbs = safeRealpath(abs);
    if (
      !canAccessPath({
        abs: realAbs,
        cwd: this.cwd,
        allowedRoots: this.allowedRoots,
        skillRoots: this.skillRoots,
        intent,
      })
    ) {
      throw new Error(`Path escapes workspace: ${abs}`);
    }
  }

  resolveSafe(
    relativePath: string,
    intent: "read" | "write" = "read",
  ): string {
    const repaired = stripMistakenWorkspacePrefix(this.cwd, relativePath);
    const normalized = normalize(normalizeAgentFilePath(repaired));
    const isAbsolute =
      normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized);

    // Prefer workspace-rooted resolution for relative paths when the target exists.
    // absolutePathCandidates() uses path.resolve(relative) against process.cwd(), which
    // breaks when the daemon is launched from a workspace subdirectory (apps/daemon).
    // Only win when the workspace join exists so mistaken abs-looking relatives
    // (e.g. "Users/..." / "var/...") still fall through to candidate repair.
    if (!isAbsolute && !normalized.split(/[\\/]/).includes("..")) {
      const abs = resolve(this.cwd, normalized === "" ? "." : normalized);
      const isWorkspaceRoot = normalized === "." || normalized === "";
      if (
        (isWorkspaceRoot || existsSync(abs))
        && canAccessPath({
          abs,
          cwd: this.cwd,
          allowedRoots: this.allowedRoots,
          skillRoots: this.skillRoots,
          intent,
        })
      ) {
        this.assertAccessible(abs, intent);
        return abs;
      }
    }

    for (const abs of absolutePathCandidates(repaired)) {
      if (
        canAccessPath({
          abs,
          cwd: this.cwd,
          allowedRoots: this.allowedRoots,
          skillRoots: this.skillRoots,
          intent,
        })
      ) {
        this.assertAccessible(abs, intent);
        return abs;
      }
    }

    if (normalized.includes("..")) {
      throw new Error(`Path escapes workspace: ${relativePath}`);
    }

    const abs = resolve(this.cwd, normalized);
    const cwdPrefix = this.cwd.endsWith(sep) ? this.cwd : this.cwd + sep;
    const inWorkspace = abs === this.cwd || abs.startsWith(cwdPrefix);
    if (!inWorkspace) {
      throw new Error(`Path not allowed: ${relativePath}`);
    }
    this.assertAccessible(abs, intent);
    return abs;
  }

  get cwdPath(): string {
    return this.cwd;
  }
}


export async function listDir(
  guard: WorkspaceGuard,
  relPath = ".",
  maxDepth = 3,
): Promise<string[]> {
  const root = guard.resolveSafe(relPath);
  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const full = join(dir, e.name);
      const rel = relative(guard.cwdPath, full);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        results.push(rel + "/");
        await walk(full, depth + 1);
      } else {
        results.push(rel);
      }
    }
  }

  await walk(root, 0);
  return results.slice(0, 200);
}

export async function readFileLimited(
  guard: WorkspaceGuard,
  relPath: string,
  offset = 1,
  limit = 200,
  maxChars = 8000,
): Promise<string> {
  const abs = guard.resolveSafe(relPath);
  const content = await readFile(abs, "utf-8");
  const lines = content.split("\n");
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let out = slice
    .map((l, i) => `${offset + i}|${l}`)
    .join("\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + "\n...[truncated]";
  }
  return out;
}

export async function grepWorkspace(
  guard: WorkspaceGuard,
  pattern: string,
  glob?: string,
): Promise<GrepResult | string> {
  return new Promise((resolvePromise) => {
    const args = ["--json", pattern, guard.cwdPath];
    if (glob) args.splice(1, 0, "-g", glob);
    const proc = spawn("rg", args, { cwd: guard.cwdPath });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code === 1) {
        return resolvePromise({
          matchCount: 0,
          preview: "No matches",
          raw: "",
        });
      }
      if (code !== 0 && !stdout) {
        return resolvePromise(
          JSON.stringify({ ok: false, hint: "rg not found or failed", stderr }),
        );
      }
      resolvePromise(parseRgJson(stdout));
    });
    proc.on("error", () => {
      resolvePromise(
        JSON.stringify({ ok: false, hint: "Install ripgrep (rg) for search" }),
      );
    });
  });
}

import {
  applySimplePatch,
  createFileFromPatch,
  diagnosePatchFailure,
  isEffectivelyApplied,
  normalizeEol,
  readWorkspaceFileSync,
  type PatchDiagnostic,
} from "./patch.js";

export {
  applySimplePatch,
  buildCreateFileDiff,
  buildReplaceFileDiff,
  createFileFromPatch,
  diagnosePatchFailure,
  isEffectivelyApplied,
  normalizeEol,
  type PatchDiagnostic,
} from "./patch.js";

export function validateUnifiedPatch(
  guard: WorkspaceGuard,
  relPath: string,
  unifiedDiff: string,
): {
  ok: boolean;
  message: string;
  diagnostic?: PatchDiagnostic;
  alreadyApplied?: boolean;
} {
  const abs = guard.resolveSafe(relPath);
  const original = readWorkspaceFileSync(abs);
  if (original === null) {
    const created = createFileFromPatch(unifiedDiff);
    if (created === null) {
      return {
        ok: false,
        message: `Not a valid create-file patch for ${relPath}`,
        diagnostic: {
          message: "Not a valid create-file patch",
          hint: "Use write_file for new files, or --- /dev/null +++ b/path with + lines only.",
        },
      };
    }
    return { ok: true, message: "Valid create-file patch" };
  }
  const patched = applySimplePatch(original, unifiedDiff);
  if (patched === null) {
    if (isEffectivelyApplied(original, unifiedDiff)) {
      return {
        ok: true,
        message: "变更已在文件中（无需重复应用）",
        alreadyApplied: true,
      };
    }
    const diagnostic = diagnosePatchFailure(original, unifiedDiff);
    return {
      ok: false,
      message: diagnostic.message,
      diagnostic,
    };
  }
  if (normalizeEol(patched) === original) {
    return {
      ok: true,
      message: "文件已是最新内容",
      alreadyApplied: true,
    };
  }
  return { ok: true, message: "Patch applies cleanly (dry-run)" };
}

export type ApplyPatchResult = {
  ok: boolean;
  message: string;
  diagnostic?: PatchDiagnostic;
  alreadyApplied?: boolean;
  line?: number;
  expected?: string;
  actual?: string;
  hint?: string;
};

export async function applyUnifiedPatch(
  guard: WorkspaceGuard,
  relPath: string,
  unifiedDiff: string,
): Promise<ApplyPatchResult> {
  const check = validateUnifiedPatch(guard, relPath, unifiedDiff);
  if (!check.ok) {
    const d = check.diagnostic;
    return {
      ok: false,
      message: check.message,
      diagnostic: d,
      line: d?.line,
      expected: d?.expected,
      actual: d?.actual,
      hint: d?.hint,
    };
  }
  if (check.alreadyApplied) {
    return { ok: true, message: check.message, alreadyApplied: true };
  }

  const abs = guard.resolveSafe(relPath);
  const original = await readFile(abs, "utf-8")
    .then(normalizeEol)
    .catch(() => null);
  if (original === null) {
    const created = createFileFromPatch(unifiedDiff)!;
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, created, "utf-8");
    return { ok: true, message: `Created file from patch: ${relPath}` };
  }

  const patched = applySimplePatch(original, unifiedDiff)!;
  await writeFile(abs, patched, "utf-8");
  return { ok: true, message: `Applied patch to ${relPath}` };
}

const NOT_A_GIT_REPO = "(not a git repository)";

function runGitText(
  guard: WorkspaceGuard,
  args: string[],
  env?: Record<string, string>,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd: guard.cwdPath,
      env: env ? { ...process.env, ...env } : undefined,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += String(d)));
    proc.stderr.on("data", (d) => (stderr += String(d)));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.on("error", (e) => resolve({ code: null, stdout: "", stderr: e.message }));
  });
}

const CHECKPOINT_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "forge",
  GIT_AUTHOR_EMAIL: "forge@local",
  GIT_COMMITTER_NAME: "forge",
  GIT_COMMITTER_EMAIL: "forge@local",
};

/**
 * Snapshot the working tree (tracked + untracked, .gitignore respected) as a
 * dangling commit, without touching HEAD, the real index, or the worktree.
 */
export async function createWorkspaceSnapshot(
  guard: WorkspaceGuard,
): Promise<{ ok: boolean; sha?: string; message: string }> {
  if (!(await isGitRepository(guard))) {
    return { ok: false, message: NOT_A_GIT_REPO };
  }
  const tmpIndex = join(
    tmpdir(),
    `forge-checkpoint-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const env = { GIT_INDEX_FILE: tmpIndex, ...CHECKPOINT_GIT_IDENTITY };
  try {
    const head = await runGitText(guard, ["rev-parse", "--verify", "HEAD"]);
    const headSha = head.code === 0 ? head.stdout.trim() : null;

    const seed = headSha
      ? await runGitText(guard, ["read-tree", headSha], env)
      : await runGitText(guard, ["read-tree", "--empty"], env);
    if (seed.code !== 0) {
      return { ok: false, message: `read-tree failed: ${seed.stderr.trim()}` };
    }
    const add = await runGitText(guard, ["add", "-A"], env);
    if (add.code !== 0) {
      return { ok: false, message: `add -A failed: ${add.stderr.trim()}` };
    }
    const tree = await runGitText(guard, ["write-tree"], env);
    if (tree.code !== 0) {
      return { ok: false, message: `write-tree failed: ${tree.stderr.trim()}` };
    }
    const commitArgs = ["commit-tree", tree.stdout.trim(), "-m", "forge checkpoint"];
    if (headSha) commitArgs.push("-p", headSha);
    const commit = await runGitText(guard, commitArgs, env);
    if (commit.code !== 0) {
      return { ok: false, message: `commit-tree failed: ${commit.stderr.trim()}` };
    }
    const sha = commit.stdout.trim();
    // Anchor the snapshot under refs/forge so `git gc` can't prune it; rotate old ones.
    await runGitText(guard, [
      "update-ref",
      `refs/forge/checkpoints/${sha.slice(0, 12)}`,
      sha,
    ]);
    await pruneCheckpointRefs(guard);
    return { ok: true, sha, message: "checkpoint created" };
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

const CHECKPOINT_KEEP_COUNT = 200;
const CHECKPOINT_KEEP_DAYS = 30;

async function pruneCheckpointRefs(guard: WorkspaceGuard): Promise<void> {
  const res = await runGitText(guard, [
    "for-each-ref",
    "--sort=-creatordate",
    "--format=%(refname) %(creatordate:unix)",
    "refs/forge/checkpoints",
  ]);
  if (res.code !== 0) return;
  const cutoff = Math.floor(Date.now() / 1000) - CHECKPOINT_KEEP_DAYS * 24 * 3600;
  const lines = res.stdout.split("\n").filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const [ref, ts] = lines[i].split(" ");
    if (!ref) continue;
    if (i >= CHECKPOINT_KEEP_COUNT || Number(ts) < cutoff) {
      await runGitText(guard, ["update-ref", "-d", ref]);
    }
  }
}

/** Restore the worktree to a snapshot: check out its files and delete files created since. */
export async function restoreWorkspaceSnapshot(
  guard: WorkspaceGuard,
  sha: string,
): Promise<{ ok: boolean; message: string; removedCount?: number }> {
  if (!/^[0-9a-f]{6,64}$/i.test(String(sha || ""))) {
    return { ok: false, message: "invalid checkpoint id" };
  }
  if (!(await isGitRepository(guard))) {
    return { ok: false, message: NOT_A_GIT_REPO };
  }
  const kind = await runGitText(guard, ["cat-file", "-t", sha]);
  if (kind.code !== 0 || kind.stdout.trim() !== "commit") {
    return {
      ok: false,
      message: "检查点已不存在（超过保留期被清理），无法回滚",
    };
  }

  const snapList = await runGitText(guard, ["ls-tree", "-r", "--name-only", sha]);
  if (snapList.code !== 0) {
    return { ok: false, message: `ls-tree failed: ${snapList.stderr.trim()}` };
  }
  const snapFiles = new Set(snapList.stdout.split("\n").filter(Boolean));

  const current = await runGitText(guard, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const currentFiles = current.stdout.split("\n").filter(Boolean);

  let restore = await runGitText(guard, [
    "restore",
    "--source",
    sha,
    "--worktree",
    "--",
    ".",
  ]);
  if (restore.code !== 0) {
    // Older git without `restore`.
    restore = await runGitText(guard, ["checkout", sha, "--", "."]);
    if (restore.code !== 0) {
      return { ok: false, message: `restore failed: ${restore.stderr.trim()}` };
    }
  }

  let removedCount = 0;
  for (const rel of currentFiles) {
    if (snapFiles.has(rel)) continue;
    try {
      const abs = guard.resolveSafe(rel);
      await rm(abs, { force: true });
      removedCount += 1;
    } catch {
      /* outside workspace or already gone */
    }
  }
  return { ok: true, message: "已回滚到检查点", removedCount };
}

/** Whether cwd is inside a git work tree (skips spurious git status/diff). */
export async function isGitRepository(guard: WorkspaceGuard): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: guard.cwdPath },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += String(d)));
    proc.on("close", (code) => resolve(code === 0 && out.trim() === "true"));
    proc.on("error", () => resolve(false));
  });
}

export type GitBranchInfo = {
  isRepo: boolean;
  current: string | null;
  detached: boolean;
  branches: string[];
};

export async function gitBranchInfo(guard: WorkspaceGuard): Promise<GitBranchInfo> {
  const inRepo = await isGitRepository(guard);
  if (!inRepo) {
    return { isRepo: false, current: null, detached: false, branches: [] };
  }

  const symbolic = await runGitText(guard, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const currentBranch = symbolic.code === 0 ? symbolic.stdout.trim() : "";
  const head = currentBranch
    ? ""
    : (await runGitText(guard, ["rev-parse", "--short", "HEAD"])).stdout.trim();
  const current = currentBranch || (head ? `HEAD ${head}` : null);
  const detached = Boolean(!currentBranch && head);

  const refs = await runGitText(guard, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  const branches = refs.stdout
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  if (currentBranch && !branches.includes(currentBranch)) {
    branches.push(currentBranch);
    branches.sort((a, b) => a.localeCompare(b));
  }

  return { isRepo: true, current, detached, branches };
}

export async function gitSwitchBranch(
  guard: WorkspaceGuard,
  branch: string,
): Promise<{ ok: boolean; current?: string; message?: string }> {
  const target = String(branch ?? "").trim();
  if (!target || target !== branch || /[\0\r\n]/.test(target)) {
    return { ok: false, message: "Invalid branch name" };
  }

  const before = await gitBranchInfo(guard);
  if (!before.isRepo) return { ok: false, message: NOT_A_GIT_REPO };
  if (!before.branches.includes(target)) {
    return { ok: false, message: `Branch not found: ${target}` };
  }

  const switched = await runGitText(guard, ["switch", "--", target]);
  if (switched.code !== 0) {
    const message = (switched.stderr || switched.stdout || "git switch failed").trim();
    return { ok: false, message };
  }
  const after = await gitBranchInfo(guard);
  return { ok: true, current: after.current ?? target };
}

export async function gitDiffSummary(
  guard: WorkspaceGuard,
  maxLines = 80,
  options?: { inGit?: boolean },
): Promise<string> {
  const inRepo = options?.inGit ?? (await isGitRepository(guard));
  if (!inRepo) {
    return NOT_A_GIT_REPO;
  }
  return new Promise((resolve) => {
    const proc = spawn(
      "git",
      ["diff", "--no-color", "HEAD"],
      { cwd: guard.cwdPath },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => {
      if (code !== 0 && !out) return resolve("(no git diff)");
      const lines = out.split("\n").slice(0, maxLines);
      const text = lines.join("\n").trim();
      resolve(text || "(no uncommitted diff vs HEAD)");
    });
    proc.on("error", () => resolve("(git unavailable)"));
  });
}

export {
  detectRunHints,
  formatRunHintsBlock,
  type RunHint,
  type RunHintsResult,
} from "./run-hints.js";

export {
  normalizeAgentFilePath,
  normalizeCommandForWorkspace,
  stripMistakenWorkspacePrefix,
  toWorkspaceRelativePath,
} from "./paths.js";

export async function gitStatusLine(
  guard: WorkspaceGuard,
  options?: { inGit?: boolean },
): Promise<string> {
  const inRepo = options?.inGit ?? (await isGitRepository(guard));
  if (!inRepo) {
    return NOT_A_GIT_REPO;
  }
  return new Promise((resolve) => {
    const proc = spawn("git", ["status", "--short"], { cwd: guard.cwdPath });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => {
      if (code !== 0) return resolve("(git unavailable)");
      resolve(out.trim().slice(0, 500) || "(clean)");
    });
    proc.on("error", () => resolve("(git unavailable)"));
  });
}
