import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { OutboxDispatcher } from "./dispatcher.js";
import { EventStore } from "./store.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("OutboxDispatcher", () => {
  it("starts polling immediately and stops without leaving work in flight", async () => {
    const store = eventFixture("event-loop");
    const delivered: string[] = [];
    const dispatcher = new OutboxDispatcher({
      store,
      destination: "relay",
      workerId: "worker-loop",
      pollIntervalMs: 5,
      publish: async (claim) => {
        await Promise.resolve();
        delivered.push(claim.eventId);
      },
    });

    dispatcher.start();
    try {
      await waitFor(() => delivered.length === 1);
    } finally {
      await dispatcher.stop();
    }

    expect(delivered).toEqual(["event-loop"]);
    expect(store.claimOutbox(claimInput("worker-check", NOW))).toEqual([]);
  });

  it("publishes a claimed entry and acknowledges it", async () => {
    const store = eventFixture("event-success");
    const delivered: string[] = [];
    const dispatcher = new OutboxDispatcher({
      store,
      destination: "relay",
      workerId: "worker-a",
      now: () => NOW,
      publish: (claim) => delivered.push(claim.eventId),
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toEqual({ claimed: 1, published: 1, retried: 0, failed: 0 });
    expect(delivered).toEqual(["event-success"]);
    expect(store.claimOutbox(claimInput("worker-check", NOW))).toEqual([]);
  });

  it("releases a failed delivery until its backoff expires", async () => {
    const store = eventFixture("event-retry");
    let now = NOW;
    let shouldFail = true;
    const dispatcher = new OutboxDispatcher({
      store,
      destination: "relay",
      workerId: "worker-a",
      now: () => now,
      baseRetryMs: 1_000,
      publish: () => {
        if (shouldFail) throw new Error("relay unavailable");
      },
    });

    expect(await dispatcher.dispatchOnce()).toEqual({
      claimed: 1,
      published: 0,
      retried: 1,
      failed: 0,
    });
    now = "2026-01-01T00:00:00.999Z";
    expect((await dispatcher.dispatchOnce()).claimed).toBe(0);

    shouldFail = false;
    now = "2026-01-01T00:00:01.000Z";
    expect(await dispatcher.dispatchOnce()).toEqual({
      claimed: 1,
      published: 1,
      retried: 0,
      failed: 0,
    });
  });

  it("marks a delivery failed when the attempt limit is reached", async () => {
    const store = eventFixture("event-terminal");
    const dispatcher = new OutboxDispatcher({
      store,
      destination: "relay",
      workerId: "worker-a",
      now: () => NOW,
      maxAttempts: 1,
      publish: () => {
        throw new Error("permanent failure");
      },
    });

    expect(await dispatcher.dispatchOnce()).toEqual({
      claimed: 1,
      published: 0,
      retried: 0,
      failed: 1,
    });
    expect(store.claimOutbox(claimInput("worker-check", NOW))).toEqual([]);
  });

  it("reclaims an expired lease left by a crashed worker", async () => {
    const store = eventFixture("event-reclaimed");
    const abandoned = store.claimOutbox({
      ...claimInput("crashed-worker", NOW),
      leaseMs: 1_000,
    });
    expect(abandoned).toHaveLength(1);

    const delivered: string[] = [];
    const dispatcher = new OutboxDispatcher({
      store,
      destination: "relay",
      workerId: "replacement-worker",
      now: () => "2026-01-01T00:00:01.000Z",
      publish: (claim) => delivered.push(claim.eventId),
    });

    expect((await dispatcher.dispatchOnce()).published).toBe(1);
    expect(delivered).toEqual(["event-reclaimed"]);
  });
});

function eventFixture(eventId: string): EventStore {
  const root = mkdtempSync(join(tmpdir(), "forge-outbox-dispatcher-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const store = new EventStore(forgeStore.db);
  store.append({
    eventId,
    type: "run.created",
    subject: { kind: "agent", id: "agent-1" },
    correlationId: "corr-1",
    runId: "run-1",
    occurredAt: NOW,
    data: {},
    destination: "relay",
  });
  return store;
}

function claimInput(workerId: string, now: string) {
  return { destination: "relay", limit: 10, now, workerId };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("timed out waiting for outbox delivery");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
