import { randomUUID } from "node:crypto";
import type { Database } from "@forge/store";
import type { PolicyEngine } from "@forge/policy";
import type { ApprovalService } from "@forge/policy";
import type { BudgetLedgerService } from "@forge/usage-ledger";
import type { CredentialProvider } from "./credentials.js";
import { redactObject, redactSecrets } from "./credentials.js";
import type {
  ApprovedConnectorAction,
  ConnectorActionInput,
  ConnectorActionRecord,
  ConnectorAdapter,
  ConnectorGatewayEvent,
  ConnectorProposalRecord,
  ConnectorProposalPreview,
} from "./types.js";

export interface ConnectorGatewayDeps {
  db: Database;
  policy: PolicyEngine;
  approvals: ApprovalService;
  budgetLedger?: BudgetLedgerService;
  credentials: CredentialProvider;
  adapters: Map<string, ConnectorAdapter>;
  emit?: (event: ConnectorGatewayEvent) => void;
}

export class ConnectorGateway {
  private readonly knownSecrets = new Set<string>();

  constructor(private readonly deps: ConnectorGatewayDeps) {}

  async propose(
    input: ConnectorActionInput,
  ): Promise<ConnectorProposalRecord & { preview: ConnectorProposalPreview }> {
    const adapter = this.requireAdapter(input.connectorId);
    const decision = this.deps.policy.authorize({
      subject: input.subject,
      action: `connector.${input.action}`,
      resource: {
        kind: "connector",
        id: input.connectorId,
      },
      scope: {},
      risk: "low",
      context: input.payload,
    });
    if (decision.outcome === "deny") {
      throw new Error(decision.reason ?? "connector action denied");
    }

    const preview = await adapter.propose(input);
    const now = new Date().toISOString();
    const existing = this.findByIdempotency(
      input.connectorAccountId,
      input.idempotencyKey,
    );
    if (existing) {
      return { ...existing, preview };
    }

    const id = randomUUID();
    this.deps.db
      .prepare(
        `INSERT INTO core_connector_actions (
          id, connector_id, connector_account_id, action, state, idempotency_key,
          proposal_json, result_json, approval_id, run_id, step_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'proposed', ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.connectorId,
        input.connectorAccountId,
        input.action,
        input.idempotencyKey,
        JSON.stringify(redactObject(input.payload, [...this.knownSecrets])),
        input.runId ?? null,
        input.stepId ?? null,
        now,
        now,
      );

    const record = this.getAction(id)!;
    this.emit("connector.proposed", record.id, { preview });
    return { ...record, preview };
  }

  async execute(
    proposalId: string,
    approvalId: string,
  ): Promise<ConnectorActionRecord> {
    const proposal = this.getAction(proposalId);
    if (!proposal) {
      throw new Error(`connector proposal not found: ${proposalId}`);
    }
    if (proposal.state === "succeeded") {
      return proposal;
    }

    const adapter = this.requireAdapter(proposal.connectorId);
    const account = this.getAccount(proposal.connectorAccountId);
    const credential = await this.deps.credentials.resolve(account.credential_ref);
    this.knownSecrets.add(credential.token);

    const approved: ApprovedConnectorAction = {
      proposalId: proposal.id,
      connectorId: proposal.connectorId,
      connectorAccountId: proposal.connectorAccountId,
      action: proposal.action,
      payload: this.readProposalPayload(proposal.id),
      approvalId,
    };

    const now = new Date().toISOString();
    this.deps.db
      .prepare(
        `UPDATE core_connector_actions
         SET state = 'executing', approval_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(approvalId, now, proposal.id);

    try {
      const result = await adapter.execute(approved, credential);
      const resultJson = JSON.stringify(
        redactObject(
          {
            ok: result.ok,
            externalId: result.externalId,
            summary: result.summary,
            error: result.error,
          },
          [credential.token],
        ),
      );
      this.deps.db
        .prepare(
          `UPDATE core_connector_actions
           SET state = ?, result_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(result.ok ? "succeeded" : "failed", resultJson, now, proposal.id);
      const updated = this.getAction(proposal.id)!;
      this.emit("connector.executed", updated.id, {
        state: updated.state,
        result: JSON.parse(resultJson) as Record<string, unknown>,
      });
      return updated;
    } catch (error) {
      const message = redactSecrets(String(error), [credential.token]);
      this.deps.db
        .prepare(
          `UPDATE core_connector_actions
           SET state = 'failed', result_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify({ ok: false, error: message }), now, proposal.id);
      throw error;
    }
  }

  async reconcile(actionId: string): Promise<ConnectorActionRecord> {
    const action = this.getAction(actionId);
    if (!action) {
      throw new Error(`connector action not found: ${actionId}`);
    }
    const adapter = this.requireAdapter(action.connectorId);
    const account = this.getAccount(action.connectorAccountId);
    const credential = await this.deps.credentials.resolve(account.credential_ref);
    const result = await adapter.reconcile(action, credential);
    const now = new Date().toISOString();
    if (result === "unknown") {
      this.deps.db
        .prepare(
          `UPDATE core_connector_actions SET state = 'unknown', updated_at = ? WHERE id = ?`,
        )
        .run(now, action.id);
    } else {
      this.deps.db
        .prepare(
          `UPDATE core_connector_actions
           SET state = ?, result_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          result.ok ? "reconciled" : "failed",
          JSON.stringify(redactObject({ ...result }, [credential.token])),
          now,
          action.id,
        );
    }
    return this.getAction(action.id)!;
  }

  dumpDatabase(): string {
    const rows = this.deps.db
      .prepare(`SELECT proposal_json, result_json FROM core_connector_actions`)
      .all() as Array<{ proposal_json: string; result_json: string | null }>;
    return JSON.stringify(rows);
  }

  private requireAdapter(connectorId: string): ConnectorAdapter {
    const connector = this.deps.db
      .prepare(`SELECT adapter_kind FROM core_connectors WHERE id = ?`)
      .get(connectorId) as { adapter_kind: string } | undefined;
    if (!connector) {
      throw new Error(`connector not found: ${connectorId}`);
    }
    const adapter = this.deps.adapters.get(connector.adapter_kind);
    if (!adapter) {
      throw new Error(`connector adapter not registered: ${connector.adapter_kind}`);
    }
    return adapter;
  }

  private getAccount(accountId: string): { credential_ref: string } {
    const row = this.deps.db
      .prepare(`SELECT credential_ref FROM core_connector_accounts WHERE id = ?`)
      .get(accountId) as { credential_ref: string } | undefined;
    if (!row) {
      throw new Error(`connector account not found: ${accountId}`);
    }
    return row;
  }

  private findByIdempotency(
    connectorAccountId: string,
    idempotencyKey: string,
  ): ConnectorProposalRecord | null {
    const row = this.deps.db
      .prepare(
        `SELECT id, connector_id, connector_account_id, action, state, idempotency_key, approval_id
         FROM core_connector_actions
         WHERE connector_account_id = ? AND idempotency_key = ?`,
      )
      .get(connectorAccountId, idempotencyKey) as
      | {
          id: string;
          connector_id: string;
          connector_account_id: string;
          action: string;
          state: string;
          idempotency_key: string;
          approval_id: string | null;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          connectorId: row.connector_id,
          connectorAccountId: row.connector_account_id,
          action: row.action,
          state: row.state as ConnectorProposalRecord["state"],
          idempotencyKey: row.idempotency_key,
          approvalId: row.approval_id ?? undefined,
        }
      : null;
  }

  private getAction(id: string): ConnectorActionRecord | null {
    const row = this.deps.db
      .prepare(
        `SELECT id, connector_id, connector_account_id, action, state, idempotency_key,
                result_json, approval_id, run_id, step_id
         FROM core_connector_actions WHERE id = ?`,
      )
      .get(id) as ActionRow | undefined;
    return row ? { ...mapAction(row), resultJson: row.result_json ?? undefined } : null;
  }

  private readProposalPayload(actionId: string): Record<string, unknown> {
    const row = this.deps.db
      .prepare(`SELECT proposal_json FROM core_connector_actions WHERE id = ?`)
      .get(actionId) as { proposal_json: string };
    return JSON.parse(row.proposal_json) as Record<string, unknown>;
  }

  private emit(type: string, actionId: string, payload: Record<string, unknown>): void {
    this.deps.emit?.({ type, actionId, payload });
  }
}

interface ActionRow {
  id: string;
  connector_id: string;
  connector_account_id: string;
  action: string;
  state: string;
  idempotency_key: string;
  result_json: string | null;
  approval_id: string | null;
  run_id: string | null;
  step_id: string | null;
}

function mapAction(row: ActionRow): ConnectorProposalRecord {
  return {
    id: row.id,
    connectorId: row.connector_id,
    connectorAccountId: row.connector_account_id,
    action: row.action,
    state: row.state as ConnectorProposalRecord["state"],
    idempotencyKey: row.idempotency_key,
    approvalId: row.approval_id ?? undefined,
  };
}
