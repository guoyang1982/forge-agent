import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MobileDeviceRegistry } from "./device-registry.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tempDirs: string[] = [];

function bootRegistry(): { registry: MobileDeviceRegistry; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "forge-mobile-registry-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "data.db");
  const db = new Database(dbPath);
  db.exec(readFileSync(join(repoRoot, "migrations", "008_mobile_devices.sql"), "utf8"));
  db.close();
  return { registry: new MobileDeviceRegistry(dbPath, "adapter_mobile01"), dbPath };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("MobileDeviceRegistry", () => {
  it("consumes pairing secrets once and authenticates only token hashes", () => {
    const { registry, dbPath } = bootRegistry();
    try {
      registry.recordPairing({
        deviceId: "device_000001",
        inviteId: "invite_000001",
        pairingSecret: "pairing-secret-value",
        expiresAt: Date.now() + 60_000,
      });
      expect(registry.consumePairing("device_000001", "wrong-secret")).toBe(false);
      expect(registry.consumePairing("device_000001", "pairing-secret-value")).toBe(true);
      expect(registry.consumePairing("device_000001", "pairing-secret-value")).toBe(false);

      registry.installDevice({
        deviceId: "device_000001",
        token: "device-token-secret-value",
        allowedProjects: ["/workspace/a"],
      });
      expect(registry.authenticate("device_000001", "wrong-token")).toBeNull();
      expect(registry.authenticate("device_000001", "device-token-secret-value")).toMatchObject({
        deviceId: "device_000001",
        allowedProjects: ["/workspace/a"],
      });

      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT token_hash FROM mobile_devices WHERE device_id = ?")
        .get("device_000001") as { token_hash: Buffer };
      db.close();
      expect(row.token_hash.toString("utf8")).not.toContain("device-token-secret-value");
    } finally {
      registry.close();
    }
  });

  it("revokes locally before recording a durable Relay outbox operation", () => {
    const { registry } = bootRegistry();
    try {
      registry.installDevice({
        deviceId: "device_000001",
        token: "device-token-secret-value",
        allowedProjects: [],
      });
      expect(registry.revoke("device_000001")).toBe(true);
      expect(registry.authenticate("device_000001", "device-token-secret-value")).toBeNull();
      expect(registry.pendingRevocations()).toEqual([
        expect.objectContaining({ deviceId: "device_000001" }),
      ]);
      registry.completeOutbox(registry.pendingRevocations()[0]!.id);
      expect(registry.pendingRevocations()).toEqual([]);
    } finally {
      registry.close();
    }
  });

  it("updates project grants only for active devices", () => {
    const { registry } = bootRegistry();
    try {
      registry.installDevice({
        deviceId: "device_000001",
        token: "device-token-secret-value",
        allowedProjects: ["/workspace/a"],
      });
      expect(
        registry.updateAllowedProjects("device_000001", ["/workspace/b", "/workspace/b"]),
      ).toMatchObject({ allowedProjects: ["/workspace/b"] });
      registry.revoke("device_000001");
      expect(registry.updateAllowedProjects("device_000001", [])).toBeNull();
    } finally {
      registry.close();
    }
  });
});
