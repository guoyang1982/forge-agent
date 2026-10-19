export type WorkItemState =
  | "draft" | "ready" | "in_progress" | "waiting_input" | "waiting_approval"
  | "blocked" | "submitted" | "verifying" | "accepted" | "rejected"
  | "completed" | "cancelled";

export type WorkArtifactKind = "intent" | "spec" | "plan";
export type WorkArtifactStatus = "draft" | "accepted" | "superseded";

export interface WorkArtifact {
  id: string;
  companyId: string;
  workItemId: string;
  kind: WorkArtifactKind;
  version: number;
  status: WorkArtifactStatus;
  content: string;
  contentHash: string;
  workspacePath?: string;
  acceptedAt?: string;
  acceptedBy?: string;
}

export interface WorkItem {
  id: string;
  companyId: string;
  goalId?: string;
  projectId?: string;
  parentId?: string;
  type: "intent" | "implementation" | "fix" | "research";
  title: string;
  problem: string;
  expectedOutcome: string;
  ownerId: string;
  assigneeId?: string;
  state: WorkItemState;
  risk: "low" | "medium" | "high";
  autonomyLevel: 0 | 1 | 2 | 3 | 4;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface LinkedCompanyRun {
  runId: string;
  createdAt: string;
  state?: string;
  sessionId?: string;
  cwd?: string;
}

export interface LinkedCompanyValidation {
  id: string;
  runId: string;
  status: "passed" | "failed" | "inconclusive";
  summary: string;
  validatorId?: string;
  layer?: "result" | "process" | "answer";
}

export interface LinkedCompanyEvidence {
  id: string;
  runId: string;
  claim: string;
  sourceKind: string;
  sourceRef: string;
}

export interface ResearchResult {
  schemaVersion: 1;
  conclusion: string | null;
  evidence: Array<{ claim: string; source: string }>;
  risks: string[];
  unknowns: string[];
  nextActions: string[];
  missingFields: string[];
  source: { runId: string; outputRef: string; reportHash: string };
}

export interface LinkedCompanyOutput {
  id: string;
  runId: string;
  mediaType: string;
  contentRef: string;
  content?: string;
  createdAt?: string;
  sessionId?: string;
  kind?: "report" | "file";
  researchResult?: ResearchResult;
}

export interface LinkedWorkspaceFile {
  path: string;
  runId: string;
}

export interface DeliveryTrace {
  workItemId: string;
  specVersion?: number;
  planVersion?: number;
  runIds: string[];
  runs: LinkedCompanyRun[];
  artifactIds: string[];
  validationIds: string[];
  validations: LinkedCompanyValidation[];
  evidence: LinkedCompanyEvidence[];
  outputs: LinkedCompanyOutput[];
  workspaceFiles: LinkedWorkspaceFile[];
}

export const DAEMON_COMPANY_METHODS = {
  GET: "company.get",
  WORKFLOW_CAPABILITIES: "company.workflows.capabilities",
  WORKFLOWS_START: "company.workflows.start",
  WORKFLOWS_RESEARCH_STATUS: "company.workflows.researchStatus",
  DASHBOARD_GET: "company.dashboard.get",
  CREATE: "company.create",
  ORGANIZATION_TREE: "company.organization.tree",
  ORGANIZATION_ENSURE_CREW: "company.organization.ensureCrew",
  EMPLOYEES_LIST: "company.employees.list",
  EMPLOYEES_HIRE: "company.employees.hire",
  EMPLOYEES_ONBOARD_OPTIONS: "company.employees.onboardOptions",
  EMPLOYEES_ONBOARD: "company.employees.onboard",
  EMPLOYEES_BIND: "company.employees.bind",
  EMPLOYEES_GRANT_DEFAULT_WORKSPACE: "company.employees.grantDefaultWorkspace",
  GOALS_LIST: "company.goals.list",
  GOALS_CREATE: "company.goals.create",
  PROJECTS_LIST: "company.projects.list",
  PROJECTS_CREATE: "company.projects.create",
  WORK_ITEMS_LIST: "company.workItems.list",
  WORK_ITEMS_CREATE: "company.workItems.create",
  WORK_ITEMS_GET: "company.workItems.get",
  WORK_OUTPUTS_READ: "company.workOutputs.read",
  WORK_FILES_READ: "company.workFiles.read",
  WORK_ARTIFACTS_UPSERT: "company.workArtifacts.upsert",
  WORK_ARTIFACTS_ACCEPT: "company.workArtifacts.accept",
  WORK_ARTIFACTS_DRAFT: "company.workArtifacts.draft",
  WORK_ITEMS_DISPATCH: "company.workItems.dispatch",
  WORK_ITEMS_REQUEST_RUN: "company.workItems.requestRun",
  WORK_ITEMS_PAUSE_FOR_FIX: "company.workItems.pauseForFix",
  WORK_ITEMS_PREVIEW_APPROVAL: "company.workItems.previewApproval",
  APPROVALS_LIST: "company.approvals.list",
  APPROVALS_DECIDE: "company.approvals.decide",
  CEO_BRIEF: "company.ceo.brief",
  PROJECTS_BIND_WORKSPACES: "company.projects.bindWorkspaces",
  DELIVERY_GATES_SNAPSHOT: "company.delivery.gates.snapshot",
  DELIVERY_GATES_DECIDE: "company.delivery.gates.decide",
  DELIVERY_GATES_LATEST: "company.delivery.gates.latest",
} as const;

/** Template availability is separate from production orchestration support. */
export interface CompanyWorkflowCapability {
  workflowId: string;
  templateVersion: number;
  runnable: boolean;
  missingExecutorKinds: string[];
  blockers: string[];
}

/** Only requirement-research is runnable in this milestone; product-delivery is rejected. */
export const COMPANY_RESEARCH_WORKFLOW_ID = "forge.company.requirement-research" as const;

export interface CompanyWorkflowStartRequest {
  companyId: string;
  projectId: string;
  workflowId: typeof COMPANY_RESEARCH_WORKFLOW_ID;
  briefId: string;
  idempotencyKey: string;
  /** Optional explicit stepId -> employeeId assignments; otherwise resolved from the company org. */
  assignments?: Record<string, string>;
}

export type CompanyResearchRecommendation =
  | "stop"
  | "continue_research"
  | "enter_product_definition";

/** Claim slice returned with research workflow status for the delivery UI. */
export interface CompanyResearchClaimView {
  id: string;
  text: string;
  classification: "fact" | "inference" | "hypothesis" | "unknown";
  evidenceIds: string[];
}

/** Chinese skim brief so operators need not read every raw claim. */
export interface CompanyResearchBranchDigestView {
  id: string;
  label: string;
  summary: string;
  highlights: string[];
  claimCount: number;
}

export interface CompanyResearchSuggestedDirectionView {
  title: string;
  why: string;
  nextStep: string;
}

export interface CompanyResearchReadingBriefView {
  executiveSummary: string;
  /** Proactive next moves when stop/continue — not a passive claim dump. */
  suggestedDirections?: CompanyResearchSuggestedDirectionView[];
  branches: CompanyResearchBranchDigestView[];
}

export interface CompanyResearchMemoSourceView {
  label: string;
  url?: string;
}

/** Boss-facing decision memo assembled from readingBrief + claims. */
export interface CompanyResearchDecisionMemoView {
  title: string;
  evaluatedAt: string;
  claimTotal: number;
  recommendation: CompanyResearchRecommendation;
  verdictLabel: string;
  reasons: Array<{ text: string; sources: CompanyResearchMemoSourceView[] }>;
  metrics: Array<{ label: string; value: string; sources: CompanyResearchMemoSourceView[] }>;
  competitors: Array<{
    name: string;
    form?: string;
    scale?: string;
    implication?: string;
    sources: CompanyResearchMemoSourceView[];
  }>;
  risks: Array<{
    text: string;
    severity: "veto" | "high" | "medium" | "low";
    implication?: string;
    sources: CompanyResearchMemoSourceView[];
  }>;
  chart?: {
    label: string;
    points: Array<{ name: string; valueLabel: string; ratio: number }>;
  };
  directions: CompanyResearchSuggestedDirectionView[];
  attachments: Array<{
    id: string;
    label: string;
    summary: string;
    highlights: string[];
    claims: CompanyResearchClaimView[];
  }>;
}

/** Read-only status of a project's latest requirement-research workflow run. */
export interface CompanyResearchWorkflowStatus {
  workflowRunId: string | null;
  /** Research brief this status belongs to (idea-scoped; never mix another idea's run). */
  briefId: string | null;
  /** Durable run state when a run exists (running / waiting / failed / …). */
  runState: string | null;
  waitingAtGate: boolean;
  synthesisRecommendation: CompanyResearchRecommendation | null;
  synthesisSummary: string | null;
  /** Claims from the succeeded synthesis step (empty until synthesis finishes). */
  claims: CompanyResearchClaimView[];
  /** Full claim count before UI truncation (includes recommendation claim when present). */
  claimTotal: number;
  /** Chinese executive + per-branch digests derived from synthesis claims. */
  readingBrief: CompanyResearchReadingBriefView | null;
  /** Formal one-pager for delivery UI (null until synthesis succeeds). */
  decisionMemo: CompanyResearchDecisionMemoView | null;
  /** Markdown research report written after the four branches. Null until that write succeeds. */
  formalReport: string | null;
  /** Next-attempt hint when the latest run failed before producing results. */
  failureReason: string | null;
}

export interface CompanyWorkflowStartResult {
  workflowId: typeof COMPANY_RESEARCH_WORKFLOW_ID;
  instanceId: string;
  runId: string;
  reused: boolean;
}
