import { assetVersionResourceId } from "@forge/asset-registry";
import {
  OrganizationService,
  RESEARCH_STEP_SEAT_TITLES,
  ensureCompanyBudgetAccount,
} from "@forge/company-domain";
import type { ValidationService } from "@forge/evidence";
import type { ExecutionStore, RunSpec } from "@forge/execution";
import {
  COMPANY_RESEARCH_WORKFLOW_ID,
  type CompanyWorkflowStartRequest,
  type CompanyWorkflowStartResult,
} from "@forge/protocol";
import type { Database } from "@forge/store";
import {
  WorkflowStore,
  compileWorkflowRun,
  createRequirementResearchWorkflow,
  hashWorkflowDefinition,
  type DurableWorkflowDefinition,
  type WorkflowQualityGateInput,
} from "@forge/workflows";
import { LOCAL_DEFAULT_POLICY_ID } from "./automation-governance.js";
import { buildCompanyResearchStepGovernance } from "./company-workflow-governance.js";

export type CompanyWorkflowStartErrorCode =
  | "WORKFLOW_NOT_RUNNABLE"
  | "INVALID_REQUEST"
  | "POLICY_DENIED"
  | "VALIDATION_FAILED";

export class CompanyWorkflowStartError extends Error {
  constructor(
    readonly code: CompanyWorkflowStartErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CompanyWorkflowStartError";
  }
}

export interface CompanyWorkflowDispatchDeps {
  db: Database;
  executionStore: Pick<ExecutionStore, "createRun" | "getRun">;
  validations: Pick<ValidationService, "validateDelivery">;
  clock: { now(): string };
  wakeExecutor?: () => void;
  /** When present, missing company budget bindings are created before governance. */
  budgetLedger?: {
    createAccount(input: {
      id: string;
      name: string;
      currency: string;
      hardLimitMinor: bigint;
    }): void;
  };
  companyName?: string;
}

export const COMPANY_WORKFLOW_PUBLISH_ACTION = "company.workflow.publish";
const PUBLISHER = { kind: "human", id: "local-user" } as const;

let startQueue: Promise<unknown> = Promise.resolve();

/**
 * Start (or idempotently re-attach to) a governed requirement-research run.
 * Starts are serialised in-process because publishing awaits validation
 * between choosing the next asset version and publishing it.
 */
export function startCompanyResearchWorkflow(
  deps: CompanyWorkflowDispatchDeps,
  request: CompanyWorkflowStartRequest,
): Promise<CompanyWorkflowStartResult> {
  const result = startQueue.then(() => startUnlocked(deps, request));
  startQueue = result.catch(() => undefined);
  return result;
}

