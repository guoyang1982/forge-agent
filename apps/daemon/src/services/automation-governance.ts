import { createHash } from "node:crypto";
import type { AgentProfileStore } from "@forge/agent-profile";
import { loadConfig } from "@forge/config";
import type { ValidationService } from "@forge/evidence";
import type { AutomationRecord } from "@forge/protocol";
import type { Database } from "@forge/store";
import type { BudgetLedgerService } from "@forge/usage-ledger";
import type { WorkspaceGroupService } from "@forge/workspace";
import type {
  DurableWorkflowDefinition,
  WorkflowQualityGateInput,
} from "@forge/workflows";

export class AutomationGrantRequiredError extends Error {
  constructor(message = "automation requires an external grant") {
    super(message);
    this.name = "AutomationGrantRequiredError";
  }
}

export interface PreparedAutomationGovernance {
  profileId: string;
  profileVersionId: string;
  policyContext: Record<string, unknown>;
  budgetAccountId: string;
  qualityGate: WorkflowQualityGateInput;
}

export const LOCAL_DEFAULT_POLICY_ID = "policy:local-default";

export interface PrepareAutomationGovernanceOptions {
  /** Desktop「立即运行」等人类确认。记为外部授权，不是自动化自授权。 */
  userGranted?: boolean;
}

export class AutomationGovernanceService {
  constructor(
    private readonly db: Database,
    private readonly profiles: AgentProfileStore,
    private readonly budgets: BudgetLedgerService,
    private readonly workspaces: WorkspaceGroupService,
    private readonly validations: ValidationService,
  ) {}

  /** Local-first daemon: create an active policy if the DB was never bootstrapped. */
  ensureLocalPolicy(): string {
    return this.ensurePolicyVersion();
  }

  async prepare(
    automation: AutomationRecord,
    definition: DurableWorkflowDefinition,
    options: PrepareAutomationGovernanceOptions = {},
  ): Promise<PreparedAutomationGovernance> {
    const policyVersionId = this.ensurePolicyVersion();
    const profile = this.ensureProfile(automation, policyVersionId);
    this.ensureSubject(profile.profileId, automation.name);
    const workspaceId = this.ensureWorkspace(automation);
    const budgetAccountId = this.ensureBudget(automation);
    const permissionReviewId = this.requireGrant(
      automation,
      profile.profileId,
      policyVersionId,
      workspaceId,
      options.userGranted === true,
    );
    const definitionValidation = await this.validations.validateDelivery({
      runId: `automation-definition:${automation.id}:${automation.updatedAt}`,
      deliveryId: definition.id,
      artifactIds: [],
      evidenceIds: [permissionReviewId],
      context: {
        validationTarget: "automation.workflow.definition",
        definition,
      },
    });
    if (!definitionValidation.accepted || definitionValidation.validationIds.length === 0) {
      throw new Error("automation workflow definition validation failed");
    }
    const securityValidationId = definitionValidation.validationIds[0]!;
    return {
      profileId: profile.profileId,
      profileVersionId: profile.id,
      budgetAccountId,
      policyContext: {
        governance: {
          profileId: profile.profileId,
          profileVersionId: profile.id,
          action: "agent.run",
          resource: { kind: "workspace", id: workspaceId },
          risk: "low",
          workspace: {
            id: workspaceId,
            rootPath: automation.cwd,
            mode: "write",
          },
          budget: { accountId: budgetAccountId, amountMinor: 1 },
          delivery: { id: "agent" },
        },
        automationId: automation.id,
      },
      qualityGate: {
        validationIds: definitionValidation.validationIds,
        permissionReviewId,
        securityValidationId,
      },
    };
  }

  private ensurePolicyVersion(): string {
    const active = this.db
      .prepare(
        `SELECT id FROM core_policy_versions
         WHERE is_active = 1
         ORDER BY version DESC, created_at DESC
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (active) return active.id;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO core_policy_versions (
          id, name, version, rules_json, is_active, created_at
        ) VALUES (?, 'local-default', 1, '{}', 1, ?)`,
      )
      .run(LOCAL_DEFAULT_POLICY_ID, now);
    return LOCAL_DEFAULT_POLICY_ID;
  }

