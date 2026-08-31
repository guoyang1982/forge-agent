import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupForgeData, verifyBackup } from "./backup-data.js";

const temporaryRoots: string[] = [];

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-core-v2-backup-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("backupForgeData", () => {
  it("copies Forge database files and JSON assets with a SHA-256 manifest", async () => {
    const root = createFixtureRoot();
    const dataDir = join(root, "data");
    const outputDir = join(root, "backups");

    mkdirSync(join(dataDir, "settings"), { recursive: true });
    writeFileSync(join(dataDir, "data.db"), "database-fixture");
    writeFileSync(join(dataDir, "data.db-wal"), "wal-fixture");
    writeFileSync(join(dataDir, "data.db-shm"), "shm-fixture");
    writeFileSync(join(dataDir, "settings", "company.json"), '{"name":"Forge"}');
    writeFileSync(join(dataDir, "runtime.log"), "must not be copied");

    const manifest = await backupForgeData({ dataDir, outputDir });

    expect(manifest.sourceDir).toBe(realpathSync(dataDir));
    expect(manifest.backupDir).not.toBe(outputDir);
    expect(manifest.files.map((file) => file.relativePath)).toEqual([
      "data.db",
      "data.db-shm",
      "data.db-wal",
      "settings/company.json",
    ]);
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(JSON.parse(readFileSync(manifest.manifestPath, "utf8"))).toMatchObject({
      sourceDir: realpathSync(dataDir),
      backupDir: manifest.backupDir,
    });
    await expect(verifyBackup(manifest.manifestPath)).resolves.toBeUndefined();
  });

  it("fails closed when a copied file no longer matches its checksum", async () => {
    const root = createFixtureRoot();
    const dataDir = join(root, "data");
    const outputDir = join(root, "backups");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "data.db"), "original");

    const manifest = await backupForgeData({ dataDir, outputDir });
    writeFileSync(join(manifest.backupDir, "data.db"), "tampered");

    await expect(verifyBackup(manifest.manifestPath)).rejects.toThrow(
      "checksum mismatch for data.db",
    );
  });

  it("rejects broad, relative, and overlapping directory targets", async () => {
    const root = createFixtureRoot();
    const dataDir = join(root, "data");
    mkdirSync(dataDir);

    await expect(
      backupForgeData({ dataDir: "/", outputDir: join(root, "backups") }),
    ).rejects.toThrow("unsafe data directory");
    await expect(
      backupForgeData({ dataDir: homedir(), outputDir: join(root, "backups") }),
    ).rejects.toThrow("unsafe data directory");
    await expect(
      backupForgeData({ dataDir: "relative-data", outputDir: join(root, "backups") }),
    ).rejects.toThrow("data directory must be an absolute path");
    await expect(
      backupForgeData({ dataDir, outputDir: join(dataDir, "backups") }),
    ).rejects.toThrow("backup output must not overlap the data directory");
    expect(existsSync(join(dataDir, "backups"))).toBe(false);
  });
});
