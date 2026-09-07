import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationStore } from "@forge/automation";
import { AgentProfileStore } from "@forge/agent-profile";
import { ValidationService } from "@forge/evidence";
import { ForgeStore } from "@forge/store";
import { BudgetLedgerService } from "@forge/usage-ledger";
import { WorkspaceGroupService } from "@forge/workspace";
import type { DurableWorkflowDefinition } from "@forge/workflows";
import { createProductionValidatorRegistry } from "./production-validators.js";
import {
  AutomationGovernanceService,
  AutomationGrantRequiredError,
  LOCAL_DEFAULT_POLICY_ID,
  seedAutomationGrant,
} from "./automation-governance.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AutomationGovernanceService local bootstrap", () => {
  it("creates a default active policy when the daemon DB has none", () => {
    const fx = fixture();
    expect(fx.activePolicyId()).toBeUndefined();
    expect(fx.governance.ensureLocalPolicy()).toBe(LOCAL_DEFAULT_POLICY_ID);
    expect(fx.activePolicyId()).toBe(LOCAL_DEFAULT_POLICY_ID);
  });

  it("rejects caller-supplied userGranted without inserting a grant", async () => {
    const fx = fixture();
    await expect(
      Reflect.apply(fx.governance.prepare, fx.governance, [
        fx.automation,
        fx.definition,
        { userGranted: true },
      ]),
    ).rejects.toThrow(AutomationGrantRequiredError);
    expect(fx.grantCount()).toBe(0);
  });

  it("rejects a manual-trigger automation without inserting a grant", async () => {
    const fx = fixture();
    await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
      AutomationGrantRequiredError,
    );
    expect(fx.grantCount()).toBe(0);
  });

  it("rejects the auto-grant flag in production without inserting a grant", async () => {
    const fx = fixture();
    const nodeEnv = process.env.NODE_ENV;
    const autoGrant = process.env.FORGE_AUTOMATION_AUTO_GRANT;
    process.env.NODE_ENV = "production";
    process.env.FORGE_AUTOMATION_AUTO_GRANT = "1";
    try {
      await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
        AutomationGrantRequiredError,
      );
      expect(fx.grantCount()).toBe(0);
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (autoGrant === undefined) delete process.env.FORGE_AUTOMATION_AUTO_GRANT;
      else process.env.FORGE_AUTOMATION_AUTO_GRANT = autoGrant;
    }
  });

  it("uses an existing matching external grant", async () => {
    const fx = fixture();
    fx.seedExternalGrant();
    const prepared = await fx.governance.prepare(fx.automation, fx.definition);
    expect(prepared.budgetAccountId).toContain("automation-budget:");
    expect(fx.grantCount()).toBe(2);
    expect(
      fx.profiles.getLatestVersion(`automation-profile:${fx.automation.id}`)
        ?.snapshot.modelPolicy.model,
    ).not.toBe("forge-default");
  });

  it("rejects an existing grant scoped to a different workspace", async () => {
    const fx = fixture();
    fx.seedExternalGrant("automation-workspace:other");
    await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
      AutomationGrantRequiredError,
    );
    expect(fx.grantCount()).toBe(2);
  });

  it("rejects an external grant with an empty scope", async () => {
    const fx = fixture();
    fx.seedExternalGrant();
    fx.db
      .prepare("UPDATE core_grants SET resource_scope_json = ? WHERE id = ?")
      .run(JSON.stringify({}), fx.grantId);
    await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
      AutomationGrantRequiredError,
    );
    expect(fx.grantCount()).toBe(2);
  });

  it("rejects an external grant with an empty resourceIds scope", async () => {
    const fx = fixture();
    fx.seedExternalGrant();
    fx.db
      .prepare("UPDATE core_grants SET resource_scope_json = ? WHERE id = ?")
      .run(JSON.stringify({ resourceIds: [] }), fx.grantId);
    await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
      AutomationGrantRequiredError,
    );
    expect(fx.grantCount()).toBe(2);
  });

  it("rejects an external grant from another policy version", async () => {
    const fx = fixture();
    fx.seedExternalGrant();
    const now = new Date().toISOString();
    fx.db
      .prepare(
        `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
         VALUES ('policy:other', 'other', 1, '{}', 0, ?)`,
      )
      .run(now);
    fx.db
      .prepare("UPDATE core_grants SET policy_version_id = 'policy:other' WHERE id = ?")
      .run(fx.grantId);
    await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
      AutomationGrantRequiredError,
    );
  });

  it("rejects an external grant for a different automation profile", async () => {
    const fx = fixture();
    fx.seedExternalGrant();
    const now = new Date().toISOString();
    const otherProfileId = "automation-profile:other";
    fx.db
      .prepare(
        `INSERT INTO core_subjects (kind, subject_id, display_name, created_at, updated_at)
         VALUES ('agent_profile', ?, 'Other', ?, ?)`,
      )
      .run(otherProfileId, now, now);
    fx.db
      .prepare("UPDATE core_grants SET subject_id = ? WHERE id = ?")
      .run(otherProfileId, fx.grantId);
    await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
      AutomationGrantRequiredError,
    );
  });

  it("rejects an external grant for a different subject kind", async () => {
    const fx = fixture();
    fx.seedExternalGrant();
    const now = new Date().toISOString();
    const profileId = `automation-profile:${fx.automation.id}`;
    fx.db
      .prepare(
        `INSERT INTO core_subjects (kind, subject_id, display_name, created_at, updated_at)
         VALUES ('human', ?, 'Local user', ?, ?)`,
      )
      .run(profileId, now, now);
    fx.db
      .prepare("UPDATE core_grants SET subject_kind = 'human' WHERE id = ?")
      .run(fx.grantId);
    await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
      AutomationGrantRequiredError,
    );
  });

  it("rejects an external grant for a different action", async () => {
    const fx = fixture();
    fx.seedExternalGrant();
    fx.db
      .prepare("UPDATE core_grants SET action = 'workflow.replay' WHERE id = ?")
      .run(fx.grantId);
    await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
      AutomationGrantRequiredError,
    );
  });

  it("rejects an expired external grant", async () => {
    const fx = fixture();
    fx.seedExternalGrant();
    fx.db
      .prepare("UPDATE core_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(fx.grantId);
    await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
      AutomationGrantRequiredError,
    );
  });

  it("binds the automation profile to a real model instead of forge-default", async () => {
    const fx = fixture({ model: "deepseek-v4-flash" });
    fx.seedExternalGrant();
    const prepared = await fx.governance.prepare(fx.automation, fx.definition);
    expect(prepared.policyContext.governance).toMatchObject({
      profileId: `automation-profile:${fx.automation.id}`,
    });
    const version = fx.profiles.getLatestVersion(
      `automation-profile:${fx.automation.id}`,
    );
    expect(version?.snapshot.modelPolicy.model).toBe("deepseek-v4-flash");
  });

});

