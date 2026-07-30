import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./index.js";

describe("SessionStore", () => {
  it("lists sessions with message counts and compacts history", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-session-"));
    const migrations = join(root, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(
      join(migrations, "001_init.sql"),
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workspace_checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, sha TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE session_dispatch_plans (session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (session_id, turn_index));
CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER, event_type TEXT NOT NULL, item_id TEXT, payload TEXT NOT NULL, emitted_at_ms INTEGER NOT NULL);`,
    );
    const store = new SessionStore(join(root, "data.db"), migrations);
    const id = store.createSession("/tmp/project");

    for (let i = 0; i < 5; i++) {
      store.appendMessage(id, { role: "user", content: `message ${i}` });
    }

    const sessions = store.listSessions();
    expect(sessions[0].id).toBe(id);
    expect(sessions[0].messageCount).toBe(5);
    expect(sessions[0].lastPreview).toBe("message 0");

    const compacted = store.compactSession(id, 2);
    expect(compacted.summarizedMessages).toBe(3);
    expect(compacted.keptMessages).toBe(2);
    expect(store.loadMessages(id, 10)).toHaveLength(3);

    store.close();
  });
});

describe("workspace checkpoints persistence", () => {
  function newStore() {
    const root = mkdtempSync(join(tmpdir(), "forge-checkpointdb-"));
    const migrations = join(root, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(
      join(migrations, "001_init.sql"),
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workspace_checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, sha TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE session_dispatch_plans (session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (session_id, turn_index));
CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER, event_type TEXT NOT NULL, item_id TEXT, payload TEXT NOT NULL, emitted_at_ms INTEGER NOT NULL);`,
    );
    return new SessionStore(join(root, "data.db"), migrations);
  }

  it("anchors checkpoints to the upcoming user turn", () => {
    const store = newStore();
    const id = store.createSession("/tmp/p");

    // Turn 0: snapshot recorded BEFORE the user message is appended.
    store.recordCheckpoint(id, "a".repeat(40));
    store.appendMessage(id, { role: "user", content: "first" });
    store.appendMessage(id, { role: "assistant", content: "ok" });
    // Turn 1
    store.recordCheckpoint(id, "b".repeat(40));
    store.appendMessage(id, { role: "user", content: "second" });

    expect(store.listCheckpoints(id)).toEqual([
      { turnIndex: 0, sha: "a".repeat(40) },
      { turnIndex: 1, sha: "b".repeat(40) },
    ]);
  });

  it("truncates the conversation at a turn and drops later checkpoints", () => {
    const store = newStore();
    const id = store.createSession("/tmp/p");
    // turn 0
    store.recordCheckpoint(id, "a".repeat(40));
    store.appendMessage(id, { role: "user", content: "u0" });
    store.appendMessage(id, { role: "assistant", content: "a0" });
    // turn 1
    store.recordCheckpoint(id, "b".repeat(40));
    store.appendMessage(id, { role: "user", content: "u1" });
    store.appendMessage(id, { role: "assistant", content: "a1" });
    // turn 2
    store.recordCheckpoint(id, "c".repeat(40));
    store.appendMessage(id, { role: "user", content: "u2" });

    const { removed } = store.truncateAfterTurn(id, 1);
    expect(removed).toBe(3); // u1, a1, u2
    const left = store.loadMessages(id, 100).map((m) => m.content);
    expect(left).toEqual(["u0", "a0"]);
    // Checkpoints at/after turn 1 are gone; turn 0 survives.
    expect(store.listCheckpoints(id)).toEqual([{ turnIndex: 0, sha: "a".repeat(40) }]);
  });

  it("drops checkpoints when history is compacted (ordinals shift)", () => {
    const store = newStore();
    const id = store.createSession("/tmp/p");
    for (let i = 0; i < 6; i++) {
      store.recordCheckpoint(id, String(i).repeat(40).slice(0, 40));
      store.appendMessage(id, { role: "user", content: `m${i}` });
    }
    store.compactSession(id, 2);
    expect(store.listCheckpoints(id)).toEqual([]);
  });
});

