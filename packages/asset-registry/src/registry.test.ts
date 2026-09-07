import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import {
  AssetNotFoundError,
  AssetQualityGateError,
  AssetRegistry,
  hashAssetContent,
} from "./index.js";
import { seedPublishEvidence, seedRollbackGrant } from "./test-evidence.js";
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
    const depDraft = registry.getDraftVersion(dependency.id)!;
    seedPublishEvidence(registry.db, publishEvidenceIds(dependency.id, depDraft.id));
    const publishedDep = registry.publish(
      dependency.id,
      publishInput(dependency.id, depDraft.id),
    );
    const asset = registry.createDraft(
      assetDraft({
        dependencies: [{ assetId: dependency.id, version: publishedDep.version }],
      }),
    );
    const draft = registry.getDraftVersion(asset.id)!;
    seedPublishEvidence(registry.db, publishEvidenceIds(asset.id, draft.id));
    const version = registry.publish(asset.id, publishInput(asset.id, draft.id));
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
    const draft = registry.getDraftVersion(asset.id)!;
    expect(() =>
      registry.publish(asset.id, {
        ...publishInput(asset.id, draft.id),
        validationIds: ["validation-failed-test"],
      }),
    ).toThrow(AssetQualityGateError);
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
    const draftA = registry.getDraftVersion("asset-a")!;
    seedPublishEvidence(registry.db, publishEvidenceIds("asset-a", draftA.id));
    registry.publish("asset-a", publishInput("asset-a", draftA.id));
    const b = registry.createDraft(
      assetDraft({
        id: "asset-b",
        name: "B",
        dependencies: [{ assetId: "asset-a", version: 1 }],
      }),
    );
    const draftB = registry.getDraftVersion("asset-b")!;
    seedPublishEvidence(registry.db, publishEvidenceIds("asset-b", draftB.id));
    registry.publish("asset-b", publishInput("asset-b", draftB.id));
    registry.createVersionDraft("asset-a", {
      sourceRef: "skill://a-v2",
      contentHash: hashAssetContent("a-v2"),
      description: "A v2",
      dependencies: [{ assetId: "asset-b", version: 1 }],
    });
    const draftA2 = registry.getDraftVersion("asset-a")!;
    seedPublishEvidence(registry.db, publishEvidenceIds("asset-a", draftA2.id));
    expect(() =>
      registry.publish("asset-a", publishInput("asset-a", draftA2.id, { description: "A v2" })),
    ).toThrow(/dependency cycle/);
  });

  it("deprecates a published asset", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    const draft = registry.getDraftVersion(asset.id)!;
    seedPublishEvidence(registry.db, publishEvidenceIds(asset.id, draft.id));
    registry.publish(asset.id, publishInput(asset.id, draft.id));
    const deprecated = registry.deprecate(asset.id);
    expect(deprecated.state).toBe("deprecated");
    expect(registry.resolveVersion(asset.id).state).toBe("deprecated");
  });

  it("requires durable permission and security evidence before publish", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    const draft = registry.getDraftVersion(asset.id)!;
    expect(() => registry.publish(asset.id, publishInput(asset.id, draft.id))).toThrow(
      AssetQualityGateError,
    );
  });

  it.each([
    ["an empty grant scope", "UPDATE core_grants SET resource_scope_json = '{}' WHERE id = ?"],
    ["another subject", "UPDATE core_grants SET subject_id = 'other' WHERE id = ?"],
    ["another action", "UPDATE core_grants SET action = 'asset.rollback' WHERE id = ?"],
    ["an inactive policy", "UPDATE core_policy_versions SET is_active = 0 WHERE id = (SELECT policy_version_id FROM core_grants WHERE id = ?)"],
  ])("rejects publish evidence bound to %s", (_case, mutation) => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    const draft = registry.getDraftVersion(asset.id)!;
    const evidence = publishEvidenceIds(asset.id, draft.id);
    seedPublishEvidence(registry.db, evidence);
    registry.db.prepare(
      "INSERT OR IGNORE INTO core_subjects (kind, subject_id, display_name, created_at, updated_at) VALUES ('human', 'other', 'Other', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run();
    registry.db.prepare(mutation).run(evidence.grantId);

    expect(() => registry.publish(asset.id, publishInput(asset.id, draft.id))).toThrow(
      AssetQualityGateError,
    );
  });

  it.each([
    ["asset binding", "assetId"],
    ["asset version binding", "assetVersionId"],
    ["policy binding", "policyVersionId"],
    ["subject kind binding", "subjectKind"],
    ["subject id binding", "subjectId"],
    ["action binding", "action"],
  ])("rejects validation evidence missing its %s", (_case, field) => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    const draft = registry.getDraftVersion(asset.id)!;
    const evidence = publishEvidenceIds(asset.id, draft.id);
    seedPublishEvidence(registry.db, evidence);
    for (const id of [...evidence.validationIds, evidence.securityValidationId]) {
      const row = registry.db
        .prepare("SELECT details_json FROM core_validations WHERE id = ?")
        .get(id) as { details_json: string };
      const details = JSON.parse(row.details_json) as Record<string, unknown>;
      delete details[field];
      registry.db
        .prepare("UPDATE core_validations SET details_json = ? WHERE id = ?")
        .run(JSON.stringify(details), id);
    }

    expect(() => registry.publish(asset.id, publishInput(asset.id, draft.id))).toThrow(
      AssetQualityGateError,
    );
  });

  it("rollback creates a published version with the selected content", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    const draft = registry.getDraftVersion(asset.id)!;
    seedPublishEvidence(registry.db, publishEvidenceIds(asset.id, draft.id));
    const originalContent = { description: "launch workflow skill" };
    const v1 = registry.publish(asset.id, publishInput(asset.id, draft.id));
    registry.createVersionDraft(asset.id, {
      sourceRef: "skill://v2",
      contentHash: hashAssetContent("v2"),
      description: "version two",
      content: { description: "version two" },
    });
    const draftV2 = registry.getDraftVersion(asset.id)!;
    seedPublishEvidence(registry.db, publishEvidenceIds(asset.id, draftV2.id));
    registry.publish(asset.id, publishInput(asset.id, draftV2.id, { description: "version two" }));

    seedRollbackGrant(registry.db, "grant:rollback:1", asset.id, v1.id);
    const rolled = registry.rollback(asset.id, v1.id, {
      grantId: "grant:rollback:1",
      actor: { kind: "human", id: "local" },
      reason: "restore launch version",
    });
    expect(rolled.state).toBe("published");
    expect(registry.getPublished(asset.id)?.content).toMatchObject(originalContent);
    expect(registry.getPublished(asset.id)?.content).toMatchObject({
      rollbackFromVersionId: v1.id,
      rollbackFromVersion: 1,
    });
  });

  it("does not rollback draft-only versions", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    const draft = registry.getDraftVersion(asset.id)!;
    seedRollbackGrant(registry.db, "grant:rollback:1", asset.id, draft.id);
    expect(() =>
      registry.rollback(asset.id, draft.id, {
        grantId: "grant:rollback:1",
        actor: { kind: "human", id: "local" },
        reason: "invalid rollback",
      }),
    ).toThrow(AssetQualityGateError);
  });

  it("does not resolve draft-only assets as published", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    expect(() => registry.resolveVersion(asset.id)).toThrow(AssetNotFoundError);
  });

  it("rolls back by publishing a pointer to an existing immutable version", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    const draft = registry.getDraftVersion(asset.id)!;
    seedPublishEvidence(registry.db, publishEvidenceIds(asset.id, draft.id));
    const v1 = registry.publish(asset.id, publishInput(asset.id, draft.id));
    registry.createVersionDraft(asset.id, {
      sourceRef: "skill://v2",
      contentHash: hashAssetContent("v2"),
      description: "version two",
      content: { description: "version two" },
    });
    const draftV2 = registry.getDraftVersion(asset.id)!;
    seedPublishEvidence(registry.db, publishEvidenceIds(asset.id, draftV2.id));
    const v2 = registry.publish(asset.id, publishInput(asset.id, draftV2.id, { description: "version two" }));
    expect(v2.version).toBe(2);

    seedRollbackGrant(registry.db, "grant:rollback:2", asset.id, v1.id);
    const rolled = registry.rollback(asset.id, v1.id, {
      grantId: "grant:rollback:2",
      actor: { kind: "human", id: "local" },
      reason: "restore v1",
    });
    expect(rolled.version).toBe(3);
    expect(rolled.contentHash).toBe(v1.contentHash);
    expect(rolled.sourceRef).toBe(v1.sourceRef);
    expect(registry.getVersion(v1.id).contentHash).toBe(v1.contentHash);
    expect(registry.resolveVersion(asset.id).id).toBe(rolled.id);
  });

  it("resolves the latest published version by default", () => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    const draft = registry.getDraftVersion(asset.id)!;
    seedPublishEvidence(registry.db, publishEvidenceIds(asset.id, draft.id));
    registry.publish(asset.id, publishInput(asset.id, draft.id));
    expect(registry.resolveVersion(asset.id).version).toBe(1);
    expect(() => registry.resolveVersion("missing")).toThrow(AssetNotFoundError);
  });

  it.each([
    ["an empty resource scope", "UPDATE core_grants SET resource_scope_json = '{}' WHERE id = ?"],
    ["a different actor", "UPDATE core_grants SET subject_id = 'other' WHERE id = ?"],
    ["an inactive policy", "UPDATE core_policy_versions SET is_active = 0 WHERE id = (SELECT policy_version_id FROM core_grants WHERE id = ?)"],
  ])("rejects rollback authorization bound to %s", (_case, mutation) => {
    const registry = registryFixture();
    const asset = registry.createDraft(assetDraft());
    const draft = registry.getDraftVersion(asset.id)!;
    seedPublishEvidence(registry.db, publishEvidenceIds(asset.id, draft.id));
    const published = registry.publish(asset.id, publishInput(asset.id, draft.id));
    const grantId = "grant:rollback:scoped";
    seedRollbackGrant(registry.db, grantId, asset.id, published.id);
    registry.db.prepare(
      "INSERT OR IGNORE INTO core_subjects (kind, subject_id, display_name, created_at, updated_at) VALUES ('human', 'other', 'Other', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run();
    registry.db.prepare(mutation).run(grantId);

    expect(() =>
      registry.rollback(asset.id, published.id, {
        grantId,
        actor: { kind: "human", id: "local" },
        reason: "restore",
      }),
    ).toThrow(AssetQualityGateError);
  });
});

function registryFixture(): AssetRegistry & { db: ForgeStore["db"] } {
  const root = mkdtempSync(join(tmpdir(), "forge-asset-registry-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const registry = new AssetRegistry(store.db) as AssetRegistry & { db: ForgeStore["db"] };
  registry.db = store.db;
  return registry;
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

function publishEvidenceIds(assetId: string, assetVersionId: string) {
  return {
    grantId: `grant:publish:${assetId}`,
    validationIds: [`validation-pass-${assetId}`],
    securityValidationId: `security-pass-${assetId}`,
    assetId,
    assetVersionId,
  };
}

function publishInput(
  assetId: string,
  assetVersionId: string,
  overrides: Partial<PublishInput> = {},
): PublishInput {
  return {
    validationIds: [`validation-pass-${assetId}`],
    permissionReviewId: `grant:publish:${assetId}`,
    securityValidationId: `security-pass-${assetId}`,
    description: "launch workflow skill",
    ...overrides,
  };
}
