import type { SubjectRef } from "@forge/protocol";
import { ApprovalService, PolicyEngine, hashApprovalParameters } from "@forge/policy";
import type { Database } from "@forge/store";
import { connectorApprovalParameters, type ConnectorGateway } from "../gateway.js";
import type { ConnectorActionRecord, ConnectorActionState } from "../types.js";
import { loadPublishView } from "./accounts.js";
import { routePublishRequest } from "./route.js";
import type { PublishRequest, PublishResult, PublishStatus } from "./types.js";

const TERMINAL = new Set<ConnectorActionState>(["succeeded", "failed", "unknown", "reconciled"]);

export class SocialPublishService {
  constructor(
    private readonly db: Database,
    private readonly gateway: ConnectorGateway,
    private readonly approvals: ApprovalService,
  ) {}

  async publish(request: PublishRequest, subject: SubjectRef): Promise<PublishResult> {
    const view = loadPublishView(this.db, request.connectorId, request.connectorAccountId);
    const rejected = routePublishRequest(request, view);
    if (rejected) return rejected;

    let proposal;
    try {
      proposal = await this.gateway.propose({
        connectorId: request.connectorId,
        connectorAccountId: request.connectorAccountId,
        action: "publish",
        idempotencyKey: request.idempotencyKey,
        payload: request.payload,
        subject,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /denied|no matching grant/i.test(message) ? "denied" : "failed";
      return result(request, status, { reason: message });
    }
    if (TERMINAL.has(proposal.state)) return this.storedResult(proposal.id, request);

    const decision = PolicyEngine.fromDatabase(this.db).authorize({
      subject,
      action: "connector.publish",
      resource: { kind: "connector", id: request.connectorId },
      scope: {},
      risk: proposal.preview.risk,
      context: request.payload,
    });
    if (decision.outcome === "require_approval") {
      return result(request, "require_approval", { proposalId: proposal.id });
    }
    if (decision.outcome !== "allow") {
      return result(request, "denied", { reason: decision.reason, proposalId: proposal.id });
    }

    const payload = JSON.parse(
      (
        this.db
          .prepare(`SELECT proposal_json FROM core_connector_actions WHERE id = ?`)
          .get(proposal.id) as { proposal_json: string }
      ).proposal_json,
    ) as Record<string, unknown>;
    const approval = this.approvals.requestApproval({
      subject,
      action: "connector.publish",
      resource: { kind: "connector_proposal", id: proposal.id },
      parametersHash: hashApprovalParameters(connectorApprovalParameters(proposal, payload)),
      parametersSummary: request.idempotencyKey,
      risk: proposal.preview.risk,
      policyVersionId: decision.policyVersionId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      runId: proposal.runId,
      stepId: proposal.stepId,
    });
    this.approvals.decide(approval.id, { decision: "approved", actor: subject });
    try {
      const executed = await this.gateway.execute(proposal.id, approval.id);
      return this.storedResult(executed.id, request);
    } catch {
      return this.storedResult(proposal.id, request);
    }
  }

  async reconcile(proposalId: string): Promise<PublishResult> {
    const executed = await this.gateway.reconcile(proposalId);
    return this.storedResult(executed.id, {
      connectorId: executed.connectorId,
      connectorAccountId: executed.connectorAccountId,
      idempotencyKey: executed.idempotencyKey,
      payload: {},
    });
  }

  private storedResult(actionId: string, request: PublishRequest): PublishResult {
    const row = this.db
      .prepare(`SELECT state, result_json FROM core_connector_actions WHERE id = ?`)
      .get(actionId) as { state: ConnectorActionRecord["state"]; result_json: string | null };
    const body = row.result_json
      ? (JSON.parse(row.result_json) as { externalId?: string; url?: string; error?: string })
      : {};
    const status: PublishStatus = TERMINAL.has(row.state) ? row.state : "failed";
    return result(request, status, {
      proposalId: actionId,
      externalId: body.externalId,
      url: body.url,
      reason: body.error,
    });
  }
}

function result(
  request: Pick<PublishRequest, "connectorId" | "connectorAccountId">,
  status: PublishStatus,
  extra: Partial<PublishResult> = {},
): PublishResult {
  return {
    connectorId: request.connectorId,
    connectorAccountId: request.connectorAccountId,
    status,
    ...extra,
  };
}
