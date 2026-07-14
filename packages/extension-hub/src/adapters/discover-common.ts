import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { hashDirectory } from "../hash.js";
import type { ExtensionKind } from "../types.js";
import { pathExists } from "./fs-ops.js";
import type { DiscoveredExt } from "./types.js";

export async function looksLikePackage(dir: string, kind: ExtensionKind): Promise<boolean> {
  if (kind === "skill") {
    return pathExists(join(dir, "SKILL.md"));
  }
  if (
    (await pathExists(join(dir, "plugin.json"))) ||
    (await pathExists(join(dir, ".cursor-plugin/plugin.json"))) ||
    (await pathExists(join(dir, ".claude-plugin/plugin.json"))) ||
    (await pathExists(join(dir, ".codex-plugin/plugin.json")))
  ) {
    return true;
  }
  // Marketplace cache packages sometimes ship skills/MCP without a pointer
  // manifest (e.g. Cursor `harness`). Still treat them as discoverable plugins.
  return (
    (await pathExists(join(dir, "skills"))) ||
    (await pathExists(join(dir, "mcp.json"))) ||
    (await pathExists(join(dir, ".mcp.json")))
  );
}

/**
 * Scan a directory whose immediate children are `<id>/` packages and return
 * the ones that look like the given kind. Content-hashes each match.
 */
export async function scanPackageDir(
  dir: string,
  kind: ExtensionKind,
): Promise<DiscoveredExt[]> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DiscoveredExt[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    const pkgDir = join(dir, entry.name);
    if (!(await looksLikePackage(pkgDir, kind))) continue;
    out.push({
      id: entry.name,
      kind,
      path: pkgDir,
      contentHash: await hashDirectory(pkgDir),
    });
  }
  return out;
}

/**
 * Scan agent marketplace install caches shaped as:
 *   `cache/<marketplace>/<name>/<version-or-sha>/`
 *
 * Used by Cursor (`~/.cursor/plugins/cache`) and Codex (`~/.codex/plugins/cache`).
 * When the same plugin id appears under multiple marketplaces/versions, keep one
 * entry (prefer a package that has an explicit plugin manifest).
 */
export async function scanVersionedMarketplaceCache(
  cacheRoot: string,
): Promise<DiscoveredExt[]> {
  let marketplaces: Dirent[] = [];
  try {
    marketplaces = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const byId = new Map<string, DiscoveredExt & { score: number }>();

  for (const mp of marketplaces) {
    if (!mp.isDirectory() || mp.name.startsWith(".")) continue;
    const mpDir = join(cacheRoot, mp.name);
    let names: Dirent[] = [];
    try {
      names = await readdir(mpDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.isDirectory() || name.name.startsWith(".")) continue;
      const nameDir = join(mpDir, name.name);
      let versions: Dirent[] = [];
      try {
        versions = await readdir(nameDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ver of versions) {
        if (!ver.isDirectory() || ver.name.startsWith(".")) continue;
        const pkgDir = join(nameDir, ver.name);
        if (!(await looksLikePackage(pkgDir, "plugin"))) continue;
        const score = await pluginManifestScore(pkgDir);
        const prev = byId.get(name.name);
        if (prev && prev.score >= score) continue;
        byId.set(name.name, {
          id: name.name,
          kind: "plugin",
          path: pkgDir,
          contentHash: await hashDirectory(pkgDir),
          score,
        });
      }
    }
  }

  return [...byId.values()].map(({ score: _score, ...ext }) => ext);
}

/** Higher = better candidate when deduping the same plugin id across caches. */
async function pluginManifestScore(dir: string): Promise<number> {
  if (await pathExists(join(dir, "plugin.json"))) return 4;
  if (await pathExists(join(dir, ".codex-plugin/plugin.json"))) return 3;
  if (await pathExists(join(dir, ".cursor-plugin/plugin.json"))) return 3;
  if (await pathExists(join(dir, ".claude-plugin/plugin.json"))) return 3;
  return 1;
}
