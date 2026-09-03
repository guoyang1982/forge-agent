import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@forge/protocol";
import { SessionStore } from "@forge/session";
import { ForgeStore } from "@forge/store";
import { CancelService } from "./cancel-service.js";
import { FirstPartyRunCoordinator } from "./first-party-run.js";
import { createProductionExecutionComposition } from "./production-execution-composition.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("FirstPartyRunCoordinator", () => {
  it("runs chat through a durable forge.agent step and forwards events", async () => {
    const fx = firstPartyFixture();
    const events: AgentEvent[] = [];

    const result = await fx.coordinator.start(
      { cwd: fx.root, message: "hello" },
      (event) => events.push(event),
    );

    expect(result).toEqual({ sessionId: "session-chat", finalText: "pong" });
    expect(events.map((event) => event.type)).toEqual([
      "status",
      "text_delta",
      "done",
    ]);
    const runs = fx.executionStore.loadRecoverableRuns();
    expect(runs).toHaveLength(0);
  });

  it("cancels the durable run and the cancel service together", async () => {
    const fx = firstPartyFixture({ hang: true });
    const abort = fx.cancelService.registerRun("session-hang");
    const started = fx.coordinator.start(
      { cwd: fx.root, message: "hang", sessionId: "session-hang" },
      () => {},
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    const canceled = fx.coordinator.cancel("session-hang");
    expect(canceled).toEqual({ ok: true, canceled: true });
    expect(abort.signal.aborted).toBe(true);
    await expect(started).rejects.toMatchObject({
      fault: { code: "CORE_CANCELLED", message: "任务已取消" },
    });
  });

  it("surfaces the durable attempt error instead of a generic RPC failure", async () => {
    const fx = firstPartyFixture({ failMessage: "LLM 请求失败 (402): payment required" });

    await expect(
      fx.coordinator.start(
        { cwd: fx.root, message: "hello" },
        () => {},
      ),
    ).rejects.toMatchObject({
      fault: {
        code: "INTERNAL_ERROR",
        message: "LLM 请求失败 (402): payment required",
      },
    });
  });
});

function firstPartyFixture(options: { hang?: boolean; failMessage?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-first-party-run-"));
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
      if (options.failMessage) {
        const error = new Error(options.failMessage);
        error.name = "LlmError";
        throw error;
      }
      emit({ type: "text_delta", sessionId: "session-chat", delta: "pong" });
      emit({ type: "done", sessionId: "session-chat", finalText: "pong" });
      return { sessionId: "session-chat", finalText: "pong" };
    },
  });
  const coordinator = new FirstPartyRunCoordinator({
    executionStore: production.executionStore,
    executor: production.executor,
    clock,
    sessions: new SessionStore(forgeStore.db),
    cancelService,
    bindEmit: production.bindFirstPartyEmit,
    db: forgeStore.db,
  });
  return {
    root,
    coordinator,
    cancelService,
    executionStore: production.executionStore,
  };
}