  private ensureProfile(automation: AutomationRecord, policyVersionId: string) {
    const profileId = `automation-profile:${automation.id}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO core_agent_profiles (
          id, name, source_kind, source_ref, created_at, updated_at
        ) VALUES (?, ?, 'automation', ?, ?, ?)`,
      )
      .run(profileId, automation.name, automation.id, now, now);
    const latest = this.profiles.getLatestVersion(profileId);
    const requestedModel = resolveAutomationModel(automation);
    if (latest?.snapshot.modelPolicy.model === requestedModel) return latest;
    return this.profiles.publishVersion({
      profileId,
      name: automation.name,
      sourceKind: "automation",
      sourceRef: automation.id,
      model: requestedModel,
      policyVersionId,
    });
  }

  private ensureSubject(profileId: string, displayName: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO core_subjects (
          kind, subject_id, display_name, created_at, updated_at
        ) VALUES ('agent_profile', ?, ?, ?, ?)`,
      )
      .run(profileId, displayName, now, now);
  }

  private ensureWorkspace(automation: AutomationRecord): string {
    const id = `automation-workspace:${digest(automation.cwd)}`;
    this.workspaces.registerWorkspace({
      id,
      rootPath: automation.cwd,
      label: `Automation ${automation.name}`,
    });
    return id;
  }

  private ensureBudget(automation: AutomationRecord): string {
    const id = `automation-budget:${automation.id}`;
    const existing = this.db
      .prepare("SELECT id FROM core_budget_accounts WHERE id = ?")
      .get(id);
    if (!existing) {
      this.budgets.createAccount({
        id,
        name: `Automation ${automation.name}`,
        currency: "USD",
        hardLimitMinor: 100_000n,
      });
    }
    return id;
  }

  private requireGrant(
    automation: AutomationRecord,
    profileId: string,
    policyVersionId: string,
    workspaceId: string,
    userGranted: boolean,
  ): string {
    const grantId = `grant:automation:${automation.id}`;
    const grant = this.db
      .prepare(
        `SELECT effect, expires_at FROM core_grants
         WHERE id = ? AND subject_kind = 'agent_profile' AND subject_id = ?
           AND action = 'agent.run' AND resource_kind = 'workspace'`,
      )
      .get(grantId, profileId) as { effect: string; expires_at: string | null } | undefined;
    if (grant?.effect === "allow") {
      if (grant.expires_at && grant.expires_at <= new Date().toISOString()) {
        throw new AutomationGrantRequiredError("automation grant expired");
      }
      return grantId;
    }
    if (userGranted || process.env.FORGE_AUTOMATION_AUTO_GRANT === "1") {
      return this.bootstrapGrant(grantId, profileId, policyVersionId, workspaceId);
    }
    throw new AutomationGrantRequiredError(
      "missing external grant for automation workspace access",
    );
  }

  private bootstrapGrant(
    grantId: string,
    profileId: string,
    policyVersionId: string,
    workspaceId: string,
  ): string {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO core_grants (
          id, subject_kind, subject_id, policy_version_id, action, resource_kind,
          resource_scope_json, effect, approval_class, expires_at, created_at
        ) VALUES (?, 'agent_profile', ?, ?, 'agent.run', 'workspace', ?, 'allow', NULL, NULL, ?)`,
      )
      .run(
        grantId,
        profileId,
        policyVersionId,
        JSON.stringify({ resourceIds: [workspaceId], minRisk: "low" }),
        new Date().toISOString(),
      );
    return grantId;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function resolveAutomationModel(automation: AutomationRecord): string {
  const candidates = [
    automation.model,
    loadConfig({ cwd: automation.cwd }).model.name,
    loadConfig().model.name,
  ];
  for (const raw of candidates) {
    const name = raw?.trim();
    if (name && name !== "forge-default") return name;
  }
  return "gpt-4o-mini";
}

/** Test and bootstrap helper for seeding an external automation grant. */
export function seedAutomationGrant(
  db: Database,
  automationId: string,
  profileId: string,
  policyVersionId: string,
  workspaceId: string,
): string {
  const grantId = `grant:automation:${automationId}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO core_subjects (
      kind, subject_id, display_name, created_at, updated_at
    ) VALUES ('agent_profile', ?, ?, ?, ?)`,
  ).run(profileId, profileId, now, now);
  db.prepare(
    `INSERT OR REPLACE INTO core_grants (
      id, subject_kind, subject_id, policy_version_id, action, resource_kind,
      resource_scope_json, effect, approval_class, expires_at, created_at
    ) VALUES (?, 'agent_profile', ?, ?, 'agent.run', 'workspace', ?, 'allow', NULL, NULL, ?)`,
  ).run(
    grantId,
    profileId,
    policyVersionId,
    JSON.stringify({ resourceIds: [workspaceId], minRisk: "low" }),
    now,
  );
  return grantId;
}
