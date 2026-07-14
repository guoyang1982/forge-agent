import { describe, expect, it } from "vitest";
import {
  assignWaves,
  buildTalentDispatchPlan,
  planToDispatchPlanEvent,
  planToPlanUpdateItems,
  talentExecutionWaves,
} from "./index.js";

describe("buildTalentDispatchPlan", () => {
  const baseAssignments = [
    {
      mention: "nova",
      displayName: "Nova",
      role: "AI 工程师",
      emoji: "🤖",
      task: "写后端接口",
    },
    {
      mention: "lumi",
      displayName: "Lumi",
      role: "UI 设计师",
      emoji: "🎨",
      task: "出登录页样式",
    },
  ];

  it("parallel mode puts all talents in wave 0", () => {
    const plan = buildTalentDispatchPlan({
      message: "@nova 写接口 @lumi 出样式",
      assignments: baseAssignments,
      executionMode: "parallel",
    });
    const waves = talentExecutionWaves(plan);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(2);
    expect(waves[0]!.map((s) => s.mention)).toEqual(["nova", "lumi"]);
    expect(plan.coordinatorFollowup).toBe(true);
    const coord = plan.steps.find((s) => s.kind === "coordinator");
    expect(coord?.wave).toBe(1);
  });

  it("serial mode chains waves", () => {
    const plan = buildTalentDispatchPlan({
      message: "@nova 设计 @lumi 开发设计完的游戏",
      assignments: baseAssignments,
      executionMode: "serial",
    });
    const waves = talentExecutionWaves(plan);
    expect(waves).toHaveLength(2);
    expect(waves[0]![0]!.mention).toBe("nova");
    expect(waves[1]![0]!.mention).toBe("lumi");
  });

  it("maps to dispatch_plan event and plan_update items", () => {
    const plan = buildTalentDispatchPlan({
      message: "hello",
      assignments: baseAssignments,
      executionMode: "parallel",
    });
    const event = planToDispatchPlanEvent(plan);
    expect(event.runKind).toBe("talent_dispatch");
    expect(event.executionMode).toBe("parallel");
    expect(event.waves.length).toBeGreaterThan(0);
    const items = planToPlanUpdateItems(plan);
    expect(items).toHaveLength(2);
    expect(items[0]!.text).toContain("Nova");
    expect(items[0]!.text).toContain("写后端接口");
  });
});

describe("assignWaves", () => {
  it("detects cycles", () => {
    const steps = [
      {
        id: "a",
        kind: "talent_background" as const,
        task: "a",
        after: ["b"],
        wave: 0,
        status: "pending" as const,
      },
      {
        id: "b",
        kind: "talent_background" as const,
        task: "b",
        after: ["a"],
        wave: 0,
        status: "pending" as const,
      },
    ];
    expect(() => assignWaves(steps)).toThrow(/cycle/i);
  });
});
