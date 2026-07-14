import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { ToolDefinition } from "@forge/protocol";
import type { ToolRegistry, ToolContext } from "@forge/tools";

export type MemoryType =
  | "user_preference"
  | "project_fact"
  | "episode"
  | "user_rejection";

export interface MemoryRow {
  id: string;
  project_id: string | null;
  memory_type: MemoryType;
  content: string;
  pinned: number;
}

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.ensureSchema();
  }

  /** Upgrade legacy DB (session_scope) → project_id */
  private ensureSchema(): void {
    const table = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`,
      )
      .get() as { name: string } | undefined;

    if (!table) {
      this.db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          memory_type TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          deleted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
      `);
      return;
    }

    const cols = this.db
      .prepare(`PRAGMA table_info(memories)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));

    if (!names.has("project_id")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN project_id TEXT`);
    }
    if (names.has("session_scope")) {
      this.db.exec(
        `UPDATE memories SET project_id = session_scope WHERE project_id IS NULL`,
      );
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id)`,
    );
  }

  private hash(content: string): string {
    return createHash("sha256").update(content.trim()).digest("hex");
  }

  upsert(input: {
    projectId: string | null;
    memoryType: MemoryType;
    content: string;
    pinned?: boolean;
  }): MemoryRow {
    const now = new Date().toISOString();
    const h = this.hash(input.content);
    const existing = this.db
      .prepare(
        `SELECT id FROM memories WHERE project_id IS ? AND memory_type = ? AND content_hash = ? AND deleted_at IS NULL`,
      )
      .get(input.projectId, input.memoryType, h) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE memories SET content = ?, pinned = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.content,
          input.pinned ? 1 : 0,
          now,
          existing.id,
        );
      return this.get(existing.id)!;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memories (id, project_id, memory_type, content, content_hash, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.memoryType,
        input.content,
        h,
        input.pinned ? 1 : 0,
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): MemoryRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, memory_type, content, pinned FROM memories WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id) as MemoryRow | undefined;
    return row ?? null;
  }

  list(projectId: string | null, type?: MemoryType, limit = 20): MemoryRow[] {
    let sql = `SELECT id, project_id, memory_type, content, pinned FROM memories WHERE deleted_at IS NULL`;
    const params: unknown[] = [];
    if (projectId) {
      sql += ` AND (project_id = ? OR project_id IS NULL)`;
      params.push(projectId);
    }
    if (type) {
      sql += ` AND memory_type = ?`;
      params.push(type);
    }
    sql += ` ORDER BY pinned DESC, updated_at DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as MemoryRow[];
  }

  search(projectId: string | null, query: string, limit = 8): MemoryRow[] {
    const q = `%${query.slice(0, 100)}%`;
    return this.db
      .prepare(
        `SELECT id, project_id, memory_type, content, pinned FROM memories
         WHERE deleted_at IS NULL AND content LIKE ?
         AND (project_id = ? OR project_id IS NULL OR project_id = '')
         ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
      )
      .all(q, projectId, limit) as MemoryRow[];
  }

  formatPack(projectId: string | null, query: string): string {
    const pinned = this.list(projectId, undefined, 30).filter((m) => m.pinned);
    const prefs = this.list(null, "user_preference", 15);
    const episodes = this.search(projectId, query, 5);
    const lines: string[] = [];
    if (prefs.length) {
      lines.push("### User preferences");
      for (const m of prefs) lines.push(`- ${m.content}`);
    }
    if (pinned.length) {
      lines.push("### Pinned");
      for (const m of pinned) lines.push(`- ${m.content}`);
    }
    if (episodes.length) {
      lines.push("### Related past tasks");
      for (const m of episodes) lines.push(`- [${m.memory_type}] ${m.content}`);
    }
    return lines.join("\n");
  }

  close(): void {
    this.db.close();
  }
}

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{8,}/,
  /api[_-]?key\s*=/i,
  /password\s*=/i,
  /boss\|[0-9]+\|[a-f0-9]{16,}/i,
];

export function sanitizeMemoryContent(content: string): {
  ok: boolean;
  text: string;
  reason?: string;
} {
  if (content.length > 2000) {
    return { ok: false, text: content, reason: "Memory too long (max 2000 chars)" };
  }
  for (const p of SECRET_PATTERNS) {
    if (p.test(content)) {
      return { ok: false, text: content, reason: "Looks like a secret; not saved" };
    }
  }
  return { ok: true, text: content.trim() };
}

export function registerMemoryTools(
  registry: ToolRegistry,
  store: MemoryStore,
  projectId: string | null,
): void {
  const searchDef: ToolDefinition = {
    name: "memory_search",
    description: "Search long-term memory for preferences and past task summaries",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  };

  registry.register(searchDef, async (args: Record<string, unknown>) => {
    const rows = store.search(projectId, String(args.query), Number(args.limit ?? 8));
    return JSON.stringify({ ok: true, memories: rows });
  });

  const saveDef: ToolDefinition = {
    name: "memory_save",
    description: "Save a short durable memory (preference, project fact, or task summary). No secrets.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        memory_type: {
          type: "string",
          enum: ["user_preference", "project_fact", "episode", "user_rejection"],
        },
        pinned: { type: "boolean" },
      },
      required: ["content", "memory_type"],
    },
  };

  registry.register(saveDef, async (args: Record<string, unknown>, _ctx: ToolContext) => {
    const sanitized = sanitizeMemoryContent(String(args.content));
    if (!sanitized.ok) {
      return JSON.stringify({ ok: false, error: sanitized.reason });
    }
    const type = String(args.memory_type) as MemoryType;
    const row = store.upsert({
      projectId: type === "user_preference" ? null : projectId,
      memoryType: type,
      content: sanitized.text,
      pinned: Boolean(args.pinned),
    });
    return JSON.stringify({ ok: true, id: row.id, message: "Memory saved" });
  });
}
