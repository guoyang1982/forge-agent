import { describe, it, expect } from "vitest";
import {
  applyTokenBudget,
  estimateMessageTokens,
  groupMessagesIntoTurns,
} from "./tokens.js";

describe("estimateMessageTokens", () => {
  it("estimates from message size", () => {
    const t = estimateMessageTokens({
      role: "user",
      content: "hello world",
    });
    expect(t).toBeGreaterThan(0);
  });
});

describe("applyTokenBudget", () => {
  it("keeps assistant and tool messages in the same turn", () => {
    const messages = [
      { role: "user" as const, content: "old task" },
      { role: "assistant" as const, content: "working", tool_calls: [
        { id: "1", type: "function" as const, function: { name: "read_file", arguments: "{}" } },
      ]},
      { role: "tool" as const, tool_call_id: "1", content: "file body" },
      { role: "user" as const, content: "new task" },
    ];
    const turns = groupMessagesIntoTurns(messages);
    expect(turns).toHaveLength(3);
    expect(turns[1]).toHaveLength(2);

    const budget = applyTokenBudget(messages, 999_999);
    expect(budget.truncated).toBe(false);
    expect(budget.messages).toHaveLength(4);
  });

  it("drops oldest turns as a unit when over budget", () => {
    const big = "x".repeat(4000);
    const messages = [
      { role: "user" as const, content: big },
      { role: "user" as const, content: "keep me" },
    ];
    const budget = applyTokenBudget(messages, 500);
    expect(budget.truncated).toBe(true);
    expect(budget.messages).toHaveLength(1);
    expect(budget.messages[0].content).toBe("keep me");
  });

  it("flags nearLimit before truncation", () => {
    const messages = [
      { role: "user" as const, content: "x".repeat(220_000) },
    ];
    const budget = applyTokenBudget(messages, 64_000);
    expect(budget.nearLimit).toBe(true);
    expect(budget.truncated).toBe(false);
  });
});
