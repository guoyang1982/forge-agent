import type { RunSpec, StepRetryPolicy, SubjectRef } from "@forge/execution";
import type { AssetRecord, AssetVersion } from "@forge/asset-registry";

export type WorkflowTriggerKind =
  | "manual"
  | "cron"
  | "webhook"
  | "domain_event"
  | "connector_event";

export type WorkflowTrigger =
  | { kind: "manual" }
  | { kind: "cron"; expression: string }
  | { kind: "webhook"; path?: string }
  | { kind: "domain_event"; eventType: string }
  | { kind: "connector_event"; connectorId: string; eventType: string };

export interface WorkflowStepDefinition {
  id: string;
  kind: string;
  dependsOn: string[];
  input: Record<string, unknown>;
  workspaceBindingId?: string;
  idempotencyKey?: string;
  retry?: StepRetryPolicy;
  timeoutMs?: number;
}

export interface WorkflowConcurrencyPolicy {
  maxRuns: number;
  keyExpression?: string;
}

export interface DurableWorkflowDefinition {
  id: string;
  version: number;
  inputSchema: Record<string, unknown>;
  steps: WorkflowStepDefinition[];
  triggers: WorkflowTrigger[];
  concurrency: WorkflowConcurrencyPolicy;
}

export interface WorkflowRunContext {
  workflowId: string;
  instanceId: string;
  instanceNumber: number;
  requestedBy: SubjectRef;
  actingSubject: SubjectRef;
  objective?: string;
  policyContext?: Record<string, unknown>;
  budgetAccountId?: string;
}

export interface WorkflowDraftInput {
  id?: string;
  name: string;
  ownerSubject: SubjectRef;
  definition: DurableWorkflowDefinition;
  description?: string;
}

export interface WorkflowQualityGateInput {
  validationIds: string[];
  permissionReviewId: string;
  securityValidationId: string;
  description?: string;
}

export interface PublishedWorkflowVersion {
  asset: AssetRecord;
  assetVersion: AssetVersion;
  definition: DurableWorkflowDefinition;
  workflowVersionId: string;
}

export interface WorkflowInstanceRecord {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  runId?: string;
  state: string;
  triggerKind: WorkflowTriggerKind;
  triggerRef?: string;
  concurrencyKey?: string;
  input: unknown;
  createdAt: string;
  updatedAt: string;
}

export type { RunSpec };
