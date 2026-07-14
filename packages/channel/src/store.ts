import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  ChannelAdapterDraft,
  ChannelAdapterRecord,
  ChannelBindingRecord,
  ChannelKind,
} from "@forge/protocol";

export interface CreateChannelInput {
  kind: ChannelKind;
  name: string;
  description?: string;
  cwd: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export type UpdateChannelPatch = Partial<CreateChannelInput> & {
  enabled?: boolean;
  lastError?: string | null;
  lastMessageAt?: string | null;
};

interface ChannelAdapterRow {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  enabled: number;
  cwd: string;
  config_json: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  last_message_at: string | null;
}

interface ChannelBindingRow {
  channel_id?: string | null;
  channel: string;
  thread_key: string;
  session_id: string;
  cwd: string;
  peer_user_id: string | null;
  peer_chat_id: string | null;
  last_context_token?: string | null;
  updated_at: string;
}

function parseConfig(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToRecord(row: ChannelAdapterRow): ChannelAdapterRecord {
  return {
    id: row.id,
    kind: row.kind as ChannelKind,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    cwd: row.cwd,
    config: parseConfig(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error ?? undefined,
    lastMessageAt: row.last_message_at ?? undefined,
  };
}

function rowToBinding(row: ChannelBindingRow): ChannelBindingRecord {
  return {
    channelId: row.channel_id ?? undefined,
    channel: row.channel as ChannelKind,
    threadKey: row.thread_key,
    sessionId: row.session_id,
    cwd: row.cwd,
    peerUserId: row.peer_user_id ?? undefined,
    peerChatId: row.peer_chat_id ?? undefined,
    lastContextToken: row.last_context_token ?? undefined,
    updatedAt: row.updated_at,
  } as ChannelBindingRecord;
}

export class ChannelStore {
  constructor(private readonly db: Database.Database) {
    this.ensureBindingSchema();
  }

  private ensureBindingSchema(): void {
    const rows = this.db.prepare("PRAGMA table_info(channel_bindings)").all() as Array<{
      name: string;
    }>;
    const names = new Set(rows.map((r) => r.name));
    const tableSql = (this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_bindings'")
      .get() as { sql?: string } | undefined)?.sql;
    const needsPkMigration =
      !names.has("channel_id") ||
      /PRIMARY KEY\s*\(\s*channel\s*,\s*thread_key\s*\)/i.test(tableSql || "");
    if (needsPkMigration) {
      const legacyRows = this.db.prepare("SELECT * FROM channel_bindings").all() as ChannelBindingRow[];
      const resolveChannelId = this.db.prepare(
        `SELECT id FROM channel_adapters
         WHERE kind = ? AND cwd = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      );
      const tx = this.db.transaction(() => {
        this.db.exec("ALTER TABLE channel_bindings RENAME TO channel_bindings_legacy");
        this.db.exec(`CREATE TABLE channel_bindings (
          channel_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          thread_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          peer_user_id TEXT,
          peer_chat_id TEXT,
          last_context_token TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (channel_id, thread_key)
        )`);
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS idx_channel_bindings_session ON channel_bindings(session_id)",
        );
        const insert = this.db.prepare(
          `INSERT INTO channel_bindings
           (channel_id, channel, thread_key, session_id, cwd, peer_user_id, peer_chat_id, last_context_token, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of legacyRows) {
          const channelId =
            row.channel_id ??
            (resolveChannelId.get(row.channel, row.cwd) as { id?: string } | undefined)?.id;
          if (!channelId) continue;
          insert.run(
            channelId,
            row.channel,
            row.thread_key,
            row.session_id,
            row.cwd,
            row.peer_user_id ?? null,
            row.peer_chat_id ?? null,
            row.last_context_token ?? null,
            row.updated_at,
          );
        }
        this.db.exec("DROP TABLE channel_bindings_legacy");
      });
      tx();
      return;
    }
    if (!names.has("last_context_token")) {
      this.db.exec("ALTER TABLE channel_bindings ADD COLUMN last_context_token TEXT");
    }
  }

  list(opts?: { cwd?: string; enabledOnly?: boolean }): ChannelAdapterRecord[] {
    let sql = "SELECT * FROM channel_adapters";
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.cwd) {
      clauses.push("cwd = ?");
      params.push(opts.cwd);
    }
    if (opts?.enabledOnly) {
      clauses.push("enabled = 1");
    }
    if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY updated_at DESC";
    const rows = this.db.prepare(sql).all(...params) as ChannelAdapterRow[];
    return rows.map(rowToRecord);
  }

  get(id: string): ChannelAdapterRecord | null {
    const row = this.db
      .prepare("SELECT * FROM channel_adapters WHERE id = ?")
      .get(id) as ChannelAdapterRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  create(input: CreateChannelInput): ChannelAdapterRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const record: ChannelAdapterRecord = {
      id,
      kind: input.kind,
      name: input.name,
      description: input.description,
      enabled: input.enabled ?? false,
      cwd: input.cwd,
      config: input.config ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO channel_adapters
         (id, kind, name, description, enabled, cwd, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.kind,
        record.name,
        record.description ?? null,
        record.enabled ? 1 : 0,
        record.cwd,
        JSON.stringify(record.config),
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  createFromDraft(draft: ChannelAdapterDraft, cwd: string): ChannelAdapterRecord {
    return this.create({
      kind: draft.kind,
      name: draft.name,
      description: draft.description,
      cwd,
      enabled: draft.enabled,
      config: draft.config,
    });
  }

  update(id: string, patch: UpdateChannelPatch): ChannelAdapterRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const next: ChannelAdapterRecord = {
      ...existing,
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      enabled: patch.enabled ?? existing.enabled,
      cwd: patch.cwd ?? existing.cwd,
      config: patch.config ? { ...existing.config, ...patch.config } : existing.config,
      updatedAt: now,
      lastError:
        patch.lastError === null
          ? undefined
          : patch.lastError ?? existing.lastError,
      lastMessageAt:
        patch.lastMessageAt === null
          ? undefined
          : patch.lastMessageAt ?? existing.lastMessageAt,
    };
    this.db
      .prepare(
        `UPDATE channel_adapters SET
          name = ?, description = ?, enabled = ?, cwd = ?, config_json = ?,
          updated_at = ?, last_error = ?, last_message_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.description ?? null,
        next.enabled ? 1 : 0,
        next.cwd,
        JSON.stringify(next.config),
        next.updatedAt,
        next.lastError ?? null,
        next.lastMessageAt ?? null,
        id,
      );
    return next;
  }

  delete(id: string): boolean {
    const r = this.db.prepare("DELETE FROM channel_adapters WHERE id = ?").run(id);
    return r.changes > 0;
  }

  getBinding(channelId: string, threadKey: string): ChannelBindingRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM channel_bindings WHERE channel_id = ? AND thread_key = ?",
      )
      .get(channelId, threadKey) as ChannelBindingRow | undefined;
    return row ? rowToBinding(row) : null;
  }

  upsertBinding(input: {
    channelId: string;
    channel: ChannelKind;
    threadKey: string;
    sessionId: string;
    cwd: string;
    peerUserId?: string;
    peerChatId?: string;
    lastContextToken?: string;
  }): ChannelBindingRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_bindings
         (channel_id, channel, thread_key, session_id, cwd, peer_user_id, peer_chat_id, last_context_token, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, thread_key) DO UPDATE SET
           channel = excluded.channel,
           session_id = excluded.session_id,
           cwd = excluded.cwd,
           peer_user_id = excluded.peer_user_id,
           peer_chat_id = excluded.peer_chat_id,
           last_context_token = COALESCE(excluded.last_context_token, channel_bindings.last_context_token),
           updated_at = excluded.updated_at`,
      )
      .run(
        input.channelId,
        input.channel,
        input.threadKey,
        input.sessionId,
        input.cwd,
        input.peerUserId ?? null,
        input.peerChatId ?? null,
        input.lastContextToken ?? null,
        now,
      );
    return {
      channelId: input.channelId,
      channel: input.channel,
      threadKey: input.threadKey,
      sessionId: input.sessionId,
      cwd: input.cwd,
      peerUserId: input.peerUserId,
      peerChatId: input.peerChatId,
      lastContextToken: input.lastContextToken,
      updatedAt: now,
    } as ChannelBindingRecord;
  }

  findLatestBinding(opts: {
    channel: ChannelKind;
    channelId?: string;
    cwd?: string;
    threadKey?: string;
  }): ChannelBindingRecord | null {
    const clauses = ["channel = ?"];
    const params: unknown[] = [opts.channel];
    if (opts.channelId) {
      clauses.push("channel_id = ?");
      params.push(opts.channelId);
    }
    if (opts.cwd) {
      clauses.push("cwd = ?");
      params.push(opts.cwd);
    }
    if (opts.threadKey) {
      clauses.push("thread_key = ?");
      params.push(opts.threadKey);
    }
    const row = this.db
      .prepare(
        `SELECT * FROM channel_bindings
         WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(...params) as ChannelBindingRow | undefined;
    return row ? rowToBinding(row) : null;
  }

  deleteBinding(channelId: string, threadKey: string): void {
    this.db
      .prepare("DELETE FROM channel_bindings WHERE channel_id = ? AND thread_key = ?")
      .run(channelId, threadKey);
  }
}
