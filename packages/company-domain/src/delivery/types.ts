export type ResearchClaimClassification =
  | "fact"
  | "inference"
  | "hypothesis"
  | "unknown";

export interface ResearchClaim {
  id: string;
  briefId: string;
  text: string;
  classification: ResearchClaimClassification;
  evidenceIds: string[];
  confidence: number;
  contradictions: string[];
}

export type StageGateKind = "research" | "scope" | "technical" | "release";

export type StageGateOutcome =
  | "approved"
  | "rejected"
  | "changes_requested"
  | "stopped";

export type StageGateNextAction =
  | "enter_product_definition"
  | "create_development_work_items"
  | "call_deployment_connector"
  | "close_research_project"
  | "none";

export interface StageGateDecision {
  id: string;
  gate: StageGateKind;
  outcome: StageGateOutcome;
  inputVersionRefs: string[];
  decidedBy: { kind: string; id: string };
  rationale: string;
  impact: string;
  decidedAt: string;
  nextAction: StageGateNextAction;
}

export interface ResearchBrief {
  id: string;
  companyId: string;
  workItemId: string;
  version: number;
  normalizedProblem: string;
  targetUser: string;
  expectedOutcome: string;
  constraints: string[];
  researchQuestions: string[];
  stopConditions: string[];
  ready: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ResearchQuestionStatus = "open" | "answered" | "dropped";

export interface ResearchQuestion {
  id: string;
  companyId: string;
  briefId: string;
  text: string;
  status: ResearchQuestionStatus;
  createdAt: string;
  updatedAt: string;
}

export type ReleaseCandidateState =
  | "draft"
  | "validating"
  | "waiting_approval"
  | "approved"
  | "released"
  | "rejected";

export interface ReleaseCandidate {
  id: string;
  companyId: string;
  projectId: string;
  checkpointId: string;
  artifactIds: string[];
  validationIds: string[];
  rollbackPlanArtifactId: string;
  approvalId?: string;
  state: ReleaseCandidateState;
  createdAt: string;
  updatedAt: string;
}

export type FeedbackItemSource = "release_review" | "post_release" | "customer";

export interface FeedbackItem {
  id: string;
  companyId: string;
  projectId?: string;
  releaseCandidateId?: string;
  source: FeedbackItemSource;
  summary: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
