import { describe, expect, it, vi } from "vitest";
import { createForgeMobileApi } from "./forge-mobile-api.js";

describe("Forge mobile API", () => {
  it("drops malformed workspace and runtime payloads", async () => {
    const client = {
      call: vi.fn()
        .mockResolvedValueOnce({
          entries: [
            { path: 3 },
            { name: "src", path: "src", kind: "directory", size: 0, secret: "drop" },
          ],
        })
        .mockResolvedValueOnce({
          runtimes: [
            { provider: 3 },
            { provider: "claude", available: true, status: "ready", models: ["sonnet", 3] },
          ],
        })
        .mockResolvedValueOnce({
          providers: [
            {
              id: "forge",
              label: "Forge Agent",
              status: "ready",
              modes: [{ id: "default", label: "Default" }],
              models: [{ id: "auto", model: "auto", displayName: "Auto" }],
            },
          ],
        }),
      startRun: vi.fn(),
    };
    const api = createForgeMobileApi(client as never);

    expect(await api.files("/repo", ".")).toEqual([
      { name: "src", path: "src", kind: "directory", size: 0 },
    ]);
    expect(await api.runtimes()).toEqual([
      { provider: "claude", available: true, status: "ready", modes: [], models: ["sonnet"] },
    ]);
    expect(await api.runtimes("/repo")).toEqual([
      {
        provider: "forge",
        label: "Forge Agent",
        available: true,
        status: "ready",
        modes: [{ id: "default", label: "Default" }],
        models: ["auto"],
      },
    ]);
    expect(client.call).toHaveBeenNthCalledWith(3, "runtime.list", { cwd: "/repo" });
  });

  it("uses the authorized RPC parameters without exposing unknown response fields", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({
        path: "README.md",
        kind: "text",
        language: "markdown",
        content: "# Forge",
        size: 7,
        truncated: false,
        token: "drop",
      }),
      startRun: vi.fn(),
    };
    const api = createForgeMobileApi(client as never);

    await expect(api.file("/repo", "README.md")).resolves.toEqual({
      path: "README.md",
      kind: "text",
      language: "markdown",
      content: "# Forge",
      size: 7,
      truncated: false,
    });
    expect(client.call).toHaveBeenCalledWith("workspace.file.read", {
      cwd: "/repo",
      path: "README.md",
    });
  });

  it("builds the exact run payload from required context", () => {
    const client = {
      call: vi.fn(),
      startRun: vi.fn().mockReturnValue({
        subscriptionId: "subscription-01",
        result: Promise.resolve({}),
      }),
    };
    const api = createForgeMobileApi(client as never);
    const onEvent = vi.fn();

    api.startRun(
      {
        cwd: "/repo",
        branch: "feature/mobile",
        provider: "claude",
        model: "sonnet",
        permissionMode: "confirm",
        sandboxMode: "workspace-write",
        effort: "high",
      },
      { message: "Fix it", sessionId: "session-01" },
      onEvent,
    );

    expect(client.startRun).toHaveBeenCalledWith({
      cwd: "/repo",
      message: "Fix it",
      sessionId: "session-01",
      runtime: {
        provider: "claude",
        model: "sonnet",
        permissionMode: "confirm",
        sandboxMode: "workspace-write",
        effort: "high",
      },
    }, onEvent);
    const runtime = client.startRun.mock.calls[0]?.[0]?.runtime;
    expect(runtime).not.toHaveProperty("cwd");
    expect(runtime).not.toHaveProperty("branch");
  });

  it("omits empty model and rejects missing provider before run.start", () => {
    const client = {
      call: vi.fn(),
      startRun: vi.fn().mockReturnValue({
        subscriptionId: "subscription-01",
        result: Promise.resolve({}),
      }),
    };
    const api = createForgeMobileApi(client as never);

    expect(() => api.startRun(
      {
        cwd: "/repo",
        branch: null,
        provider: "",
        model: "",
        permissionMode: "default",
        sandboxMode: "workspace-write",
      },
      { message: "hi" },
      vi.fn(),
    )).toThrow("请先选择 Agent");

    api.startRun(
      {
        cwd: "/repo",
        branch: null,
        provider: "forge",
        model: "",
        permissionMode: "default",
        sandboxMode: "workspace-write",
      },
      { message: "hi" },
      vi.fn(),
    );
    expect(client.startRun).toHaveBeenCalledWith({
      cwd: "/repo",
      message: "hi",
      runtime: {
        provider: "forge",
        permissionMode: "default",
        sandboxMode: "workspace-write",
      },
    }, expect.any(Function));
    expect(client.startRun.mock.calls[0]?.[0]?.runtime).not.toHaveProperty("model");
  });

  it("omits empty permissionMode so Codex does not receive Cursor defaults", () => {
    const client = {
      call: vi.fn(),
      startRun: vi.fn().mockReturnValue({
        subscriptionId: "subscription-01",
        result: Promise.resolve({}),
      }),
    };
    const api = createForgeMobileApi(client as never);

    api.startRun(
      {
        cwd: "/repo",
        branch: null,
        provider: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "",
        sandboxMode: "workspace-write",
      },
      { message: "只回复：pong" },
      vi.fn(),
    );

    expect(client.startRun).toHaveBeenCalledWith({
      cwd: "/repo",
      message: "只回复：pong",
      runtime: {
        provider: "codex",
        model: "gpt-5.6-sol",
        sandboxMode: "workspace-write",
      },
    }, expect.any(Function));
    expect(client.startRun.mock.calls[0]?.[0]?.runtime).not.toHaveProperty("permissionMode");
  });
});
