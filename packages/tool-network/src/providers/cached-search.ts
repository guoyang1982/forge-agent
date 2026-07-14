import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SearchHit, SearchProvider } from "./search-types.js";

interface CacheEntry {
  cachedAt: string;
  results: SearchHit[];
}

export function createCachedSearchProvider(
  inner: SearchProvider,
  options: { cacheDir: string; ttlHours: number },
): SearchProvider {
  const ttlMs = Math.max(options.ttlHours, 1) * 60 * 60 * 1000;

  return {
    id: `${inner.id}+cached`,
    async search(query, limit, signal) {
      const key = cacheKey(inner.id, query, limit);
      const path = join(options.cacheDir, `${key}.json`);
      const cached = await readCache(path, ttlMs);
      if (cached) return cached;

      const results = await inner.search(query, limit, signal);
      await writeCache(path, results).catch(() => undefined);
      return results;
    },
  };
}

function cacheKey(providerId: string, query: string, limit: number): string {
  const raw = `${providerId}\0${query}\0${limit}`;
  return createHash("sha256").update(raw).digest("hex");
}

async function readCache(
  path: string,
  ttlMs: number,
): Promise<SearchHit[] | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const entry = JSON.parse(raw) as CacheEntry;
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (age > ttlMs) return null;
    return entry.results;
  } catch {
    return null;
  }
}

async function writeCache(path: string, results: SearchHit[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const entry: CacheEntry = {
    cachedAt: new Date().toISOString(),
    results,
  };
  await writeFile(path, JSON.stringify(entry), "utf-8");
}
