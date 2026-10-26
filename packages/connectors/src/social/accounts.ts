import { randomUUID } from "node:crypto";
import type { SubjectRef } from "@forge/protocol";
import type { Database } from "@forge/store";
import type { ConnectorRouteView } from "./types.js";

export interface ConnectPublishAccountInput {
  connectorId: string;
  connectorName: string;
  adapterKind: string;
  accountId: string;
  accountName: string;
  credentialRef: string;
  subject: SubjectRef;
}

export function connectPublishAccount(db: Database, input: ConnectPublishAccountInput): void {
  const now = new Date().toISOString();
  const policy = db
    .prepare(
      `SELECT id FROM core_policy_versions WHERE is_active = 1 ORDER BY version DESC LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (!policy) throw new Error("no active policy");
  db.prepare(
    `INSERT INTO core_subjects (kind, subject_id, metadata_json, created_at, updated_at)
     VALUES (?, ?, '{}', ?, ?)
     ON CONFLICT (kind, subject_id) DO NOTHING`,
  ).run(input.subject.kind, input.subject.id, now, now);
  db.prepare(
    `INSERT INTO core_connectors (
      id, name, adapter_kind, capabilities_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '{}', ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      adapter_kind = excluded.adapter_kind,
      capabilities_json = excluded.capabilities_json,
      updated_at = excluded.updated_at`,
  ).run(
    input.connectorId,
    input.connectorName,
    input.adapterKind,
    JSON.stringify(["publish"]),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO core_connector_accounts (
      id, connector_id, name, credential_ref, scopes_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '[]', ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      connector_id = excluded.connector_id,
      name = excluded.name,
      credential_ref = excluded.credential_ref,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at`,
  ).run(
    input.accountId,
    input.connectorId,
    input.accountName,
    input.credentialRef,
    JSON.stringify({ health: "connected" }),
    now,
    now,
  );
  const scope = JSON.stringify({ resourceIds: [input.connectorId] });
  const existing = db
    .prepare(
      `SELECT id FROM core_grants
       WHERE subject_kind = ? AND subject_id = ? AND action = 'connector.publish'
         AND resource_kind = 'connector' AND resource_scope_json = ?`,
    )
    .get(input.subject.kind, input.subject.id, scope) as { id: string } | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO core_grants (
        id, subject_kind, subject_id, policy_version_id, action, resource_kind,
        resource_scope_json, effect, created_at
      ) VALUES (?, ?, ?, ?, 'connector.publish', 'connector', ?, 'allow', ?)`,
    ).run(randomUUID(), input.subject.kind, input.subject.id, policy.id, scope, now);
  }
}

export function markAccountNeedsAuth(db: Database, accountId: string): void {
  const row = db
    .prepare(`SELECT metadata_json FROM core_connector_accounts WHERE id = ?`)
    .get(accountId) as { metadata_json: string } | undefined;
  if (!row) return;
  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  metadata.health = "needs_auth";
  db.prepare(
    `UPDATE core_connector_accounts SET metadata_json = ?, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(metadata), new Date().toISOString(), accountId);
}

export function loadPublishView(
  db: Database,
  connectorId: string,
  accountId: string,
): ConnectorRouteView {
  const connector = db
    .prepare(`SELECT capabilities_json FROM core_connectors WHERE id = ?`)
    .get(connectorId) as { capabilities_json: string } | undefined;
  const account = db
    .prepare(`SELECT id, connector_id, metadata_json FROM core_connector_accounts WHERE id = ?`)
    .get(accountId) as { id: string; connector_id: string; metadata_json: string } | undefined;
  let capabilities: string[] = [];
  if (connector) {
    try {
      const parsed = JSON.parse(connector.capabilities_json) as unknown;
      capabilities = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      capabilities = [];
    }
  }
  let health = "needs_auth";
  if (account) {
    try {
      health = String((JSON.parse(account.metadata_json) as { health?: string }).health ?? "needs_auth");
    } catch {
      health = "needs_auth";
    }
  }
  return {
    connectorFound: Boolean(connector),
    capabilities,
    account: account ? { id: account.id, connectorId: account.connector_id, health } : null,
  };
}

export function listPublishAccounts(db: Database, subject: SubjectRef) {
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.name, a.metadata_json AS account_metadata,
              c.id AS connector_id, c.capabilities_json
       FROM core_connector_accounts a
       JOIN core_connectors c ON c.id = a.connector_id`,
    )
    .all() as Array<{
    account_id: string;
    name: string;
    account_metadata: string;
    connector_id: string;
    capabilities_json: string;
  }>;
  return rows.flatMap((row) => {
    let capabilities: string[] = [];
    let health = "";
    try {
      const parsed = JSON.parse(row.capabilities_json) as unknown;
      capabilities = Array.isArray(parsed) ? parsed.map(String) : [];
      health = String((JSON.parse(row.account_metadata) as { health?: string }).health ?? "");
    } catch {
      return [];
    }
    if (!capabilities.includes("publish") || health !== "connected") return [];
    const scope = JSON.stringify({ resourceIds: [row.connector_id] });
    const grant = db
      .prepare(
        `SELECT id FROM core_grants
         WHERE subject_kind = ? AND subject_id = ? AND action = 'connector.publish'
           AND resource_kind = 'connector' AND resource_scope_json = ? AND effect = 'allow'`,
      )
      .get(subject.kind, subject.id, scope);
    if (!grant) return [];
    return [{ connectorId: row.connector_id, accountId: row.account_id, name: row.name }];
  });
}
