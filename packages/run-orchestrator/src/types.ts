export type RunStepKind =
  | "talent_background"
  | "talent_foreground"
  | "coordinator"
  | "verify";

export type RunStepStatus = "pending" | "in_progress" | "done";

export type RunPlanSource = "heuristic" | "model";

export type RunKind = "coordinator" | "talent_foreground" | "talent_dispatch";

export type TalentExecutionMode = "parallel" | "serial";

export interface RunPlanStep {
  id: string;
  kind: RunStepKind;
  mention?: string;
  displayName?: string;
  role?: string;
  emoji?: string;
  avatar?: string;
  task: string;
  after: string[];
  wave: number;
  status: RunStepStatus;
}

export interface RunPlan {
  intent: string;
  source: RunPlanSource;
  runKind: RunKind;
  steps: RunPlanStep[];
  coordinatorFollowup: boolean;
}

export interface TalentAssignmentInput {
  mention: string;
  displayName: string;
  role: string;
  emoji?: string;
  avatar?: string;
  task: string;
}

export interface DispatchPlanWaveStep {
  id: string;
  kind: RunStepKind;
  mention?: string;
  displayName?: string;
  role?: string;
  emoji?: string;
  avatar?: string;
  task: string;
  status: RunStepStatus;
}

export interface DispatchPlanEventPayload {
  intent: string;
  source: RunPlanSource;
  runKind: RunKind;
  executionMode: TalentExecutionMode;
  waves: Array<{
    index: number;
    steps: DispatchPlanWaveStep[];
  }>;
}

export interface PlanUpdateItem {
  text: string;
  status: RunStepStatus;
}
