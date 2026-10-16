import { describe, expect, it } from "vitest";
import { buildCompanyDashboard } from "./dashboard.js";
import { buildCeoBrief } from "./ceo-brief.js";

describe("company dashboard", () => {
  it("summarizes decisions, goal health, and load", () => {
    const dashboard = buildCompanyDashboard({
      companyId: "company_1",
      employees: 3,
      goals: [{ id: "goal_1", title: "团队版" }],
      projects: [{ id: "project_1" }],
      pendingApprovals: 1,
      workItems: [
        {
          id: "work_1",
          title: "窗格最大化",
          state: "waiting_approval",
          goalId: "goal_1",
          assigneeId: "emp_1",
        },
        {
          id: "work_2",
          title: "修复还原",
          state: "blocked",
          goalId: "goal_1",
          assigneeId: "emp_1",
        },
        {
          id: "work_3",
          title: "已完成",
          state: "completed",
          goalId: "goal_1",
        },
      ],
      budget: { accountId: "acc_1", currency: "USD", availableMinor: 800, hardLimitMinor: 1000 },
    });

    expect(dashboard.inProgressWorkItems).toBe(1);
    expect(dashboard.blockedWorkItems).toBe(1);
    expect(dashboard.goalHealth).toEqual([
      { id: "goal_1", title: "团队版", openWorkItems: 2 },
    ]);
    expect(dashboard.decisions.map((row) => row.id)).toEqual(["work_1", "work_2"]);
    expect(dashboard.load).toEqual([{ employeeId: "emp_1", openWorkItems: 2 }]);
    expect(dashboard.budget?.availableMinor).toBe(800);

    expect(buildCeoBrief({
      companyName: "曜石",
      dashboard,
      employees: [{ id: "emp_1", displayName: "苏衡" }],
    })).toEqual({
      summary: "曜石：1 条进行中，1 条待验收，1 条阻塞。",
      priorities: [
        "验收「窗格最大化」",
        "接管阻塞「修复还原」",
        "苏衡 手头有 2 条未完成",
      ],
    });
  });
});
