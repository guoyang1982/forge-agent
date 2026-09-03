import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "@forge/protocol";
import { CORE_EVENT_METHOD } from "@forge/protocol";
import { connectDaemon } from "./index.js";
import type {
  SubscriptionTransport,
  TestEventSubscription,
} from "./subscription.js";
import { createEventSubscription, matchesEventFilter } from "./subscription.js";

const servers: Server[] = [];
const socketPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  for (const socketPath of socketPaths.splice(0)) {
    if (process.platform !== "win32" && existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  }
});

describe("event subscriptions", () => {
  it("replays after the last acknowledged cursor", async () => {
    const fx = await reconnectingClientFixture(
      [event(1), event(2)],
      [event(2), event(3)],
    );
    const seen: number[] = [];
    const sub = fx.client.subscribe({ runId: "r1" }, (evt) => {
      seen.push(evt.sequence);
    }) as TestEventSubscription;

    await sub.settledAfter(2);
    await fx.disconnectAndReconnect();
    await sub.settledAfter(3);
    expect(seen).toEqual([1, 2, 3]);
    await sub.close();
    fx.client.close();
  });

  it("deduplicates duplicate event ids across snapshot and live delivery", async () => {
    const duplicate = event(2);
    const fx = await reconnectingClientFixture([event(1), duplicate], []);
    const seen: string[] = [];
    const sub = fx.client.subscribe({ runId: "r1" }, (evt) => {
      seen.push(evt.eventId);
    }) as TestEventSubscription;

    await sub.settledAfter(2);
    fx.pushLive(duplicate);
    await sub.settledAfter(2);
    expect(seen).toEqual(["event-1", "event-2"]);
    await sub.close();
    fx.client.close();
  });

  it("acknowledges the cursor only after the handler resolves", async () => {
    const fx = await reconnectingClientFixture([event(1)], []);
    const acked: number[] = [];
    fx.onAck = (sequence) => acked.push(sequence);
    let entered = false;
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const sub = fx.client.subscribe({ runId: "r1" }, async () => {
      entered = true;
      await handlerGate;
    }) as TestEventSubscription;

    await waitFor(() => entered);
    expect(acked).toEqual([]);
    releaseHandler();
    await sub.settledAfter(1);
    expect(acked).toEqual([1]);
    await sub.close();
    fx.client.close();
  });

  it("does not dedupe or ack when the handler fails", async () => {
    const fx = await reconnectingClientFixture([event(1)], [event(1)]);
    const acked: number[] = [];
    fx.onAck = (sequence) => acked.push(sequence);
    let attempts = 0;
    const sub = fx.client.subscribe({ runId: "r1" }, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("handler failed");
      }
    }) as TestEventSubscription;

    await waitFor(() => attempts === 1);
    expect(acked).toEqual([]);

    await fx.disconnectAndReconnect();
    await sub.settledAfter(1);
    expect(attempts).toBe(2);
    expect(acked).toEqual([1]);
    await sub.close();
    fx.client.close();
  });

  it("does not advance past a failed live event and replays it after reconnect", async () => {
    const fx = await reconnectingClientFixture([], [event(1)]);
    const acked: number[] = [];
    const seen: number[] = [];
    fx.onAck = (sequence) => acked.push(sequence);
    const sub = fx.client.subscribe({ runId: "r1" }, async (evt) => {
      seen.push(evt.sequence);
      if (
        evt.sequence === 1 &&
        seen.filter((sequence) => sequence === 1).length === 1
      ) {
        throw new Error("first event failed");
      }
    }) as TestEventSubscription;

    try {
      fx.pushLive(event(1));
      fx.pushLive(event(2));
      await waitFor(() => seen.includes(1));
      await sleep(25);

      expect(seen).toEqual([1]);
      expect(sub.cursor).toBe(0);
      expect(acked).toEqual([]);

      await fx.disconnectAndReconnect();
      await sub.settledAfter(1);
      expect(seen).toEqual([1, 1]);
      expect(fx.readCursors).toEqual([0, 0]);
      expect(acked).toEqual([1]);
    } finally {
      await sub.close();
      fx.client.close();
    }
  });

  it("does not queue failed-subscription live events ahead of reconnect", async () => {
    const fx = inMemorySubscriptionTransport();
    let failed = false;
    const sub = createEventSubscription(
      fx.transport,
      { runId: "r1" },
      async (evt) => {
        if (evt.sequence === 1 && !failed) {
          failed = true;
          throw new Error("first event failed");
        }
      },
      { reconnectDelayMs: 1 },
    );

    try {
      fx.pushLive(event(1));
      await waitFor(() => failed);
      await sleep(0);

      const laterEvent = event(2);
      const started = Date.now();
      for (let index = 0; index < 1_000_000; index += 1) {
        fx.pushLive(laterEvent);
      }
      fx.disconnect();

      await waitFor(() => fx.reconnects === 1, 100);
      expect(fx.reconnects).toBe(1);
      expect(Date.now() - started).toBeLessThan(250);
    } finally {
      await sub.close();
    }
  });

  it("does not advance past a failed event in the same replay batch", async () => {
    const fx = await reconnectingClientFixture([event(1), event(2)], []);
    const acked: number[] = [];
    const seen: number[] = [];
    fx.onAck = (sequence) => acked.push(sequence);
    const sub = fx.client.subscribe({ runId: "r1" }, async (evt) => {
      seen.push(evt.sequence);
      if (evt.sequence === 1) {
        throw new Error("first batch event failed");
      }
    }) as TestEventSubscription;

    try {
      await waitFor(() => seen.includes(1));
      await sleep(25);
      expect(seen).toEqual([1]);
      expect(sub.cursor).toBe(0);
      expect(acked).toEqual([]);
    } finally {
      await sub.close();
      fx.client.close();
    }
  });

  it("does not redeliver an acknowledged sequence after event-id eviction", async () => {
    const fx = inMemorySubscriptionTransport();
    const seen: number[] = [];
    const sub = createEventSubscription(fx.transport, { runId: "r1" }, (evt) => {
      seen.push(evt.sequence);
    }) as TestEventSubscription;

    try {
      for (let sequence = 1; sequence <= 2_049; sequence += 1) {
        fx.pushLive(event(sequence));
      }
      await sub.settledAfter(2_049);

      fx.pushLive(event(1));
      await sleep(25);
      expect(seen).toHaveLength(2_049);
      expect(fx.acked).toHaveLength(2_049);
      expect(sub.cursor).toBe(2_049);
    } finally {
      await sub.close();
    }
  });

  it("matches subscription filters on live notifications", () => {
    const envelope = event(4, "r2");
    expect(matchesEventFilter(envelope, { runId: "r1" })).toBe(false);
    expect(matchesEventFilter(envelope, { runId: "r2", typePrefix: "step." })).toBe(
      true,
    );
  });
});