async function startUnlocked(
  deps: CompanyWorkflowDispatchDeps,
  request: CompanyWorkflowStartRequest,
): Promise<CompanyWorkflowStartResult> {
  if ((request.workflowId as string) !== COMPANY_RESEARCH_WORKFLOW_ID) {
    throw new CompanyWorkflowStartError(
      "WORKFLOW_NOT_RUNNABLE",
      `only ${COMPANY_RESEARCH_WORKFLOW_ID} (requirement-research) can be started in this milestone`,
    );
  }
  const companyId = requireText(request.companyId, "companyId");
  const projectId = requireText(request.projectId, "projectId");
  const briefId = requireText(request.briefId, "briefId");
  const idempotencyKey = requireText(request.idempotencyKey, "idempotencyKey");
  if (idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey)) {
    throw new CompanyWorkflowStartError("INVALID_REQUEST", "idempotencyKey is invalid");
  }

  const workflows = WorkflowStore.forDatabase(deps.db);
  const triggerRef =
    `company-workflow:requirement-research:${companyId}:${projectId}:${idempotencyKey}`;
  const existing = workflows.findInstanceByTriggerRef(COMPANY_RESEARCH_WORKFLOW_ID, triggerRef);
  if (existing && existing.concurrencyKey !== briefId) {
    throw new CompanyWorkflowStartError(
      "INVALID_REQUEST",
      "idempotencyKey was already used with a different research brief",
    );
  }
  if (existing?.runId) {
    return result(existing.id, existing.runId, true);
  }

  const brief = loadReadyBrief(deps.db, companyId, projectId, briefId);
  if (deps.budgetLedger) {
    ensureCompanyBudgetAccount(deps.db, {
      companyId,
      companyName: deps.companyName,
      createdAt: deps.clock.now(),
      createAccount: (account) => deps.budgetLedger!.createAccount(account),
    });
  }
  const definition = createRequirementResearchWorkflow({
    briefId,
    brief: {
      id: brief.id,
      version: brief.version,
      normalizedProblem: brief.normalizedProblem,
      targetUser: brief.targetUser,
      expectedOutcome: brief.expectedOutcome,
      constraints: brief.constraints,
      researchQuestions: brief.researchQuestions,
      stopConditions: brief.stopConditions,
    },
  });

  // Governance first: fail closed before publishing anything.
  const assignments = resolveAssignments(deps.db, companyId, definition, request.assignments);
  let stepGovernance: ReturnType<typeof buildCompanyResearchStepGovernance>;
  try {
    stepGovernance = buildCompanyResearchStepGovernance({
      db: deps.db,
      companyId,
      projectId,
      definition,
      assignments,
    });
  } catch (error) {
    throw new CompanyWorkflowStartError(
      "POLICY_DENIED",
      error instanceof Error ? error.message : String(error),
    );
  }
  // CEO start authorizes the assigned profiles to run read-only in the granted workspaces.
  ensureResearchRuntimeGrants(deps.db, stepGovernance, deps.clock.now());
  const firstStepId = definition.steps[0]!.id;
  const first = stepGovernance[firstStepId]!;

  const published = await publishDefinition(deps, workflows, definition);
  const instance = existing ?? workflows.createInstance({
    workflowId: COMPANY_RESEARCH_WORKFLOW_ID,
    workflowVersionId: published.workflowVersionId,
    triggerKind: "manual",
    triggerRef,
    concurrencyKey: briefId,
    runInput: { briefId },
  });

  let spec: RunSpec;
  if (deps.executionStore.getRun(instance.id)) {
    spec = deps.executionStore.getRun(instance.id)!.spec;
  } else {
    const compiled = compileWorkflowRun(
      published.definition,
      { briefId },
      {
        workflowId: COMPANY_RESEARCH_WORKFLOW_ID,
        instanceId: instance.id,
        instanceNumber: workflows.countInstances(COMPANY_RESEARCH_WORKFLOW_ID),
        requestedBy: { ...PUBLISHER },
        actingSubject: { kind: "agent_profile", id: first.profileId },
        objective: `requirement-research:${brief.normalizedProblem}`.slice(0, 500),
        budgetAccountId: first.budget.accountId,
        // Deliberately no companyWorkItemId: that would bypass requireGovernance.
        policyContext: { stepGovernance, companyId, projectId, briefId },
      },
    );
    spec = compiled;
    deps.executionStore.createRun(spec, deps.clock.now());
  }
  workflows.linkRun(instance.id, spec.id);
  deps.wakeExecutor?.();
  return result(instance.id, spec.id, false);
}

function result(instanceId: string, runId: string, reused: boolean): CompanyWorkflowStartResult {
  return { workflowId: COMPANY_RESEARCH_WORKFLOW_ID, instanceId, runId, reused };
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CompanyWorkflowStartError("INVALID_REQUEST", `${name} is required`);
  }
  return value.trim();
}

interface BriefRow {
  id: string;
  version: number;
  normalizedProblem: string;
  targetUser: string;
  expectedOutcome: string;
  constraints: string[];
  researchQuestions: string[];
  stopConditions: string[];
}

function loadReadyBrief(
  db: Database,
  companyId: string,
  projectId: string,
  briefId: string,
): BriefRow {
  const row = db
    .prepare(
      `SELECT b.id, b.version, b.normalized_problem AS normalizedProblem,
              b.target_user AS targetUser, b.expected_outcome AS expectedOutcome,
              b.constraints_json AS constraints, b.research_questions_json AS researchQuestions,
              b.stop_conditions_json AS stopConditions, b.ready, w.project_id AS projectId
       FROM company_research_briefs b
       JOIN company_work_items w ON w.company_id = b.company_id AND w.id = b.work_item_id
       WHERE b.company_id = ? AND b.id = ?`,
    )
    .get(companyId, briefId) as
    | (Omit<BriefRow, "constraints" | "researchQuestions" | "stopConditions"> & {
        constraints: string;
        researchQuestions: string;
        stopConditions: string;
        ready: number;
        projectId: string | null;
      })
    | undefined;
  if (!row) throw new CompanyWorkflowStartError("INVALID_REQUEST", "research brief not found");
  if (row.projectId !== projectId) {
    throw new CompanyWorkflowStartError("INVALID_REQUEST", "research brief does not belong to project");
  }
  if (!row.ready) {
    throw new CompanyWorkflowStartError("POLICY_DENIED", "research brief is not ready");
  }
  return {
    id: row.id,
    version: row.version,
    normalizedProblem: row.normalizedProblem,
    targetUser: row.targetUser,
    expectedOutcome: row.expectedOutcome,
    constraints: parseStrings(row.constraints),
    researchQuestions: parseStrings(row.researchQuestions),
    stopConditions: parseStrings(row.stopConditions),
  };
}

