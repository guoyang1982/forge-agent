export interface PublishRequest {
  connectorId: string;
  connectorAccountId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type PublishStatus =
  | "capability_unavailable"
  | "account_not_found"
  | "needs_auth"
  | "invalid_request"
  | "denied"
  | "require_approval"
  | "succeeded"
  | "failed"
  | "unknown"
  | "reconciled";

export interface PublishResult {
  status: PublishStatus;
  connectorId: string;
  connectorAccountId: string;
  reason?: string;
  proposalId?: string;
  externalId?: string;
  url?: string;
}

export interface ConnectorRouteView {
  connectorFound: boolean;
  capabilities: string[];
  account: { id: string; connectorId: string; health: string } | null;
}
