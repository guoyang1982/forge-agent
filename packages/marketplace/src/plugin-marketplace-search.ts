import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import featured from "./featured-plugins-catalog.json" with { type: "json" };
import { searchGitHubRepositories } from "./github-repos.js";

export type MarketplacePluginSource = "featured" | "github" | "catalog";

export interface MarketplacePluginItem {
  id: string;
  name: string;
  description: string;
  repo: string;
  subdir?: string;
  catalogId?: string;
  stars?: number;
  source: MarketplacePluginSource;
  installed: boolean;
}

interface FeaturedPluginRow {
  id: string;
  name: string;
  description: string;
  repo: string;
  subdir?: string;
  catalogId?: string;
  stars?: number;
  tags?: string[];
}

export function listInstalledPluginIds(userPluginsDir?: string): Set<string> {
  const dir = userPluginsDir ?? join(homedir(), ".forge-agent", "plugins");
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const manifestPath = join(dir, name, "plugin.json");
    if (!existsSync(manifestPath)) {
      ids.add(name);
      continue;
    }
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: string };
      if (raw.id) ids.add(raw.id);
      ids.add(name);
    } catch {
      ids.add(name);
    }
  }
  return ids;
}

function featuredToItem(row: FeaturedPluginRow): MarketplacePluginItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    repo: row.repo,
    subdir: row.subdir ?? "",
    catalogId: row.catalogId,
    stars: row.stars,
    source: "featured",
    installed: false,
  };
}

function filterByQuery(items: MarketplacePluginItem[], query?: string): MarketplacePluginItem[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    const hay = [item.id, item.name, item.description, item.repo, item.subdir, item.catalogId]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

function dedupeItems(items: MarketplacePluginItem[]): MarketplacePluginItem[] {
  const seen = new Set<string>();
  const out: MarketplacePluginItem[] = [];
  for (const item of items) {
    const key = `${item.repo}::${item.subdir ?? ""}::${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function markInstalled(
  items: MarketplacePluginItem[],
  installed: Set<string>,
): MarketplacePluginItem[] {
  return items.map((item) => ({
    ...item,
    installed:
      installed.has(item.id) ||
      installed.has(item.name) ||
      (item.catalogId ? installed.has(item.catalogId) : false),
  }));
}

export async function searchPluginsMarketplace(options: {
  query?: string;
  mode?: "featured" | "online" | "all";
  limit?: number;
  installedIds?: string[];
}): Promise<{ items: MarketplacePluginItem[]; hint?: string }> {
  const mode = options.mode ?? "all";
  const limit = options.limit ?? 40;
  const installed = new Set([
    ...listInstalledPluginIds(),
    ...(options.installedIds ?? []),
  ]);
  const q = (options.query ?? "").trim();
  const items: MarketplacePluginItem[] = [];
  let hint: string | undefined;

  if (mode === "featured" || mode === "all") {
    items.push(...filterByQuery((featured as FeaturedPluginRow[]).map(featuredToItem), q));
  }

  if (mode === "online" || (mode === "all" && q.length >= 2)) {
    if (q.length >= 2) {
      try {
        const hits = await searchGitHubRepositories(q, limit);
        for (const hit of hits) {
          const slug = hit.fullName.split("/").pop() ?? hit.fullName;
          items.push({
            id: slug.replace(/[^a-zA-Z0-9_-]/g, "-"),
            name: slug,
            description: hit.description || `GitHub 仓库 ${hit.fullName}`,
            repo: hit.fullName,
            subdir: "",
            stars: hit.stars,
            source: "github",
            installed: false,
          });
        }
      } catch (e) {
        hint = `GitHub 搜索暂时不可用: ${e instanceof Error ? e.message : String(e)}。仍可安装精选插件。`;
      }
    } else if (mode === "online") {
      hint = "在线搜索请输入至少 2 个字符（通过 GitHub 仓库搜索）。";
    }
  }

  if (mode === "all" && !q) {
    hint = "精选 Forge 常用插件；输入关键词（≥2 字）可从 GitHub 搜索更多仓库。";
  }

  const deduped = dedupeItems(items).slice(0, limit);
  return {
    items: markInstalled(deduped, installed),
    hint,
  };
}
