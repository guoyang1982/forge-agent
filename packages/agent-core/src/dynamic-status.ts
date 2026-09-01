export interface DynamicRunStatusInput {
  runId: string;
  currentStepId?: string;
  workspaceBindings?: string[];
  modifiedFiles?: string[];
  validationSummary?: string;
  failures?: string[];
  retryCount?: number;
  budgetRemainingMinor?: bigint;
  unresolvedDecisions?: string[];
  remainingWork?: string[];
}

export interface DynamicRunStatus {
  runId: string;
  currentStepId?: string;
  workspaceBindings: string[];
  modifiedFiles: string[];
  validationSummary: string;
  failures: string[];
  retryCount: number;
  budgetRemainingMinor?: bigint;
  unresolvedDecisions: string[];
  remainingWork: string[];
}

export function buildDynamicStatus(
  input: DynamicRunStatusInput,
): DynamicRunStatus {
  return {
    runId: input.runId,
    currentStepId: input.currentStepId,
    workspaceBindings: [...(input.workspaceBindings ?? [])],
    modifiedFiles: [...(input.modifiedFiles ?? [])],
    validationSummary: input.validationSummary ?? "none",
    failures: [...(input.failures ?? [])],
    retryCount: input.retryCount ?? 0,
    budgetRemainingMinor: input.budgetRemainingMinor,
    unresolvedDecisions: [...(input.unresolvedDecisions ?? [])],
    remainingWork: [...(input.remainingWork ?? [])],
  };
}

export function formatDynamicStatusTail(status: DynamicRunStatus): string {
  const lines = [
    "## Dynamic run status",
    `runId: ${status.runId}`,
    status.currentStepId ? `currentStep: ${status.currentStepId}` : undefined,
    status.workspaceBindings.length
      ? `workspaceBindings: ${status.workspaceBindings.join(", ")}`
      : undefined,
    status.modifiedFiles.length
      ? `modifiedFiles: ${status.modifiedFiles.join(", ")}`
      : undefined,
    `validation: ${status.validationSummary}`,
    status.failures.length ? `failures: ${status.failures.join("; ")}` : undefined,
    `retryCount: ${status.retryCount}`,
    status.budgetRemainingMinor !== undefined
      ? `budgetRemainingMinor: ${status.budgetRemainingMinor.toString()}`
      : undefined,
    status.unresolvedDecisions.length
      ? `unresolvedDecisions: ${status.unresolvedDecisions.join("; ")}`
      : undefined,
    status.remainingWork.length
      ? `remaining: ${status.remainingWork.join("; ")}`
      : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}
