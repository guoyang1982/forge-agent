import type { SubjectRef } from "@forge/protocol";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type PolicyDecision =
  | { outcome: "allow"; policyVersionId: string; reason: string; inputHash: string }
  | { outcome: "deny"; policyVersionId: string; reason: string; inputHash: string }
  | {
      outcome: "require_approval";
      policyVersionId: string;
      reason: string;
      approvalClass: string;
      inputHash: string;
    };

export interface ResourceRef {
  kind: string;
  id: string;
}

export interface ResourceScope {
  resourceKind?: string;
  resourceIds?: string[];
  pathPrefixes?: string[];
  minRisk?: RiskLevel;
}

export interface AuthorizationInput {
  subject: SubjectRef;
  action: string;
  resource: ResourceRef;
  scope: Record<string, string>;
  risk: RiskLevel;
  context: Record<string, unknown>;
}

export interface PolicyGrant {
  id: string;
  subjectKind: string;
  subjectId: string;
  policyVersionId: string;
  action: string;
  resourceKind: string;
  resourceScope: ResourceScope;
  effect: "allow" | "deny" | "require_approval";
  approvalClass?: string;
  expiresAt?: string;
}

export interface PolicyEngineOptions {
  policyVersionId: string;
  grants: PolicyGrant[];
}

export interface PolicyRule {
  action: string;
  resourceKind: string;
  resourceIds?: string[];
  minRisk?: RiskLevel;
  effect: "allow" | "deny" | "require_approval";
  approvalClass?: string;
}

export interface PolicyVersionRules {
  rules?: PolicyRule[];
}

const RISK_RANK: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function riskMeetsMinimum(risk: RiskLevel, minimum?: RiskLevel): boolean {
  if (!minimum) {
    return true;
  }
  return RISK_RANK[risk] >= RISK_RANK[minimum];
}

export { RISK_RANK };
