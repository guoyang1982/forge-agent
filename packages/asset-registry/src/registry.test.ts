import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import {
  AssetNotFoundError,
  AssetRegistry,
  hashAssetContent,
} from "./index.js";
import type { CreateDraftInput, PublishInput } from "./types.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AssetRegistry", () => {
  it("publishes an immutable version with owner source and dependencies", () => {
    const registry = registryFixture();
    const dependency = registry.createDraft(
      assetDraft({
        id: "dep-1",
        name: "dependency",
        sourceRef: "skill://dep",
        contentHash: hashAssetContent("dep"),
      }),
    );
    const publishedDep = registry.publish(dependency.id, publishInput());
    const asset = registry.createDraft(
      assetDraft({
        dependencies: [{ assetId: dependency.id, version: publishedDep.version }],
      }),
    );
    const version = registry.publish(asset.id, publishInput({ validationIds: ["validation-pass"] }));
    expect(version).toMatchObject({
      version: 1,
      state: "published",
      ownerSubjectId: "human:local",
    });
    expect(() => registry.mutateVersion(version.id, {})).toThrow("immutable asset version");
  });

  it("blocks publish when security or evaluation validation fails", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    expect(() =>
      registry.publish(asset.id, publishInput({ validationIds: ["validation-failed"] })),
    ).toThrow(/asset quality gate failed/);
  });

  it("rejects publish when owner is missing", () => {
    const registry = registryFixture();
    expect(() =>
      registry.createDraft({
        kind: "skill",
        name: "orphan",
        ownerSubject: { kind: "", id: "" },
        sourceRef: "skill://orphan",
        contentHash: hashAssetContent("orphan"),
      }),
    ).toThrow(/owner is required/);
  });

  it("rejects dependency cycles", () => {
    const registry = registryFixture();
    const a = registry.createDraft(assetDraft({ id: "asset-a", name: "A" }));
    registry.publish(a.id, publishInput());
    const b = registry.createDraft(
      assetDraft({
        id: "asset-b",
        name: "B",
        dependencies: [{ assetId: "asset-a", version: 1 }],
      }),
    );
    registry.publish(b.id, publishInput());
    registry.createVersionDraft("asset-a", {
      sourceRef: "skill://a-v2",
      contentHash: hashAssetContent("a-v2"),
      description: "A v2",
      dependencies: [{ assetId: "asset-b", version: 1 }],
    });
    expect(() =>
      registry.publish("asset-a", publishInput({ description: "A v2" })),
    ).toThrow(/dependency cycle/);
  });

  it("deprecates a published asset", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    registry.publish(asset.id, publishInput());
    const deprecated = registry.deprecate(asset.id);
    expect(deprecated.state).toBe("deprecated");
    expect(registry.resolveVersion(asset.id).state).toBe("deprecated");
  });

  it("rolls back by publishing a pointer to an existing immutable version", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    const v1 = registry.publish(asset.id, publishInput());
    registry.createVersionDraft(asset.id, {
      sourceRef: "skill://v2",
      contentHash: hashAssetContent("v2"),
      description: "version two",
      content: { description: "version two" },
    });
    const v2 = registry.publish(asset.id, publishInput({ description: "version two" }));
    expect(v2.version).toBe(2);

    const rolled = registry.rollback(asset.id, v1.id);
    expect(rolled.version).toBe(3);
    expect(rolled.contentHash).toBe(v1.contentHash);
    expect(rolled.sourceRef).toBe(v1.sourceRef);
    expect(registry.getVersion(v1.id).contentHash).toBe(v1.contentHash);
    expect(registry.resolveVersion(asset.id).id).toBe(rolled.id);
  });

  it("resolves the latest published version by default", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    registry.publish(asset.id, publishInput());
    expect(registry.resolveVersion(asset.id).version).toBe(1);
    expect(() => registry.resolveVersion("missing")).toThrow(AssetNotFoundError);
  });
});

function registryFixture(): AssetRegistry {
  const root = mkdtempSync(join(tmpdir(), "forge-asset-registry-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  return new AssetRegistry(store.db);
}

function assetDraft(overrides: Partial<CreateDraftInput> = {}): CreateDraftInput {
  return {
    kind: "skill",
    name: "launch-skill",
    ownerSubject: { kind: "human", id: "local" },
    sourceRef: "skill://launch",
    contentHash: hashAssetContent("launch"),
    description: "launch workflow skill",
    content: { description: "launch workflow skill" },
    ...overrides,
  };
}

function publishInput(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    validationIds: ["validation-pass"],
    permissionReviewed: true,
    securityValidationId: "security-pass",
    description: "launch workflow skill",
    ...overrides,
  };
}
