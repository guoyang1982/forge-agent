import { describe, expect, it, vi } from "vitest";

// Mock the LLM so reviewer chats are scriptable and no real module loads.
const chatMock = vi.fn();
vi.mock("@forge/llm", () => ({
  LlmClient: class {
    chat = chatMock;
  },
  LlmError: class extends Error {},
}));

const {
  parseVerdict,
  collectToolEvidence,
  shouldReflect,
  hasBlockingIssue,
  resolveReviewerModel,
  reflectOnFinal,
} = await import("./reflection.js");
const { runReActLoop } = await import("./loop.js");

describe("parseVerdict", () => {
  it("parses a pass verdict", () => {
    expect(parseVerdict('{"verdict":"pass","issues":[]}')).toEqual({
      verdict: "pass",
      issues: [],
    });
  });

  it("parses a revise verdict and normalizes issues", () => {
    const v = parseVerdict(
      '{"verdict":"revise","issues":[{"dimension":"completeness","severity":"blocker","detail":"漏了 X","suggestedAction":"补上 X"}]}',
    );
    expect(v.verdict).toBe("revise");
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0].dimension).toBe("completeness");
  });

  it("drops issues with unknown dimensions", () => {
    const v = parseVerdict(
      '{"verdict":"revise","issues":[{"dimension":"vibes","severity":"blocker","detail":"d","suggestedAction":"a"}]}',
    );
    // No valid issues left -> can't drive a fix -> pass.
    expect(v.verdict).toBe("pass");
  });

  it("treats revise-with-no-issues as pass", () => {
    expect(parseVerdict('{"verdict":"revise","issues":[]}').verdict).toBe("pass");
  });

  it("extracts JSON embedded in prose / code fences", () => {
    const v = parseVerdict(
      '好的，结论：```json\n{"verdict":"pass","issues":[]}\n```',
    );
    expect(v.verdict).toBe("pass");
  });

  it("fails open to pass on garbage", () => {
    expect(parseVerdict("not json at all").verdict).toBe("pass");
    expect(parseVerdict("").verdict).toBe("pass");
    expect(parseVerdict(null).verdict).toBe("pass");
  });
});

describe("collectToolEvidence", () => {
  const toolMsg = (content: string) => ({ role: "tool" as const, content });

  it("captures ok:false and error fields, skips ok:true", () => {
    const ev = collectToolEvidence([
      toolMsg('{"ok":true,"data":"fine"}'),
      toolMsg('{"ok":false,"error":"boom"}'),
      toolMsg('{"error":"nope"}'),
    ]);
    expect(ev).toContain("boom");
    expect(ev).toContain("nope");
    expect(ev).not.toContain("fine");
  });

  it("flags non-JSON tool output containing error keywords", () => {
    const ev = collectToolEvidence([toolMsg("Traceback: failed to run")]);
    expect(ev).toContain("failed to run");
  });

  it("returns a placeholder when nothing failed", () => {
    const ev = collectToolEvidence([toolMsg('{"ok":true}')]);
    expect(ev).toContain("无失败");
  });
});

describe("shouldReflect", () => {
  const base = {
    config: { reflection: { enabled: true } } as never,
    finalText: "answer",
    step: 0,
    maxSteps: 5,
    roundsUsed: 0,
  };

  it("is false when disabled", () => {
    expect(shouldReflect({ ...base, config: { reflection: { enabled: false } } as never })).toBe(false);
    expect(shouldReflect({ ...base, config: {} as never })).toBe(false);
  });

  it("is false with empty final text", () => {
    expect(shouldReflect({ ...base, finalText: "  " })).toBe(false);
  });

  it("respects maxRounds", () => {
    expect(shouldReflect({ ...base, roundsUsed: 1 })).toBe(false);
    expect(
      shouldReflect({
        ...base,
        config: { reflection: { enabled: true, maxRounds: 2 } } as never,
        roundsUsed: 1,
      }),
    ).toBe(true);
  });

  it("is false when remaining step budget is too small", () => {
    // remaining = maxSteps - (step+1) = 5 - 5 = 0 < default minBudget(2)
    expect(shouldReflect({ ...base, step: 4 })).toBe(false);
  });

  it("is true on the happy path", () => {
    expect(shouldReflect(base)).toBe(true);
  });
});

describe("hasBlockingIssue", () => {
  const revise = (severity: "blocker" | "minor") => ({
    verdict: "revise" as const,
    issues: [
      { dimension: "grounding" as const, severity, detail: "d", suggestedAction: "a" },
    ],
  });

  it("never blocks a pass verdict", () => {
    expect(hasBlockingIssue({ verdict: "pass", issues: [] }, undefined)).toBe(false);
  });

  it("blocks on blocker with default gate", () => {
    expect(hasBlockingIssue(revise("blocker"), undefined)).toBe(true);
  });

  it("ignores minor issues under the blocker gate", () => {
    expect(hasBlockingIssue(revise("minor"), { severityGate: "blocker" })).toBe(false);
  });

  it("blocks on minor when gate is minor", () => {
    expect(hasBlockingIssue(revise("minor"), { severityGate: "minor" })).toBe(true);
  });
});

