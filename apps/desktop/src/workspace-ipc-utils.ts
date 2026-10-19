import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const FULL_GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function gitDiffArgs(baseSha?: string): string[] {
  const revision = String(baseSha || "").trim() || "HEAD";
  if (revision !== "HEAD" && !FULL_GIT_OID.test(revision)) {
    throw new Error("非法 Git 基准版本");
  }
  return [
    "-c",
    "core.quotepath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--end-of-options",
    revision,
  ];
}

export function resolveRealWorkspaceFile(cwdInput: string, pathInput: string): string {
  const cwd = realpathSync(resolve(cwdInput));
  const target = realpathSync(resolve(cwd, pathInput));
  const rel = relative(cwd, target);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) throw new Error("非法文件路径");
  return target;
}

export function resolveWorkspaceImageFile(
  cwd: string,
  path: string,
  supportedExtensions: ReadonlySet<string>,
): { target: string; extension: string } {
  const target = resolveRealWorkspaceFile(cwd, path);
  if (!statSync(target).isFile()) throw new Error(`文件不存在: ${path}`);
  const name = basename(target);
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!supportedExtensions.has(extension)) {
    throw new Error(`不是支持的图片文件: ${path}`);
  }
  return { target, extension };
}

function decodeGitPathToken(token: string): string {
  const decoded = token.startsWith('"') ? JSON.parse(token) : token;
  return decoded.startsWith("b/") ? decoded.slice(2) : decoded;
}

export function parseUnifiedDiffByFile(
  diff: string,
): Array<{ path: string; unifiedDiff: string }> {
  const text = String(diff || "").trim();
  if (!text) return [];
  const files: Array<{ path: string; unifiedDiff: string }> = [];
  const chunks = text.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const header = chunk.split("\n", 1)[0] || "";
    const match = header.match(/^("(?:\\.|[^"])*"|\S+)\s+("(?:\\.|[^"])*"|.+)$/);
    const plusLine = chunk.split("\n").find((line) => line.startsWith("+++ "));
    const binaryLine = chunk
      .split("\n")
      .find((line) => line.startsWith("Binary files ") && line.endsWith(" differ"));
    const binaryMarker = binaryLine?.lastIndexOf(" and ") ?? -1;
    const binaryPath =
      binaryLine && binaryMarker >= 0
        ? binaryLine.slice(binaryMarker + 5, -" differ".length).trim()
        : "";
    const pathToken = plusLine?.slice(4).trim() || binaryPath || match?.[2];
    if (!pathToken || pathToken === "/dev/null") continue;
    let path = "";
    try {
      path = decodeGitPathToken(pathToken).trim();
    } catch {
      continue;
    }
    if (!path) continue;
    files.push({ path, unifiedDiff: `diff --git ${chunk}`.trimEnd() });
  }
  return files;
}

const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_DIFF_BYTES = 512 * 1024;

function isRepoRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return false;
  }
  const parts = path.split(/[\\/]/);
  return parts.length > 0 && parts.every((part) => part && part !== "." && part !== "..");
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveGit) => {
    const proc = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (error) => resolveGit({ code: null, stdout, stderr: error.message }));
    proc.on("close", (code) => resolveGit({ code, stdout, stderr }));
  });
}

/**
 * Files this turn changed relative to the pre-run snapshot.
 * An empty baseline returns nothing: diffing HEAD would list every dirty
 * file already in the worktree, including edits from other sessions.
 */
export async function collectWorkspaceTurnDiffs(
  cwd: string,
  baseSha?: string,
): Promise<{ ok: boolean; files: Array<{ path: string; unifiedDiff: string }>; message?: string }> {
  const revision = String(baseSha || "").trim();
  if (!revision) {
    return { ok: false, files: [], message: "missing turn checkpoint" };
  }
  let args: string[];
  try {
    args = gitDiffArgs(revision);
  } catch (error) {
    return {
      ok: false,
      files: [],
      message: error instanceof Error ? error.message : "非法 Git 基准版本",
    };
  }
  const diff = await runGit(cwd, args);
  if (diff.code !== 0 && !diff.stdout.trim()) {
    return { ok: false, files: [], message: diff.stderr.trim() || "git diff failed" };
  }
  const files = parseUnifiedDiffByFile(diff.stdout).filter((file) => isRepoRelativePath(file.path));
  const seen = new Set(files.map((file) => file.path));

  const [snapshot, untracked] = await Promise.all([
    runGit(cwd, ["ls-tree", "-r", "--name-only", "--end-of-options", revision]),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if (snapshot.code !== 0 || untracked.code !== 0) return { ok: true, files };

  const snapshotPaths = new Set(
    snapshot.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const created = untracked.stdout
    .split("\0")
    .map((line) => line.trim())
    .filter((path) => isRepoRelativePath(path) && !snapshotPaths.has(path))
    .slice(0, MAX_UNTRACKED_FILES);

  for (const path of created) {
    if (seen.has(path)) continue;
    seen.add(path);
    let unifiedDiff = "";
    try {
      resolveRealWorkspaceFile(cwd, path);
      if (statSync(resolve(cwd, path)).size <= MAX_UNTRACKED_DIFF_BYTES) {
        const createdDiff = await runGit(cwd, [
          "-c",
          "core.quotepath=false",
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-index",
          "--",
          "/dev/null",
          path,
        ]);
        if (createdDiff.stdout.startsWith("diff --git ")) unifiedDiff = createdDiff.stdout.trimEnd();
      }
    } catch {
      continue;
    }
    files.push({ path, unifiedDiff });
  }
  return { ok: true, files };
}
