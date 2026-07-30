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
import { afterEach, describe, expect, it, vi } from "vitest";
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
    let listSessionCalls = 0;
    const daemon: AdapterDaemonBridge = {
      async request(method) {
        if (method === "list_sessions") {
          listSessionCalls += 1;
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
            id: "request_history",
            method: "session.messages",
            params: { sessionId: "session_01", limit: 20 },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: true });
      expect(listSessionCalls).toBe(1);
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_forbidden_history",
            method: "session.messages",
            params: { sessionId: "session_02", limit: 20 },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
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
        autoApply: true,
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

  it("cancels a follow-up turn on an existing sessionId (activeRuns registered immediately)", async () => {
    const { root, registry } = fixture();
    let finishRun!: (value: unknown) => void;
    const cancelCalls: unknown[] = [];
    const daemon: AdapterDaemonBridge = {
      async request(method, params, onEvent) {
        if (method === "run") {
          // Same sessionId as the request — previously this never entered activeRuns.
          onEvent?.({ type: "session_start", sessionId: "session_existing_01" });
          onEvent?.({ type: "status", sessionId: "session_existing_01", message: "连接模型…" });
          return new Promise((resolve) => {
            finishRun = resolve;
          });
        }
        if (method === "cancel_run") {
          cancelCalls.push(params);
          return { ok: true };
        }
        if (method === "list_sessions") {
          return { sessions: [{ id: "session_existing_01", cwd: root }] };
        }
        return {};
      },
    };
    const router = new MobileRpcRouter({ daemon, registry, allowedProjects: [root] });
    try {
      const runPromise = router.handle(
        "device_000001",
        {
          type: "rpc.request",
          id: "request_01",
          method: "run.start",
          params: {
            cwd: root,
            message: "follow up",
            sessionId: "session_existing_01",
            subscriptionId: "subscription_followup",
          },
        },
        () => undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_02",
            method: "run.cancel",
            params: { sessionId: "session_existing_01" },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: true, result: { ok: true } });

      expect(cancelCalls).toEqual([{ sessionId: "session_existing_01" }]);
      finishRun({ sessionId: "session_existing_01", finalText: "" });
      await expect(runPromise).resolves.toMatchObject({ ok: true });
    } finally {
      registry.close();
    }
  });

  it("cancels a Desktop-owned run when the device has session project access", async () => {
    const { root, outside, registry } = fixture();
    const cancelCalls: unknown[] = [];
    const daemon: AdapterDaemonBridge = {
      async request(method, params) {
        if (method === "cancel_run") {
          cancelCalls.push(params);
          return { ok: true };
        }
        if (method === "list_sessions") {
          return {
            sessions: [
              { id: "session_desktop_01", cwd: root },
              { id: "session_outside_01", cwd: outside },
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
          {
            type: "rpc.request",
            id: "request_01",
            method: "run.cancel",
            params: { sessionId: "session_desktop_01" },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: true, result: { ok: true } });
      expect(cancelCalls).toEqual([{ sessionId: "session_desktop_01" }]);

      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_02",
            method: "run.cancel",
            params: { sessionId: "session_outside_01" },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
    } finally {
      registry.close();
    }
  });

  it("forwards Codex permission_request events without auto-approving", async () => {
    const { root, registry } = fixture();
    let finishRun!: (value: unknown) => void;
    const permissionResponses: unknown[] = [];
    const daemon: AdapterDaemonBridge = {
      async request(method, params, onEvent) {
        if (method === "run") {
          onEvent?.({ type: "session_start", sessionId: "session_codex_01" });
          onEvent?.({
            type: "permission_request",
            sessionId: "session_codex_01",
            id: "codex_perm_01",
            kind: "codex",
            summary: "执行命令: touch /tmp/forge-permission-probe",
            options: [
              { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
              { optionId: "allow-session", name: "本会话总是允许", kind: "allow_always" },
              { optionId: "deny", name: "拒绝", kind: "reject_once" },
            ],
          });
          return new Promise((resolve) => {
            finishRun = resolve;
          });
        }
        if (method === "permission_response") {
          permissionResponses.push(params);
          return { ok: true };
        }
        return {};
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
            message: "touch a file",
            subscriptionId: "subscription_codex",
            runtime: { provider: "codex", permissionMode: "untrusted" },
          },
        },
        (event) => events.push(event),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(permissionResponses).toEqual([]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "rpc.event",
            event: expect.objectContaining({
              type: "permission_request",
              id: "codex_perm_01",
              summary: "执行命令: touch /tmp/forge-permission-probe",
            }),
          }),
        ]),
      );

      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_02",
            method: "permission.pending",
            params: { sessionId: "session_codex_01" },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          requests: [
            expect.objectContaining({
              requestId: "codex_perm_01",
              sessionId: "session_codex_01",
              event: expect.objectContaining({
                type: "permission_request",
                id: "codex_perm_01",
                summary: "执行命令: touch /tmp/forge-permission-probe",
              }),
            }),
          ],
        },
      });

      finishRun({ sessionId: "session_codex_01", finalText: "done" });
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

  it.each([
    ["git.branches", (denied: string) => ({ cwd: denied })],
    [
      "git.switch",
      (denied: string) => ({ cwd: denied, branch: "main", confirmDirty: true }),
    ],
    ["workspace.files.list", (denied: string) => ({ cwd: denied, path: "." })],
    ["workspace.file.read", (denied: string) => ({ cwd: denied, path: "README.md" })],
    ["workspace.diff.list", (denied: string) => ({ cwd: denied })],
    ["workspace.diff.get", (denied: string) => ({ cwd: denied, path: "README.md" })],
  ])("rejects %s outside device grants", async (method, makeParams) => {
    const { root, outside, registry } = fixture();
    const request = vi.fn(async () => ({}));
    const router = new MobileRpcRouter({
      daemon: { request },
      registry,
      allowedProjects: [root],
    });
    try {
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_000001",
            method,
            params: makeParams(outside),
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(request).not.toHaveBeenCalled();
    } finally {
      registry.close();
    }
  });

  it("forwards canonical workspace requests and sanitizes mobile workspace responses", async () => {
    const { root, registry } = fixture();
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "mobile.git.branches") {
        return {
          isRepo: true,
          current: "main",
          detached: false,
          dirty: true,
          branches: ["main", ...Array.from({ length: 501 }, (_, index) => `branch-${index}`)],
          secret: "remove",
        };
      }
      if (method === "mobile.git.switch") {
        return { ok: true, current: "feature/mobile", secret: "remove" };
      }
      if (method === "mobile.workspace.files.list") {
        return {
          entries: [
            { name: "README.md", path: "README.md", kind: "file", size: 10, secret: "remove" },
            ...Array.from({ length: 500 }, (_, index) => ({
              name: `file-${index}`,
              path: `file-${index}`,
              kind: "file",
              size: index,
            })),
          ],
        };
      }
      if (method === "mobile.workspace.file.read") {
        return {
          path: "README.md",
          kind: "text",
          language: "markdown",
          content: "x".repeat(200_000),
          size: 200_001,
          truncated: true,
          secret: "remove",
        };
      }
      if (method === "mobile.workspace.diff.list") {
        return {
          files: [
            { path: "README.md", additions: 1, deletions: 0, binary: false, secret: "remove" },
            ...Array.from({ length: 501 }, (_, index) => ({
              path: `file-${index}.ts`,
              additions: index,
              deletions: 0,
              binary: false,
            })),
          ],
        };
      }
      return {
        path: "README.md",
        unifiedDiff: "@@ -1 +1 @@",
        truncated: false,
        secret: "remove",
      };
    });
    const router = new MobileRpcRouter({
      daemon: { request },
      registry,
      allowedProjects: [root],
    });
    const emit = () => undefined;
    try {
      const gitBranchesResponse = await router.handle(
        "device_000001",
        {
          type: "rpc.request",
          id: "request_000001",
          method: "git.branches",
          params: { cwd: root },
        },
        emit,
      );
      expect(gitBranchesResponse).toMatchObject({
        ok: true,
        result: { branches: expect.any(Array) },
      });
      expect(
        (gitBranchesResponse as { result: { branches: string[] } }).result.branches,
      ).toHaveLength(500);
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_000002",
            method: "git.switch",
            params: { cwd: root, branch: "feature/mobile", confirmDirty: true },
          },
          emit,
        ),
      ).resolves.toMatchObject({ ok: true, result: { ok: true, current: "feature/mobile" } });
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_000003",
            method: "workspace.files.list",
            params: { cwd: root },
          },
          emit,
        ),
      ).resolves.toMatchObject({ ok: true, result: { entries: expect.any(Array) } });
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_000004",
            method: "workspace.file.read",
            params: { cwd: root, path: "README.md" },
          },
          emit,
        ),
      ).resolves.toMatchObject({
        ok: true,
        result: { content: "x".repeat(200_000), truncated: true },
      });
      const diffListResponse = await router.handle(
        "device_000001",
        {
          type: "rpc.request",
          id: "request_000005",
          method: "workspace.diff.list",
          params: { cwd: root },
        },
        emit,
      );
      expect(diffListResponse).toMatchObject({
        ok: true,
        result: { files: expect.any(Array) },
      });
      const diffFiles = (
        diffListResponse as { result: { files: Array<Record<string, unknown>> } }
      ).result.files;
      expect(diffFiles).toHaveLength(500);
      expect(diffFiles[0]).toMatchObject({ path: "README.md" });
      expect(diffFiles[0]).not.toHaveProperty("secret");
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_000006",
            method: "workspace.diff.get",
            params: { cwd: root, path: "README.md" },
          },
          emit,
        ),
      ).resolves.toMatchObject({
        ok: true,
        result: { path: "README.md", unifiedDiff: "@@ -1 +1 @@", truncated: false },
      });

      expect(request).toHaveBeenCalledWith("mobile.git.switch", {
        cwd: realpathSync.native(root),
        branch: "feature/mobile",
        confirmDirty: true,
      });
      expect(request).toHaveBeenCalledWith("mobile.workspace.files.list", {
        cwd: realpathSync.native(root),
        path: ".",
      });
      expect(request.mock.calls[0]?.[1]).not.toHaveProperty("secret");
      const filesListResponse = await router.handle(
        "device_000001",
        {
          type: "rpc.request",
          id: "request_000007",
          method: "workspace.files.list",
          params: { cwd: root },
        },
        emit,
      );
      expect(
        (filesListResponse as { result: { entries: unknown[] } }).result.entries,
      ).toHaveLength(500);
    } finally {
      registry.close();
    }
  });

  it.each([
    ["workspace.files.list", { path: "x".repeat(4097) }],
    ["workspace.file.read", { path: "x".repeat(4097) }],
    ["workspace.diff.get", { path: "x".repeat(4097) }],
  ])("bounds %s path parameters", async (method, params) => {
    const { root, registry } = fixture();
    const request = vi.fn(async () => ({}));
    const router = new MobileRpcRouter({
      daemon: { request },
      registry,
      allowedProjects: [root],
    });
    try {
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_000001",
            method,
            params: { cwd: root, ...params },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "bad_request" } });
      expect(request).not.toHaveBeenCalled();
    } finally {
      registry.close();
    }
  });

  it("exposes a mobile-capped session.messages payload without desktop-only journals", async () => {
    const { root, registry } = fixture();
    const desktopPersistedMessages = {
      sessionId: "session_shared_01",
      messages: [
        { role: "user", content: "fix login" },
        { role: "assistant", content: [{ type: "text", text: "Fixed the auth guard." }] },
      ],
      events: [
        {
          sequence: 1,
          sessionId: "session_shared_01",
          turnIndex: 0,
          eventType: "status",
          emittedAtMs: 10,
          event: { type: "status", phase: "model", message: "running" },
        },
      ],
      page: {
        truncated: false,
        messageIds: [10, 11],
        oldestMessageId: 10,
        oldestEventSequence: 1,
      },
      checkpoints: [{ turnIndex: 0, sha: "abc" }],
      dispatchPlans: [{ turnIndex: 0, intent: "x", source: "heuristic", runKind: "coordinator", waves: [] }],
    };
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "list_sessions") {
        return { sessions: [{ id: "session_shared_01", cwd: root }] };
      }
      if (method === "get_session_messages") {
        expect(params).toEqual({
          sessionId: "session_shared_01",
          limit: 200,
          eventLimit: 120,
        });
        return desktopPersistedMessages;
      }
      return {};
    });
    const router = new MobileRpcRouter({
      daemon: { request },
      registry,
      allowedProjects: [root],
    });
    try {
      const response = await router.handle(
        "device_000001",
        {
          type: "rpc.request",
          id: "request_messages_01",
          method: "session.messages",
          params: { sessionId: "session_shared_01", limit: 200 },
        },
        () => undefined,
      );
      expect(response).toMatchObject({
        ok: true,
        result: {
          sessionId: "session_shared_01",
          truncated: false,
          oldestMessageId: 10,
          oldestEventSequence: 1,
          messages: [
            { role: "user", content: "fix login", id: 10 },
            { role: "assistant", content: [{ type: "text", text: "Fixed the auth guard." }], id: 11 },
          ],
          events: desktopPersistedMessages.events,
        },
      });
      const mobileMessages = (response as { result: Record<string, unknown> }).result;
      expect(mobileMessages.checkpoints).toBeUndefined();
      expect(mobileMessages.dispatchPlans).toBeUndefined();
    } finally {
      registry.close();
    }
  });

  it("pages older history through session.history.page", async () => {
    const { root, registry } = fixture();
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "list_sessions") {
        return { sessions: [{ id: "session_page_01", cwd: root }] };
      }
      if (method === "get_session_messages") {
        expect(params).toEqual({
          sessionId: "session_page_01",
          limit: 40,
          eventLimit: 100,
          beforeMessageId: 20,
          beforeEventSequence: 50,
        });
        return {
          sessionId: "session_page_01",
          messages: [{ role: "user", content: "older" }],
          events: [{
            sequence: 40,
            sessionId: "session_page_01",
            turnIndex: 0,
            eventType: "status",
            emittedAtMs: 1,
            event: { type: "status", phase: "model", message: "old" },
          }],
          page: {
            truncated: true,
            messageIds: [9],
            oldestMessageId: 9,
            oldestEventSequence: 40,
          },
        };
      }
      return {};
    });
    const router = new MobileRpcRouter({
      daemon: { request },
      registry,
      allowedProjects: [root],
    });
    try {
      const response = await router.handle(
        "device_000001",
        {
          type: "rpc.request",
          id: "request_history_page",
          method: "session.history.page",
          params: {
            sessionId: "session_page_01",
            beforeMessageId: 20,
            beforeEventSequence: 50,
          },
        },
        () => undefined,
      );
      expect(response).toMatchObject({
        ok: true,
        result: {
          truncated: true,
          oldestMessageId: 9,
          oldestEventSequence: 40,
          messages: [{ role: "user", content: "older", id: 9 }],
        },
      });
    } finally {
      registry.close();
    }
  });

  it("truncates oversized session.messages event windows before leaving the host", async () => {
    const { root, registry } = fixture();
    const events = Array.from({ length: 450 }, (_, index) => ({
      sequence: index + 1,
      sessionId: "session_heavy_01",
      turnIndex: 0,
      eventType: "status",
      emittedAtMs: index + 1,
      event: {
        type: "status",
        phase: "model",
        message: `step-${index + 1}-${"x".repeat(8_000)}`,
      },
    }));
    const request = vi.fn(async (method: string) => {
      if (method === "list_sessions") {
        return { sessions: [{ id: "session_heavy_01", cwd: root }] };
      }
      if (method === "get_session_messages") {
        return {
          sessionId: "session_heavy_01",
          messages: [{ role: "user", content: "analyze everything" }],
          events,
          page: {
            truncated: true,
            messageIds: [1],
            oldestMessageId: 1,
            oldestEventSequence: 1,
          },
        };
      }
      return {};
    });
    const router = new MobileRpcRouter({
      daemon: { request },
      registry,
      allowedProjects: [root],
    });
    try {
      const response = await router.handle(
        "device_000001",
        {
          type: "rpc.request",
          id: "request_messages_heavy",
          method: "session.messages",
          params: { sessionId: "session_heavy_01", limit: 200 },
        },
        () => undefined,
      );
      expect(response).toMatchObject({ ok: true });
      const result = (response as { result: { events: Array<{ event: { message: string }; emittedAtMs: number }>; truncated: boolean } }).result;
      expect(result.events).toHaveLength(400);
      expect(result.events[0]?.emittedAtMs).toBe(51);
      expect(result.events.at(-1)?.emittedAtMs).toBe(450);
      expect(result.events.at(-1)?.event.message.length).toBeLessThanOrEqual(4_001);
      expect(result.truncated).toBe(true);
    } finally {
      registry.close();
    }
  });

  it("maps daemon providers into mobile runtime.list entries with model and mode ids", async () => {
    const { root, registry } = fixture();
    const request = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe("runtime.list");
      expect(params).toEqual({ cwd: root });
      return {
        providers: [
          {
            id: "forge",
            label: "Forge Agent",
            kind: "default",
            status: "ready",
            modes: [{ id: "default", label: "Default" }],
            models: [{ id: "auto", model: "auto", displayName: "Auto" }],
            secret: "drop",
          },
          {
            id: "cursor",
            label: "Cursor",
            kind: "acp",
            status: "needs_setup",
            modes: ["agent"],
            models: ["gpt-5"],
          },
        ],
      };
    });
    const router = new MobileRpcRouter({
      daemon: { request },
      registry,
      allowedProjects: [root],
    });
    try {
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_runtime_01",
            method: "runtime.list",
            params: { cwd: root },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          runtimes: [
            {
              provider: "forge",
              label: "Forge Agent",
              available: true,
              status: "ready",
              modes: [{ id: "default", label: "Default" }],
              models: ["auto"],
            },
            {
              provider: "cursor",
              label: "Cursor",
              available: false,
              status: "needs_setup",
              modes: [{ id: "agent", label: "agent" }],
              models: ["gpt-5"],
            },
          ],
        },
      });
    } finally {
      registry.close();
    }
  });

  it("forwards normalized attachments on run.start", async () => {
    const { root, registry } = fixture();
    const calls: Array<{ method: string; params: unknown }> = [];
    const daemon: AdapterDaemonBridge = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "run") return { sessionId: "session_att_01", finalText: "ok" };
        return {};
      },
    };
    const router = new MobileRpcRouter({
      daemon,
      registry,
      allowedProjects: [root],
      runPermission: "allow",
    });
    try {
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_att_01",
            method: "run.start",
            params: {
              cwd: root,
              message: "",
              subscriptionId: "subscription_att_01",
              attachments: [
                {
                  kind: "file",
                  name: "note.txt",
                  mimeType: "text/plain",
                  text: "from phone",
                },
              ],
            },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: true });
      const runCall = calls.find((item) => item.method === "run");
      expect(runCall?.params).toMatchObject({
        message: "请查看附件",
        attachments: [
          { kind: "file", name: "note.txt", mimeType: "text/plain", text: "from phone" },
        ],
        autoApply: true,
      });
    } finally {
      registry.close();
    }
  });

  it("forwards workspace file mentions on run.start", async () => {
    const { root, registry } = fixture();
    const calls: Array<{ method: string; params: unknown }> = [];
    const daemon: AdapterDaemonBridge = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "run") return { sessionId: "session_files_01", finalText: "ok" };
        return {};
      },
    };
    const router = new MobileRpcRouter({
      daemon,
      registry,
      allowedProjects: [root],
      runPermission: "allow",
    });
    try {
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_files_01",
            method: "run.start",
            params: {
              cwd: root,
              message: "请检查 `src/a.ts`",
              subscriptionId: "subscription_files_01",
              files: ["src/a.ts", "README.md"],
            },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({ ok: true });
      const runCall = calls.find((item) => item.method === "run");
      expect(runCall?.params).toMatchObject({
        files: ["src/a.ts", "README.md"],
        autoApply: true,
      });
    } finally {
      registry.close();
    }
  });

  it("surfaces safe daemon Error messages instead of opaque request failed", async () => {
    const { root, registry } = fixture();
    const daemon: AdapterDaemonBridge = {
      async request() {
        throw new Error(
          "Invalid request: unknown variant `default`, expected one of `untrusted`, `on-request`, `granular`, `never`",
        );
      },
    };
    const router = new MobileRpcRouter({
      daemon,
      registry,
      allowedProjects: [root],
      runPermission: "allow",
    });
    try {
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_err_01",
            method: "run.start",
            params: {
              cwd: root,
              message: "hi",
              subscriptionId: "subscription_err_01",
              runtime: { provider: "codex", permissionMode: "default" },
            },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: "internal",
          message:
            "Invalid request: unknown variant `default`, expected one of `untrusted`, `on-request`, `granular`, `never`",
          retryable: true,
        },
      });
    } finally {
      registry.close();
    }
  });

  it("redacts credential-looking daemon errors", async () => {
    const { root, registry } = fixture();
    const daemon: AdapterDaemonBridge = {
      async request() {
        throw new Error("auth failed api_key=sk-secret-value-123456");
      },
    };
    const router = new MobileRpcRouter({
      daemon,
      registry,
      allowedProjects: [root],
      runPermission: "allow",
    });
    try {
      await expect(
        router.handle(
          "device_000001",
          {
            type: "rpc.request",
            id: "request_err_02",
            method: "run.start",
            params: {
              cwd: root,
              message: "hi",
              subscriptionId: "subscription_err_02",
              runtime: { provider: "codex" },
            },
          },
          () => undefined,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "internal", message: "request failed", retryable: true },
      });
    } finally {
      registry.close();
    }
  });
});
