import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { TriggerLeaseError, TriggerStore } from "./triggers.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("TriggerStore", () => {
  it("accepts a trigger once and rejects duplicates", () => {
    const store = triggerFixture();
    const input = { source: "webhook", externalId: "evt-1" };
    expect(store.accept(input).accepted).toBe(true);
    expect(store.accept(input).accepted).toBe(false);
  });

  it("does not recover active leases owned by another worker", () => {
    const db = openTriggerDb();
    const workerA = new TriggerStore(db, { ownerId: "worker-a", leaseTtlMs: 60_000 });
    const workerB = new TriggerStore(db, { ownerId: "worker-b", leaseTtlMs: 60_000 });
    const input = { source: "webhook", externalId: "evt-lease" };
    const accepted = workerA.accept(input);
    expect(accepted.accepted).toBe(true);

    expect(workerB.recoverIncomplete()).toBe(0);
    expect(workerA.getReceipt(input)?.state).toBe("processing");
  });

  it("allows atomic takeover after lease expiry", () => {
    const db = openTriggerDb();
    const workerA = new TriggerStore(db, { ownerId: "worker-a", leaseTtlMs: 1 });
    const workerB = new TriggerStore(db, { ownerId: "worker-b", leaseTtlMs: 60_000 });
    const input = { source: "webhook", externalId: "evt-expire" };
    workerA.accept(input);

    db.prepare(
      `UPDATE core_workflow_trigger_receipts
       SET lease_expires_at = ?, heartbeat_at = ?
       WHERE source = ? AND external_id = ?`,
    ).run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", input.source, input.externalId);

    expect(workerB.recoverIncomplete("2026-01-01T00:00:00.000Z")).toBe(1);
    expect(workerB.accept(input).accepted).toBe(true);
  });

  it("rejects late completion from a stale lease token", () => {
    const db = openTriggerDb();
    const workerA = new TriggerStore(db, { ownerId: "worker-a", leaseTtlMs: 60_000 });
    const workerB = new TriggerStore(db, { ownerId: "worker-b", leaseTtlMs: 60_000 });
    const input = { source: "webhook", externalId: "evt-fence" };
    const first = workerA.accept(input);
    expect(first.leaseToken).toBeTruthy();

    db.prepare(
      `UPDATE core_workflow_trigger_receipts
       SET lease_expires_at = ?, state = 'pending', claimed_by = NULL, lease_token = NULL
       WHERE source = ? AND external_id = ?`,
    ).run("2000-01-01T00:00:00.000Z", input.source, input.externalId);
    workerB.recoverIncomplete("2026-01-01T00:00:00.000Z");
    workerB.accept(input);

    expect(() => workerA.complete(input, first.leaseToken!)).toThrow(TriggerLeaseError);
  });
});

function triggerFixture(): TriggerStore {
  return new TriggerStore(openTriggerDb());
}

function openTriggerDb() {
  const root = mkdtempSync(join(tmpdir(), "forge-workflow-triggers-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  return forgeStore.db;
}
