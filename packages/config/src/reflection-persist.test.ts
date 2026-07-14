import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, setConfigPath } from "./index.js";

describe("reflection config persistence", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    setConfigPath(undefined);
  });

  it("survives the save → disk → load round trip", () => {
    dir = mkdtempSync(join(tmpdir(), "forge-cfg-"));
    setConfigPath(join(dir, "config.json"));

    saveConfig({
      profiles: {
        custom: { provider: "custom", baseUrl: "https://example.com/v1", apiKey: "k", name: "custom-model" },
      },
      activeProfile: "custom",
      reflection: {
        enabled: true,
        reviewerProfile: "deepseek",
        maxRounds: 2,
        severityGate: "blocker",
      },
    });

    // Written to disk, not stripped by the file whitelist.
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(onDisk.reflection).toEqual({
      enabled: true,
      reviewerProfile: "deepseek",
      maxRounds: 2,
      severityGate: "blocker",
    });

    // Read back through the normal load path.
    const loaded = loadConfig();
    expect(loaded.reflection?.enabled).toBe(true);
    expect(loaded.reflection?.reviewerProfile).toBe("deepseek");
    expect(loaded.reflection?.maxRounds).toBe(2);
  });
});
