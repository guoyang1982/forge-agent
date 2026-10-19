import { describe, expect, it } from "vitest";
import { createProductionValidatorRegistry } from "./production-validators.js";
import { ValidationService } from "@forge/evidence";
import { ForgeStore } from "@forge/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("production validators: requirement-research steps", () => {
  it("covers requirement-research step kinds and requires an output reference", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-prod-validators-"));
    const store = ForgeStore.open({
      dbPath: join(root, "data.db"),
      migrationsDir: join(import.meta.dirname, "..", "..", "..", "..", "migrations"),
      owner: "test",
    });
    try {
      const service = new ValidationService(store.db, createProductionValidatorRegistry());
      const base = { runId: "r", deliveryId: "d", artifactIds: [], evidenceIds: [] };
      const ctx = (extra: Record<string, unknown>) => ({
        ...base,
        context: { stepKind: "requirement-research.synthesis", ...extra },
      });
      expect(service.hasCoverage(ctx({}))).toBe(true);
      expect(service.hasCoverage({ ...base, context: { stepKind: "product-delivery.release-gate" } })).toBe(false);
      expect((await service.validateDelivery(ctx({ outputRef: "forge-run-result:x" }))).accepted).toBe(true);
      expect((await service.validateDelivery(ctx({}))).accepted).toBe(false);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
