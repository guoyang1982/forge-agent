import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { AgentProfileStore } from "./store.js";
import type { PublishVersionInput } from "./types.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentProfileStore", () => {
  it("keeps a run snapshot unchanged after profile upgrade", () => {
    const profiles = profileFixture();
    const v1 = profiles.publishVersion(profileVersion({ model: "m1" }));
    const snapshot = profiles.resolveSnapshot({
      profileId: v1.profileId,
      profileVersionId: v1.id,
      runId: "run-1",
    });
    profiles.publishVersion(profileVersion({ profileId: v1.profileId, model: "m2" }));
    expect(profiles.getSnapshot(snapshot.id).modelPolicy.model).toBe("m1");
  });

  it("increments immutable profile versions", () => {
    const profiles = profileFixture();
    const v1 = profiles.publishVersion(profileVersion({ model: "m1" }));
    const v2 = profiles.publishVersion(profileVersion({ profileId: v1.profileId, model: "m2" }));
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.profileId).toBe(v1.profileId);
  });

  it("round-trips typed dynamic-status and context-compression runtime policy", () => {
    const profiles = profileFixture();
    const version = profiles.publishVersion({
      name: "runtime-policy",
      modelPolicy: {
        model: "m-policy",
        dynamicStatus: {
          enabled: true,
          modelHeartbeatIntervalMs: 25,
          toolHeartbeatIntervalMs: 50,
          dedupeWindowMs: 5,
        },
        contextCompression: {
          enabled: true,
          triggerTokenEstimate: 1_000,
          tokenBudget: 500,
          modelFailureThreshold: 2,
          maxModelAttempts: 2,
        },
      },
    });

    const snapshot = profiles.resolveSnapshot({
      profileId: version.profileId,
      profileVersionId: version.id,
      runId: "run-policy",
    });
    expect(snapshot.runtime).toEqual(version.snapshot.modelPolicy);
    expect(snapshot.runtime.dynamicStatus?.modelHeartbeatIntervalMs).toBe(25);
    expect(snapshot.runtime.contextCompression?.tokenBudget).toBe(500);
  });

  it("creates a normalized profile from a talent template", () => {
    const profiles = profileFixture();
    const version = profiles.createFromTalent({
      source: {
        templateId: "research-analyst",
        name: "Research Analyst",
        suggestedSkills: ["web-search", "summarize"],
        suggestedTools: ["browser.search"],
        knowledgeRefs: ["kb/product"],
        connectors: ["connector:notion"],
      },
      hired: {
        skills: ["web-search"],
        tools: ["browser.search", "echo"],
        strictSkills: true,
      },
      model: "gpt-test",
      policyVersionId: "policy-v1",
    });

    expect(version.snapshot.displayName).toBe("Research Analyst");
    expect(version.snapshot.skills).toEqual([{ assetId: "web-search", version: "latest" }]);
    expect(version.snapshot.tools.map((tool) => tool.name)).toEqual([
      "browser.search",
      "echo",
    ]);
    expect(version.snapshot.memoryScopes).toEqual(["talent-bound"]);
    expect(version.policyVersionId).toBe("policy-v1");
  });
});

function profileFixture(): AgentProfileStore {
  const store = openStore();
  seedPolicyVersion(store);
  return new AgentProfileStore(store.db);
}

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "forge-agent-profile-"));
  fixtureRoots.push(root);
  return ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
}

function seedPolicyVersion(store: ForgeStore) {
  store.db
    .prepare(
      `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
       VALUES ('policy-v1', 'default', 1, '{}', 1, ?)`,
    )
    .run(new Date().toISOString());
}

function profileVersion(input: PublishVersionInput): PublishVersionInput {
  return {
    name: "forge-default",
    sourceKind: "custom",
    policyVersionId: "policy-v1",
    ...input,
    modelPolicy: input.model ? { model: input.model } : input.modelPolicy,
  };
}
