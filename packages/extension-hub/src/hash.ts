import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Directories never included in a content hash (VCS, build, caches). */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".turbo",
  "dist",
  ".DS_Store",
]);

async function walk(dir: string, root: string, files: string[]): Promise<void> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, root, files);
    } else if (entry.isFile()) {
      files.push(abs);
    }
  }
}

/**
 * Deterministic content hash of a directory tree.
 *
 * Hashes each file's POSIX-normalized relative path and its bytes, in sorted
 * path order, so the same content yields the same hash regardless of FS order.
 * Returns `sha256:<hex>`.
 */
export async function hashDirectory(dir: string): Promise<string> {
  const files: string[] = [];
  await walk(dir, dir, files);
  files.sort();

  const hash = createHash("sha256");
  for (const file of files) {
    const rel = relative(dir, file).split(sep).join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Hash arbitrary string/bytes content. Returns `sha256:<hex>`. */
export function hashContent(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
