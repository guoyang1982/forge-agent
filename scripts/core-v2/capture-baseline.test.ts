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
    mkdirSync(join(root, "apps", "daemon", "test-fixtures"), { recursive: true });
    mkdirSync(join(root, "packages", "store", "src"), { recursive: true });
    mkdirSync(join(root, "scripts", "core-v2"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "fixture-root", private: true, scripts: { test: "vitest run" } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, "packages", "fixture", "package.json"),
      `${JSON.stringify({ name: "@fixture/package", version: "1.0.0" }, null, 2)}\n`,
    );
    writeFileSync(join(root, "migrations", "001_fixture.sql"), "select 1;\n");
    writeFileSync(
      join(root, "apps", "daemon", "test-fixtures", "core-v1-data.ts"),
      "legacy fixture\n",
    );
    writeFileSync(
      join(root, "packages", "store", "src", "legacy-upgrade.test.ts"),
      "upgrade gate\n",
    );
    writeFileSync(
      join(root, "scripts", "core-v2", "backup-data.ts"),
      "restore tool\n",
    );

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
    expect(report.schemas.migrationRange).toEqual({
      first: "001_fixture.sql",
      latest: "001_fixture.sql",
      count: 1,
    });
    expect(report.schemas.foundationEvidence).toEqual({
      legacyFixture: {
        relativePath: "apps/daemon/test-fixtures/core-v1-data.ts",
        bytes: 15,
        sha256: "eb6427a372f93c1ab9b7fab8d7c31b575ca8b733438d8c5375cc5a87b7bbf754",
      },
      upgradeGate: {
        relativePath: "packages/store/src/legacy-upgrade.test.ts",
        bytes: 13,
        sha256: "4988bda9b6886baed16b9b411c787004d7b133d86e5f84eeab853fa107bb3c88",
      },
      restoreTool: {
        relativePath: "scripts/core-v2/backup-data.ts",
        bytes: 13,
        sha256: "36a1cbc7efafaa728154cf8a9e2decd112449e1493c5221eca98a99c41ddb7cb",
      },
    });
    expect(report.runtime.node).toBe(process.version);
    expect(report.runtime.pnpm).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(report);
  });
});
