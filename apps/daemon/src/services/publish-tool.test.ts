import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectPublishAccount, type PublishRequest, type PublishResult } from "@forge/connectors";
import { ForgeStore } from "@forge/store";
import { createBuiltinRegistry, type ToolContext } from "@forge/tools";
import { attachPublishTool } from "./publish-tool.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const roots: string[] = [];
const stores: ForgeStore[] = [];
const subject = { kind: "human", id: "local" };
const ctx = {} as ToolContext;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openStore(): ForgeStore {
  const root = mkdtempSync(join(tmpdir(), "forge-publish-tool-"));
  roots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);
  return store;
}

describe("attachPublishTool", () => {
  it("does nothing until a publish runtime is attached", async () => {
    const registry = createBuiltinRegistry();
    attachPublishTool(registry, {});
    const result = await registry.execute(
      { id: "1", name: "connector.publish", arguments: {} },
      ctx,
    );
    expect(result).toContain("Unknown tool");
  });

  it("forwards the payload and lists only the connected account", async () => {
    const store = openStore();
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
         VALUES ('policy-v1', 'default', 1, '{"rules":[]}', 1, ?)`,
      )
      .run(now);
    connectPublishAccount(store.db, {
      connectorId: "connector-1",
      connectorName: "Fixture",
      adapterKind: "mock",
      accountId: "account-1",
      accountName: "default",
      credentialRef: "cred://fixture",
      subject,
    });
    const seen: PublishRequest[] = [];
    const registry = createBuiltinRegistry();
    attachPublishTool(registry, {
      publish: {
        db: store.db,
        subject,
        service: {
          async publish(request: PublishRequest): Promise<PublishResult> {
            seen.push(request);
            return {
              connectorId: request.connectorId,
              connectorAccountId: request.connectorAccountId,
              status: "succeeded",
              url: "https://example.test/notes/1",
            };
          },
        } as never,
      },
    });

    const payload = { note: "hello", images: [] };
    const published = JSON.parse(
      await registry.execute(
        {
          id: "2",
          name: "connector.publish",
          arguments: {
            connectorId: "connector-1",
            connectorAccountId: "account-1",
            idempotencyKey: "key-1",
            payload,
          },
        },
        ctx,
      ),
    );
    expect(published.ok).toBe(true);
    expect(seen[0]?.payload).toEqual(payload);

    const rejected = JSON.parse(
      await registry.execute(
        {
          id: "3",
          name: "connector.publish",
          arguments: {
            connectorId: "connector-1",
            connectorAccountId: "account-1",
            idempotencyKey: "key-2",
            payload: "text",
          },
        },
        ctx,
      ),
    );
    expect(rejected).toMatchObject({ ok: false, status: "invalid_request" });
    expect(seen).toHaveLength(1);

    const listed = JSON.parse(
      await registry.execute(
        { id: "4", name: "connector.list_publish_accounts", arguments: {} },
        ctx,
      ),
    );
    expect(listed).toEqual({
      ok: true,
      accounts: [{ connectorId: "connector-1", accountId: "account-1", name: "default" }],
    });
    expect(JSON.stringify(listed)).not.toContain("cred://");
  });
});
