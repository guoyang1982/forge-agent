import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationService, ValidatorRegistry } from "../../index.js";
import { createDeliveryValidatorBundle } from "./delivery-validator-bundle.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "..", "migrations");
const roots: string[] = [];
const stores: ForgeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("delivery validator bundle", () => {
  it("blocks a final answer that claims success after failed tests", async () => {
    const validation = fixture();

    const result = await validation.validateDelivery(
      deliveryFixture({ testsPassed: false, finalClaim: "全部完成" }),
    );

    expect(result.accepted).toBe(false);
    expect(result.results).toContainEqual(
      expect.objectContaining({
        layer: "answer",
        status: "failed",
        severity: "blocking",
      }),
    );
  });

  it("passes all three layers with passing checks and current delivery evidence", async () => {
    const validation = fixture();

    const result = await validation.validateDelivery(deliveryFixture());

    expect(result.accepted).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.map(({ layer, status }) => ({ layer, status }))).toEqual([
      { layer: "result", status: "passed" },
      { layer: "process", status: "passed" },
      { layer: "answer", status: "passed" },
    ]);
  });

  it("fails the result layer independently when tests fail", async () => {
    const validation = fixture();

    const result = await validation.validateDelivery(
      deliveryFixture({
        testsPassed: false,
        finalClaim: "测试失败，交付尚未完成",
      }),
    );

    expect(result.accepted).toBe(false);
    expect(result.results).toContainEqual(
      expect.objectContaining({ layer: "result", status: "failed" }),
    );
    expect(result.results).toContainEqual(
      expect.objectContaining({ layer: "answer", status: "passed" }),
    );
  });

  it("fails process validation when the trace is not checkpoint-anchored", async () => {
    const validation = fixture();

    const result = await validation.validateDelivery(
      deliveryFixture({ trace: { id: "trace-1" } }),
    );

    expect(result.accepted).toBe(false);
    expect(result.results).toContainEqual(
      expect.objectContaining({ layer: "process", status: "failed" }),
    );
  });

  it("fails process validation for stale trace evidence", async () => {
    const validation = fixture();

    const result = await validation.validateDelivery(
      deliveryFixture({ trace: { id: "trace-1", stale: true } }),
    );

    expect(result.accepted).toBe(false);
    expect(result.results).toContainEqual(
      expect.objectContaining({ layer: "process", status: "failed" }),
    );
  });
});

function fixture(): ValidationService {
  const root = mkdtempSync(join(tmpdir(), "forge-delivery-validation-"));
  roots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);
  const registry = new ValidatorRegistry();
  for (const validator of createDeliveryValidatorBundle()) {
    registry.register(validator);
  }
  return new ValidationService(store.db, registry);
}

function deliveryFixture(contextOverrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    deliveryId: "delivery-1",
    artifactIds: ["artifact-1"],
    evidenceIds: ["evidence-1"],
    context: {
      testsPassed: true,
      buildPassed: true,
      checkpointId: "checkpoint-1",
      checkpointHash: "sha256:checkpoint-1",
      trace: { id: "trace-1", checkpointId: "checkpoint-1", stale: false },
      finalClaim: "测试与构建通过，关键交付等待发布审批",
      ...contextOverrides,
    },
  };
}
