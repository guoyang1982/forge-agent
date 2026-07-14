import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");

describe("model profile quick switch", () => {
  it("switches the active model when the composer profile select changes", () => {
    const source = appSource();

    expect(source).toContain('$("profileSelect").addEventListener("change"');
    expect(source).toContain("switchSelectedProfile");
  });
});
