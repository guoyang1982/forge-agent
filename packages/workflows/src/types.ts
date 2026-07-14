export interface WorkflowInput {
  name: string;
  label?: string;
  type: "string" | "boolean" | "number" | "choice";
  required?: boolean;
  choices?: string[];
}

export interface WorkflowStep {
  id: string;
  title: string;
  description?: string;
}

export interface WorkflowDefinition {
  id: string;
  title: string;
  description: string;
  inputs?: WorkflowInput[];
  steps: WorkflowStep[];
}

export interface PlanResult {
  summary: string;
  steps: WorkflowStep[];
  filesToInspect: string[];
  risks: string[];
  verification: string[];
}

export interface ReviewFinding {
  severity: "high" | "medium" | "low";
  message: string;
  file?: string;
  suggestion?: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  summary: string;
  residualRisk?: string;
}
