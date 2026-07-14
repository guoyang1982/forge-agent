import { cp, mkdir, rm, symlink, lstat } from "node:fs/promises";
import { dirname } from "node:path";

const COPY_SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", ".turbo", "dist"]);

/** Remove any existing file/dir/symlink at `target` (idempotent). */
export async function removePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

/** Symlink `source` -> `target`, replacing anything already there. */
export async function deploySymlink(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await removePath(target);
  await symlink(source, target, "dir");
}

/** Copy `source` tree into `target`, replacing anything already there. */
export async function deployCopy(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await removePath(target);
  await cp(source, target, {
    recursive: true,
    filter: (src) => {
      const seg = src.split(/[\\/]/).pop() ?? "";
      return !COPY_SKIP.has(seg);
    },
  });
}

/** True if a path currently exists (file, dir, or symlink). */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}
