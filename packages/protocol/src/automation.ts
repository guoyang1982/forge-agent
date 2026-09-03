export type AutomationTriggerType = "cron" | "manual";
export type AutomationRunStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped";
export type AutomationRunTrigger = "schedule" | "manual" | "cli";

export interface AutomationRecord {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  cwd: string;
  trigger:
    | { type: "cron"; cron: string; timezone: string }
    | { type: "manual" };
  prompt: string;
  model?: string;
  memoryEnabled: boolean;
  sessionMode: "new" | "resume";
  resumeSessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  notify?: AutomationNotifyConfig;
}

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  sessionId: string;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  preview?: string;
  workflowInstanceId?: string;
  durableRunId?: string;
  triggerRef?: string;
}

export interface AutomationDraft {
  name: string;
  description?: string;
  cron?: string;
  timezone?: string;
  prompt: string;
  cwd?: string;
  enabled?: boolean;
  notify?: AutomationNotifyConfig;
}

export interface AutomationNotifyConfig {
  enabled: boolean;
  channelKind?: ChannelKind;
  channelId?: string;
  threadKey?: string;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  draft: AutomationDraft;
}

export interface ListAutomationsRequest {
  cwd?: string;
}
export interface ListAutomationsResult {
  automations: AutomationRecord[];
}

export interface GetAutomationRequest {
  id: string;
}
export interface GetAutomationResult {
  automation: AutomationRecord;
}

export interface CreateAutomationRequest {
  draft: AutomationDraft;
  skipConfirm?: boolean;
}
export interface CreateAutomationResult {
  automation: AutomationRecord;
}

export interface UpdateAutomationRequest {
  id: string;
  patch: Partial<AutomationDraft> & { enabled?: boolean };
}
export interface UpdateAutomationResult {
  automation: AutomationRecord;
}

export interface DeleteAutomationRequest {
  id: string;
  skipConfirm?: boolean;
}
export interface DeleteAutomationResult {
  ok: true;
}

export interface RunAutomationRequest {
  id: string;
  trigger?: AutomationRunTrigger;
  skipConfirm?: boolean;
}
export interface RunAutomationResult {
  run: AutomationRunRecord;
}

export interface ListAutomationRunsRequest {
  automationId: string;
  limit?: number;
}
export interface ListAutomationRunsResult {
  runs: AutomationRunRecord[];
}

export interface ParseAutomationDraftRequest {
  message: string;
  cwd?: string;
}
export interface ParseAutomationDraftResult {
  draft?: AutomationDraft;
  questions?: string[];
}

export interface ListAutomationTemplatesResult {
  templates: AutomationTemplate[];
}
import type { ChannelKind } from "./channel.js";
