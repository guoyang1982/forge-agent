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
}

export interface DeliveryTrace {
  workItemId: string;
  specVersion?: number;
  planVersion?: number;
  runIds: string[];
  artifactIds: string[];
  validationIds: string[];
}

export const DAEMON_COMPANY_METHODS = {
  GET: "company.get",
  DASHBOARD_GET: "company.dashboard.get",
  CREATE: "company.create",
  ORGANIZATION_TREE: "company.organization.tree",
  EMPLOYEES_LIST: "company.employees.list",
  EMPLOYEES_HIRE: "company.employees.hire",
  GOALS_LIST: "company.goals.list",
  GOALS_CREATE: "company.goals.create",
  PROJECTS_LIST: "company.projects.list",
  PROJECTS_CREATE: "company.projects.create",
  WORK_ITEMS_LIST: "company.workItems.list",
  WORK_ITEMS_CREATE: "company.workItems.create",
  WORK_ITEMS_GET: "company.workItems.get",
  WORK_ARTIFACTS_UPSERT: "company.workArtifacts.upsert",
  WORK_ARTIFACTS_ACCEPT: "company.workArtifacts.accept",
  WORK_ITEMS_DISPATCH: "company.workItems.dispatch",
  WORK_ITEMS_REQUEST_RUN: "company.workItems.requestRun",
  WORK_ITEMS_PAUSE_FOR_FIX: "company.workItems.pauseForFix",
  APPROVALS_LIST: "company.approvals.list",
  APPROVALS_DECIDE: "company.approvals.decide",
} as const;
