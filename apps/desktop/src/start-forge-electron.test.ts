import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(import.meta.dirname, "../scripts/start-forge-electron.mjs"),
  "utf8",
);

describe("Forge macOS development launcher", () => {
  it("uses a stable signed Forge.app launched through LaunchServices", () => {
    expect(source).toContain('process.env.FORGE_DESKTOP_BUNDLE_NAME !== "0"');
    expect(source).toContain("hasStableForgeSignature(forgeApp)");
    expect(source).toContain('const versionPath = join(cacheDir, "electron-version")');
    expect(source).toContain("cachedVersion === electronVersion");
    expect(source).toContain('"--force", "--deep", "--sign", "-", forgeApp');
    expect(source).toContain('run("/usr/bin/open", ["-W", "-n", forgeApp');
  });
});
