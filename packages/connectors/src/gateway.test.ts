import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalHashMismatchError,
  ApprovalService,
  PolicyEngine,
  hashApprovalParameters,
} from "@forge/policy";
import { ForgeStore } from "@forge/store";
import { BudgetLedgerService } from "@forge/usage-ledger";
import { MockConnectorAdapter } from "./adapters/mock.js";
import { InMemoryCredentialProvider, type CredentialProvider } from "./credentials.js";
import {
  ConnectorAccountMismatchError,
  ConnectorApprovalError,
  ConnectorGateway,
} from "./gateway.js";
import type {
  ConnectorActionInput,
  ConnectorGatewayEvent,
  ResolvedCredential,
} from "./types.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ConnectorGateway", () => {
  it("returns one result for repeated execution with the same idempotency key", async () => {
    const fx = connectorFixture();
    const proposal = await fx.gateway.propose(publishInput("post-1"));
    seedApproval(fx.db, "approval-1", proposal, publishInput("post-1"));
    const first = await fx.gateway.execute(proposal.id, "approval-1");
    const second = await fx.gateway.execute(proposal.id, "approval-1");
    expect(second.id).toBe(first.id);
    expect(fx.adapter.executeCalls).toBe(1);
  });

  it("executes one external action for concurrent calls with the same proposal", async () => {
    const fx = connectorFixture();
    fx.adapter.executeDelayMs = 50;
    const proposal = await fx.gateway.propose(publishInput("post-concurrent"));
    seedApproval(fx.db, "approval-concurrent", proposal, publishInput("post-concurrent"));
    await Promise.all([
      fx.gateway.execute(proposal.id, "approval-concurrent"),
      fx.gateway.execute(proposal.id, "approval-concurrent"),
    ]);
    expect(fx.adapter.executeCalls).toBe(1);
  });

  it("rejects an approval issued for a different action hash", async () => {
    const fx = connectorFixture();
    const proposal = await fx.gateway.propose(publishInput("post-forged"));
    seedApproval(fx.db, "approval-forged", proposal, {
      ...publishInput("post-forged"),
      payload: { title: "different payload" },
    });
    await expect(
      fx.gateway.execute(proposal.id, "approval-forged"),
    ).rejects.toThrow(ApprovalHashMismatchError);
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("rejects proposals bound to the wrong connector account", async () => {
    const fx = connectorFixture();
    seedSecondConnector(fx.db);
    const proposal = await fx.gateway.propose({
      ...publishInput("post-mismatch"),
      connectorAccountId: "account-2",
    });
    seedApproval(fx.db, "approval-mismatch", proposal, {
      ...publishInput("post-mismatch"),
      connectorAccountId: "account-2",
    });
    await expect(
      fx.gateway.execute(proposal.id, "approval-mismatch"),
    ).rejects.toThrow(ConnectorAccountMismatchError);
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("never persists resolved secret material", async () => {
    const fx = connectorFixture({ secret: "super-secret" });
    const proposal = await fx.gateway.propose(publishInput("post-2"));
    seedApproval(fx.db, "approval-2", proposal, publishInput("post-2"));
    await fx.gateway.execute(proposal.id, "approval-2");
    expect(fx.dumpDatabase()).not.toContain("super-secret");
    expect(JSON.stringify(fx.events())).not.toContain("super-secret");
  });

  it("redacts secrets from thrown adapter errors", async () => {
    const fx = connectorFixture({ secret: "super-secret" });
    fx.adapter.executeImpl = async () => {
      throw new Error("failed with super-secret token");
    };
    const proposal = await fx.gateway.propose(publishInput("post-3"));
    seedApproval(fx.db, "approval-3", proposal, publishInput("post-3"));
    await expect(fx.gateway.execute(proposal.id, "approval-3")).rejects.toThrow(
      /\[REDACTED\]/,
    );
    expect(fx.dumpDatabase()).not.toContain("super-secret");
  });

  it("fences an ambiguous adapter exception as unknown and never executes it again", async () => {
    const fx = connectorFixture();
    fx.adapter.executeImpl = async () => {
      throw new Error("transport closed after submit");
    };
    const input = publishInput("post-unknown");
    const proposal = await fx.gateway.propose(input);
    seedApproval(fx.db, "approval-unknown", proposal, input);

    await expect(fx.gateway.execute(proposal.id, "approval-unknown")).rejects.toThrow(
      /transport closed after submit/,
    );
    expect(connectorActionState(fx.db, proposal.id)).toBe("unknown");
    expect(fx.events()).toContainEqual(
      expect.objectContaining({ type: "connector.unknown", actionId: proposal.id }),
    );

    const repeated = await fx.gateway.execute(proposal.id, "approval-unknown");
    expect(repeated.state).toBe("unknown");
    expect(fx.adapter.executeCalls).toBe(1);
  });

  it("holds budget while outcome is unknown and settles it after reconciliation", async () => {
    const fx = connectorFixture({ withBudget: true });
    fx.adapter.executeImpl = async () => {
      throw new Error("response lost");
    };
    const input = publishInput("post-reconcile");
    const proposal = await fx.gateway.propose(input);
    seedApproval(fx.db, "approval-reconcile", proposal, input);

    await expect(fx.gateway.execute(proposal.id, "approval-reconcile")).rejects.toThrow();
    expect(fx.ledger!.balance("budget-1")).toMatchObject({
      committedMinor: 0n,
      reservedMinor: 100n,
    });

    fx.adapter.reconcileImpl = async () => ({
      ok: true,
      externalId: "external-1",
      summary: "confirmed",
    });
    const reconciled = await fx.gateway.reconcile(proposal.id);
    expect(reconciled.state).toBe("reconciled");
    expect(fx.events()).toContainEqual(
      expect.objectContaining({ type: "connector.reconciled", actionId: proposal.id }),
    );
    expect(fx.ledger!.balance("budget-1")).toMatchObject({
      committedMinor: 100n,
      reservedMinor: 0n,
    });
  });

  it("marks a pre-dispatch budget rejection as failed instead of unknown", async () => {
    const fx = connectorFixture({ withBudget: true, budgetLimitMinor: 50n });
    const input = publishInput("post-budget-rejected");
    const proposal = await fx.gateway.propose(input);
    seedApproval(fx.db, "approval-budget-rejected", proposal, input);

    await expect(
      fx.gateway.execute(proposal.id, "approval-budget-rejected"),
    ).rejects.toThrow();
    expect(connectorActionState(fx.db, proposal.id)).toBe("failed");
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("resolves credentials just in time and zeroes every issued byte buffer", async () => {
    const credentials = new TrackingCredentialProvider("short-lived-secret");
    const fx = connectorFixture({ credentials });
    const input = publishInput("post-short-lived");
    const proposal = await fx.gateway.propose(input);
    expect(credentials.issued).toHaveLength(1);
    expect([...credentials.issued[0]!.bytes].every((byte) => byte === 0)).toBe(true);

    seedApproval(fx.db, "approval-short-lived", proposal, input);
    await fx.gateway.execute(proposal.id, "approval-short-lived");
    expect(credentials.issued).toHaveLength(2);
    expect(
      credentials.issued.every((credential) =>
        [...credential.bytes].every((byte) => byte === 0),
      ),
    ).toBe(true);
  });

  it("fails closed before dispatch when execution credential resolution fails", async () => {
    const credentials = new FailsOnSecondResolveCredentialProvider("temporary-secret");
    const fx = connectorFixture({ credentials });
    const input = publishInput("post-credential-failure");
    const proposal = await fx.gateway.propose(input);
    seedApproval(fx.db, "approval-credential-failure", proposal, input);

    await expect(
      fx.gateway.execute(proposal.id, "approval-credential-failure"),
    ).rejects.toThrow(/credential backend unavailable/);
    expect(connectorActionState(fx.db, proposal.id)).toBe("failed");
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("rejects execution when approval action does not match", async () => {
    const fx = connectorFixture();
    const proposal = await fx.gateway.propose(publishInput("post-4"));
    seedApproval(fx.db, "approval-4", proposal, publishInput("post-4"), {
      action: "connector.delete",
    });
    await expect(fx.gateway.execute(proposal.id, "approval-4")).rejects.toThrow(
      ConnectorApprovalError,
    );
  });

  it("reserves and commits budget for successful connector actions", async () => {
    const fx = connectorFixture({ withBudget: true });
    const proposal = await fx.gateway.propose(publishInput("post-budget"));
    seedApproval(fx.db, "approval-budget", proposal, publishInput("post-budget"));
    await fx.gateway.execute(proposal.id, "approval-budget");
    expect(fx.ledger!.balance("budget-1")).toMatchObject({
      committedMinor: 100n,
      reservedMinor: 0n,
    });
  });

  it("rejects an approval issued to a different subject", async () => {
    const fx = connectorFixture();
    const input = publishInput("post-subject");
    const proposal = await fx.gateway.propose(input);
    seedApproval(fx.db, "approval-subject", proposal, input);
    fx.db
      .prepare("UPDATE core_approvals SET subject_id = 'other' WHERE id = ?")
      .run("approval-subject");

    await expect(fx.gateway.execute(proposal.id, "approval-subject")).rejects.toThrow(
      ConnectorApprovalError,
    );
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("rejects an approval whose run and step do not match the proposal", async () => {
    const fx = connectorFixture();
    const input = { ...publishInput("post-run"), runId: "run-1", stepId: "step-1" };
    const proposal = await fx.gateway.propose(input);
    seedApproval(fx.db, "approval-run", proposal, { ...input, runId: undefined, stepId: undefined });

    await expect(fx.gateway.execute(proposal.id, "approval-run")).rejects.toThrow(
      ConnectorApprovalError,
    );
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("rejects an approval from an inactive policy version", async () => {
    const fx = connectorFixture();
    const input = publishInput("post-policy");
    const proposal = await fx.gateway.propose(input);
    seedApproval(fx.db, "approval-policy", proposal, input);
    fx.db.prepare("UPDATE core_policy_versions SET is_active = 0 WHERE id = 'policy-v1'").run();

    await expect(fx.gateway.execute(proposal.id, "approval-policy")).rejects.toThrow(
      ConnectorApprovalError,
    );
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("consumes an approval so it cannot authorize another proposal", async () => {
    const fx = connectorFixture();
    const firstInput = publishInput("post-once-1");
    const secondInput = publishInput("post-once-2");
    const first = await fx.gateway.propose(firstInput);
    const second = await fx.gateway.propose(secondInput);
    seedApproval(fx.db, "approval-once", first, firstInput);

    await fx.gateway.execute(first.id, "approval-once");
    await expect(fx.gateway.execute(second.id, "approval-once")).rejects.toThrow();
    expect(
      (fx.db.prepare("SELECT consumed_at FROM core_approvals WHERE id = ?").get(
        "approval-once",
      ) as { consumed_at: string | null }).consumed_at,
    ).not.toBeNull();
    expect(fx.adapter.executeCalls).toBe(1);
  });
});

function connectorFixture(options: {
  secret?: string;
  withBudget?: boolean;
  budgetLimitMinor?: bigint;
  credentials?: CredentialProvider;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-connectors-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  seedPolicy(forgeStore.db);
  seedConnector(forgeStore.db);
  const adapter = new MockConnectorAdapter();
  const events: ConnectorGatewayEvent[] = [];
  let ledger: BudgetLedgerService | undefined;
  if (options.withBudget) {
    ledger = new BudgetLedgerService(forgeStore.db);
    ledger.createAccount({
      id: "budget-1",
      name: "connector",
      currency: "USD",
      hardLimitMinor: options.budgetLimitMinor ?? 1000n,
    });
  }
  const gateway = new ConnectorGateway({
    db: forgeStore.db,
    policy: PolicyEngine.fromDatabase(forgeStore.db),
    approvals: new ApprovalService(forgeStore.db),
    budgetLedger: ledger,
    budget: options.withBudget
      ? { accountId: "budget-1", amountMinor: 100n, currency: "USD" }
      : undefined,
    credentials:
      options.credentials ??
      new InMemoryCredentialProvider({
        "cred://mock": options.secret ?? "token-value",
      }),
    adapters: new Map([["mock", adapter]]),
    emit: (event) => events.push(event),
  });
  return {
    gateway,
    adapter,
    db: forgeStore.db,
    ledger,
    dumpDatabase: () => gateway.dumpDatabase(),
    events: () => events,
  };
}

function connectorActionState(db: ForgeStore["db"], actionId: string): string {
  return (
    db.prepare("SELECT state FROM core_connector_actions WHERE id = ?").get(actionId) as {
      state: string;
    }
  ).state;
}

class TrackingCredentialProvider implements CredentialProvider {
  readonly issued: ResolvedCredential[] = [];

  constructor(private readonly secret: string) {}

  async resolve(ref: string): Promise<ResolvedCredential> {
    const credential = {
      ref,
      bytes: new TextEncoder().encode(this.secret),
    };
    this.issued.push(credential);
    return credential;
  }
}

class FailsOnSecondResolveCredentialProvider implements CredentialProvider {
  private calls = 0;

  constructor(private readonly secret: string) {}

  async resolve(ref: string): Promise<ResolvedCredential> {
    this.calls += 1;
    if (this.calls === 2) {
      throw new Error("credential backend unavailable");
    }
    return { ref, bytes: new TextEncoder().encode(this.secret) };
  }
}

function publishInput(idempotencyKey: string): ConnectorActionInput {
  return {
    connectorId: "connector-1",
    connectorAccountId: "account-1",
    action: "publish",
    idempotencyKey,
    payload: { title: "hello" },
    subject: { kind: "human", id: "local" },
  };
}

function seedPolicy(db: ForgeStore["db"]): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_subjects (kind, subject_id, metadata_json, created_at, updated_at)
     VALUES ('human', 'local', '{}', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
     VALUES ('policy-v1', 'default', 1, ?, 1, ?)`,
  ).run(
    JSON.stringify({
      rules: [
        {
          id: "connector-publish",
          action: "connector.publish",
          resourceKind: "connector",
          minRisk: "low",
          effect: "allow",
        },
      ],
    }),
    now,
  );
  db.prepare(
    `INSERT INTO core_grants (
      id, subject_kind, subject_id, policy_version_id, action, resource_kind,
      resource_scope_json, effect, approval_class, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'allow', NULL, NULL, ?)`,
  ).run(
    "grant-1",
    "human",
    "local",
    "policy-v1",
    "connector.publish",
    "connector",
    now,
  );
}

function seedConnector(db: ForgeStore["db"]): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_connectors (id, name, adapter_kind, capabilities_json, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, '[]', '{}', ?, ?)`,
  ).run("connector-1", "Mock", "mock", now, now);
  db.prepare(
    `INSERT INTO core_connector_accounts (
      id, connector_id, name, credential_ref, scopes_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '[]', '{}', ?, ?)`,
  ).run("account-1", "connector-1", "default", "cred://mock", now, now);
}

function seedSecondConnector(db: ForgeStore["db"]): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_connectors (id, name, adapter_kind, capabilities_json, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, '[]', '{}', ?, ?)`,
  ).run("connector-2", "Other", "mock", now, now);
  db.prepare(
    `INSERT INTO core_connector_accounts (
      id, connector_id, name, credential_ref, scopes_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '[]', '{}', ?, ?)`,
  ).run("account-2", "connector-2", "other", "cred://mock", now, now);
}

function seedApproval(
  db: ForgeStore["db"],
  approvalId: string,
  proposal: Awaited<ReturnType<ConnectorGateway["propose"]>>,
  input: ConnectorActionInput,
  overrides: { action?: string; resourceId?: string } = {},
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_approvals (
      id, subject_kind, subject_id, action, resource_kind, resource_id,
      parameters_hash, parameters_summary, risk, policy_version_id, state,
      run_id, step_id, expires_at, created_at, decided_at
    ) VALUES (?, 'human', 'local', ?, 'connector_proposal', ?,
      ?, 'summary', 'low', 'policy-v1', 'approved', ?, ?, ?, ?, ?)`,
  ).run(
    approvalId,
    overrides.action ?? "connector.publish",
    overrides.resourceId ?? proposal.id,
    hashApprovalParameters({
      proposalId: proposal.id,
      connectorId: input.connectorId,
      connectorAccountId: input.connectorAccountId,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      payload: input.payload,
    }),
    input.runId ?? null,
    input.stepId ?? null,
    new Date(Date.now() + 3_600_000).toISOString(),
    now,
    now,
  );
}
