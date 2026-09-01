import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "@forge/session";
import { ForgeStore } from "@forge/store";
import { RpcFaultError, TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";
import { createSessionModule } from "./session-module.js";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "migrations",
);
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("session module", () => {
  it("accepts every ChatContent variant and rejects malformed content before persisting", async () => {
    const { router, sessions } = sessionRouterFixture();
    const { sessionId } = await router.handle(
      "session.create",
      { cwd: "/workspace" },
      rpcContext(),
    );

    await router.handle(
      "session.appendMessage",
      { sessionId, role: "user", content: "plain text" },
      rpcContext(),
    );
    await router.handle(
      "session.appendMessage",
      {
        sessionId,
        role: "assistant",
        content: [
          { type: "text", text: "caption" },
          { type: "image_url", image_url: { url: "https://example.test/image.png" } },
        ],
      },
      rpcContext(),
    );
    await router.handle(
      "session.appendMessage",
      { sessionId, role: "system", content: null },
      rpcContext(),
    );

    const error = await router
      .handle(
        "session.appendMessage",
        { sessionId, role: "user", content: { unexpected: true } },
        rpcContext(),
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(RpcFaultError);
    expect(error).toMatchObject({
      fault: { code: "INVALID_REQUEST", correlationId: "correlation-1" },
    });
    const persisted = readPersistedMessages(sessions, sessionId);

    expect(persisted).toEqual([
      { role: "user", content: "plain text" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "caption" },
          { type: "image_url", image_url: { url: "https://example.test/image.png" } },
        ],
      },
      { role: "system", content: null },
    ]);
  });
});

function sessionRouterFixture(): { router: TypedRouter; sessions: SessionStore } {
  const root = mkdtempSync(join(tmpdir(), "forge-session-module-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const sessions = new SessionStore(forgeStore.db);
  const context = {
    socketPath: join(root, "daemon.sock"),
    store: forgeStore,
    serverVersion: "0.2.0-test",
    build: "session-module-test",
    sessions,
    getRuntime: async () => {
      throw new Error("not implemented in session module fixture");
    },
  } satisfies Pick<
    ForgeDaemonContext,
    "socketPath" | "store" | "serverVersion" | "build" | "sessions" | "getRuntime"
  >;
  const router = new TypedRouter();
  createSessionModule().register(router, context);
  return { router, sessions };
}

function readPersistedMessages(sessions: SessionStore, sessionId: string): unknown[] {
  return sessions.getDb()
    .prepare("SELECT content FROM messages WHERE session_id = ? ORDER BY id ASC")
    .all(sessionId)
    .map((row) => {
      if (!isRecord(row) || typeof row.content !== "string") {
        throw new Error("expected persisted message content row");
      }
      const message: unknown = JSON.parse(row.content);
      return message;
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rpcContext() {
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    emitLegacyAgentEvent: () => {},
  };
}
