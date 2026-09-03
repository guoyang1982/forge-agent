import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectDaemon } from "@forge/bus";
import { FIRST_PARTY_RUN_ORIGIN } from "@forge/execution";
import { DAEMON_METHODS } from "@forge/protocol";
import { SessionStore } from "@forge/session";
import { ForgeStore } from "@forge/store";
import { DaemonHost } from "./host/daemon-host.js";
import type { ForgeDaemonContext } from "./modules/context.js";
import { createRuntimeModule } from "./modules/runtime-module.js";
import { CancelService } from "./services/cancel-service.js";
import { FirstPartyRunCoordinator } from "./services/first-party-run.js";
import { createProductionExecutionComposition } from "./services/production-execution-composition.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("first-party run socket e2e", () => {
  it("persists a chat run into core_runs with first-party origin", async () => {
    const fx = await firstPartySocketFixture();
    try {
      const result = await fx.client.request(DAEMON_METHODS.RUN, {
        cwd: fx.root,
        message: "hello",
      });
      expect(result).toEqual({ sessionId: "session-chat", finalText: "pong" });
      const run = fx.latestRun();
      expect(run?.state).toBe("succeeded");
      expect(JSON.parse(String(run?.policy ?? "{}"))).toMatchObject({
        origin: FIRST_PARTY_RUN_ORIGIN,
      });
    } finally {
      fx.client.close();
      await fx.host.stop();
    }
  });

  it("cancel_run marks the durable first-party run cancelled", async () => {
    const fx = await firstPartySocketFixture({ hang: true });
    try {
      const sessionId = "session-hang";
      const started = fx.client.request(DAEMON_METHODS.RUN, {
        cwd: fx.root,
        message: "hang",
        sessionId,
      });
      await waitFor(() => fx.latestRun()?.state === "running");
      const canceled = await fx.client.request(DAEMON_METHODS.CANCEL_RUN, {
        sessionId,
      });
      expect(canceled).toEqual({ ok: true, canceled: true });
      await expect(started).rejects.toMatchObject({
        fault: { code: "CORE_CANCELLED" },
      });
      expect(fx.latestRun()?.state).toBe("cancelled");
    } finally {
      fx.client.close();
      await fx.host.stop();
    }
  });
});

async function firstPartySocketFixture(options: { hang?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-first-party-socket-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const clock = {
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
  const cancelService = new CancelService();
  const production = createProductionExecutionComposition({
    db: forgeStore.db,
    clock,
    broadcast: () => {},
    run: async (_request, emit, signal) => {
      emit({ type: "status", phase: "model", message: "replying" });
      if (options.hang) {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("Aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("Aborted")), {
            once: true,
          });
        });
      }
      emit({ type: "text_delta", sessionId: "session-chat", delta: "pong" });
      emit({ type: "done", sessionId: "session-chat", finalText: "pong" });
      return { sessionId: "session-chat", finalText: "pong" };
    },
  });
  const firstPartyRuns = new FirstPartyRunCoordinator({
    executionStore: production.executionStore,
    executor: production.executor,
    clock,
    sessions: new SessionStore(forgeStore.db),
    cancelService,
    bindEmit: production.bindFirstPartyEmit,
    db: forgeStore.db,
  });
  const context = {
    socketPath: join(root, "daemon.sock"),
    store: forgeStore,
    serverVersion: "0.2.0-test",
    build: "first-party-socket-test",
    firstPartyRuns,
    cancelService,
    getRuntime: async () => ({}),
    shutdownRuntime: async () => {},
  } as ForgeDaemonContext;
  const host = new DaemonHost([createRuntimeModule()], context);
  await host.start();
  const client = await connectDaemon(context.socketPath);
  return {
    root,
    host,
    client,
    latestRun() {
      return forgeStore.db
        .prepare(
          `SELECT id, state, policy_context_json AS policy
           FROM core_runs
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get() as { id: string; state: string; policy: string } | undefined;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
