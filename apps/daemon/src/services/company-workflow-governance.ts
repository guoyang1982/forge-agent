import {
  OrganizationService,
  getCompanyBudgetAccountId,
  getProjectWorkspaceGroupId,
} from "@forge/company-domain";
import type { Database } from "@forge/store";
import type { DurableWorkflowDefinition } from "@forge/workflows";

export interface CompanyStepGovernance {
  profileId: string;
  profileVersionId: string;
  action: "agent.run";
  resource: { kind: "workspace"; id: string };
  risk: "low" | "medium" | "high";
  workspace: { id: string; rootPath: string; mode: "read" | "write" };
  budget: { accountId: string; amountMinor: number };
}

const DEFAULT_RESEARCH_BUDGET_MINOR = 50_000;

/**
 * Read-only governance for every step of the requirement-research workflow.
 * Fails closed: no silent fallback to a default profile, workspace or budget.
 * Workspace grants are only used to pick the workspace; the resulting mode is
 * always "read" regardless of the granted mode.
 */
export function buildCompanyResearchStepGovernance(input: {
  db: Database;
  companyId: string;
  projectId: string;
  definition: DurableWorkflowDefinition;
  assignments: Record<string, string>;
  budgetAmountMinor?: number;
}): Record<string, CompanyStepGovernance> {
  const amountMinor = input.budgetAmountMinor ?? DEFAULT_RESEARCH_BUDGET_MINOR;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("research budget amount must be a positive integer");
  }
  const project = input.db
    .prepare(`SELECT 1 AS ok FROM company_projects WHERE company_id = ? AND id = ?`)
    .get(input.companyId, input.projectId);
  if (!project) throw new Error("project not found in company");

  const accountId = getCompanyBudgetAccountId(input.db, input.companyId);
  if (!accountId) throw new Error("company budget account is not configured");

  const tree = new OrganizationService(input.db, { now: () => new Date().toISOString() })
    .tree(input.companyId);
  const groupWorkspaceIds = projectGroupWorkspaceIds(input.db, input.projectId);
  const workspaceCache = new Map<string, CompanyStepGovernance["workspace"]>();
  const result: Record<string, CompanyStepGovernance> = {};

  for (const step of input.definition.steps) {
    const employeeId = input.assignments[step.id]?.trim();
    if (!employeeId) throw new Error(`step ${step.id} has no assigned employee`);
    const employee = tree.employees.find((entry) => entry.id === employeeId);
    if (!employee) throw new Error(`employee ${employeeId} not found for step ${step.id}`);
    if (employee.status !== "active") {
      throw new Error(`employee ${employeeId} does not have active employment`);
    }
    const profileId = employee.profile?.agentProfileId?.trim();
    const profileVersionId = employee.profile?.agentProfileVersionId?.trim();
    if (!profileId || !profileVersionId) {
      throw new Error(`employee ${employeeId} has no published agent profile for step ${step.id}`);
    }

    const grants = employee.workspaces;
    const scoped = groupWorkspaceIds
      ? grants.filter((grant) => groupWorkspaceIds.has(grant.workspaceId))
      : grants;
    const grant = scoped.find((entry) => entry.isDefault) ?? scoped[0];
    if (!grant) {
      throw new Error(
        `employee ${employeeId} has no workspace grant${groupWorkspaceIds ? " in the project group" : ""}`,
      );
    }
    let workspace = workspaceCache.get(grant.workspaceId);
    if (!workspace) {
      workspace = resolveReadWorkspace(input.db, grant.workspaceId);
      workspaceCache.set(grant.workspaceId, workspace);
    }

    result[step.id] = {
      profileId,
      profileVersionId,
      action: "agent.run",
      resource: { kind: "workspace", id: workspace.id },
      risk: "low",
      workspace: { ...workspace },
      budget: { accountId, amountMinor },
    };
  }
  return result;
}

function projectGroupWorkspaceIds(db: Database, projectId: string): Set<string> | undefined {
  const groupId = getProjectWorkspaceGroupId(db, projectId);
  if (!groupId) return undefined;
  const rows = db
    .prepare(`SELECT workspace_id AS workspaceId FROM core_workspace_bindings WHERE group_id = ?`)
    .all(groupId) as Array<{ workspaceId: string }>;
  return new Set(rows.map((row) => row.workspaceId));
}

function resolveReadWorkspace(db: Database, workspaceId: string): CompanyStepGovernance["workspace"] {
  const row = db
    .prepare(`SELECT id, root_path AS rootPath FROM core_workspaces WHERE id = ?`)
    .get(workspaceId) as { id: string; rootPath: string } | undefined;
  if (!row) throw new Error(`workspace ${workspaceId} not found`);
  return { id: row.id, rootPath: row.rootPath, mode: "read" };
}
