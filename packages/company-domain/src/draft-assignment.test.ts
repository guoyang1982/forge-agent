import { describe, expect, it } from "vitest";
import {
  composeArtifactDrafts,
  isResearchAssignment,
  parseGeneratedDrafts,
  pickDefaultAssigneeId,
  pickDefaultDrafterId,
} from "./draft-assignment.js";

describe("draft assignment", () => {
  it("prefers a product-role employee, then the owner, then the model", () => {
    const employees = [
      { id: "emp_owner", positionId: "pos_ceo" },
      { id: "emp_pm", positionId: "pos_pm" },
    ];
    const positions = [
      { id: "pos_ceo", title: "CEO" },
      { id: "pos_pm", title: "产品总监" },
    ];

    expect(
      pickDefaultDrafterId({ employees, positions, ownerId: "emp_owner" }),
    ).toBe("emp_pm");
    expect(
      pickDefaultDrafterId({
        employees: [employees[0]],
        positions,
        ownerId: "emp_owner",
      }),
    ).toBe("emp_owner");
    expect(pickDefaultDrafterId({ employees: [], positions: [] })).toBeNull();
  });

  it("prefers a market researcher for research work, else the product seat", () => {
    const employees = [
      { id: "emp_owner", positionId: "pos_ceo" },
      { id: "emp_pm", positionId: "pos_pm" },
      { id: "emp_research", positionId: "pos_mr" },
    ];
    const positions = [
      { id: "pos_ceo", title: "研发负责人" },
      { id: "pos_pm", title: "产品助理" },
      { id: "pos_mr", title: "市场调查员" },
    ];

    expect(
      pickDefaultDrafterId({
        employees,
        positions,
        ownerId: "emp_owner",
        kind: "research",
      }),
    ).toBe("emp_research");
    expect(
      pickDefaultDrafterId({
        employees: employees.slice(0, 2),
        positions,
        ownerId: "emp_owner",
        kind: "research",
      }),
    ).toBe("emp_pm");
  });

  it("assigns research work to the market researcher, else product, else a writer", () => {
    const positions = [
      { id: "pos_eng", title: "执行工程师" },
      { id: "pos_pm", title: "产品助理" },
      { id: "pos_mr", title: "市场调查员" },
    ];
    const engineer = {
      id: "emp_eng",
      positionId: "pos_eng",
      workspaces: [{ isDefault: true, mode: "write" }],
    };
    const product = { id: "emp_pm", positionId: "pos_pm", workspaces: [] };
    const researcher = { id: "emp_research", positionId: "pos_mr", workspaces: [] };

    expect(
      pickDefaultAssigneeId({
        employees: [engineer, product, researcher],
        positions,
        kind: "research",
      }),
    ).toBe("emp_research");
    expect(
      pickDefaultAssigneeId({
        employees: [engineer, product],
        positions,
        kind: "research",
      }),
    ).toBe("emp_pm");
    expect(
      pickDefaultAssigneeId({
        employees: [engineer, product],
        positions,
      }),
    ).toBe("emp_eng");
  });

  it("treats feasibility and market titles as research assignments", () => {
    expect(isResearchAssignment({ type: "research" })).toBe(true);
    expect(isResearchAssignment({ type: "implementation", title: "开发：可行性调研后的应用" })).toBe(false);
    expect(
      isResearchAssignment({ title: "ai数字人组做一个app是否可行" }),
    ).toBe(true);
    expect(isResearchAssignment({ title: "窗格最大化" })).toBe(false);
  });

  it("parses model JSON and falls back to the demand template", async () => {
    expect(
      parseGeneratedDrafts('{"spec":"范围","plan":"先做按钮"}'),
    ).toEqual({ spec: "范围", plan: "先做按钮" });
    expect(parseGeneratedDrafts("not json")).toBeNull();

    const generated = await composeArtifactDrafts({
      title: "窗格最大化",
      problem: "一键最大化",
      expectedOutcome: "可还原",
      drafter: { id: "emp_pm", displayName: "林川", title: "产品总监" },
      generate: async () => '{"spec":"按钮在标题栏","plan":"先改状态"}',
    });
    expect(generated.source).toBe("employee");
    expect(generated.spec).toContain("按钮在标题栏");
    expect(generated.spec).toContain("起草：林川 · 产品总监");

    const fallback = await composeArtifactDrafts({
      title: "窗格最大化",
      problem: "一键最大化",
      expectedOutcome: "可还原",
      generate: async () => {
        throw new Error("no key");
      },
    });
    expect(fallback.source).toBe("template");
    expect(fallback.error).toContain("no key");
    expect(fallback.spec).toContain("一键最大化");
    expect(fallback.spec).toContain("起草：模型代写");

    const unparsed = await composeArtifactDrafts({
      title: "窗格最大化",
      problem: "一键最大化",
      expectedOutcome: "可还原",
      generate: async () => "规格写得很长，但不是 JSON",
    });
    expect(unparsed.source).toBe("template");
    expect(unparsed.error).toContain("无法解析");

    const timedOut = await composeArtifactDrafts({
      title: "窗格最大化",
      problem: "一键最大化",
      expectedOutcome: "可还原",
      generate: async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });
    expect(timedOut.source).toBe("template");
    expect(timedOut.error).toBe("模型起草超时");
  });

  it("asks the model to draft from the employee talent pack instead of copying the demand", async () => {
    let prompt = "";
    const generated = await composeArtifactDrafts({
      title: "做一个小游戏",
      problem: "陨石落到地球的求生游戏",
      expectedOutcome: "能玩，画面精美",
      drafter: { id: "emp_pm", displayName: "乔麦", title: "产品助理" },
      talent: {
        role: "产品助理",
        skills: ["需求拆解", "验收标准"],
        methodology: ["先写范围和非目标"],
        qualityGates: ["验收可判定"],
        systemPrompt: "你负责把模糊需求写成可执行规格。",
      },
      generate: async (text) => {
        prompt = text;
        return '{"spec":"## 范围\\n陨石求生","plan":"## 步骤\\n先出可玩原型"}';
      },
    });

    expect(prompt).toContain("乔麦 · 产品助理");
    expect(prompt).toContain("人才包角色：产品助理");
    expect(prompt).toContain("需求拆解");
    expect(prompt).toContain("先写范围和非目标");
    expect(prompt).toContain("验收可判定");
    expect(prompt).toContain("你负责把模糊需求写成可执行规格");
    expect(prompt).toContain("不要照抄需求原文");
    expect(generated.source).toBe("employee");
    expect(generated.talentRole).toBe("产品助理");
    expect(generated.spec).toContain("陨石求生");
    expect(generated.spec).toContain("起草：乔麦 · 产品助理");
  });

  it("puts the employee's recalled notes into the draft prompt", async () => {
    let prompt = "";
    await composeArtifactDrafts({
      title: "修复还原",
      problem: "最大化后比例错",
      expectedOutcome: "能还原",
      drafter: { id: "emp_pm", displayName: "乔麦", title: "产品助理" },
      memories: ["驳回：还原比例仍错"],
      generate: async (text) => {
        prompt = text;
        return '{"spec":"还原","plan":"先复现"}';
      },
    });
    expect(prompt).toContain("这个人身上的经验");
    expect(prompt).toContain("驳回：还原比例仍错");
  });
});
