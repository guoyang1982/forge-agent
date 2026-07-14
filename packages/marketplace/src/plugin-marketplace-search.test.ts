import { describe, expect, it } from "vitest";
import { searchPluginsMarketplace } from "./plugin-marketplace-search.js";

describe("searchPluginsMarketplace", () => {
  it("returns featured items without query", async () => {
    const res = await searchPluginsMarketplace({ mode: "featured" });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items[0]?.source).toBe("featured");
  });

  it("filters featured by query", async () => {
    const res = await searchPluginsMarketplace({ mode: "featured", query: "superpowers" });
    expect(res.items.some((i) => i.id.includes("superpowers"))).toBe(true);
  });
});
