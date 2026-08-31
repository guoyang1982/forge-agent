import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureCoreV2Baseline } from "./capture-baseline.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-core-v2-baseline-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("captureCoreV2Baseline", () => {
  it("records the Git, workspace package, and migration checksum baseline", async () => {
    const root = createFixtureRoot();
    const outputPath = join(root, "reports", "core-v2-baseline.json");
    mkdirSync(join(root, "migrations"), { recursive: true });
    mkdirSync(join(root, "packages", "fixture"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "fixture-root", private: true, scripts: { test: "vitest run" } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, "packages", "fixture", "package.json"),
      `${JSON.stringify({ name: "@fixture/package", version: "1.0.0" }, null, 2)}\n`,
    );
    writeFileSync(join(root, "migrations", "001_fixture.sql"), "select 1;\n");

    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Forge Test",
        "-c",
        "user.email=forge-test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
    const { stdout: commitOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });

    const report = await captureCoreV2Baseline({ repositoryRoot: root, outputPath });

    expect(report.repository).toEqual({
      root: realpathSync(root),
      commit: commitOutput.trim(),
      branch: "main",
      dirty: false,
    });
    expect(report.workspace.packageNames).toEqual(["@fixture/package", "fixture-root"]);
    expect(report.workspace.rootScripts).toEqual(["test"]);
    expect(report.schemas.migrations).toEqual([
      {
        relativePath: "migrations/001_fixture.sql",
        bytes: 10,
        sha256: "4a45092ccf992ea92250053a80b931b787924ba61648f420555511b84f10ab6c",
      },
    ]);
    expect(report.runtime.node).toBe(process.version);
    expect(report.runtime.pnpm).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(report);
  });
});
