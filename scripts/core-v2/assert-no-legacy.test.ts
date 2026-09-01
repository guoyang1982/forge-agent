import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanLegacySymbols } from "./assert-no-legacy.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("scanLegacySymbols", () => {
  it("finds forbidden legacy symbols", () => {
    const root = fixtureRepo({
      "apps/example/x.ts": "client.request(DAEMON_METHODS.RUN, value)",
    });
    const findings = scanLegacySymbols({ root, allowPaths: [] });
    expect(findings[0]?.symbol).toBe("DAEMON_METHODS.RUN");
  });

  it("ignores allowlisted transitional paths", () => {
    const root = fixtureRepo({
      "apps/cli/src/runner.ts": "DAEMON_METHODS.RUN",
      "apps/other/x.ts": "console.log('ok')",
    });
    const findings = scanLegacySymbols({ root });
    expect(findings).toEqual([]);
  });
});

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "forge-legacy-scan-"));
  fixtureRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
