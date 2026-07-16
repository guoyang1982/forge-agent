import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelayTransport } from "./relay-transport.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("RelayTransport host identity", () => {
  it("persists stable Ed25519/X25519 keys in an owner-only file", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mobile-identity-"));
    tempDirs.push(dir);
    const identityPath = join(dir, "nested", "host-identity.json");
    const create = () =>
      new RelayTransport({
        relayOrigin: "https://relay.example.com",
        identityPath,
        log: () => undefined,
        onDataConnection: () => undefined,
      });
    const first = create();
    const firstPublicKey = Buffer.from(first.e2eePublicKey).toString("base64url");
    const firstFile = readFileSync(identityPath, "utf8");
    const second = create();

    expect(Buffer.from(second.e2eePublicKey).toString("base64url")).toBe(firstPublicKey);
    expect(readFileSync(identityPath, "utf8")).toBe(firstFile);
    if (process.platform !== "win32") {
      expect(statSync(identityPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    }
    expect(firstFile).not.toContain("BEGIN PRIVATE KEY");
  });
});
