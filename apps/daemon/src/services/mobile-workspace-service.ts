import { spawn } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { basename, extname, relative, sep } from "node:path";
import {
  WorkspaceGuard,
  gitBranchInfo,
  gitStatusLine,
  gitSwitchBranch,
  isGitRepository,
  type GitBranchInfo,
} from "@forge/workspace";

export const MOBILE_FILE_MAX_BYTES = 200_000;
export const MOBILE_DIFF_MAX_BYTES = 500_000;
export const MOBILE_DIRECTORY_MAX_ENTRIES = 500;

export type MobileFileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "binary";
  size: number;
};

export type MobileFilePreview =
  | {
      path: string;
      kind: "text";
      language: string;
      content: string;
      size: number;
      truncated: boolean;
    }
  | { path: string; kind: "binary"; mime: string; size: number; truncated: false };

export type MobileDiffSummary = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

type GitResult = { code: number | null; stdout: Buffer; stderr: string; truncated: boolean };

const TEXT_EXTENSIONS = new Map<string, string>([
  [".c", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".css", "css"],
  [".go", "go"],
  [".html", "html"],
  [".java", "java"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".md", "markdown"],
  [".mdx", "markdown"],
  [".mjs", "javascript"],
  [".py", "python"],
  [".rb", "ruby"],
  [".rs", "rust"],
  [".sh", "shell"],
  [".sql", "sql"],
  [".svelte", "svelte"],
  [".toml", "toml"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".txt", "text"],
  [".vue", "vue"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".json", "json"],
]);

function parseParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Invalid mobile workspace parameters");
  }
  return params as Record<string, unknown>;
}

function requireString(params: unknown, key: string): string {
  const value = parseParams(params)[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function relativePath(guard: WorkspaceGuard, abs: string): string {
  return relative(guard.cwdPath, abs).split(sep).join("/");
}

function assertMobilePath(path: string): void {
  if (!path.trim() || path.split(/[\\/]+/).includes(".git")) {
    throw new Error("Path not allowed");
  }
}

function textLanguage(path: string): string | undefined {
  const name = basename(path);
  if (name.startsWith(".") && name !== ".") return "text";
  return TEXT_EXTENSIONS.get(extname(name).toLowerCase());
}

function containsNul(bytes: Buffer): boolean {
  return bytes.subarray(0, 8_192).includes(0);
}

async function readBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(bytes, 0, maxBytes, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function runGit(
  cwd: string,
  args: string[],
  maxBytes = MOBILE_DIFF_MAX_BYTES,
): Promise<GitResult> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd });
    const chunks: Buffer[] = [];
    let length = 0;
    let truncated = false;
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      if (length >= maxBytes) {
        truncated = true;
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - length;
      const accepted = bytes.subarray(0, remaining);
      chunks.push(accepted);
      length += accepted.length;
      if (accepted.length < bytes.length) truncated = true;
    });
    proc.stderr.on("data", (chunk) => (stderr += String(chunk)));
    proc.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(chunks), stderr, truncated }),
    );
    proc.on("error", (error) =>
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: error.message, truncated: false }),
    );
  });
}

export async function handleMobileGitBranches(
  params: { cwd: string },
): Promise<GitBranchInfo & { dirty: boolean }> {
  const cwd = requireString(params, "cwd");
  const guard = new WorkspaceGuard(cwd);
  const branchInfo = await gitBranchInfo(guard);
  const status = await gitStatusLine(guard, { inGit: branchInfo.isRepo });
  return { ...branchInfo, dirty: branchInfo.isRepo && status !== "(clean)" };
}

export async function handleMobileGitSwitch(
  params: { cwd: string; branch: string; confirmDirty?: boolean; running?: boolean },
): Promise<{ ok: boolean; current?: string; message?: string }> {
  const cwd = requireString(params, "cwd");
  const branch = requireString(params, "branch");
  const payload = parseParams(params);
  if (payload.running === true) return { ok: false, message: "RUN_ACTIVE" };

  const guard = new WorkspaceGuard(cwd);
  if (!(await isGitRepository(guard))) return { ok: false, message: "(not a git repository)" };
  const status = await gitStatusLine(guard, { inGit: true });
  if (status !== "(clean)" && payload.confirmDirty !== true) {
    return { ok: false, message: "WORKTREE_DIRTY" };
  }
  return gitSwitchBranch(guard, branch);
}

