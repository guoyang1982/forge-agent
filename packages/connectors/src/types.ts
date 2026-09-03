import type { SubjectRef } from "@forge/protocol";

export type ConnectorActionState =
  | "proposed"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "reconciled";

export interface ConnectorActionInput {
  connectorId: string;
  connectorAccountId: string;
  action: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  subject: SubjectRef;
  runId?: string;
  stepId?: string;
}

export interface ConnectorProposalPreview {
  action: string;
  summary: string;
  risk: "low" | "medium" | "high";
}

export interface ConnectorProposalRecord {
  id: string;
  connectorId: string;
  connectorAccountId: string;
  action: string;
  state: ConnectorActionState;
  idempotencyKey: string;
  approvalId?: string;
}

export interface ApprovedConnectorAction {
  proposalId: string;
  connectorId: string;
  connectorAccountId: string;
  action: string;
  payload: Record<string, unknown>;
  approvalId: string;
}

export interface ConnectorActionRecord extends ConnectorProposalRecord {
  resultJson?: string;
  runId?: string;
  stepId?: string;
}

export interface AdapterResult {
  ok: boolean;
  externalId?: string;
  summary?: string;
  error?: string;
}

export interface ConnectorAdapter {
  kind: string;
  propose(input: ConnectorActionInput): Promise<ConnectorProposalPreview>;
  execute(
    input: ApprovedConnectorAction,
    credential: ResolvedCredential,
  ): Promise<AdapterResult>;
  reconcile(
    input: ConnectorActionRecord,
    credential: ResolvedCredential,
  ): Promise<AdapterResult | "unknown">;
}

export interface ResolvedCredential {
  ref: string;
  bytes: Uint8Array;
}

export interface ConnectorGatewayEvent {
  type: string;
  actionId: string;
  payload: Record<string, unknown>;
}
