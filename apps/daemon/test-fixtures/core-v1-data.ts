import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  openNonMigratingDatabase,
  type ForgeStoreOptions,
} from "@forge/store";

export interface CoreV1Fixture {
  dataDir: string;
  messageContent: string;
  memoryContent: string;
  projectId: string;
  options: ForgeStoreOptions;
}

export function createCoreV1Fixture(input: {
  root: string;
  migrationsDir: string;
}): CoreV1Fixture {
  const dataDir = join(input.root, "core-v1-data");
  const dbPath = join(dataDir, "data.db");
  const messageContent = "legacy session content must survive";
  const memoryContent = "legacy scoped memory must survive";
  const projectId = "/fixtures/core-v1-project";
  mkdirSync(dataDir, { recursive: true });

  const db = openNonMigratingDatabase(dbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        session_scope TEXT,
        memory_type TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions (id, cwd, created_at)
        VALUES ('legacy-session', '${projectId}', '2026-01-01T00:00:00.000Z');
      INSERT INTO messages (id, session_id, role, content, created_at)
        VALUES (1, 'legacy-session', 'user', '${messageContent}', '2026-01-01T00:00:01.000Z');
      INSERT INTO memories (
        id, session_scope, memory_type, content, content_hash,
        pinned, deleted_at, created_at, updated_at
      ) VALUES (
        'legacy-memory', '${projectId}', 'project_fact', '${memoryContent}',
        'legacy-content-hash', 1, NULL,
        '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'
      );
    `);
  } finally {
    db.close();
  }
  writeFileSync(
    join(dataDir, "config.json"),
    `${JSON.stringify({ ui: { theme: "dark" } }, null, 2)}\n`,
  );

  return {
    dataDir,
    messageContent,
    memoryContent,
    projectId,
    options: {
      dbPath,
      migrationsDir: input.migrationsDir,
      owner: "test",
    },
  };
}
