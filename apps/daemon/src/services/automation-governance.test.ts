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

  it("records a grant when the human confirms a manual run", async () => {
    const fx = fixture();
    const prepared = await fx.governance.prepare(fx.automation, fx.definition, {
      userGranted: true,
    });
    expect(prepared.budgetAccountId).toContain("automation-budget:");
    expect(fx.grantCount()).toBe(1);
    expect(
      fx.profiles.getLatestVersion(`automation-profile:${fx.automation.id}`)
        ?.snapshot.modelPolicy.model,
    ).not.toBe("forge-default");
  });

  it("binds the automation profile to a real model instead of forge-default", async () => {
    const fx = fixture({ model: "deepseek-v4-flash" });
    const prepared = await fx.governance.prepare(fx.automation, fx.definition, {
      userGranted: true,
    });
    expect(prepared.policyContext.governance).toMatchObject({
      profileId: `automation-profile:${fx.automation.id}`,
    });
    const version = fx.profiles.getLatestVersion(
      `automation-profile:${fx.automation.id}`,
    );
    expect(version?.snapshot.modelPolicy.model).toBe("deepseek-v4-flash");
  });

  it("still requires an external grant for unattended scheduled runs", async () => {
    const fx = fixture();
    await expect(fx.governance.prepare(fx.automation, fx.definition)).rejects.toThrow(
      AutomationGrantRequiredError,
    );
    expect(fx.activePolicyId()).toBe(LOCAL_DEFAULT_POLICY_ID);
    expect(fx.grantCount()).toBe(0);
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
    automation,
    definition,
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
