import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceGuard } from "@forge/workspace";
import { createBuiltinRegistry, type ToolContext } from "./index.js";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "forge-cmd-"));
  return {
    guard: new WorkspaceGuard(dir),
    emit: () => {},
    autoApply: false,
    pendingPatches: new Map(),
    ...over,
  };
}

describe("run_command confirmation gate", () => {
  const reg = createBuiltinRegistry();
  const call = { id: "1", name: "run_command", arguments: { command: "git status" } };

  it("runs the command when no confirmCommand is provided (no refusal)", async () => {
    const out = JSON.parse(await reg.execute(call, ctx()));
    // Whether the shell succeeds depends on env; the point is it was NOT refused.
    expect(out.error).not.toContain("拒绝");
  });

  it("refuses and does not execute when confirmCommand denies", async () => {
    const confirmCommand = vi.fn(async () => false);
    const out = JSON.parse(await reg.execute(call, ctx({ confirmCommand })));
    expect(confirmCommand).toHaveBeenCalledWith("git status");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("拒绝");
  });

  it("executes (does not refuse) when confirmCommand approves", async () => {
    const confirmCommand = vi.fn(async () => true);
    const out = JSON.parse(await reg.execute(call, ctx({ confirmCommand })));
    expect(confirmCommand).toHaveBeenCalledOnce();
    expect(out.error).not.toContain("拒绝");
  });
});

describe("spawn_agent delegation", () => {
  const reg = createBuiltinRegistry();
  const call = { id: "s1", name: "spawn_agent", arguments: { task: "do X" } };

  it("delegates to ctx.spawnSubagent and returns its summary", async () => {
    const spawnSubagent = vi.fn(async (t: string) => `done: ${t}`);
    const out = JSON.parse(await reg.execute(call, ctx({ spawnSubagent })));
    expect(spawnSubagent).toHaveBeenCalledWith("do X");
    expect(out.ok).toBe(true);
    expect(out.summary).toBe("done: do X");
  });

  it("refuses recursion when no spawnSubagent is provided (depth cap)", async () => {
    const out = JSON.parse(await reg.execute(call, ctx()));
    expect(out.ok).toBe(false);
    expect(out.error).toContain("递归");
  });

  it("requires a task", async () => {
    const spawnSubagent = vi.fn(async () => "x");
    const out = JSON.parse(
      await reg.execute(
        { id: "s2", name: "spawn_agent", arguments: { task: "  " } },
        ctx({ spawnSubagent }),
      ),
    );
    expect(out.ok).toBe(false);
    expect(spawnSubagent).not.toHaveBeenCalled();
  });
});

describe("per-path write lock under concurrent writes", () => {
  function sharedCtx(dir: string): ToolContext {
    return {
      guard: new WorkspaceGuard(dir),
      emit: () => {},
      autoApply: true,
      pendingPatches: new Map(),
    } as never;
  }

  it("serializes same-path writes (no interleaving) and parallelizes different paths", async () => {
    const reg = createBuiltinRegistry();
    const dir = mkdtempSync(join(tmpdir(), "forge-lock-"));
    const ctxA = sharedCtx(dir);
    const ctxB = sharedCtx(dir);

    const a = reg.execute(
      { id: "1", name: "write_file", arguments: { path: "same.txt", content: "AAA", overwrite: true } },
      ctxA,
    );
    const b = reg.execute(
      { id: "2", name: "write_file", arguments: { path: "same.txt", content: "BBB", overwrite: true } },
      ctxB,
    );
    const c = reg.execute(
      { id: "3", name: "write_file", arguments: { path: "other.txt", content: "CCC" } },
      sharedCtx(dir),
    );
    await Promise.all([a, b, c]);

    const { readFileSync, existsSync } = await import("node:fs");
    // same.txt ends as exactly one full write, never a corrupted blend.
    expect(["AAA", "BBB"]).toContain(readFileSync(join(dir, "same.txt"), "utf-8"));
    // the unrelated path was written too (ran in parallel).
    expect(existsSync(join(dir, "other.txt"))).toBe(true);
    expect(readFileSync(join(dir, "other.txt"), "utf-8")).toBe("CCC");
  });
});
