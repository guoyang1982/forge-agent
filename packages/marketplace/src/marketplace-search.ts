import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import featured from "./featured-catalog.json" with { type: "json" };
import { getCatalogEntry } from "./import.js";
import { parseSkillsShId, searchSkillsSh } from "./skills-sh.js";

export type MarketplaceSkillSource = "featured" | "skills.sh" | "catalog";

export interface MarketplaceSkillItem {
  id: string;
  name: string;
  description: string;
  repo: string;
  subdir?: string;
  catalogId?: string;
  installs?: number;
  stars?: number;
  source: MarketplaceSkillSource;
  installed: boolean;
}

interface FeaturedRow {
  id: string;
  name: string;
  description: string;
  repo: string;
  subdir?: string;
  catalogId?: string;
  installs?: number;
  stars?: number;
  tags?: string[];
}

export function listInstalledSkillIds(userSkillsDir?: string): Set<string> {
  const dir = userSkillsDir ?? join(homedir(), ".forge-agent", "skills");
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    ids.add(name);
  }
  return ids;
}

function markInstalled(
  items: MarketplaceSkillItem[],
  installed: Set<string>,
): MarketplaceSkillItem[] {
  return items.map((item) => ({
    ...item,
    installed:
      installed.has(item.id) ||
      installed.has(item.name) ||
      (item.catalogId ? installed.has(item.catalogId) : false),
  }));
}

function featuredToItem(row: FeaturedRow): MarketplaceSkillItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    repo: row.repo,
    subdir: row.subdir ?? "",
    catalogId: row.catalogId,
    installs: row.installs,
    stars: row.stars,
    source: "featured",
    installed: false,
  };
}

function filterByQuery(items: MarketplaceSkillItem[], query?: string): MarketplaceSkillItem[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    const hay = [
      item.id,
      item.name,
      item.description,
      item.repo,
      item.subdir,
      item.catalogId,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

function dedupeItems(items: MarketplaceSkillItem[]): MarketplaceSkillItem[] {
  const seen = new Set<string>();
  const out: MarketplaceSkillItem[] = [];
  for (const item of items) {
    const key = `${item.repo}::${item.subdir ?? ""}::${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function searchSkillsMarketplace(options: {
  query?: string;
  mode?: "featured" | "online" | "all";
  limit?: number;
  installedIds?: string[];
}): Promise<{ items: MarketplaceSkillItem[]; hint?: string }> {
  const mode = options.mode ?? "all";
  const limit = options.limit ?? 40;
  const installed = new Set([
    ...listInstalledSkillIds(),
    ...(options.installedIds ?? []),
  ]);
  const q = (options.query ?? "").trim();
  const items: MarketplaceSkillItem[] = [];
  let hint: string | undefined;

  if (mode === "featured" || mode === "all") {
    const featuredItems = (featured as FeaturedRow[]).map(featuredToItem);
    items.push(...filterByQuery(featuredItems, q));
  }

  if (mode === "online" || (mode === "all" && q.length >= 2)) {
    if (q.length >= 2) {
      try {
        const hits = await searchSkillsSh(q, limit);
        for (const hit of hits) {
          const { repo, subdir } = parseSkillsShId(hit.id);
          const catalog = getCatalogEntry(hit.skillId);
          items.push({
            id: hit.skillId,
            name: hit.name,
            description: catalog?.description ?? `来自 ${hit.source}`,
            repo,
            subdir,
            catalogId: catalog?.id,
            installs: hit.installs,
            source: "skills.sh",
            installed: false,
          });
        }
      } catch (e) {
        hint = `在线搜索暂时不可用: ${e instanceof Error ? e.message : String(e)}。仍可安装精选列表中的 Skill。`;
      }
    } else if (mode === "online") {
      hint = "在线搜索请输入至少 2 个字符（数据来自 skills.sh）。";
    }
  }

  if (mode === "all" && !q) {
    hint =
      "精选推荐来自热门 GitHub Skill 仓库；输入关键词（≥2 字）可搜索 skills.sh 更多结果。";
  }

  const deduped = dedupeItems(items).slice(0, limit);
  return {
    items: markInstalled(deduped, installed),
    hint,
  };
}

export function formatInstallCount(n?: number): string {
  if (n == null || n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
