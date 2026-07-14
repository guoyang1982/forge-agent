import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCachedSearchProvider } from "./cached-search.js";
import type { SearchProvider } from "./search-types.js";

describe("createCachedSearchProvider", () => {
  let cacheDir: string;

  afterEach(async () => {
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  });

  it("reuses cached results on second call", async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "forge-search-cache-"));
    const inner: SearchProvider = {
      id: "mock",
      search: vi
        .fn()
        .mockResolvedValue([
          { title: "Hit", url: "https://example.com", snippet: "s" },
        ]),
    };
    const cached = createCachedSearchProvider(inner, {
      cacheDir,
      ttlHours: 24,
    });

    const first = await cached.search("forge agent", 5);
    const second = await cached.search("forge agent", 5);

    expect(first).toEqual(second);
    expect(inner.search).toHaveBeenCalledTimes(1);
  });
});
