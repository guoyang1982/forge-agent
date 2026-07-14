import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikePackage, scanVersionedMarketplaceCache } from "./discover-common.js";

describe("looksLikePackage", () => {
  it("accepts skills/MCP-only packages without a pointer manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-harness-"));
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "mcp.json"), "{}");
    expect(await looksLikePackage(dir, "plugin")).toBe(true);
  });

  it("accepts .codex-plugin manifests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-codex-pkg-"));
    mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(join(dir, ".codex-plugin/plugin.json"), JSON.stringify({ name: "browser" }));
    expect(await looksLikePackage(dir, "plugin")).toBe(true);
  });
});

describe("scanVersionedMarketplaceCache", () => {
  it("finds cache/<marketplace>/<name>/<version> packages", async () => {
    const cache = mkdtempSync(join(tmpdir(), "hub-cache-"));
    const pkg = join(cache, "openai-bundled", "browser", "1.0.0");
    mkdirSync(join(pkg, ".codex-plugin"), { recursive: true });
    writeFileSync(join(pkg, ".codex-plugin/plugin.json"), JSON.stringify({ name: "browser" }));

    const found = await scanVersionedMarketplaceCache(cache);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "browser", kind: "plugin", path: pkg });
  });

  it("dedupes the same id across marketplaces, preferring explicit manifests", async () => {
    const cache = mkdtempSync(join(tmpdir(), "hub-cache-dedupe-"));
    const weak = join(cache, "openai-curated", "figma", "aaa");
    mkdirSync(join(weak, "skills"), { recursive: true });
    const strong = join(cache, "openai-curated-remote", "figma", "2.0.14");
    mkdirSync(join(strong, ".codex-plugin"), { recursive: true });
    writeFileSync(join(strong, ".codex-plugin/plugin.json"), JSON.stringify({ name: "figma" }));

    const found = await scanVersionedMarketplaceCache(cache);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(strong);
  });
});
