import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { EventStore } from "./store.js";
import type { NewEvent } from "./types.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("EventStore", () => {
  it("reads events after an exclusive cursor in sequence order", () => {
    const events = eventFixture();
    events.append(event("run.created", "r1"));
    const second = events.append(event("step.started", "r1"));
    expect(
      events.readAfter({ sequence: 0, filter: { runId: "r1" }, limit: 10 }),
    ).toHaveLength(2);
    expect(
      events.readAfter({ sequence: second.sequence, filter: {}, limit: 10 }),
    ).toEqual([]);
  });

  it("deduplicates eventId", () => {
    const events = eventFixture();
    events.append(event("run.created", "r1", "event-fixed"));
    expect(() => events.append(event("run.created", "r1", "event-fixed"))).toThrow(
      /duplicate eventId/i,
    );
  });

  it("filters by subject kind and id", () => {
    const events = eventFixture();
    events.append({
      ...event("run.created", "r1", "event-a"),
      subject: { kind: "agent", id: "agent-1" },
    });
    events.append({
      ...event("run.created", "r2", "event-b"),
      subject: { kind: "user", id: "user-1" },
    });

    expect(
      events.readAfter({
        sequence: 0,
        filter: { subjectKind: "agent", subjectId: "agent-1" },
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(
      events.readAfter({
        sequence: 0,
        filter: { subjectKind: "agent", subjectId: "agent-1" },
        limit: 10,
      })[0]?.eventId,
    ).toBe("event-a");
  });

  it("filters by event type prefix", () => {
    const events = eventFixture();
    events.append(event("run.created", "r1", "event-run"));
    events.append(event("step.started", "r1", "event-step"));

    const matched = events.readAfter({
      sequence: 0,
      filter: { typePrefix: "step." },
      limit: 10,
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.type).toBe("step.started");
  });

  it("tracks consumer cursors monotonically", () => {
    const events = eventFixture();
    const first = events.append(event("run.created", "r1", "event-1"));
    const second = events.append(event("step.started", "r1", "event-2"));

    events.ackCursor("desktop", 3, NOW);
    expect(events.getCursor("desktop")).toBe(3);
    events.ackCursor("desktop", second.sequence, NOW);
    expect(events.getCursor("desktop")).toBe(3);
    events.ackCursor("desktop", first.sequence, NOW);
    expect(events.getCursor("desktop")).toBe(3);
  });

  it("claims pending outbox entries for a destination", () => {
    const events = eventFixture();
    events.append({
      ...event("run.created", "r1", "event-outbox"),
      destination: "relay",
    });

    const claims = events.claimOutbox({
      destination: "relay",
      limit: 10,
      now: NOW,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      eventId: "event-outbox",
      destination: "relay",
    });
    expect(events.getOutboxState(claims[0]!.id)).toBe("published");
  });

  it("supports appendInTransaction with caller transactions", () => {
    const { store, db } = eventFixtureWithDb();
    db.transaction(() => {
      EventStore.appendInTransaction(db, event("run.created", "r1", "event-tx"));
    })();
    expect(store.readAfter({ sequence: 0, filter: {}, limit: 10 })).toHaveLength(1);
  });
});

function eventFixture(): EventStore {
  return eventFixtureWithDb().store;
}

function eventFixtureWithDb(): {
  store: EventStore;
  db: ReturnType<ForgeStore["db"]>;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-event-store-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  return { store: new EventStore(forgeStore.db), db: forgeStore.db };
}

function event(
  type: string,
  runId: string,
  eventId = `event-${type}-${runId}`,
): NewEvent {
  return {
    eventId,
    type,
    subject: { kind: "agent", id: "agent-1" },
    correlationId: "corr-1",
    runId,
    occurredAt: NOW,
    data: {},
  };
}
