import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceGuard } from "@forge/workspace";
import { createBuiltinRegistry, type ToolContext } from "./index.js";

function testContext(over: Partial<ToolContext> = {}) {
  const cleanups: Array<() => void> = [];
  const ctx: ToolContext = {
    guard: new WorkspaceGuard(mkdtempSync(join(tmpdir(), "forge-node-repl-"))),
    emit: () => {},
    autoApply: false,
    pendingPatches: new Map(),
    onCleanup: (cleanup) => cleanups.push(cleanup),
    confirmCommand: async () => true,
    ...over,
  };
  return { ctx, cleanup: () => cleanups.forEach((fn) => fn()) };
}

describe("node_repl", () => {
  it("is exposed as a built-in tool", () => {
    const registry = createBuiltinRegistry();
    expect(registry.definitions.some((tool) => tool.name === "node_repl")).toBe(true);
  });

  it("keeps state, awaits promises, and captures console output", async () => {
    const registry = createBuiltinRegistry();
    const { ctx, cleanup } = testContext();
    try {
      const first = JSON.parse(
        await registry.execute(
          {
            id: "1",
            name: "node_repl",
            arguments: { code: "const answer = 41; console.log('saved', answer)" },
          },
          ctx,
        ),
      );
      expect(first.ok).toBe(true);
      expect(first.logs).toEqual(["saved 41"]);

      const second = JSON.parse(
        await registry.execute(
          {
            id: "2",
            name: "node_repl",
            arguments: { code: "Promise.resolve(answer + 1)" },
          },
          ctx,
        ),
      );
      expect(second).toMatchObject({ ok: true, result: "42", persistent: true });
    } finally {
      cleanup();
    }
  });

  it("blocks modules, processes, and host-constructor escapes", async () => {
    const registry = createBuiltinRegistry();
    const { ctx, cleanup } = testContext();
    try {
      for (const code of [
        "require('node:fs').readFileSync('/etc/passwd', 'utf8')",
        "require('node:child_process').spawn('echo', ['unsafe'])",
        "process.cwd()",
        "console.log.constructor('return process')().cwd()",
        "({}).constructor.constructor('return process')().cwd()",
        "this.constructor.constructor('return process')().cwd()",
        "globalThis.constructor.constructor('return process')().cwd()",
      ]) {
        const denied = JSON.parse(
          await registry.execute(
            { id: code, name: "node_repl", arguments: { code } },
            ctx,
          ),
        );
        expect(denied.ok).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  it("is unavailable when the runtime cannot ask for explicit approval", async () => {
    const registry = createBuiltinRegistry();
    const { ctx, cleanup } = testContext({ confirmCommand: undefined });
    try {
      const denied = JSON.parse(
        await registry.execute(
          { id: "no-confirm", name: "node_repl", arguments: { code: "1 + 1" } },
          ctx,
        ),
      );
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain("交互式用户确认");
    } finally {
      cleanup();
    }
  });

  it("resets persisted state before evaluating replacement code", async () => {
    const registry = createBuiltinRegistry();
    const { ctx, cleanup } = testContext();
    try {
      await registry.execute(
        { id: "set", name: "node_repl", arguments: { code: "const persisted = 42" } },
        ctx,
      );
      const reset = JSON.parse(
        await registry.execute(
          {
            id: "reset-code",
            name: "node_repl",
            arguments: { code: "typeof persisted", reset: true },
          },
          ctx,
        ),
      );
      expect(reset).toMatchObject({ ok: true, result: "undefined", persistent: true });
    } finally {
      cleanup();
    }
  });

  it("closes a pending evaluation when the run is aborted", async () => {
    const controller = new AbortController();
    const registry = createBuiltinRegistry();
    const { ctx, cleanup } = testContext({ signal: controller.signal });
    try {
      const pending = registry.execute(
        {
          id: "abort",
          name: "node_repl",
          arguments: { code: "new Promise(() => {})", timeout_ms: 5000 },
        },
        ctx,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      const result = JSON.parse(await pending);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("closed");
    } finally {
      cleanup();
    }
  });

  it("resets state and uses the existing command confirmation gate", async () => {
    const confirmCommand = vi.fn(async () => false);
    const registry = createBuiltinRegistry();
    const { ctx, cleanup } = testContext({ confirmCommand });
    try {
      const denied = JSON.parse(
        await registry.execute(
          { id: "1", name: "node_repl", arguments: { code: "1 + 1" } },
          ctx,
        ),
      );
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain("拒绝");
      expect(confirmCommand).toHaveBeenCalledWith("node_repl 1 + 1");

      const reset = JSON.parse(
        await registry.execute(
          { id: "2", name: "node_repl", arguments: { code: "", reset: true } },
          ctx,
        ),
      );
      expect(reset).toEqual({ ok: true, reset: true });
    } finally {
      cleanup();
    }
  });

  it("terminates and resets a session when asynchronous evaluation times out", async () => {
    const registry = createBuiltinRegistry();
    const { ctx, cleanup } = testContext();
    try {
      const timedOut = JSON.parse(
        await registry.execute(
          {
            id: "1",
            name: "node_repl",
            arguments: { code: "new Promise(() => {})", timeout_ms: 100 },
          },
          ctx,
        ),
      );
      expect(timedOut.ok).toBe(false);
      expect(timedOut.error).toContain("timed out");

      const next = JSON.parse(
        await registry.execute(
          { id: "2", name: "node_repl", arguments: { code: "6 * 7" } },
          ctx,
        ),
      );
      expect(next).toMatchObject({ ok: true, result: "42" });
    } finally {
      cleanup();
    }
  });
});