export async function handleMobileFilesList(
  params: { cwd: string; path?: string },
): Promise<{ entries: MobileFileEntry[] }> {
  const cwd = requireString(params, "cwd");
  const path = typeof parseParams(params).path === "string" ? String(parseParams(params).path) : ".";
  assertMobilePath(path);
  const guard = new WorkspaceGuard(cwd);
  const directory = guard.resolveSafe(path, "read");
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) throw new Error("Path is not a directory");

  const entries: MobileFileEntry[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entries.length >= MOBILE_DIRECTORY_MAX_ENTRIES) break;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".pnpm-store") {
      continue;
    }
    const requestedPath = relativePath(guard, `${directory}${sep}${entry.name}`);
    try {
      const absolutePath = guard.resolveSafe(requestedPath, "read");
      const entryStat = await stat(absolutePath);
      const kind = entryStat.isDirectory()
        ? "directory"
        : containsNul(await readBytes(absolutePath, 8_192))
          ? "binary"
          : "file";
      entries.push({ name: entry.name, path: requestedPath, kind, size: entryStat.size });
    } catch {
      // Do not expose links or inaccessible entries outside the workspace.
    }
  }
  entries.sort((a, b) => {
    if (a.kind === "directory" && b.kind !== "directory") return -1;
    if (a.kind !== "directory" && b.kind === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
  return { entries };
}

export async function handleMobileFileRead(
  params: { cwd: string; path: string },
): Promise<MobileFilePreview> {
  const cwd = requireString(params, "cwd");
  const path = requireString(params, "path");
  assertMobilePath(path);
  const guard = new WorkspaceGuard(cwd);
  const absolutePath = guard.resolveSafe(path, "read");
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("Path is not a file");

  const language = textLanguage(path);
  const sample = await readBytes(absolutePath, 8_192);
  if (!language || containsNul(sample)) {
    return {
      path: relativePath(guard, absolutePath),
      kind: "binary",
      mime: "application/octet-stream",
      size: fileStat.size,
      truncated: false,
    };
  }

  const bytes = await readBytes(absolutePath, Math.min(fileStat.size, MOBILE_FILE_MAX_BYTES));
  return {
    path: relativePath(guard, absolutePath),
    kind: "text",
    language,
    content: bytes.toString("utf8"),
    size: fileStat.size,
    truncated: fileStat.size > MOBILE_FILE_MAX_BYTES,
  };
}

export async function handleMobileDiffList(
  params: { cwd: string },
): Promise<{ files: MobileDiffSummary[] }> {
  const cwd = requireString(params, "cwd");
  const guard = new WorkspaceGuard(cwd);
  if (!(await isGitRepository(guard))) return { files: [] };
  const result = await runGit(guard.cwdPath, ["diff", "--numstat", "HEAD"]);
  if (result.code !== 0) return { files: [] };

  const files = result.stdout.toString("utf8").split("\n").filter(Boolean).flatMap((line) => {
    const [added, deleted, path] = line.split("\t");
    if (!path || path.split("/").includes(".git")) return [];
    const binary = added === "-" || deleted === "-";
    return [{ path, additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary }];
  });
  return { files };
}

export async function handleMobileDiffGet(
  params: { cwd: string; path: string },
): Promise<{ path: string; unifiedDiff: string; truncated: boolean }> {
  const cwd = requireString(params, "cwd");
  const path = requireString(params, "path");
  assertMobilePath(path);
  const guard = new WorkspaceGuard(cwd);
  const absolutePath = guard.resolveSafe(path, "read");
  const safePath = relativePath(guard, absolutePath);
  if (!(await isGitRepository(guard))) return { path: safePath, unifiedDiff: "", truncated: false };

  const result = await runGit(guard.cwdPath, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "HEAD",
    "--",
    safePath,
  ]);
  return {
    path: safePath,
    unifiedDiff: result.stdout.toString("utf8"),
    truncated: result.truncated,
  };
}