describe("resolveReviewerModel", () => {
  it("returns the active model when no reviewerProfile", () => {
    const config = { model: { name: "main", baseUrl: "u", apiKey: "k" } } as never;
    expect(resolveReviewerModel(config)).toEqual({ name: "main", baseUrl: "u", apiKey: "k" });
  });

  it("merges the chosen profile over the active model", () => {
    const config = {
      model: { name: "main", baseUrl: "u", apiKey: "k" },
      reflection: { enabled: true, reviewerProfile: "rev" },
      profiles: { rev: { name: "judge", baseUrl: "v", apiKey: "" } },
    } as never;
    const m = resolveReviewerModel(config);
    expect(m.name).toBe("judge");
    expect(m.baseUrl).toBe("v");
    // falls back to active apiKey when the profile has none
    expect(m.apiKey).toBe("k");
  });
});

describe("reflectOnFinal", () => {
  it("parses the reviewer reply", async () => {
    chatMock.mockReset();
    chatMock.mockResolvedValueOnce({ text: '{"verdict":"pass","issues":[]}', toolCalls: [] });
    const reviewer = { chat: chatMock } as never;
    const v = await reflectOnFinal(reviewer, {
      taskText: "t",
      finalText: "a",
      toolEvidence: "e",
    });
    expect(v.verdict).toBe("pass");
  });

  it("fails open when the reviewer throws", async () => {
    chatMock.mockReset();
    chatMock.mockRejectedValueOnce(new Error("network"));
    const reviewer = { chat: chatMock } as never;
    const v = await reflectOnFinal(reviewer, {
      taskText: "t",
      finalText: "a",
      toolEvidence: "e",
    });
    expect(v.verdict).toBe("pass");
  });
});

function fakeTools() {
  return {
    definitions: [],
    async execute() {
      return JSON.stringify({ ok: true });
    },
  } as never;
}

function cfg(reflection?: unknown) {
  return {
    model: { name: "test", baseUrl: "u", apiKey: "k", options: {} },
    limits: { maxSteps: 5, toolResultMaxChars: 10000 },
    permissions: undefined,
    reflection,
  } as never;
}

describe("reflection gate in runReActLoop", () => {
  it("revises once then releases the corrected answer", async () => {
    chatMock.mockReset();
    chatMock
      // main turn 1 -> candidate final
      .mockResolvedValueOnce({ text: "答复 v1", reasoningContent: "", toolCalls: [] })
      // reflection -> revise with a blocker
      .mockResolvedValueOnce({
        text: '{"verdict":"revise","issues":[{"dimension":"completeness","severity":"blocker","detail":"漏点","suggestedAction":"补上"}]}',
        toolCalls: [],
      })
      // main turn 2 (after nudge) -> corrected final; roundsUsed now hits maxRounds
      .mockResolvedValueOnce({ text: "答复 v2", reasoningContent: "", toolCalls: [] });

    const events: any[] = [];
    const out = await runReActLoop({
      config: cfg({ enabled: true, maxRounds: 1, minStepsBudget: 1 }),
      guard: {} as never,
      messages: [{ role: "user", content: "go" }],
      tools: fakeTools(),
      autoApply: false,
      onEvent: (e) => events.push(e),
    });

    expect(out.finalText).toBe("答复 v2");
    expect(chatMock).toHaveBeenCalledTimes(3);
    const types = events.map((e) => e.type);
    expect(types).toContain("reflection_start");
    const verdictEv = events.find((e) => e.type === "reflection_verdict");
    expect(verdictEv.verdict).toBe("revise");
    expect(verdictEv.reworking).toBe(true);
    // the corrective nudge was injected as a user message
    expect(
      out.messages.some(
        (m) => m.role === "user" && String(m.content).includes("[forge] 反思"),
      ),
    ).toBe(true);
  });

  it("releases a revise verdict whose issues are below the gate (minor-only)", async () => {
    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce({ text: "答复", reasoningContent: "", toolCalls: [] })
      // verdict=revise but the only issue is minor; default gate is blocker
      .mockResolvedValueOnce({
        text: '{"verdict":"revise","issues":[{"dimension":"grounding","severity":"minor","detail":"无证据","suggestedAction":"补证据"}]}',
        toolCalls: [],
      });

    const events: any[] = [];
    const out = await runReActLoop({
      config: cfg({ enabled: true, maxRounds: 1, minStepsBudget: 1 }),
      guard: {} as never,
      messages: [{ role: "user", content: "go" }],
      tools: fakeTools(),
      autoApply: false,
      onEvent: (e) => events.push(e),
    });

    // No rework: answer released as-is, only 2 chat calls (main + reviewer).
    expect(out.finalText).toBe("答复");
    expect(chatMock).toHaveBeenCalledTimes(2);
    const verdictEv = events.find((e) => e.type === "reflection_verdict");
    expect(verdictEv.verdict).toBe("revise");
    expect(verdictEv.reworking).toBe(false);
  });

  it("releases immediately when reflection passes", async () => {
    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce({ text: "答复", reasoningContent: "", toolCalls: [] })
      .mockResolvedValueOnce({ text: '{"verdict":"pass","issues":[]}', toolCalls: [] });

    const out = await runReActLoop({
      config: cfg({ enabled: true, maxRounds: 1, minStepsBudget: 1 }),
      guard: {} as never,
      messages: [{ role: "user", content: "go" }],
      tools: fakeTools(),
      autoApply: false,
    });

    expect(out.finalText).toBe("答复");
    expect(chatMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing when reflection is disabled", async () => {
    chatMock.mockReset();
    chatMock.mockResolvedValueOnce({ text: "答复", reasoningContent: "", toolCalls: [] });

    const out = await runReActLoop({
      config: cfg(undefined),
      guard: {} as never,
      messages: [{ role: "user", content: "go" }],
      tools: fakeTools(),
      autoApply: false,
    });

    expect(out.finalText).toBe("答复");
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});
