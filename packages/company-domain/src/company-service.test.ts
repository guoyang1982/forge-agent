import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "./index.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];
const stores: ForgeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CompanyService", () => {
  const service = openService();

  it("creates and reads a company", () => {
    const created = service.create({ name: "曜石智能" });
    expect(created.name).toBe("曜石智能");
    expect(service.get(created.id).id).toBe(created.id);
  });
});

function openService(): CompanyService {
  const root = mkdtempSync(join(tmpdir(), "forge-company-domain-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);
  return new CompanyService(store.db, {
    now: () => "2026-09-09T00:00:00.000Z",
  });
}
