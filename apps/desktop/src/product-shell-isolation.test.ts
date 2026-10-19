import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
      continue;
    }
    if (/\.(js|ts|tsx|html|css)$/.test(name)) out.push(path);
  }
  return out;
}

describe("product shell source isolation", () => {
  it("keeps workbench renderer free of company-desktop", () => {
    const files = walk(join(repoRoot, "apps/desktop/src/renderer"));
    const hits = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        source.includes("@forge/company-desktop") ||
        source.includes("forgeCompany") ||
        source.includes("apps/company-desktop")
      );
    });
    expect(hits).toEqual([]);
  });

  it("keeps company renderer free of @forge/desktop", () => {
    const files = walk(join(repoRoot, "apps/company-desktop/src/renderer"));
    const hits = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        source.includes("@forge/desktop") ||
        source.includes("forgeDesktop") ||
        source.includes("apps/desktop")
      );
    });
    expect(hits).toEqual([]);
  });
});
