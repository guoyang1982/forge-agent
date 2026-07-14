export interface WorkflowStatus {
  cwd: string;
  sessionId?: string | null;
  model?: string;
  recentFiles?: string[];
}

export function formatWorkflowStatus(status: WorkflowStatus): string {
  return [
    `cwd: ${status.cwd}`,
    `session: ${status.sessionId ?? "(none)"}`,
    status.model ? `model: ${status.model}` : undefined,
    status.recentFiles?.length
      ? `recent files: ${status.recentFiles.join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
