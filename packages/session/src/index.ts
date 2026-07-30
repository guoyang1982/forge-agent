import Database from "better-sqlite3";
export type { Database } from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, ChatMessage, SessionEventRecord } from "@forge/protocol";
import { plainTextFromChatContent } from "@forge/protocol";
import { applyTokenBudget, type LoadHistoryResult } from "./tokens.js";

export { estimateMessageTokens, type LoadHistoryResult } from "./tokens.js";

export interface SessionSummary {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastPreview: string;
}

export interface SessionSearchHit {
  sessionId: string;
  cwd: string;
  updatedAt: string;
  matchCount: number;
  snippet: string;
}

export interface CompactSessionResult {
  keptMessages: number;
  summarizedMessages: number;
  summaryPreview?: string;
}

/** Persisted dispatch_plan payload (matches AgentEvent dispatch_plan minus type/sessionId). */
export interface SessionDispatchPlanRecord {
  turnIndex: number;
  intent: string;
  source: "heuristic" | "model";
  runKind: "coordinator" | "talent_foreground" | "talent_dispatch";
  waves: Array<{
    index: number;
    steps: Array<{
      id: string;
      kind: "talent_background" | "talent_foreground" | "coordinator" | "verify";
      mention?: string;
      displayName?: string;
      role?: string;
      task: string;
      status: "pending" | "in_progress" | "done";
    }>;
  }>;
}

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath: string, migrationsDir: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.runMigrations(migrationsDir);
  }

  private runMigrations(migrationsDir: string): void {
    if (!existsSync(migrationsDir)) return;
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      const sql = readFileSync(join(migrationsDir, f), "utf-8").trim();
      if (sql) this.db.exec(sql);
    }
  }

  createSession(cwd: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id, cwd, created_at) VALUES (?, ?, ?)",
      )
      .run(id, cwd, now);
    return id;
  }

  getSessionCwd(sessionId: string): string | null {
    const row = this.db
      .prepare("SELECT cwd FROM sessions WHERE id = ?")
      .get(sessionId) as { cwd: string } | undefined;
    return row?.cwd ?? null;
  }

  listSessions(limit = 20): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
          s.id,
          s.cwd,
          s.created_at AS createdAt,
          COALESCE(MAX(m.created_at), s.created_at) AS updatedAt,
          COUNT(m.id) AS messageCount
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY updatedAt DESC
        LIMIT ?`,
      )
      .all(limit) as Array<Omit<SessionSummary, "lastPreview">>;

    return rows.map((row) => ({
      ...row,
      lastPreview: this.getLastPreview(row.id),
    }));
  }

  /** Full-text-ish search over stored user/assistant messages (LIKE on JSON). */
  searchSessions(query: string, limit = 20): SessionSearchHit[] {
    const q = String(query || "").trim();
    if (!q) return [];
    const like = `%${q.replace(/([%_\\])/g, "\\$1")}%`;
    const rows = this.db
      .prepare(
        `SELECT m.session_id AS sessionId,
                s.cwd AS cwd,
                MAX(m.created_at) AS updatedAt,
                COUNT(m.id) AS matchCount
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.role IN ('user','assistant') AND m.content LIKE ? ESCAPE '\\'
         GROUP BY m.session_id
         ORDER BY updatedAt DESC
         LIMIT ?`,
      )
      .all(like, limit) as Array<Omit<SessionSearchHit, "snippet">>;
    return rows.map((row) => ({
      ...row,
      snippet: this.searchSnippet(row.sessionId, q, like),
    }));
  }

  private searchSnippet(sessionId: string, q: string, like: string): string {
    const row = this.db
      .prepare(
        `SELECT content FROM messages
         WHERE session_id = ? AND role IN ('user','assistant') AND content LIKE ? ESCAPE '\\'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId, like) as { content: string } | undefined;
    if (!row) return "";
    let text = row.content;
    try {
      const msg = JSON.parse(row.content) as ChatMessage;
      const c = msg.content as unknown;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        text = c
          .map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text?: unknown }).text ?? "") : ""))
          .join(" ");
      }
    } catch {
      /* raw JSON fallback */
    }
    const flat = text.replace(/\s+/g, " ").trim();
    const idx = flat.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return flat.slice(0, 80);
    const start = Math.max(0, idx - 30);
    return `${start > 0 ? "…" : ""}${flat.slice(start, idx + q.length + 50)}`;
  }

  /** Anchor a pre-run worktree snapshot to the upcoming turn; returns its ordinal. */
  recordCheckpoint(sessionId: string, sha: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = 'user'`,
      )
      .get(sessionId) as { c: number };
    this.db
      .prepare(
        `INSERT INTO workspace_checkpoints (session_id, turn_index, sha, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, row.c, sha, new Date().toISOString());
    return row.c;
  }

  listCheckpoints(sessionId: string): Array<{ turnIndex: number; sha: string }> {
    return this.db
      .prepare(
        `SELECT turn_index AS turnIndex, sha FROM workspace_checkpoints
         WHERE session_id = ? ORDER BY id ASC`,
      )
      .all(sessionId) as Array<{ turnIndex: number; sha: string }>;
  }

  countUserMessages(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = 'user'`,
      )
      .get(sessionId) as { c: number };
    return row.c;
  }

  upsertDispatchPlan(
    sessionId: string,
    turnIndex: number,
    payload: Omit<SessionDispatchPlanRecord, "turnIndex">,
  ): void {
    this.db
      .prepare(
        `INSERT INTO session_dispatch_plans (session_id, turn_index, payload, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, turn_index) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      )
      .run(
        sessionId,
        turnIndex,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }

  listDispatchPlans(sessionId: string): SessionDispatchPlanRecord[] {
    const rows = this.db
      .prepare(
        `SELECT turn_index AS turnIndex, payload FROM session_dispatch_plans
         WHERE session_id = ? ORDER BY turn_index ASC`,
      )
      .all(sessionId) as Array<{ turnIndex: number; payload: string }>;
    return rows.map((row) => {
      const parsed = JSON.parse(row.payload) as Omit<
        SessionDispatchPlanRecord,
        "turnIndex"
      >;
      return { turnIndex: row.turnIndex, ...parsed };
    });
  }

  /** Delete the turnIndex-th user message (0-based) and everything after it. */
  truncateAfterTurn(sessionId: string, turnIndex: number): { removed: number } {
    const cutoff = this.db
      .prepare(
        `SELECT id FROM messages WHERE session_id = ? AND role = 'user'
         ORDER BY id ASC LIMIT 1 OFFSET ?`,
      )
      .get(sessionId, turnIndex) as { id: number } | undefined;
    if (!cutoff) return { removed: 0 };
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(`DELETE FROM messages WHERE session_id = ? AND id >= ?`)
        .run(sessionId, cutoff.id);
      this.db
        .prepare(
          `DELETE FROM workspace_checkpoints WHERE session_id = ? AND turn_index >= ?`,
        )
        .run(sessionId, turnIndex);
      this.db
        .prepare(
          `DELETE FROM session_dispatch_plans WHERE session_id = ? AND turn_index >= ?`,
        )
        .run(sessionId, turnIndex);
      this.db
        .prepare(`DELETE FROM session_events WHERE session_id = ? AND turn_index >= ?`)
        .run(sessionId, turnIndex);
      return info.changes;
    });
    return { removed: tx() as number };
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, message.role, JSON.stringify(message), now);
  }

  appendEvent(
    sessionId: string,
    turnIndex: number | null,
    event: AgentEvent,
    emittedAtMs = Date.now(),
  ): number {
    const itemId =
      "callId" in event && typeof event.callId === "string" ? event.callId : null;
    const result = this.db
      .prepare(
        `INSERT INTO session_events
          (session_id, turn_index, event_type, item_id, payload, emitted_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        turnIndex,
        event.type,
        itemId,
        JSON.stringify(event),
        emittedAtMs,
      );
    return Number(result.lastInsertRowid);
  }

  listEvents(sessionId: string, limit = 10_000): SessionEventRecord[] {
    return this.readEvents(
      `SELECT id AS sequence, session_id AS sessionId, turn_index AS turnIndex,
              event_type AS eventType, item_id AS itemId, payload,
              emitted_at_ms AS emittedAtMs
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`,
      [sessionId, limit],
    );
  }

  /** Most recent events in chronological order (oldest → newest within the window). */
  listRecentEvents(sessionId: string, limit: number): SessionEventRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.readEvents(
      `SELECT id AS sequence, session_id AS sessionId, turn_index AS turnIndex,
              event_type AS eventType, item_id AS itemId, payload,
              emitted_at_ms AS emittedAtMs
       FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      [sessionId, safeLimit],
    );
    rows.reverse();
    return rows;
  }

  /** Events with id < beforeSequence, chronological within the window. */
  listEventsBefore(
    sessionId: string,
    beforeSequence: number,
    limit: number,
  ): SessionEventRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.readEvents(
      `SELECT id AS sequence, session_id AS sessionId, turn_index AS turnIndex,
              event_type AS eventType, item_id AS itemId, payload,
              emitted_at_ms AS emittedAtMs
       FROM session_events WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      [sessionId, beforeSequence, safeLimit],
    );
    rows.reverse();
    return rows;
  }

  hasEventsBefore(sessionId: string, beforeSequence: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM session_events WHERE session_id = ? AND id < ? LIMIT 1`,
      )
      .get(sessionId, beforeSequence) as { ok: number } | undefined;
    return Boolean(row);
  }

  private readEvents(sql: string, params: unknown[]): SessionEventRecord[] {
    const rows = this.db.prepare(sql).all(...params) as Array<{
      sequence: number;
      sessionId: string;
      turnIndex: number | null;
      eventType: AgentEvent["type"];
      itemId: string | null;
      payload: string;
      emittedAtMs: number;
    }>;
    return rows.flatMap(({ payload, itemId, ...row }) => {
      try {
        return [{
          ...row,
          ...(itemId ? { itemId } : {}),
          event: JSON.parse(payload) as AgentEvent,
        }];
      } catch {
        return [];
      }
    });
  }

  loadMessages(sessionId: string, limit = 50): ChatMessage[] {
    return this.loadMessagesWithBudget(sessionId, Number.MAX_SAFE_INTEGER, limit)
      .messages;
  }

  /** Newest-first fetch then reverse → chronological rows with DB ids. */
  loadRecentMessageRows(
    sessionId: string,
    limit: number,
  ): Array<{ id: number; message: ChatMessage }> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(
        `SELECT id, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, safeLimit) as Array<{ id: number; content: string }>;
    return rows.reverse().flatMap((row) => {
      try {
        return [{ id: row.id, message: JSON.parse(row.content) as ChatMessage }];
      } catch {
        return [];
      }
    });
  }

  loadMessageRowsBefore(
    sessionId: string,
    beforeMessageId: number,
    limit: number,
  ): Array<{ id: number; message: ChatMessage }> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(
        `SELECT id, content FROM messages
         WHERE session_id = ? AND id < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, beforeMessageId, safeLimit) as Array<{ id: number; content: string }>;
    return rows.reverse().flatMap((row) => {
      try {
        return [{ id: row.id, message: JSON.parse(row.content) as ChatMessage }];
      } catch {
        return [];
      }
    });
  }

  hasMessagesBefore(sessionId: string, beforeMessageId: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM messages WHERE session_id = ? AND id < ? LIMIT 1`)
      .get(sessionId, beforeMessageId) as { ok: number } | undefined;
    return Boolean(row);
  }

  compactSession(sessionId: string, keepLast = 30): CompactSessionResult {
    const rows = this.db
      .prepare(
        `SELECT id, content FROM messages WHERE session_id = ? ORDER BY id ASC`,
      )
      .all(sessionId) as Array<{ id: number; content: string }>;
    if (rows.length <= keepLast) {
      return { keptMessages: rows.length, summarizedMessages: 0 };
    }

    const splitAt = Math.max(0, rows.length - keepLast);
    const toSummarize = rows.slice(0, splitAt);
    const kept = rows.slice(splitAt).map((r) => JSON.parse(r.content) as ChatMessage);
    const summaryText = buildCompactSummary(toSummarize);
    return this.rewriteWithSummary(sessionId, summaryText, kept, toSummarize.length);
  }

  loadMessagesForCompaction(
    sessionId: string,
    keepLast = 30,
  ): { toSummarize: ChatMessage[]; kept: ChatMessage[] } {
    const rows = this.db
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? ORDER BY id ASC`,
      )
      .all(sessionId) as Array<{ content: string }>;
    const messages = rows.map((r) => JSON.parse(r.content) as ChatMessage);
    if (messages.length <= keepLast) return { toSummarize: [], kept: messages };
    const splitAt = Math.max(0, messages.length - keepLast);
    return {
      toSummarize: messages.slice(0, splitAt),
      kept: messages.slice(splitAt),
    };
  }

  compactSessionWithSummary(
    sessionId: string,
    summaryText: string,
    keepLast = 30,
  ): CompactSessionResult {
    const { toSummarize, kept } = this.loadMessagesForCompaction(sessionId, keepLast);
    if (!toSummarize.length) {
      return {
        keptMessages: kept.length,
        summarizedMessages: 0,
        summaryPreview: "",
      };
    }
    return this.rewriteWithSummary(sessionId, summaryText, kept, toSummarize.length);
  }

  countSessions(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .get() as { count: number };
    return row.count;
  }

  private rewriteWithSummary(
    sessionId: string,
    summaryText: string,
    kept: ChatMessage[],
    summarizedMessages: number,
  ): CompactSessionResult {
    const summary: ChatMessage = {
      role: "user",
      content: summaryText,
    };
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      // Turn ordinals shift after compaction — stale checkpoints would attach
      // rewind buttons to the wrong prompts, so drop them outright.
      this.db
        .prepare("DELETE FROM workspace_checkpoints WHERE session_id = ?")
        .run(sessionId);
      this.db
        .prepare("DELETE FROM session_dispatch_plans WHERE session_id = ?")
        .run(sessionId);
      this.db.prepare("DELETE FROM session_events WHERE session_id = ?").run(sessionId);
      this.db
        .prepare(
          "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(sessionId, summary.role, JSON.stringify(summary), now);
      for (const msg of kept) {
        this.db
          .prepare(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(sessionId, msg.role, JSON.stringify(msg), now);
      }
    });
    tx();

    return {
      keptMessages: kept.length,
      summarizedMessages,
      summaryPreview: summaryText.replace(/\s+/g, " ").trim().slice(0, 120),
    };
  }

  /** Keep newest messages within token budget (excludes role=system rows). */
  loadMessagesWithBudget(
    sessionId: string,
    maxTokens: number,
    fetchLimit = 200,
  ): LoadHistoryResult {
    const rows = this.db
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, fetchLimit) as Array<{ content: string }>;
    const chronological = rows
      .reverse()
      .map((r) => JSON.parse(r.content) as ChatMessage)
      .filter((m) => m.role !== "system");

    return applyTokenBudget(chronological, maxTokens);
  }

  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  /** Sidebar title: first real user turn (skip compacted-history stubs). */
  private getLastPreview(sessionId: string): string {
    const userRows = this.db
      .prepare(
        `SELECT content FROM messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY id ASC`,
      )
      .all(sessionId) as Array<{ content: string }>;

    for (const row of userRows) {
      const text = parseMessagePreview(row.content);
      if (text) return text.slice(0, 120);
    }

    const row = this.db
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as { content: string } | undefined;
    if (!row) return "";
    return (parseMessagePreview(row.content) ?? "").slice(0, 120);
  }
}

function parseMessagePreview(raw: string): string | null {
  try {
    const msg = JSON.parse(raw) as ChatMessage;
    const text = plainTextFromChatContent(msg.content).replace(/\s+/g, " ").trim();
    if (!text) return null;
    if (text.startsWith("Conversation summary")) return null;
    if (text.startsWith("会话摘要")) return null;
    return text;
  } catch {
    return null;
  }
}

function buildCompactSummary(rows: Array<{ content: string }>): string {
  const excerpts = rows
    .map((row) => {
      try {
        const msg = JSON.parse(row.content) as ChatMessage;
        if (!msg.content) return "";
        return `${msg.role}: ${plainTextFromChatContent(msg.content).replace(/\s+/g, " ").trim()}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .slice(-12)
    .join("\n");

  return [
    "Conversation summary from compacted earlier turns.",
    "",
    excerpts.slice(0, 4000) || "(earlier messages omitted)",
  ].join("\n");
}
