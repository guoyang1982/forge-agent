import { createHash } from "node:crypto";
import type { Database } from "@forge/store";
import type {
  AuthorizationInput,
  PolicyDecision,
  PolicyEngineOptions,
  PolicyGrant,
  PolicyRule,
  PolicyVersionRules,
  ResourceScope,
  RiskLevel,
} from "./types.js";
import { riskMeetsMinimum } from "./types.js";

export class PolicyEngine {
  private readonly policyVersionId: string;
  private readonly grants: PolicyGrant[];
  private readonly rules: PolicyRule[];

  constructor(options: PolicyEngineOptions & { rules?: PolicyRule[] }) {
    this.policyVersionId = options.policyVersionId;
    this.grants = options.grants;
    this.rules = options.rules ?? [];
  }

  static fromDatabase(db: Database): PolicyEngine {
    const version = db
      .prepare(
        `SELECT id, rules_json
         FROM core_policy_versions
         WHERE is_active = 1
         ORDER BY version DESC
         LIMIT 1`,
      )
      .get() as { id: string; rules_json: string } | undefined;

    if (!version) {
      return new PolicyEngine({ policyVersionId: "policy:none", grants: [] });
    }

    const parsed = JSON.parse(version.rules_json) as PolicyVersionRules;
    const grantRows = db
      .prepare(
        `SELECT id, subject_kind, subject_id, policy_version_id, action, resource_kind,
                resource_scope_json, effect, approval_class, expires_at
         FROM core_grants
         WHERE policy_version_id = ?`,
      )
      .all(version.id) as Array<{
      id: string;
      subject_kind: string;
      subject_id: string;
      policy_version_id: string;
      action: string;
      resource_kind: string;
      resource_scope_json: string;
      effect: "allow" | "deny" | "require_approval";
      approval_class: string | null;
      expires_at: string | null;
    }>;

    return new PolicyEngine({
      policyVersionId: version.id,
      rules: parsed.rules ?? [],
      grants: grantRows.map((row) => ({
        id: row.id,
        subjectKind: row.subject_kind,
        subjectId: row.subject_id,
        policyVersionId: row.policy_version_id,
        action: row.action,
        resourceKind: row.resource_kind,
        resourceScope: JSON.parse(row.resource_scope_json) as ResourceScope,
        effect: row.effect,
        approvalClass: row.approval_class ?? undefined,
        expiresAt: row.expires_at ?? undefined,
      })),
    });
  }

  authorize(input: AuthorizationInput): PolicyDecision {
    const inputHash = hashAuthorizationInput(input);
    const matching = this.matchingGrants(input);

    const deny = matching.find((grant) => grant.effect === "deny");
    if (deny) {
      return {
        outcome: "deny",
        policyVersionId: this.policyVersionId,
        reason: `denied by grant ${deny.id}`,
        inputHash,
      };
    }

    const approval = matching.find((grant) => grant.effect === "require_approval");
    if (approval) {
      return {
        outcome: "require_approval",
        policyVersionId: this.policyVersionId,
        reason: `approval required by grant ${approval.id}`,
        approvalClass: approval.approvalClass ?? "default",
        inputHash,
      };
    }

    const allow = matching.find((grant) => grant.effect === "allow");
    if (allow) {
      return {
        outcome: "allow",
        policyVersionId: this.policyVersionId,
        reason: `allowed by grant ${allow.id}`,
        inputHash,
      };
    }

    return {
      outcome: "deny",
      policyVersionId: this.policyVersionId,
      reason: "no matching grant",
      inputHash,
    };
  }

  private matchingGrants(input: AuthorizationInput): PolicyGrant[] {
    const now = new Date().toISOString();
    const candidates = [
      ...this.grants,
      ...this.rules.map((rule) => ruleToGrant(rule, this.policyVersionId)),
    ];

    return candidates.filter(
      (grant) =>
        matchesSubject(grant, input.subject) &&
        grant.action === input.action &&
        grant.resourceKind === input.resource.kind &&
        matchesResourceScope(input.resource.id, grant.resourceScope) &&
        riskMeetsMinimum(input.risk, grant.resourceScope.minRisk) &&
        (!grant.expiresAt || grant.expiresAt > now),
    );
  }
}

function matchesSubject(
  grant: PolicyGrant,
  subject: AuthorizationInput["subject"],
): boolean {
  if (grant.subjectKind === "*" && grant.subjectId === "*") {
    return true;
  }
  return grant.subjectKind === subject.kind && grant.subjectId === subject.id;
}

function ruleToGrant(rule: PolicyRule, policyVersionId: string): PolicyGrant {
  return {
    id: `rule:${rule.action}:${rule.resourceKind}:${rule.effect}`,
    subjectKind: "*",
    subjectId: "*",
    policyVersionId,
    action: rule.action,
    resourceKind: rule.resourceKind,
    resourceScope: {
      resourceIds: rule.resourceIds,
      minRisk: rule.minRisk,
    },
    effect: rule.effect,
    approvalClass: rule.approvalClass,
  };
}

function matchesResourceScope(
  resourceId: string,
  scope: Pick<ResourceScope, "resourceIds">,
): boolean {
  if (!scope.resourceIds || scope.resourceIds.length === 0) {
    return true;
  }
  return scope.resourceIds.includes(resourceId);
}

export function hashAuthorizationInput(input: AuthorizationInput): string {
  const redacted = {
    subject: input.subject,
    action: input.action,
    resource: input.resource,
    scope: input.scope,
    risk: input.risk,
    contextKeys: Object.keys(input.context).sort(),
  };
  return createHash("sha256").update(JSON.stringify(redacted)).digest("hex");
}

export { matchesResourceScope, ruleToGrant };
