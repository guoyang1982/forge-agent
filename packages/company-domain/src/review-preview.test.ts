import { describe, expect, it } from "vitest";
import {
  buildReviewPreviewPrompt,
  composeReviewPreview,
  parseReviewPreview,
  pickDefaultReviewerId,
} from "./review-preview.js";

describe("review preview", () => {
  it("picks a quality-role reviewer who is not the executor", () => {
    const employees = [
      { id: "emp_owner", positionId: "pos_eng" },
      { id: "emp_qa", positionId: "pos_qa" },
      { id: "emp_dev", positionId: "pos_eng" },
    ];
    const positions = [
      { id: "pos_eng", title: "执行工程师" },
      { id: "pos_qa", title: "质量负责人" },
    ];

    expect(
      pickDefaultReviewerId({
        employees,
        positions,
        assigneeId: "emp_dev",
        ownerId: "emp_owner",
      }),
    ).toBe("emp_qa");
    expect(
      pickDefaultReviewerId({
        employees: employees.filter((employee) => employee.id !== "emp_qa"),
        positions,
        assigneeId: "emp_dev",
        ownerId: "emp_owner",
      }),
    ).toBe("emp_owner");
    expect(
      pickDefaultReviewerId({
        employees: [{ id: "emp_dev", positionId: "pos_eng" }],
        positions,
        assigneeId: "emp_dev",
      }),
    ).toBeNull();
  });

  it("asks the model to review with the reviewer's talent pack and parses the conclusion", async () => {
    const prompt = buildReviewPreviewPrompt({
      title: "移动端也能看公司经营台",
      problem: "出差只带手机",
      expectedOutcome: "手机能看总览和待审批",
      spec: "静态单页",
      plan: "替换 snake.html",
      runId: "run_1",
      reviewer: { id: "emp_qa", displayName: "沈清", title: "质量负责人" },
      talent: {
        role: "质量负责人",
        skills: ["code-review", "acceptance"],
        qualityGates: ["对照验收标准"],
        systemPrompt: "你必须对照验收标准，缺证据就驳回。",
      },
      memories: ["上次驳回：缺还原比例证据"],
    });
    expect(prompt).toContain("沈清 · 质量负责人");
    expect(prompt).toContain("code-review");
    expect(prompt).toContain("对照验收标准");
    expect(prompt).toContain("你必须对照验收标准");
    expect(prompt).toContain("上次驳回：缺还原比例证据");
    expect(prompt).toContain("run_1");
    expect(prompt).toContain("对照规格、计划和这次执行成果");

    const researchPrompt = buildReviewPreviewPrompt({
      title: "ai数字人组成公司做一个app是否可行",
      problem: "是否可行",
      expectedOutcome: "明确是否值得开发",
      spec: "必须给出30天计划和停止条件",
      plan: "第10步只写验证计划",
      workType: "research",
      resultExcerpt: "结论：有条件可行。停止条件 ST1-ST8 已写入 04-30天验证计划。",
      workspaceFiles: ["docs/ai-company-feasibility/00-决策摘要.md"],
      reviewer: { id: "emp_qa", displayName: "沈清", title: "质量负责人" },
      talent: { role: "代码审查工程师" },
    });
    expect(researchPrompt).toContain("验收对象是已经产出的调研报告");
    expect(researchPrompt).toContain("不要因此把整份桌面研究驳回");
    expect(researchPrompt).toContain("00-决策摘要.md");
    expect(researchPrompt).toContain("有条件可行");

    expect(parseReviewPreview('{"recommendation":"approved","summary":"达到验收","findings":["覆盖总览"]}')).toEqual({
      recommendation: "approved",
      summary: "达到验收",
      findings: ["覆盖总览"],
    });

    const preview = await composeReviewPreview({
      title: "移动端也能看公司经营台",
      problem: "出差只带手机",
      expectedOutcome: "手机能看总览和待审批",
      spec: "静态单页",
      plan: "替换 snake.html",
      runId: "run_1",
      reviewer: { id: "emp_qa", displayName: "沈清", title: "质量负责人" },
      talent: { role: "质量负责人", skills: ["acceptance"] },
      generate: async () =>
        '{"recommendation":"rejected","summary":"缺待审批列表","findings":["移动端没有审批入口"]}',
    });
    expect(preview).toMatchObject({
      reviewerId: "emp_qa",
      recommendation: "rejected",
      summary: "缺待审批列表",
      findings: ["移动端没有审批入口"],
      source: "employee",
      talentRole: "质量负责人",
    });
  });
});
