import { describe, expect, it } from "vitest";
import {
  materializeModelTalentDispatchPlan,
  parseModelTalentDispatchDraft,
  resolveTalentDispatchPlan,
} from "./planning.js";

const assignments = [
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

describe("parseModelTalentDispatchDraft", () => {
  it("parses fenced JSON", () => {
    const draft = parseModelTalentDispatchDraft(`
\`\`\`json
{
  "intent": "并行开发",
  "steps": [
    { "mention": "@nova", "task": "API", "after": [] },
    { "mention": "lumi", "task": "UI", "after": [] }
  ]
}
\`\`\`
`);
    expect(draft?.steps).toHaveLength(2);
    expect(draft?.steps[0]?.mention).toBe("nova");
  });
});

describe("materializeModelTalentDispatchPlan", () => {
  it("builds serial waves from after dependencies", () => {
    const plan = materializeModelTalentDispatchPlan(
      JSON.stringify({
        intent: "先设计后开发",
        steps: [
          { mention: "nova", task: "游戏设计", after: [] },
          { mention: "lumi", task: "实现设计", after: ["nova"] },
        ],
      }),
      assignments,
    );
    expect(plan?.source).toBe("model");
    const talents = plan!.steps.filter((s) => s.kind === "talent_background");
    expect(talents[0]!.wave).toBe(0);
    expect(talents[1]!.wave).toBe(1);
  });

  it("rejects unknown mentions", () => {
    const plan = materializeModelTalentDispatchPlan(
      JSON.stringify({
        steps: [{ mention: "ghost", task: "x", after: [] }],
      }),
      assignments,
    );
    expect(plan).toBeUndefined();
  });

  it("rejects cycles", () => {
    const plan = materializeModelTalentDispatchPlan(
      JSON.stringify({
        steps: [
          { mention: "nova", task: "a", after: ["lumi"] },
          { mention: "lumi", task: "b", after: ["nova"] },
        ],
      }),
      assignments,
    );
    expect(plan).toBeUndefined();
  });
});

describe("resolveTalentDispatchPlan", () => {
  it("falls back to heuristic when model output invalid", () => {
    const plan = resolveTalentDispatchPlan({
      message: "@nova 写接口 @lumi 出样式",
      assignments,
      executionMode: "parallel",
      modelText: "not json",
    });
    expect(plan.source).toBe("heuristic");
  });

  it("uses model plan when valid", () => {
    const plan = resolveTalentDispatchPlan({
      message: "@nova 设计 @lumi 开发",
      assignments,
      executionMode: "serial",
      modelText: JSON.stringify({
        intent: "串行派活",
        steps: [
          { mention: "nova", task: "设计", after: [] },
          { mention: "lumi", task: "开发", after: ["nova"] },
        ],
      }),
    });
    expect(plan.source).toBe("model");
    const talents = plan.steps.filter((s) => s.kind === "talent_background");
    expect(talents[1]!.wave).toBe(1);
  });

  it("accepts a pre-parsed model draft (unified intent call path)", () => {
    const plan = resolveTalentDispatchPlan({
      message: "@nova 设计 @lumi 开发",
      assignments,
      executionMode: "serial",
      modelDraft: {
        intent: "串行派活",
        steps: [
          { mention: "nova", task: "设计", after: [] },
          { mention: "lumi", task: "开发", after: ["nova"] },
        ],
      },
    });
    expect(plan.source).toBe("model");
    const talents = plan.steps.filter((s) => s.kind === "talent_background");
    expect(talents[1]!.wave).toBe(1);
  });

  it("keeps a flat model plan parallel when there is no positive serial signal", () => {
    // executionMode is the *ambiguous safe default* (serial), but the model
    // judged the work independent. Without forceSerialIfFlat we must respect
    // the model's parallel call rather than wrongly serializing it.
    const plan = resolveTalentDispatchPlan({
      message: "@nova 写接口 @lumi 出样式",
      assignments,
      executionMode: "serial",
      forceSerialIfFlat: false,
      modelDraft: {
        intent: "并行派活",
        steps: [
          { mention: "nova", task: "写接口", after: [] },
          { mention: "lumi", task: "出样式", after: [] },
        ],
      },
    });
    const talents = plan.steps.filter((s) => s.kind === "talent_background");
    expect(talents.every((s) => s.wave === 0)).toBe(true);
  });

  it("forces serial waves on a flat model plan when forceSerialIfFlat is set", () => {
    const plan = resolveTalentDispatchPlan({
      message: "@nova 设计 @lumi 基于上面的设计开发",
      assignments,
      executionMode: "parallel",
      forceSerialIfFlat: true,
      modelDraft: {
        intent: "先设计后开发",
        steps: [
          { mention: "nova", task: "设计", after: [] },
          { mention: "lumi", task: "开发", after: [] },
        ],
      },
    });
    const talents = plan.steps.filter((s) => s.kind === "talent_background");
    expect(talents[0]!.wave).toBe(0);
    expect(talents[1]!.wave).toBe(1);
  });

  it("uses model tasks but enforces serial waves when heuristic says serial", () => {
    const gameAssignments = [
      {
        mention: "game-designer",
        displayName: "Game Designer",
        role: "游戏设计",
        task: "设计一款有意思的小游戏",
      },
      {
        mention: "game-audio-engineer",
        displayName: "Game Audio Engineer",
        role: "音频工程",
        task: "开发设计完的游戏",
      },
    ];
    const plan = resolveTalentDispatchPlan({
      message:
        "@game-designer 设计一款有意思的小游戏 @game-audio-engineer 开发设计完的游戏",
      assignments: gameAssignments,
      executionMode: "serial",
      modelText: JSON.stringify({
        intent: "先设计后音频",
        steps: [
          { mention: "game-designer", task: "设计小游戏 GDD", after: [] },
          { mention: "game-audio-engineer", task: "实现游戏音频", after: [] },
        ],
      }),
    });
    const talents = plan.steps.filter((s) => s.kind === "talent_background");
    expect(talents[0]!.wave).toBe(0);
    expect(talents[1]!.wave).toBe(1);
    expect(talents[1]!.task).toContain("音频");
  });
});
