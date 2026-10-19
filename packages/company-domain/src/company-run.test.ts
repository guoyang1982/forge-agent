import { describe, expect, it } from "vitest";
import {
  applyCompanyRunTerminalEvent,
  buildCompanyRunMessage,
} from "./company-run.js";

describe("company run helpers", () => {
  it("puts title spec and plan into the agent message", () => {
    const message = buildCompanyRunMessage({
      title: "Ship module",
      assigneeName: "苏衡",
      talentRole: "工程师",
      intent: "RPC is missing",
      spec: "Accepted behavior",
      plan: "Implement accepted behavior",
    });
    expect(message).toContain("Title: Ship module");
    expect(message).toContain("Assignee: 苏衡 (工程师)");
    expect(message).toContain("Accepted behavior");
    expect(message).toContain("Implement accepted behavior");
    expect(message).toMatch(/auto-applied|do not wait/i);
  });

  it("puts the assignee capability kit and memories into the run message", () => {
    const message = buildCompanyRunMessage({
      title: "Fix restore",
      assigneeName: "苏衡",
      talentRole: "执行工程师",
      intent: "比例错了",
      spec: "还原后比例正确",
      plan: "先复现再改",
      capability: {
        skills: ["实现"],
        tools: ["edit"],
        qualityGates: ["有测试证据"],
        systemPrompt: "只做已接受计划。",
      },
      memories: ["驳回：还原比例仍错"],
    });
    expect(message).toContain("Skills: 实现");
    expect(message).toContain("Tools: edit");
    expect(message).toContain("只做已接受计划。");
    expect(message).toContain("驳回：还原比例仍错");
  });

  it("ignores unrelated core events", () => {
    const gates = {
      onRunTerminal: () => {
        throw new Error("should not be called");
      },
    };
    applyCompanyRunTerminalEvent(gates, { type: "run.created", runId: "run_1" });
  });

  it("maps run.succeeded to onRunTerminal succeeded", () => {
    const calls: Array<{ runId: string; outcome: "succeeded" | "failed" }> =
      [];
    const gates = {
      onRunTerminal: (input: {
        runId: string;
        outcome: "succeeded" | "failed";
      }) => {
        calls.push(input);
      },
    };
    applyCompanyRunTerminalEvent(gates, {
      type: "run.succeeded",
      runId: "run_ok",
    });
    expect(calls).toEqual([{ runId: "run_ok", outcome: "succeeded" }]);
  });

  it("maps run.failed to onRunTerminal failed", () => {
    const calls: Array<{ runId: string; outcome: "succeeded" | "failed" }> =
      [];
    const gates = {
      onRunTerminal: (input: {
        runId: string;
        outcome: "succeeded" | "failed";
      }) => {
        calls.push(input);
      },
    };
    applyCompanyRunTerminalEvent(gates, {
      type: "run.failed",
      runId: "run_bad",
    });
    expect(calls).toEqual([{ runId: "run_bad", outcome: "failed" }]);
  });

  it("maps run.cancelled to onRunTerminal failed", () => {
    const calls: Array<{ runId: string; outcome: "succeeded" | "failed" }> =
      [];
    const gates = {
      onRunTerminal: (input: {
        runId: string;
        outcome: "succeeded" | "failed";
      }) => {
        calls.push(input);
      },
    };
    applyCompanyRunTerminalEvent(gates, {
      type: "run.cancelled",
      runId: "run_cancel",
    });
    expect(calls).toEqual([{ runId: "run_cancel", outcome: "failed" }]);
  });
});

it("requires explicit versioned JSON only for research runs", () => {
  const input = { title: "Research", assigneeName: "Analyst", intent: "Question", spec: "Spec", plan: "Plan" };
  expect(buildCompanyRunMessage({ ...input, workType: "research" })).toContain("forge-research-result");
  expect(buildCompanyRunMessage(input)).not.toContain("forge-research-result");
});