function fixture(input: { model?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-auto-gov-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const store = new AutomationStore(forgeStore.db);
  const automation = store.create({
    name: "Daily note",
    cwd: root,
    trigger: { type: "manual" },
    prompt: "Write a note",
    enabled: true,
    ...(input.model ? { model: input.model } : {}),
  });
  const profiles = new AgentProfileStore(forgeStore.db);
  const governance = new AutomationGovernanceService(
    forgeStore.db,
    profiles,
    new BudgetLedgerService(forgeStore.db),
    new WorkspaceGroupService(forgeStore.db),
    new ValidationService(forgeStore.db, createProductionValidatorRegistry()),
  );
  const definition: DurableWorkflowDefinition = {
    id: `automation:${automation.id}`,
    version: 1,
    inputSchema: {},
    steps: [
      {
        id: "agent",
        kind: "forge.agent",
        dependsOn: [],
        input: { cwd: root, message: "Write a note" },
      },
    ],
    triggers: [{ kind: "manual" }],
    concurrency: { maxRuns: 1 },
  };
  return {
    governance,
    profiles,
    db: forgeStore.db,
    automation,
    definition,
    grantId: `grant:automation:${automation.id}`,
    seedExternalGrant: (workspaceId?: string) => {
      governance.ensureLocalPolicy();
      return seedAutomationGrant(
        forgeStore.db,
        automation.id,
        `automation-profile:${automation.id}`,
        LOCAL_DEFAULT_POLICY_ID,
        workspaceId ??
          `automation-workspace:${createHash("sha256")
            .update(automation.cwd)
            .digest("hex")
            .slice(0, 16)}`,
      );
    },
    activePolicyId: () =>
      (
        forgeStore.db
          .prepare(
            `SELECT id FROM core_policy_versions WHERE is_active = 1 LIMIT 1`,
          )
          .get() as { id: string } | undefined
      )?.id,
    grantCount: () =>
      (
        forgeStore.db
          .prepare("SELECT COUNT(*) AS count FROM core_grants")
          .get() as { count: number }
      ).count,
  };
}