describe("session dispatch plans persistence", () => {
  function newStore() {
    const root = mkdtempSync(join(tmpdir(), "forge-dispatchdb-"));
    const migrations = join(root, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(
      join(migrations, "001_init.sql"),
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);`,
    );
    writeFileSync(
      join(migrations, "006_session_dispatch_plans.sql"),
      `CREATE TABLE IF NOT EXISTS session_dispatch_plans (
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_index)
);`,
    );
    writeFileSync(
      join(migrations, "007_session_events.sql"),
      `CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER, event_type TEXT NOT NULL, item_id TEXT, payload TEXT NOT NULL, emitted_at_ms INTEGER NOT NULL);`,
    );
    return new SessionStore(join(root, "data.db"), migrations);
  }

  it("upserts and lists dispatch plans by turn index", () => {
    const store = newStore();
    const id = store.createSession("/tmp/p");
    store.appendMessage(id, { role: "user", content: "@a @b build" });
    const payload = {
      intent: "并行派活",
      source: "model" as const,
      runKind: "talent_dispatch" as const,
      waves: [
        {
          index: 0,
          steps: [
            {
              id: "talent-1",
              kind: "talent_background" as const,
              mention: "a",
              task: "design",
              status: "done" as const,
            },
          ],
        },
      ],
    };
    store.upsertDispatchPlan(id, 0, payload);
    store.upsertDispatchPlan(id, 0, {
      ...payload,
      waves: [
        {
          index: 0,
          steps: [{ ...payload.waves[0]!.steps[0]!, status: "done" }],
        },
      ],
    });
    expect(store.listDispatchPlans(id)).toHaveLength(1);
    expect(store.listDispatchPlans(id)[0]?.turnIndex).toBe(0);
    expect(store.listDispatchPlans(id)[0]?.intent).toBe("并行派活");
  });

  it("persists session events in sequence and truncates later turns", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-eventdb-"));
    const migrations = join(root, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(
      join(migrations, "001_init.sql"),
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workspace_checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, sha TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE session_dispatch_plans (session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (session_id, turn_index));
CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER, event_type TEXT NOT NULL, item_id TEXT, payload TEXT NOT NULL, emitted_at_ms INTEGER NOT NULL);`,
    );
    const store = new SessionStore(join(root, "data.db"), migrations);
    const id = store.createSession("/tmp/p");
    store.appendMessage(id, { role: "user", content: "u0" });
    store.appendEvent(id, 0, { type: "status", phase: "model", message: "first" }, 10);
    store.appendMessage(id, { role: "user", content: "u1" });
    store.appendEvent(id, 1, { type: "status", phase: "model", message: "second" }, 20);
    expect(store.listEvents(id).map((row) => row.emittedAtMs)).toEqual([10, 20]);
    expect(store.listRecentEvents(id, 1).map((row) => row.emittedAtMs)).toEqual([20]);
    expect(store.listEventsBefore(id, 2, 10).map((row) => row.emittedAtMs)).toEqual([10]);
    expect(store.hasEventsBefore(id, 2)).toBe(true);
    expect(store.hasEventsBefore(id, 1)).toBe(false);
    store.truncateAfterTurn(id, 1);
    expect(store.listEvents(id)).toHaveLength(1);
  });

  it("pages message rows by id for mobile history windows", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-msgpage-"));
    const migrations = join(root, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(
      join(migrations, "001_init.sql"),
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workspace_checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, sha TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE session_dispatch_plans (session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (session_id, turn_index));
CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER, event_type TEXT NOT NULL, item_id TEXT, payload TEXT NOT NULL, emitted_at_ms INTEGER NOT NULL);`,
    );
    const store = new SessionStore(join(root, "data.db"), migrations);
    const id = store.createSession("/tmp/p");
    store.appendMessage(id, { role: "user", content: "a" });
    store.appendMessage(id, { role: "assistant", content: "b" });
    store.appendMessage(id, { role: "user", content: "c" });
    const recent = store.loadRecentMessageRows(id, 2);
    expect(recent.map((row) => row.message.content)).toEqual(["b", "c"]);
    const older = store.loadMessageRowsBefore(id, recent[0]!.id, 10);
    expect(older).toHaveLength(1);
    expect(older[0]?.message.content).toBe("a");
    expect(store.hasMessagesBefore(id, recent[0]!.id)).toBe(true);
    expect(store.hasMessagesBefore(id, older[0]!.id)).toBe(false);
  });
});
