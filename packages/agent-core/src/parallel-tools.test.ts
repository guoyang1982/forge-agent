import { describe, expect, it, vi } from "vitest";

// Mock the LLM so we can script tool-call batches deterministically.
const chatMock = vi.fn();
vi.mock("@forge/llm", () => ({
  LlmClient: class {
    chat = chatMock;
  },
  LlmError: class extends Error {},
}));

const { runReActLoop } = await import("./loop.js");

function cfg() {
  return {
    model: { name: "test", options: {} },
    limits: { maxSteps: 5, toolResultMaxChars: 10000 },
    permissions: undefined,
  } as never;
}

/** Fake registry recording execution intervals; named tools drive read-only vs mutating. */
function fakeTools(log) {
  return {
    definitions: [],
    async execute(call) {
      const start = Date.now();
      log.push({ id: call.id, name: call.name, phase: "start", t: start });
      await new Promise((r) => setTimeout(r, 60));
      log.push({ id: call.id, name: call.name, phase: "end", t: Date.now() });
      return JSON.stringify({ ok: true, id: call.id });
    },
  } as never;
}

describe("parallel tool execution", () => {
  it("runs registered tool cleanups when tool execution throws", async () => {
    chatMock.mockReset();
    chatMock.mockResolvedValueOnce({
      text: "",
      reasoningContent: "",
      toolCalls: [{ id: "boom", name: "read_file", arguments: { path: "x" } }],
    });
    const cleanup = vi.fn();
    const tools = {
      definitions: [],
      async execute(_call, ctx) {
        ctx.onCleanup?.(cleanup);
        throw new Error("tool failed");
      },
    } as never;

    await expect(
      runReActLoop({
        config: cfg(),
        guard: {} as never,
        messages: [{ role: "user", content: "go" }],
        tools,
        autoApply: false,
      }),
    ).rejects.toThrow("tool failed");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("runs registered tool cleanups after normal completion", async () => {
    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce({
        text: "",
        reasoningContent: "",
        toolCalls: [{ id: "ok", name: "read_file", arguments: { path: "x" } }],
      })
      .mockResolvedValueOnce({ text: "done", reasoningContent: "", toolCalls: [] });
    const cleanup = vi.fn();
    const tools = {
      definitions: [],
      async execute(_call, ctx) {
        ctx.onCleanup?.(cleanup);
        return JSON.stringify({ ok: true });
      },
    } as never;

    await runReActLoop({
      config: cfg(),
      guard: {} as never,
      messages: [{ role: "user", content: "go" }],
      tools,
      autoApply: false,
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("runs registered tool cleanups when the step limit is exhausted", async () => {
    chatMock.mockReset();
    chatMock.mockResolvedValue({
      text: "",
      reasoningContent: "",
      toolCalls: [{ id: "limit", name: "read_file", arguments: { path: "x" } }],
    });
    const cleanup = vi.fn();
    const tools = {
      definitions: [],
      async execute(_call, ctx) {
        ctx.onCleanup?.(cleanup);
        return JSON.stringify({ ok: true });
      },
    } as never;
    const config = cfg() as { limits: { maxSteps: number } };
    config.limits.maxSteps = 1;

    await expect(
      runReActLoop({
        config: config as never,
        guard: {} as never,
        messages: [{ role: "user", content: "go" }],
        tools,
        autoApply: false,
      }),
    ).rejects.toThrow("已达最大步数限制");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("runs a batch of read-only calls concurrently, results in call order", async () => {
    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce({
        text: "",
        reasoningContent: "",
        toolCalls: [
          { id: "a", name: "read_file", arguments: { path: "a" } },
          { id: "b", name: "read_file", arguments: { path: "b" } },
          { id: "c", name: "grep", arguments: { pattern: "x" } },
        ],
      })
      .mockResolvedValueOnce({ text: "done", reasoningContent: "", toolCalls: [] });

    const log = [];
    const started = Date.now();
    const out = await runReActLoop({
      config: cfg(),
      guard: {} as never,
      messages: [{ role: "user", content: "go" }],
      tools: fakeTools(log),
      autoApply: false,
    });
    const elapsed = Date.now() - started;

    // Concurrent: 3×60ms serial would be ~180ms; parallel finishes well under.
    expect(elapsed).toBeLessThan(150);
    // All three started before any finished (true overlap).
    const firstEnd = log.find((e) => e.phase === "end").t;
    const lastStart = [...log].reverse().find((e) => e.phase === "start").t;
    expect(lastStart).toBeLessThanOrEqual(firstEnd);
    // Tool result messages preserve call order regardless of completion timing.
    const toolMsgs = out.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["a", "b", "c"]);
  });

  it("runs multiple spawn_agent calls concurrently", async () => {
    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce({
        text: "",
        reasoningContent: "",
        toolCalls: [
          { id: "s1", name: "spawn_agent", arguments: { task: "1" } },
          { id: "s2", name: "spawn_agent", arguments: { task: "2" } },
          { id: "s3", name: "spawn_agent", arguments: { task: "3" } },
        ],
      })
      .mockResolvedValueOnce({ text: "done", reasoningContent: "", toolCalls: [] });

    const log = [];
    const started = Date.now();
    await runReActLoop({
      config: cfg(),
      guard: {} as never,
      messages: [{ role: "user", content: "go" }],
      tools: fakeTools(log),
      autoApply: false,
    });
    expect(Date.now() - started).toBeLessThan(150);
    const firstEnd = log.find((e) => e.phase === "end").t;
    const lastStart = [...log].reverse().find((e) => e.phase === "start").t;
    expect(lastStart).toBeLessThanOrEqual(firstEnd);
  });

  it("caps parallelism at the scheduling limit (peak concurrency <= 6)", async () => {
    chatMock.mockReset();
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `k${i}`,
      name: "read_file",
      arguments: { path: String(i) },
    }));
    chatMock
      .mockResolvedValueOnce({ text: "", reasoningContent: "", toolCalls: many })
      .mockResolvedValueOnce({ text: "done", reasoningContent: "", toolCalls: [] });

    const log = [];
    const out = await runReActLoop({
      config: cfg(),
      guard: {} as never,
      messages: [{ role: "user", content: "go" }],
      tools: fakeTools(log),
      autoApply: false,
    });

    // Walk the timeline; peak simultaneously-running count must not exceed 6.
    const events = [...log].sort((a, b) => a.t - b.t);
    let running = 0;
    let peak = 0;
    for (const e of events) {
      running += e.phase === "start" ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1); // still genuinely parallel
    // Results still preserve call order despite the pool.
    const toolMsgs = out.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(many.map((m) => m.id));
  });

  it("serializes a mutating call between reads (no write race)", async () => {
    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce({
        text: "",
        reasoningContent: "",
        toolCalls: [
          { id: "r1", name: "read_file", arguments: {} },
          { id: "w", name: "write_file", arguments: {} },
          { id: "r2", name: "read_file", arguments: {} },
        ],
      })
      .mockResolvedValueOnce({ text: "done", reasoningContent: "", toolCalls: [] });

    const log = [];
    await runReActLoop({
      config: cfg(),
      guard: {} as never,
      messages: [{ role: "user", content: "go" }],
      tools: fakeTools(log),
      autoApply: false,
    });

    const endOf = (id) => log.find((e) => e.id === id && e.phase === "end").t;
    const startOf = (id) => log.find((e) => e.id === id && e.phase === "start").t;
    // write starts only after the preceding read finished, and the trailing
    // read starts only after the write finished.
    expect(startOf("w")).toBeGreaterThanOrEqual(endOf("r1"));
    expect(startOf("r2")).toBeGreaterThanOrEqual(endOf("w"));
  });

  it("allowTool rejects disallowed tools without executing them", async () => {
    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce({
        text: "",
        reasoningContent: "",
        toolCalls: [{ id: "w", name: "write_file", arguments: { path: "x" } }],
      })
      .mockResolvedValueOnce({ text: "done", reasoningContent: "", toolCalls: [] });

    const log = [];
    const out = await runReActLoop({
      config: cfg(),
      guard: {} as never,
      messages: [{ role: "user", content: "go" }],
      tools: fakeTools(log),
      autoApply: false,
      allowTool: (name) => name === "read_file",
    });

    // The disallowed tool never executed (no log entry) and got a refusal.
    expect(log).toHaveLength(0);
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg.content).toContain("不可用");
  });
});