describe("matchesEventFilter", () => {
  it("filters by subject and type prefix", () => {
    const envelope: EventEnvelope = {
      ...event(1),
      subject: { kind: "agent_profile", id: "forge-default" },
      type: "step.started",
    };
    expect(
      matchesEventFilter(envelope, {
        subjectKind: "agent_profile",
        subjectId: "forge-default",
        typePrefix: "step.",
      }),
    ).toBe(true);
    expect(matchesEventFilter(envelope, { subjectId: "other" })).toBe(false);
  });
});

async function reconnectingClientFixture(
  initialBatch: EventEnvelope[],
  replayBatch: EventEnvelope[],
): Promise<{
  client: Awaited<ReturnType<typeof connectDaemon>>;
  disconnectAndReconnect: () => Promise<void>;
  pushLive: (event: EventEnvelope) => void;
  readCursors: number[];
  onAck?: (sequence: number) => void;
}> {
  const socketPath = socketName();
  socketPaths.push(socketPath);
  let generation = 0;
  let activeSocket: Socket | undefined;
  let ackHandler: ((sequence: number) => void) | undefined;
  const readCursors: number[] = [];

  const server = createServer((socket) => {
    activeSocket = socket;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let request: {
          id?: number;
          method: string;
          params?: {
            cursor?: number;
            sequence?: number;
            filter?: { runId?: string };
          };
        };
        try {
          request = JSON.parse(line) as typeof request;
        } catch {
          continue;
        }
        if (request.id === undefined) continue;

        if (request.method === "events.read") {
          const cursor = request.params?.cursor ?? 0;
          readCursors.push(cursor);
          const batch = generation === 0 ? initialBatch : replayBatch;
          const events = batch.filter(
            (entry) =>
              entry.sequence > cursor &&
              (!request.params?.filter?.runId ||
                entry.runId === request.params.filter.runId),
          );
          socket.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: { events },
            }) + "\n",
          );
          continue;
        }

        if (request.method === "events.cursor.ack") {
          ackHandler?.(request.params?.sequence ?? 0);
          socket.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                ok: true,
                cursor: request.params?.sequence ?? 0,
              },
            }) + "\n",
          );
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const client = await connectDaemon(socketPath);
  return {
    client,
    readCursors,
    get onAck() {
      return ackHandler;
    },
    set onAck(handler: ((sequence: number) => void) | undefined) {
      ackHandler = handler;
    },
    pushLive: (event) => {
      activeSocket?.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: CORE_EVENT_METHOD,
          params: event,
        }) + "\n",
      );
    },
    disconnectAndReconnect: async () => {
      generation += 1;
      activeSocket?.destroy();
      await sleep(50);
    },
  };
}

function inMemorySubscriptionTransport(): {
  transport: SubscriptionTransport;
  acked: number[];
  reconnects: number;
  pushLive: (event: EventEnvelope) => void;
  disconnect: () => void;
} {
  const acked: number[] = [];
  let reconnects = 0;
  let notificationListener: ((event: EventEnvelope) => void) | undefined;
  let closeListener: (() => void) | undefined;
  const transport = {
    request: async (method: string, params: { sequence?: number }) => {
      if (method === "events.read") {
        return { events: [] };
      }
      if (method === "events.cursor.ack") {
        acked.push(params.sequence ?? 0);
        return { ok: true, cursor: params.sequence ?? 0 };
      }
      throw new Error(`unexpected method ${method}`);
    },
    addNotificationListener: (listener: (event: EventEnvelope) => void) => {
      notificationListener = listener;
      return () => {
        notificationListener = undefined;
      };
    },
    addCloseListener: (listener: () => void) => {
      closeListener = listener;
      return () => {
        closeListener = undefined;
      };
    },
    reconnect: async () => {
      reconnects += 1;
    },
  } as unknown as SubscriptionTransport;

  return {
    transport,
    acked,
    get reconnects() {
      return reconnects;
    },
    pushLive: (event) => notificationListener?.(event),
    disconnect: () => closeListener?.(),
  };
}

function event(sequence: number, runId = "r1"): EventEnvelope {
  return {
    eventId: `event-${sequence}`,
    sequence,
    type: sequence === 1 ? "run.created" : "step.started",
    subject: { kind: "agent_profile", id: "forge-default" },
    correlationId: "corr-1",
    runId,
    occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
    schemaVersion: 1,
    data: {},
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition not met before timeout");
    }
    await sleep(5);
  }
}

function socketName(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\forge-subscription-${randomUUID()}`
    : join("/private/tmp", `forge-subscription-${randomUUID()}.sock`);
}
