import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetRegistry } from "@forge/asset-registry";
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
    const hit = (await store.search({ query: "refund", limit: 5 }))[0];
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
      accessScope: { companyId: "company-a" },
    });
    expect(
      await store.search({
        query: "playbook",
        scope: { companyId: "company-b" },
      }),
    ).toEqual([]);
    expect(
      (await store.search({
        query: "playbook",
        scope: { companyId: "company-a" },
      })).length,
    ).toBeGreaterThan(0);
  });

  it("removes deleted sources from search results", async () => {
    const store = knowledgeFixture();
    const synced = await store.syncSource(source("guide", "alpha content"));
    expect(
      (await store.search({ query: "alpha", limit: 5 })).length,
    ).toBeGreaterThan(0);
    store.deleteSource(synced.sourceId);
    expect(await store.search({ query: "alpha", limit: 5 })).toEqual([]);
  });

  it("resolves citations by chunk id", async () => {
    const store = await knowledgeFixtureWithDocument();
    const hit = (await store.search({ query: "refund", limit: 1 }))[0]!;
    const citation = store.getCitation(hit.chunkId);
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
  return new KnowledgeStore(forgeStore.db, assets, passingQualityGate());
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
    ownerSubject: { kind: "human", id: "local" },
  };
}

function passingQualityGate(): KnowledgeQualityGateInput {
  return {
    validationIds: ["validation-pass"],
    permissionReviewed: true,
    securityValidationId: "security-pass",
  };
}
