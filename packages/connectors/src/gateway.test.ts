import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService, PolicyEngine } from "@forge/policy";
import { ForgeStore } from "@forge/store";
import { MockConnectorAdapter } from "./adapters/mock.js";
import { InMemoryCredentialProvider } from "./credentials.js";
import { ConnectorGateway } from "./gateway.js";
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
    seedApproval(fx.db, "approval-1");
    const first = await fx.gateway.execute(proposal.id, "approval-1");
    const second = await fx.gateway.execute(proposal.id, "approval-1");
    expect(second.id).toBe(first.id);
    expect(fx.adapter.executeCalls).toBe(1);
  });

  it("never persists resolved secret material", async () => {
    const fx = connectorFixture({ secret: "super-secret" });
    const proposal = await fx.gateway.propose(publishInput("post-2"));
    seedApproval(fx.db, "approval-2");
    await fx.gateway.execute(proposal.id, "approval-2");
    expect(fx.dumpDatabase()).not.toContain("super-secret");
    expect(JSON.stringify(fx.events())).not.toContain("super-secret");
  });
});

function connectorFixture(options: { secret?: string } = {}) {
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
  const gateway = new ConnectorGateway({
    db: forgeStore.db,
    policy: PolicyEngine.fromDatabase(forgeStore.db),
    approvals: new ApprovalService(forgeStore.db),
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

function seedApproval(db: ForgeStore["db"], approvalId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_approvals (
      id, subject_kind, subject_id, action, resource_kind, resource_id,
      parameters_hash, parameters_summary, risk, policy_version_id, state,
      expires_at, created_at, decided_at
    ) VALUES (?, 'human', 'local', 'connector.publish', 'connector', 'connector-1',
      'hash', 'summary', 'low', 'policy-v1', 'approved', ?, ?, ?)`,
  ).run(approvalId, new Date(Date.now() + 3_600_000).toISOString(), now, now);
}
