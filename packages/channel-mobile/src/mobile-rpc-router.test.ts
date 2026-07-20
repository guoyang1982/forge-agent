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

  it("exposes the same persisted session.messages payload mobile and desktop both reload", async () => {
    const { root, registry } = fixture();
    const desktopPersistedMessages = {
      messages: [
        { role: "user", content: "fix login" },
        { role: "assistant", content: [{ type: "text", text: "Fixed the auth guard." }] },
      ],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "list_sessions") {
        return { sessions: [{ id: "session_shared_01", cwd: root }] };
      }
      if (method === "get_session_messages") {
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
      expect(response).toMatchObject({ ok: true, result: desktopPersistedMessages });
      const mobileMessages = (response as { result: typeof desktopPersistedMessages }).result;
      expect(mobileMessages).toEqual(desktopPersistedMessages);
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
              modes: ["default"],
              models: ["auto"],
            },
            {
              provider: "cursor",
              label: "Cursor",
              available: false,
              status: "needs_setup",
              modes: ["agent"],
              models: ["gpt-5"],
            },
          ],
        },
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
