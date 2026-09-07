import { randomUUID } from "node:crypto";
import type { Database } from "@forge/store";
import type { PolicyEngine } from "@forge/policy";
import {
  ApprovalExpiredError,
  ApprovalHashMismatchError,
  ApprovalService,
  hashApprovalParameters,
  type ApprovalRecord,
} from "@forge/policy";
import type { BudgetLedgerService } from "@forge/usage-ledger";
import type { CredentialProvider } from "./credentials.js";
import {
  credentialSecretStrings,
  disposeCredential,
  redactObject,
  redactSecrets,
} from "./credentials.js";
import type {
  ApprovedConnectorAction,
  ConnectorActionInput,
  ConnectorActionRecord,
  ConnectorAdapter,
  ConnectorGatewayEvent,
  ConnectorProposalRecord,
  ConnectorProposalPreview,
  ResolvedCredential,
} from "./types.js";

export interface ConnectorBudgetPolicy {
  accountId: string;
  amountMinor: bigint;
  currency: string;
}

export interface ConnectorGatewayDeps {
  db: Database;
  policy: PolicyEngine;
  approvals: ApprovalService;
  budgetLedger?: BudgetLedgerService;
  budget?: ConnectorBudgetPolicy;
  credentials: CredentialProvider;
  adapters: Map<string, ConnectorAdapter>;
  emit?: (event: ConnectorGatewayEvent) => void;
}

export class ConnectorApprovalError extends Error {
  readonly code = "CONNECTOR_APPROVAL_INVALID" as const;

  constructor(message = "connector approval is invalid") {
    super(message);
    this.name = "ConnectorApprovalError";
  }
}

export class ConnectorAccountMismatchError extends Error {
  readonly code = "CONNECTOR_ACCOUNT_MISMATCH" as const;

  constructor(message = "connector account does not match proposal") {
    super(message);
    this.name = "ConnectorAccountMismatchError";
  }
}

const TERMINAL_STATES = new Set<ConnectorActionRecord["state"]>([
  "succeeded",
  "failed",
  "unknown",
  "reconciled",
]);

export class ConnectorGateway {
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

    const account = this.getAccount(input.connectorAccountId);
    const credential = await this.deps.credentials.resolve(account.credential_ref);
    const secrets = credentialSecretStrings(credential);
    let preview: ConnectorProposalPreview;
    let persistedPayload: Record<string, unknown>;
    try {
      const proposedPreview = await adapter.propose(input);
      const redactedPreview = redactObject(
        {
          action: proposedPreview.action,
          summary: proposedPreview.summary,
          risk: proposedPreview.risk,
        },
        secrets,
      );
      preview = {
        action: String(redactedPreview.action),
        summary: String(redactedPreview.summary),
        risk: proposedPreview.risk,
      };
      persistedPayload = redactObject(input.payload, secrets);
    } finally {
      disposeCredential(credential);
    }
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
          proposal_json, result_json, approval_id, run_id, step_id,
          subject_kind, subject_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'proposed', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.connectorId,
        input.connectorAccountId,
        input.action,
        input.idempotencyKey,
        JSON.stringify(persistedPayload),
        input.runId ?? null,
        input.stepId ?? null,
        input.subject.kind,
        input.subject.id,
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
    if (TERMINAL_STATES.has(proposal.state)) {
      return proposal;
    }
    if (proposal.state === "executing") {
      return this.waitForTerminalState(proposalId);
    }

    this.assertAccountMatchesProposal(proposal);
    const payload = this.readProposalPayload(proposal.id);
    const approval = this.validateApproval(proposal, approvalId, payload);

    const policyDecision = this.deps.policy.authorize({
      subject: approval.subject,
      action: `connector.${proposal.action}`,
      resource: {
        kind: "connector",
        id: proposal.connectorId,
      },
      scope: {},
      risk: "low",
      context: payload,
    });
    if (policyDecision.outcome === "deny") {
      throw new Error(policyDecision.reason ?? "connector action denied");
    }

    const now = new Date().toISOString();
    try {
      this.deps.db.transaction(() => {
        if (!this.tryClaimExecution(proposalId, approvalId, now)) {
          throw new ConnectorApprovalError("connector proposal is not executable");
        }
        this.deps.approvals.consumeApproval(approvalId);
      })();
    } catch (error) {
      const current = this.getAction(proposalId);
      if (!current) {
        throw new Error(`connector proposal not found: ${proposalId}`);
      }
      if (TERMINAL_STATES.has(current.state)) {
        return current;
      }
      if (current.state === "executing") {
        return this.waitForTerminalState(proposalId);
      }
      if (error instanceof ConnectorApprovalError) throw error;
      throw new ConnectorApprovalError(String(error));
    }

