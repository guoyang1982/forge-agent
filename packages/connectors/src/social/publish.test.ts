import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService, PolicyEngine } from "@forge/policy";
import { ForgeStore } from "@forge/store";
import { MockConnectorAdapter } from "../adapters/mock.js";
import { InMemoryCredentialProvider } from "../credentials.js";
import { ConnectorGateway } from "../gateway.js";
import {
  connectPublishAccount,
  listPublishAccounts,
  markAccountNeedsAuth,
  type ConnectPublishAccountInput,
} from "./accounts.js";
import { SocialPublishService } from "./publish.js";
import type { PublishRequest } from "./types.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const roots: string[] = [];
const stores: ForgeStore[] = [];
const subject = { kind: "human", id: "local" };
const payload = { note: "x".repeat(500), images: [] as string[] };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-publish-"));
  roots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
       VALUES ('policy-v1', 'default', 1, '{"rules":[]}', 1, ?)`,
    )
    .run(now);
  const credentials = new InMemoryCredentialProvider();
  credentials.put("cred://fixture", "secret");
  credentials.put("cred://other", "secret");
  const adapter = new MockConnectorAdapter();
  const seen: Record<string, unknown>[] = [];
  adapter.executeImpl = async (input) => {
    seen.push(input.payload);
    return {
      ok: true,
      externalId: "ext-1",
      url: "https://example.test/notes/1",
      summary: "published",
    };
  };
  const approvals = new ApprovalService(store.db);
  const gateway = new ConnectorGateway({
    db: store.db,
    policy: { authorize: (input) => PolicyEngine.fromDatabase(store.db).authorize(input) },
    approvals,
    credentials,
    adapters: new Map([["mock", adapter]]),
  });
  const service = new SocialPublishService(store.db, gateway, approvals);
  const base: ConnectPublishAccountInput = {
    connectorId: "connector-1",
    connectorName: "Fixture",
    adapterKind: "mock",
    accountId: "account-1",
    accountName: "default",
    credentialRef: "cred://fixture",
    subject,
  };
  connectPublishAccount(store.db, base);
  const request = (overrides: Partial<PublishRequest> = {}): PublishRequest => ({
    connectorId: "connector-1",
    connectorAccountId: "account-1",
    idempotencyKey: "key-1",
    payload,
    ...overrides,
  });
  return { store, adapter, service, request, base, seen };
}

function countActions(store: ForgeStore): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM core_connector_actions`).get() as { n: number }).n;
}

describe("SocialPublishService", () => {
  it("publishes an opaque payload without inspecting it", async () => {
    const fx = fixture();
    const published = await fx.service.publish(fx.request(), subject);
    expect(published).toMatchObject({
      status: "succeeded",
      externalId: "ext-1",
      url: "https://example.test/notes/1",
    });
    expect(fx.seen).toEqual([payload]);
  });

  it("returns capability_unavailable when publish is not declared", async () => {
    const fx = fixture();
    fx.store.db.prepare(`UPDATE core_connectors SET capabilities_json = '[]' WHERE id = ?`).run("connector-1");
    expect((await fx.service.publish(fx.request(), subject)).status).toBe("capability_unavailable");
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("returns needs_auth without proposing", async () => {
    const fx = fixture();
    markAccountNeedsAuth(fx.store.db, "account-1");
    expect((await fx.service.publish(fx.request(), subject)).status).toBe("needs_auth");
    expect(countActions(fx.store)).toBe(0);
  });

  it("returns account_not_found when the account belongs to another connector", async () => {
    const fx = fixture();
    connectPublishAccount(fx.store.db, {
      ...fx.base,
      connectorId: "connector-2",
      accountId: "account-2",
      credentialRef: "cred://other",
    });
    const published = await fx.service.publish(
      fx.request({ connectorId: "connector-1", connectorAccountId: "account-2" }),
      subject,
    );
    expect(published.status).toBe("account_not_found");
    expect(countActions(fx.store)).toBe(0);
  });

  it("returns invalid_request for a blank idempotency key", async () => {
    const fx = fixture();
    expect((await fx.service.publish(fx.request({ idempotencyKey: " " }), subject)).reason).toBe(
      "empty_idempotency_key",
    );
    expect(countActions(fx.store)).toBe(0);
  });

  it("returns denied when the grant is removed", async () => {
    const fx = fixture();
    fx.store.db.prepare(`DELETE FROM core_grants`).run();
    expect((await fx.service.publish(fx.request(), subject)).status).toBe("denied");
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("stops on require_approval without executing", async () => {
    const fx = fixture();
    fx.store.db.prepare(`UPDATE core_grants SET effect = 'require_approval'`).run();
    const published = await fx.service.publish(fx.request(), subject);
    expect(published.status).toBe("require_approval");
    expect(published.proposalId).toBeTruthy();
    expect(fx.adapter.executeCalls).toBe(0);
  });

  it("publishes once for a repeated idempotency key", async () => {
    const fx = fixture();
    const first = await fx.service.publish(fx.request(), subject);
    const second = await fx.service.publish(fx.request(), subject);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(fx.adapter.executeCalls).toBe(1);
  });

  it("keeps an unknown outcome without submitting again", async () => {
    const fx = fixture();
    fx.adapter.executeImpl = async () => {
      throw new Error("socket closed");
    };
    const first = await fx.service.publish(fx.request(), subject);
    const second = await fx.service.publish(fx.request(), subject);
    expect(first.status).toBe("unknown");
    expect(second.status).toBe("unknown");
    expect(fx.adapter.executeCalls).toBe(1);
  });

  it("records needs_auth when the adapter reports auth failure", async () => {
    const fx = fixture();
    fx.adapter.executeImpl = async () => {
      markAccountNeedsAuth(fx.store.db, "account-1");
      return { ok: false, error: "auth" };
    };
    const published = await fx.service.publish(fx.request(), subject);
    expect(published.status).toBe("failed");
    const row = fx.store.db
      .prepare(`SELECT metadata_json FROM core_connector_accounts WHERE id = ?`)
      .get("account-1") as { metadata_json: string };
    expect(JSON.parse(row.metadata_json).health).toBe("needs_auth");
  });

  it("keeps account results independent", async () => {
    const fx = fixture();
    connectPublishAccount(fx.store.db, {
      ...fx.base,
      connectorId: "connector-2",
      accountId: "account-2",
      credentialRef: "cred://other",
    });
    fx.adapter.executeImpl = async (input) => {
      if (input.connectorAccountId === "account-2") return { ok: false, error: "nope" };
      return { ok: true, externalId: "ext-1", url: "https://example.test/notes/1", summary: "published" };
    };
    const ok = await fx.service.publish(fx.request(), subject);
    const bad = await fx.service.publish(
      fx.request({
        connectorId: "connector-2",
        connectorAccountId: "account-2",
        idempotencyKey: "key-2",
      }),
      subject,
    );
    expect(ok.status).toBe("succeeded");
    expect(bad.status).toBe("failed");
  });

  it("lists only connected publish accounts for the subject", () => {
    const fx = fixture();
    connectPublishAccount(fx.store.db, {
      ...fx.base,
      connectorId: "connector-2",
      accountId: "account-2",
      credentialRef: "cred://other",
    });
    markAccountNeedsAuth(fx.store.db, "account-2");
    const accounts = listPublishAccounts(fx.store.db, subject);
    expect(accounts).toEqual([{ connectorId: "connector-1", accountId: "account-1", name: "default" }]);
    expect(JSON.stringify(accounts)).not.toContain("cred://");
  });
});
