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
import { InMemoryCredentialProvider } from "./credentials.js";
import {
  ConnectorAccountMismatchError,
  ConnectorApprovalError,
  ConnectorGateway,
} from "./gateway.js";
import type { ConnectorActionInput, ConnectorGatewayEvent } from "./types.js";

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
    seedApproval(fx.db, "approval-1", publishInput("post-1").payload);
    const first = await fx.gateway.execute(proposal.id, "approval-1");
    const second = await fx.gateway.execute(proposal.id, "approval-1");
    expect(second.id).toBe(first.id);
    expect(fx.adapter.executeCalls).toBe(1);
  });

  it("executes one external action for concurrent calls with the same proposal", async () => {
    const fx = connectorFixture();
    fx.adapter.executeDelayMs = 50;
    const proposal = await fx.gateway.propose(publishInput("post-concurrent"));
    seedApproval(fx.db, "approval-concurrent", publishInput("post-concurrent").payload);
    await Promise.all([
      fx.gateway.execute(proposal.id, "approval-concurrent"),
      fx.gateway.execute(proposal.id, "approval-concurrent"),
    ]);
    expect(fx.adapter.executeCalls).toBe(1);
  });

  it("rejects an approval issued for a different action hash", async () => {
    const fx = connectorFixture();
    const proposal = await fx.gateway.propose(publishInput("post-forged"));
    seedApproval(fx.db, "approval-forged", { title: "different payload" });
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
    seedApproval(fx.db, "approval-mismatch", publishInput("post-mismatch").payload, {
      resourceId: "connector-1",
    });
    await expect(
      fx.gateway.execute(proposal.id, "approval-mismatch"),
    ).rejects.toThrow(ConnectorAccountMismatchError);
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("never persists resolved secret material", async () => {
    const fx = connectorFixture({ secret: "super-secret" });
    const proposal = await fx.gateway.propose(publishInput("post-2"));
    seedApproval(fx.db, "approval-2", publishInput("post-2").payload);
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
    seedApproval(fx.db, "approval-3", publishInput("post-3").payload);
    await expect(fx.gateway.execute(proposal.id, "approval-3")).rejects.toThrow(
      /\[REDACTED\]/,
    );
    expect(fx.dumpDatabase()).not.toContain("super-secret");
  });

  it("rejects execution when approval action does not match", async () => {
    const fx = connectorFixture();
    const proposal = await fx.gateway.propose(publishInput("post-4"));
    seedApproval(fx.db, "approval-4", publishInput("post-4").payload, {
      action: "connector.delete",
    });
    await expect(fx.gateway.execute(proposal.id, "approval-4")).rejects.toThrow(
      ConnectorApprovalError,
    );
  });

  it("reserves and commits budget for successful connector actions", async () => {
    const fx = connectorFixture({ withBudget: true });
    const proposal = await fx.gateway.propose(publishInput("post-budget"));
    seedApproval(fx.db, "approval-budget", publishInput("post-budget").payload);
    await fx.gateway.execute(proposal.id, "approval-budget");
    expect(fx.ledger!.balance("budget-1")).toMatchObject({
      committedMinor: 100n,
      reservedMinor: 0n,
    });
  });
});

function connectorFixture(options: {
  secret?: string;
  withBudget?: boolean;
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
      hardLimitMinor: 1000n,
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
    credentials: new InMemoryCredentialProvider({
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
  payload: Record<string, unknown>,
  overrides: { action?: string; resourceId?: string } = {},
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_approvals (
      id, subject_kind, subject_id, action, resource_kind, resource_id,
      parameters_hash, parameters_summary, risk, policy_version_id, state,
      expires_at, created_at, decided_at
    ) VALUES (?, 'human', 'local', ?, 'connector', ?,
      ?, 'summary', 'low', 'policy-v1', 'approved', ?, ?, ?)`,
  ).run(
    approvalId,
    overrides.action ?? "connector.publish",
    overrides.resourceId ?? "connector-1",
    hashApprovalParameters(payload),
    new Date(Date.now() + 3_600_000).toISOString(),
    now,
    now,
  );
}
