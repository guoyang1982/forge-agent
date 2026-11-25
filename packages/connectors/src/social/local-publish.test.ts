import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { InMemoryCredentialProvider } from "../credentials.js";
import { listPublishAccounts } from "./accounts.js";
import { connectLocalPublishAccount, LOCAL_PUBLISH_ACCOUNT } from "./local-publish.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const roots: string[] = [];
const stores: ForgeStore[] = [];
const subject = { kind: "human", id: "local" };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("connectLocalPublishAccount", () => {
  it("connects one local account without returning the credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-local-publish-"));
    roots.push(root);
    const store = ForgeStore.open({
      dbPath: join(root, "data.db"),
      migrationsDir,
      owner: "test",
    });
    stores.push(store);
    store.db
      .prepare(
        `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
         VALUES ('policy-v1', 'default', 1, '{"rules":[]}', 1, ?)`,
      )
      .run(new Date().toISOString());
    const credentials = new InMemoryCredentialProvider();
    const first = connectLocalPublishAccount(store.db, credentials, subject);
    const second = connectLocalPublishAccount(store.db, credentials, subject);
    expect(first).toEqual({
      connectorId: LOCAL_PUBLISH_ACCOUNT.connectorId,
      accountId: LOCAL_PUBLISH_ACCOUNT.accountId,
      name: LOCAL_PUBLISH_ACCOUNT.accountName,
    });
    expect(second).toEqual(first);
    expect(listPublishAccounts(store.db, subject)).toEqual([first]);
    expect(JSON.stringify(first)).not.toContain("cred://");
    const resolved = await credentials.resolve(LOCAL_PUBLISH_ACCOUNT.credentialRef);
    expect(new TextDecoder().decode(resolved.bytes)).toBe("local-publish");
    const grants = store.db.prepare(`SELECT COUNT(*) AS n FROM core_grants`).get() as { n: number };
    expect(grants.n).toBe(1);
  });
});