    let reservationId: string | undefined;
    let credential: ResolvedCredential | undefined;
    let externalAttemptStarted = false;

    const approved: ApprovedConnectorAction = {
      proposalId: proposal.id,
      connectorId: proposal.connectorId,
      connectorAccountId: proposal.connectorAccountId,
      action: proposal.action,
      payload,
      approvalId,
    };

    try {
      const adapter = this.requireAdapter(proposal.connectorId);
      const account = this.getAccount(proposal.connectorAccountId);
      credential = await this.deps.credentials.resolve(account.credential_ref);

      if (this.deps.budgetLedger && this.deps.budget) {
        reservationId = randomUUID();
        this.deps.budgetLedger.reserve({
          reservationId,
          accountId: this.deps.budget.accountId,
          runId: proposal.runId ?? proposal.id,
          stepId: proposal.stepId,
          amountMinor: this.deps.budget.amountMinor,
          currency: this.deps.budget.currency,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        this.deps.db
          .prepare(
            `UPDATE core_connector_actions
             SET budget_reservation_id = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(reservationId, now, proposal.id);
      }

      externalAttemptStarted = true;
      const result = await adapter.execute(approved, credential);
      const secrets = credentialSecretStrings(credential);
      const resultJson = JSON.stringify(
        redactObject(
          {
            ok: result.ok,
            externalId: result.externalId,
            summary: result.summary,
            error: result.error,
          },
          secrets,
        ),
      );
      this.deps.db
        .prepare(
          `UPDATE core_connector_actions
           SET state = ?, result_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(result.ok ? "succeeded" : "failed", resultJson, now, proposal.id);

      if (reservationId && this.deps.budgetLedger && this.deps.budget) {
        if (result.ok) {
          this.deps.budgetLedger.commit(reservationId, this.deps.budget.amountMinor);
        } else {
          this.deps.budgetLedger.release(reservationId, "connector action failed");
        }
      }

      const updated = this.getAction(proposal.id)!;
      this.emit("connector.executed", updated.id, {
        state: updated.state,
        result: JSON.parse(resultJson) as Record<string, unknown>,
      });
      return updated;
    } catch (error) {
      const secrets = credential ? credentialSecretStrings(credential) : [];
      const message = redactSecrets(String(error), secrets);
      const state = externalAttemptStarted ? "unknown" : "failed";
      this.deps.db
        .prepare(
          `UPDATE core_connector_actions
           SET state = ?, result_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(state, JSON.stringify({ ok: false, error: message }), now, proposal.id);
      if (state === "unknown") {
        this.emit("connector.unknown", proposal.id, {
          state,
          error: message,
        });
      }
      if (!externalAttemptStarted && reservationId && this.deps.budgetLedger) {
        this.deps.budgetLedger.release(
          reservationId,
          "connector action failed before dispatch",
        );
      }
      throw new Error(message);
    } finally {
      if (credential) {
        disposeCredential(credential);
      }
    }
  }

  async reconcile(actionId: string): Promise<ConnectorActionRecord> {
    const action = this.getAction(actionId);
    if (!action) {
      throw new Error(`connector action not found: ${actionId}`);
    }
    const adapter = this.requireAdapter(action.connectorId);
    const account = this.getAccount(action.connectorAccountId);
    let credential = await this.deps.credentials.resolve(account.credential_ref);
    const secrets = credentialSecretStrings(credential);
    try {
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
            JSON.stringify(redactObject({ ...result }, secrets)),
            now,
            action.id,
          );
        if (
          action.budgetReservationId &&
          this.deps.budgetLedger &&
          this.deps.budget
        ) {
          if (result.ok) {
            this.deps.budgetLedger.commit(
              action.budgetReservationId,
              this.deps.budget.amountMinor,
            );
          } else {
            this.deps.budgetLedger.release(
              action.budgetReservationId,
              "connector reconciliation failed",
            );
          }
        }
      }
      const updated = this.getAction(action.id)!;
      this.emit(
        updated.state === "reconciled"
          ? "connector.reconciled"
          : updated.state === "failed"
            ? "connector.reconciliation_failed"
            : "connector.reconciliation_unknown",
        updated.id,
        { state: updated.state },
      );
      return updated;
    } finally {
      disposeCredential(credential);
    }
  }

  dumpDatabase(): string {
    const rows = this.deps.db
      .prepare(`SELECT proposal_json, result_json FROM core_connector_actions`)
      .all() as Array<{ proposal_json: string; result_json: string | null }>;
    return JSON.stringify(rows);
  }

  private validateApproval(
    proposal: ConnectorProposalRecord,
    approvalId: string,
    payload: Record<string, unknown>,
  ): ApprovalRecord {
    let approval;
    try {
      approval = this.deps.approvals.getApproval(approvalId);
    } catch (error) {
      if (error instanceof ApprovalExpiredError) {
        throw new ConnectorApprovalError("approval expired");
      }
      throw error;
    }

    if (approval.state !== "approved") {
      throw new ConnectorApprovalError(`approval is ${approval.state}`);
    }
    if (approval.consumedAt) {
      throw new ConnectorApprovalError("approval already consumed");
    }
    if (
      approval.subject.kind !== proposal.subject.kind ||
      approval.subject.id !== proposal.subject.id
    ) {
      throw new ConnectorApprovalError("approval subject mismatch");
    }
    if (approval.action !== `connector.${proposal.action}`) {
      throw new ConnectorApprovalError("approval action mismatch");
    }
    if (
      approval.resource.kind !== "connector_proposal" ||
      approval.resource.id !== proposal.id
    ) {
      throw new ConnectorApprovalError("approval resource mismatch");
    }
    if (approval.runId !== proposal.runId || approval.stepId !== proposal.stepId) {
      throw new ConnectorApprovalError("approval run or step mismatch");
    }
    const activePolicy = this.deps.db
      .prepare("SELECT id FROM core_policy_versions WHERE id = ? AND is_active = 1")
      .get(approval.policyVersionId);
    if (!activePolicy) {
      throw new ConnectorApprovalError("approval policy is not active");
    }
    const expectedHash = hashApprovalParameters(
      connectorApprovalParameters(proposal, payload),
    );
    if (approval.parametersHash !== expectedHash) {
      throw new ApprovalHashMismatchError();
    }
    return approval;
  }

  private assertAccountMatchesProposal(proposal: ConnectorProposalRecord): void {
    const account = this.deps.db
      .prepare(
        `SELECT connector_id FROM core_connector_accounts WHERE id = ?`,
      )
      .get(proposal.connectorAccountId) as { connector_id: string } | undefined;
    if (!account) {
      throw new Error(`connector account not found: ${proposal.connectorAccountId}`);
    }
    if (account.connector_id !== proposal.connectorId) {
      throw new ConnectorAccountMismatchError();
    }
  }

  private tryClaimExecution(
    proposalId: string,
    approvalId: string,
    now: string,
  ): boolean {
    const result = this.deps.db
      .prepare(
        `UPDATE core_connector_actions
         SET state = 'executing', approval_id = ?, updated_at = ?
         WHERE id = ? AND state IN ('proposed', 'approved')`,
      )
      .run(approvalId, now, proposalId);
    return result.changes === 1;
  }

  private async waitForTerminalState(
    proposalId: string,
    timeoutMs = 5_000,
  ): Promise<ConnectorActionRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const action = this.getAction(proposalId);
      if (!action) {
        throw new Error(`connector proposal not found: ${proposalId}`);
      }
      if (TERMINAL_STATES.has(action.state)) {
        return action;
      }
      await sleep(5);
    }
    throw new Error(`timed out waiting for connector action: ${proposalId}`);
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
                , subject_kind, subject_id, run_id, step_id
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
          subject_kind: string | null;
          subject_id: string | null;
          run_id: string | null;
          step_id: string | null;
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
          subject: {
            kind: row.subject_kind ?? "unknown",
            id: row.subject_id ?? "unknown",
          },
          runId: row.run_id ?? undefined,
          stepId: row.step_id ?? undefined,
        }
      : null;
  }

  private getAction(id: string): ConnectorActionRecord | null {
    const row = this.deps.db
      .prepare(
        `SELECT id, connector_id, connector_account_id, action, state, idempotency_key,
                result_json, approval_id, run_id, step_id, budget_reservation_id
                , subject_kind, subject_id
         FROM core_connector_actions WHERE id = ?`,
      )
      .get(id) as ActionRow | undefined;
    return row
      ? {
          ...mapAction(row),
          resultJson: row.result_json ?? undefined,
          budgetReservationId: row.budget_reservation_id ?? undefined,
        }
      : null;
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
  budget_reservation_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
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
    subject: {
      kind: row.subject_kind ?? "unknown",
      id: row.subject_id ?? "unknown",
    },
    runId: row.run_id ?? undefined,
    stepId: row.step_id ?? undefined,
  };
}

function connectorApprovalParameters(
  proposal: ConnectorProposalRecord,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    proposalId: proposal.id,
    connectorId: proposal.connectorId,
    connectorAccountId: proposal.connectorAccountId,
    action: proposal.action,
    idempotencyKey: proposal.idempotencyKey,
    runId: proposal.runId ?? null,
    stepId: proposal.stepId ?? null,
    payload,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