function parseStrings(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Role matchers so each research branch uses a specialist (and that employee's skills). */
const RESEARCH_STEP_ROLE_PATTERNS: Record<string, RegExp> = {
  "user-research": /research|研究员|调研|调查|用户研究|user[\s_-]?research/i,
  "market-research": /market|市场|营销|增长|商业/i,
  "code-data-research": /开发|架构|工程|研发|engineer|architect|code|数据/i,
  "risk-research": /风险|合规|法律|风控|risk|legal|compliance/i,
};

/** Fallback when a branch has no specialist: prefer researchers, then product generalists. */
const RESEARCH_DEFAULT_ROLE_PATTERNS: RegExp[] = [
  /research|研究员|调研|调查/i,
  /产品|product|经理|owner/i,
];

/**
 * Explicit assignments win. Otherwise each step picks the best matching active
 * employee (profile + workspace):
 *   1) operating seat by position title (岗位 → 人)
 *   2) branch specialist via talentRole
 *   3) specialist via role haystack (name/title)
 *   4) default researcher / product generalist
 *   5) first eligible employee
 * Governance validates the final choice.
 */
function resolveAssignments(
  db: Database,
  companyId: string,
  definition: DurableWorkflowDefinition,
  explicit: Record<string, string> | undefined,
): Record<string, string> {
  if (explicit && typeof explicit === "object") {
    return Object.fromEntries(
      definition.steps.map((step) => [step.id, String(explicit[step.id] ?? "").trim()]),
    );
  }
  const tree = new OrganizationService(db, { now: () => new Date().toISOString() }).tree(companyId);
  const positionsById = new Map(tree.positions.map((position) => [position.id, position.title]));
  const eligible = tree.employees.filter(
    (employee) =>
      employee.status === "active" &&
      employee.profile?.agentProfileId &&
      employee.profile.agentProfileVersionId &&
      employee.workspaces.length > 0,
  );
  if (!eligible[0]) {
    throw new CompanyWorkflowStartError(
      "POLICY_DENIED",
      "no active employee with a published agent profile and workspace grant is available for research",
    );
  }
  return Object.fromEntries(
    definition.steps.map((step) => [
      step.id,
      pickResearchAssignee(step.id, eligible, positionsById).id,
    ]),
  );
}

function pickResearchAssignee<T extends {
  id: string;
  displayName?: string | null;
  positionId?: string | null;
  profile?: { talentRole?: string | null } | null;
}>(
  stepId: string,
  eligible: readonly T[],
  positionsById: ReadonlyMap<string, string> = new Map(),
): T {
  const matchSeat = (titles: readonly string[]) => {
    for (const title of titles) {
      const hit = eligible.find(
        (employee) =>
          employee.positionId && positionsById.get(employee.positionId) === title,
      );
      if (hit) return hit;
    }
    return undefined;
  };
  /** Prefer talentRole so a misleading title cannot steal a branch after seat match. */
  const matchRole = (pattern: RegExp) =>
    eligible.find((employee) => pattern.test(String(employee.profile?.talentRole || "").trim()));
  const matchHaystack = (pattern: RegExp) =>
    eligible.find((employee) => pattern.test(roleHaystack(employee, positionsById)));

  const seatTitles = RESEARCH_STEP_SEAT_TITLES[stepId];
  if (seatTitles?.length) {
    const bySeat = matchSeat(seatTitles);
    if (bySeat) return bySeat;
  }

  const specific = RESEARCH_STEP_ROLE_PATTERNS[stepId];
  if (specific) {
    const byRole = matchRole(specific);
    if (byRole) return byRole;
    const byHaystack = matchHaystack(specific);
    if (byHaystack) return byHaystack;
  }
  for (const pattern of RESEARCH_DEFAULT_ROLE_PATTERNS) {
    const byRole = matchRole(pattern);
    if (byRole) return byRole;
    const byHaystack = matchHaystack(pattern);
    if (byHaystack) return byHaystack;
  }
  return eligible[0]!;
}

function roleHaystack<T extends {
  displayName?: string | null;
  positionId?: string | null;
  profile?: { talentRole?: string | null } | null;
}>(employee: T, positionsById: ReadonlyMap<string, string>): string {
  const title = employee.positionId ? positionsById.get(employee.positionId) ?? "" : "";
  return [employee.profile?.talentRole, employee.displayName, title]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Materialize agent.run grants for every profile/workspace pair in step governance.
 * Company research has no separate grant UI yet; the CEO start click is the authorization,
 * matching the publish path's local-user grant pattern.
 */
export function ensureResearchRuntimeGrants(
  db: Database,
  stepGovernance: Record<string, {
    profileId: string;
    workspace: { id: string };
  }>,
  now: string,
): void {
  const policyVersionId = ensureLocalPolicy(db);
  const seen = new Set<string>();
  for (const step of Object.values(stepGovernance)) {
    const profileId = step.profileId?.trim();
    const workspaceId = step.workspace?.id?.trim();
    if (!profileId || !workspaceId) continue;
    const key = `${profileId}\0${workspaceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    db.prepare(
      `INSERT OR IGNORE INTO core_subjects (
        kind, subject_id, display_name, created_at, updated_at
      ) VALUES ('agent_profile', ?, ?, ?, ?)`,
    ).run(profileId, profileId, now, now);
    const grantId = `grant:company-research:${profileId}:${workspaceId}`.slice(0, 200);
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
  }
}

async function publishDefinition(
  deps: CompanyWorkflowDispatchDeps,
  workflows: WorkflowStore,
  definition: DurableWorkflowDefinition,
) {
  const existing = workflows.getLatestPublishedVersion(definition.id);
  if (
    existing &&
    hashWorkflowDefinition({ ...existing.definition, version: 1 }) ===
      hashWorkflowDefinition({ ...definition, version: 1 })
  ) {
    return existing;
  }
  const qualityGate = await validateCompanyWorkflowPublish(deps, definition);
  return workflows.publish(
    {
      id: definition.id,
      name: "Requirement research",
      ownerSubject: { ...PUBLISHER },
      definition,
      description: "Governed requirement research workflow",
    },
    qualityGate,
  );
}

/**
 * Minimal fail-closed publish gate for company workflows. The daemon records
 * a narrowly scoped `asset.publish` grant for this exact asset version (the
 * user's start action is the authorization) and requires the
 * company-workflow-definition validator to pass. No Automation grants are used.
 */
async function validateCompanyWorkflowPublish(
  deps: CompanyWorkflowDispatchDeps,
  definition: DurableWorkflowDefinition,
): Promise<WorkflowQualityGateInput> {
  const policyVersionId = ensureLocalPolicy(deps.db);
  const now = deps.clock.now();
  deps.db
    .prepare(
      `INSERT OR IGNORE INTO core_subjects (
        kind, subject_id, display_name, created_at, updated_at
      ) VALUES (?, ?, 'Local User', ?, ?)`,
    )
    .run(PUBLISHER.kind, PUBLISHER.id, now, now);
  const nextVersion =
    (
      deps.db
        .prepare("SELECT COALESCE(MAX(version), 0) AS maxVersion FROM core_asset_versions WHERE asset_id = ?")
        .get(definition.id) as { maxVersion: number }
    ).maxVersion + 1;
  const assetVersionId = assetVersionResourceId(definition.id, nextVersion);
  const grantId = `grant:company-workflow:${definition.id}:${nextVersion}`;
  deps.db
    .prepare(
      `INSERT OR REPLACE INTO core_grants (
        id, subject_kind, subject_id, policy_version_id, action, resource_kind,
        resource_scope_json, effect, approval_class, expires_at, created_at
      ) VALUES (?, ?, ?, ?, 'asset.publish', 'asset', ?, 'allow', NULL, NULL, ?)`,
    )
    .run(
      grantId,
      PUBLISHER.kind,
      PUBLISHER.id,
      policyVersionId,
      JSON.stringify({ resourceIds: [definition.id, assetVersionId], minRisk: "low" }),
      now,
    );
  const validation = await deps.validations.validateDelivery({
    runId: `company-workflow-definition:${definition.id}:${nextVersion}`,
    deliveryId: definition.id,
    artifactIds: [],
    evidenceIds: [grantId],
    context: {
      validationTarget: "company.workflow.definition",
      definition,
      assetId: definition.id,
      assetVersionId,
      subjectKind: PUBLISHER.kind,
      subjectId: PUBLISHER.id,
      action: "asset.publish",
      requestedAction: COMPANY_WORKFLOW_PUBLISH_ACTION,
      policyVersionId,
    },
  });
  if (!validation.accepted || validation.validationIds.length === 0) {
    throw new CompanyWorkflowStartError(
      "VALIDATION_FAILED",
      "company workflow definition validation failed",
    );
  }
  return {
    validationIds: validation.validationIds,
    permissionReviewId: grantId,
    securityValidationId: validation.validationIds[0]!,
  };
}

function ensureLocalPolicy(db: Database): string {
  const active = db
    .prepare(
      `SELECT id FROM core_policy_versions WHERE is_active = 1
       ORDER BY version DESC, created_at DESC LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (active) return active.id;
  db.prepare(
    `INSERT OR IGNORE INTO core_policy_versions (
      id, name, version, rules_json, is_active, created_at
    ) VALUES (?, 'local-default', 1, '{}', 1, ?)`,
  ).run(LOCAL_DEFAULT_POLICY_ID, new Date().toISOString());
  return LOCAL_DEFAULT_POLICY_ID;
}
