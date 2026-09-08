import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetRegistry } from "@forge/asset-registry";
import { seedPublishEvidence } from "@forge/asset-registry/test-evidence";
import { ForgeStore } from "@forge/store";
import {
  KnowledgeStore,
  type KnowledgeQualityGateInput,
  type KnowledgeSourceInput,
} from "./knowledge.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("KnowledgeStore", () => {
  it("rejects new knowledge without an explicit tenant scope", async () => {
    const store = knowledgeFixture();
    await expect(
      store.syncSource({
        name: "unscoped",
        sourceKind: "document",
        content: "must not become globally visible",
        ownerSubject: { kind: "human", id: "local" },
      }),
    ).rejects.toThrow(/tenant scope/i);
  });

  it("creates a new source version only when content changes", async () => {
    const store = knowledgeFixture();
    const first = await store.syncSource(source("guide", "alpha"));
    const second = await store.syncSource(source("guide", "alpha"));
    expect(second.versionId).toBe(first.versionId);
    expect(second.created).toBe(false);
  });

  it("creates a new version when content changes", async () => {
    const store = knowledgeFixture();
    const first = await store.syncSource(source("guide", "alpha"));
    const second = await store.syncSource(source("guide", "beta"));
    expect(second.versionId).not.toBe(first.versionId);
    expect(second.version).toBe(2);
  });

  it("returns source version and locator with every hit", async () => {
    const store = await knowledgeFixtureWithDocument();
    const hit = (
      await store.search({ query: "refund", limit: 5, scope: localScope() })
    )[0];
    expect(hit).toMatchObject({
      sourceVersionId: expect.any(String),
      locator: expect.any(String),
    });
  });

  it("publishes each accepted knowledge version as a knowledge asset", async () => {
    const store = knowledgeFixture();
    const result = await store.syncSource(source("guide", "alpha"));
    expect(result.assetVersionRef.kind).toBe("knowledge");
    expect(result.assetVersionRef.version).toBe(1);
  });

  it("excludes hits outside the requested access scope", async () => {
    const store = knowledgeFixture();
    await store.syncSource({
      ...source("scoped", "company secret playbook"),
      accessScope: { tenantId: "tenant-a", organizationId: "org-a" },
    });
    expect(
      await store.search({
        query: "playbook",
        scope: { tenantId: "tenant-b", organizationId: "org-a" },
      }),
    ).toEqual([]);
    expect(
      (await store.search({
        query: "playbook",
        scope: { tenantId: "tenant-a", organizationId: "org-a" },
      })).length,
    ).toBeGreaterThan(0);
  });

  it("does not return scoped knowledge when access scope context is absent", async () => {
    const store = knowledgeFixture();
    await store.syncSource({
      ...source("scoped", "company secret playbook"),
      accessScope: { tenantId: "tenant-a", organizationId: "org-a" },
    });
    expect(await store.search({ query: "playbook" })).toEqual([]);
  });

  it("rejects scoped citations without matching access scope", async () => {
    const store = knowledgeFixture();
    await store.syncSource({
      ...source("scoped", "company secret playbook"),
      accessScope: { tenantId: "tenant-a", organizationId: "org-a" },
      chunks: [
        {
          locator: "policy.md:chunk:0",
          text: "company secret playbook",
        },
      ],
    });
    const hit = (
      await store.search({
        query: "playbook",
        scope: { tenantId: "tenant-a", organizationId: "org-a" },
      })
    )[0]!;
    expect(store.getCitation(hit.chunkId)).toBeNull();
    expect(
      store.getCitation(hit.chunkId, {
        tenantId: "tenant-a",
        organizationId: "org-a",
      }),
    ).toMatchObject({ chunkId: hit.chunkId });
  });

  it("does not expose knowledge to another organization in the same tenant", async () => {
    const store = knowledgeFixture();
    await store.syncSource({
      ...source("org-private", "private launch plan"),
      accessScope: { tenantId: "tenant-a", organizationId: "org-a" },
    });

    expect(
      await store.search({
        query: "launch",
        scope: { tenantId: "tenant-a", organizationId: "org-b" },
      }),
    ).toEqual([]);
  });

  it("rejects overwriting or deleting a source from another organization", async () => {
    const store = knowledgeFixture();
    const original = await store.syncSource({
      ...source("owned-source", "org a content"),
      accessScope: { tenantId: "tenant-a", organizationId: "org-a" },
    });

    await expect(
      store.syncSource({
        ...source("owned-source", "org b replacement"),
        id: original.sourceId,
        accessScope: { tenantId: "tenant-a", organizationId: "org-b" },
      }),
    ).rejects.toThrow(/scope/i);
    expect(() =>
      store.deleteSource(original.sourceId, {
        tenantId: "tenant-a",
        organizationId: "org-b",
      }),
    ).toThrow(/scope/i);
    expect(
      await store.search({
        query: "org a",
        scope: { tenantId: "tenant-a", organizationId: "org-a" },
      }),
    ).toHaveLength(1);
  });

  it("removes deleted sources from search results", async () => {
    const store = knowledgeFixture();
    const synced = await store.syncSource(source("guide", "alpha content"));
    expect(
      (await store.search({ query: "alpha", limit: 5, scope: localScope() })).length,
    ).toBeGreaterThan(0);
    store.deleteSource(synced.sourceId, localScope());
    expect(
      await store.search({ query: "alpha", limit: 5, scope: localScope() }),
    ).toEqual([]);
  });

  it("resolves citations by chunk id", async () => {
    const store = await knowledgeFixtureWithDocument();
    const hit = (
      await store.search({ query: "refund", limit: 1, scope: localScope() })
    )[0]!;
    const citation = store.getCitation(hit.chunkId, localScope());
    expect(citation).toMatchObject({
      chunkId: hit.chunkId,
      sourceVersionId: hit.sourceVersionId,
      locator: hit.locator,
      text: expect.stringContaining("refund"),
    });
  });
});

function knowledgeFixture(): KnowledgeStore {
  const root = mkdtempSync(join(tmpdir(), "forge-knowledge-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const assets = new AssetRegistry(forgeStore.db);
  return new KnowledgeStore(forgeStore.db, assets, (target) => {
    const gate = passingQualityGate();
    seedPublishEvidence(forgeStore.db, {
      grantId: gate.permissionReviewId,
      validationIds: gate.validationIds,
      securityValidationId: gate.securityValidationId,
      assetId: target.assetId,
      assetVersionId: target.assetVersionId,
    });
    return gate;
  });
}

async function knowledgeFixtureWithDocument(): Promise<KnowledgeStore> {
  const store = knowledgeFixture();
  await store.syncSource({
    ...source("policy", "All refund requests must be approved within 30 days."),
    chunks: [
      {
        locator: "policy.md:chunk:0",
        text: "All refund requests must be approved within 30 days.",
      },
    ],
  });
  return store;
}

function source(name: string, content: string): KnowledgeSourceInput {
  return {
    name,
    sourceKind: "document",
    content,
    accessScope: localScope(),
    ownerSubject: { kind: "human", id: "local" },
  };
}

function localScope() {
  return { tenantId: "local" };
}

function passingQualityGate(): KnowledgeQualityGateInput {
  return {
    validationIds: ["validation-pass"],
    permissionReviewId: "grant:publish:knowledge",
    securityValidationId: "security-pass",
  };
}
