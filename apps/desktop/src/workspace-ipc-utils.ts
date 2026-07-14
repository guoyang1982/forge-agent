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
