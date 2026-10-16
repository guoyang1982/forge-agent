import { describe, expect, it } from "vitest";
import { draftPlanFromDemand, draftSpecFromDemand } from "./demand-drafts.js";

const demand = {
  title: "团队版窗格最大化",
  problem: "给 SSH 客户端出团队版：窗格一键最大化",
  expectedOutcome: "可一键最大化窗格",
};

describe("demand drafts", () => {
  it("plans research as evidence and a report instead of code implementation", () => {
    const plan = draftPlanFromDemand({ ...demand, type: "research" });
    expect(plan).toContain("收集证据");
    expect(plan).toContain("调研报告");
    expect(plan).not.toContain("实现最小改动");
  });
  it("drafts spec and plan from the demand wording", () => {
    expect(draftSpecFromDemand(demand)).toContain("团队版窗格最大化");
    expect(draftSpecFromDemand(demand)).toContain(demand.problem);
    expect(draftSpecFromDemand(demand)).toContain(demand.expectedOutcome);
    expect(draftPlanFromDemand(demand)).toContain("实施计划");
    expect(draftPlanFromDemand(demand)).toContain(demand.expectedOutcome);
  });
});
