import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { TriggerStore } from "./triggers.js";

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
    expect(store.accept(input)).toBe(true);
    expect(store.accept(input)).toBe(false);
  });
});

function triggerFixture(): TriggerStore {
  const root = mkdtempSync(join(tmpdir(), "forge-workflow-triggers-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  return new TriggerStore(forgeStore.db);
}
