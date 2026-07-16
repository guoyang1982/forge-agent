import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterDaemonBridge } from "@forge/channel-core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MobileDeviceRegistry } from "./device-registry.js";
import { MobileRpcRouter } from "./mobile-rpc-router.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tempDirs: string[] = [];

function fixture(): {
  root: string;
  outside: string;
  escape: string;
  registry: MobileDeviceRegistry;
} {
  const dir = mkdtempSync(join(tmpdir(), "forge-mobile-router-"));
  tempDirs.push(dir);
  const root = join(dir, "allowed");
  const outside = join(dir, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const escape = join(root, "escape-link");
  symlinkSync(outside, escape, "dir");
  const dbPath = join(dir, "data.db");
  const db = new Database(dbPath);
  db.exec(readFileSync(join(repoRoot, "migrations", "008_mobile_devices.sql"), "utf8"));
  db.close();
  const registry = new MobileDeviceRegistry(dbPath, "adapter_mobile01");
  registry.installDevice({
    deviceId: "device_000001",
    token: "device-token-secret-value",
    allowedProjects: [root],
  });
  return { root, outside, escape, registry };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("MobileRpcRouter", () => {
  it("filters session results and rejects a symlink escape", async () => {
    const { root, outside, escape, registry } = fixture();
    const daemon: AdapterDaemonBridge = {
      async request(method) {
        if (method === "list_sessions") {
          return {
            sessions: [
              { id: "session_01", cwd: root },
              { id: "session_02", cwd: outside },
            ],
          };
        }
        return {};
      },
    };
    const router = new MobileRpcRouter({ daemon, registry, allowedProjects: [root] });
    try {
      await expect(
        router.handle(
          "device_000001",
          { type: "rpc.request", id: "request_01", method: "session.list", params: {} },
          () => undefined,
        ),
      ).resolves.toMatchObject({
        ok: true,
        result: { sessions: [{ id: "session_01", cwd: root }] },
      });
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_02",
            method: "run.start",
            params: {
              cwd: escape,
              message: "do work",
              subscriptionId: "subscription_01",
            },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
    } finally {
      registry.close();
    }
  });

  it("streams request-scoped events while allowing cancel and forces remember=false", async () => {
    const { root, registry } = fixture();
    registry.installDevice({
      deviceId: "device_000002",
      token: "device-token-secret-value-2",
      allowedProjects: [root],
    });
    let finishRun!: (value: unknown) => void;
    const calls: Array<{ method: string; params: unknown }> = [];
    const daemon: AdapterDaemonBridge = {
      async request(method, params, onEvent) {
        calls.push({ method, params });
        if (method === "run") {
          onEvent?.({ type: "session_start", sessionId: "session_01" });
          onEvent?.({
            type: "permission_request",
            sessionId: "session_01",
            id: "permission_01",
            kind: "command",
          });
          return new Promise((resolve) => {
            finishRun = resolve;
          });
        }
        if (method === "cancel_run" || method === "permission_response") return { ok: true };
        return { sessions: [{ id: "session_01", cwd: root }] };
      },
    };
    const router = new MobileRpcRouter({ daemon, registry, allowedProjects: [root] });
    const events: unknown[] = [];
    try {
      const runPromise = router.handle(
        "device_000001",
        {
          type: "rpc.request",
          id: "request_01",
          method: "run.start",
          params: {
            cwd: root,
            message: "do work",
            subscriptionId: "subscription_01",
          },
        },
        (event) => events.push(event),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_02",
            method: "permission.respond",
            params: {
              requestId: "permission_01",
              sessionId: "session_01",
              approved: true,
            },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: true });

      await expect(
        router.handle(
          "device_000002",
          {
            type: "rpc.request",
            id: "request_04",
            method: "permission.pending",
            params: {},
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: true, result: { requests: [] } });
      await expect(
        router.handle(
          "device_000002",
          {
            type: "rpc.request",
            id: "request_05",
            method: "permission.respond",
            params: {
              requestId: "permission_01",
              sessionId: "session_01",
              approved: true,
            },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_03",
            method: "run.cancel",
            params: { sessionId: "session_01" },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: true });

      expect(events).toHaveLength(2);
      expect(calls.find((call) => call.method === "run")?.params).toMatchObject({
        cwd: realpathSync.native(root),
        autoApply: false,
      });
      expect(calls.find((call) => call.method === "run")?.params).not.toHaveProperty("channelRun");
      expect(calls.find((call) => call.method === "permission_response")?.params).toMatchObject({
        id: "permission_01",
        approved: true,
        remember: false,
      });
      finishRun({ sessionId: "session_01", finalText: "done" });
      await expect(runPromise).resolves.toMatchObject({ ok: true });
    } finally {
      registry.close();
    }
  });

  it("fails closed for methods outside the Mobile RPC schema", async () => {
    const { root, registry } = fixture();
    const router = new MobileRpcRouter({
      daemon: { request: async () => ({}) },
      registry,
      allowedProjects: [root],
    });
    try {
      await expect(
        router.handle(
          "device_000001",
          { type: "rpc.request", id: "request_01", method: "get_config", params: {} },
          () => undefined,
        ),
      ).rejects.toThrow();
    } finally {
      registry.close();
    }
  });

  it("lists and creates projects only inside an explicitly granted workspace root", async () => {
    const { root, registry } = fixture();
    mkdirSync(join(root, "existing-app"));
    const daemonCalls: Array<{ method: string; params: unknown }> = [];
    const router = new MobileRpcRouter({
      daemon: {
        request: async (method, params) => {
          daemonCalls.push({ method, params });
          if (method === "project.list") return { projects: [] };
          if (method === "project.register") return { project: params };
          return {};
        },
      },
      registry,
      allowedProjects: [root],
    });
    try {
      await expect(
        router.handle(
          "device_000001",
          { type: "rpc.request", id: "request_01", method: "project.list", params: {} },
          () => undefined,
        ),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          projects: expect.arrayContaining([
            expect.objectContaining({ path: realpathSync.native(root), kind: "workspace" }),
            expect.objectContaining({
              path: join(realpathSync.native(root), "existing-app"),
              kind: "project",
            }),
          ]),
        },
      });
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_02",
            method: "project.create",
            params: { parentPath: root, name: "new-mobile-app" },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({
        ok: true,
        result: { project: { name: "new-mobile-app", kind: "project" } },
      });
      expect(realpathSync.native(join(root, "new-mobile-app"))).toBe(
        join(realpathSync.native(root), "new-mobile-app"),
      );
      expect(daemonCalls).toContainEqual({
        method: "project.register",
        params: {
          name: "new-mobile-app",
          cwd: join(realpathSync.native(root), "new-mobile-app"),
        },
      });
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_03",
            method: "project.create",
            params: { parentPath: root, name: "../escape" },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "bad_request" } });
    } finally {
      registry.close();
    }
  });
});
