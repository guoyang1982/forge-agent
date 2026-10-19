import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../../markdown-preview-entry.js";

globalThis.ForgeMarkdownPreview = { renderMarkdown };

const source = readFileSync(
  join(import.meta.dirname, "delivery-ui.js"),
  "utf8",
);
const ui = Function(`${source}\nreturn ForgeDeliveryUi;`)();

function researchFixture() {
  return {
    claims: [
      {
        id: "c1",
        classification: "fact",
        text: "转化漏斗在注册后掉 18%",
        evidenceIds: ["e1"],
        evidence: [{ id: "e1", source: "analytics", version: "v3", locator: "funnel.csv:12" }],
      },
      { id: "c2", classification: "inference", text: "引导文案过长导致流失", evidenceIds: [] },
      { id: "c3", classification: "hypothesis", text: "缩短第三步可提升转化", evidenceIds: [] },
      { id: "c4", classification: "unknown", text: "竞品是否同期改版未知", evidenceIds: [] },
    ],
  };
}

function failedResearchFixture() {
  return {
    reports: [],
    claims: [],
    researchItems: [{ id: "work-1" }],
    workspaceFiles: [{ path: "docs/ai-company-feasibility/00-决策摘要.md", runId: "r1" }],
    workbenchRun: {
      runId: "r1",
      stepId: "s1",
      sessionId: "sess-1",
      cwd: "/tmp/repo",
      state: "failed",
    },
  };
}

describe("delivery UI", () => {
  it("does not reuse a previous report while a newer research task is pending", () => {
    const model = ui.buildResultsModel([
      { id: "old", projectId: "p", type: "research", createdAt: "2026-09-10", updatedAt: "2026-09-14", trace: { outputs: [{ id: "report", content: "旧结论" }] } },
      { id: "new", projectId: "p", type: "research", createdAt: "2026-09-13", state: "in_progress" },
    ], "p");
    expect(model.hasResults).toBe(false);
    expect(model.reports).toEqual([]);
    expect(model.outputs).toHaveLength(1);
    expect(ui.renderResearchPage(model)).toContain("调研正在进行");
  });

  it("escapes generated report markup", () => {
    const html = ui.renderDocument('# Report\n<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Report');
  });

  it("keeps project results isolated and never presents the demand as a conclusion", () => {
    const items = [
      { id: "w1", projectId: "p1", type: "research", problem: "是否可行？", state: "completed", trace: { outputs: [{ id: "a1", runId: "r1", content: "建议先做小规模验证。" }] } },
      { id: "w2", projectId: "p2", type: "research", problem: "另一个需求", trace: { outputs: [{ id: "a2", content: "其他项目报告" }] } },
    ];
    const model = ui.buildResultsModel(items, "p1");
    expect(model.items.map((item) => item.id)).toEqual(["w1"]);
    const html = ui.renderResearchPage(model);
    expect(html).toContain("建议先做小规模验证。");
    expect(html).toContain('data-open-output="a1"');
    expect(html).not.toContain("是否可行？");
    expect(html).not.toContain("其他项目报告");
    expect(ui.buildResultsModel(items, "").items).toEqual([]);
  });

  it("does not invent results for completed work with a missing body", () => {
    const model = ui.buildResultsModel([{ id: "w", projectId: "p", type: "research", state: "completed", problem: "需求原文" }], "p");
    expect(model.hasResults).toBe(false);
    expect(ui.renderResearchPage(model)).toContain("尚未找到调研正文");
    expect(ui.renderResearchPage(model)).not.toContain("需求原文");
  });

  it("shows only the current decision and requires a result before continuing development", () => {
    const gates = ["research", "scope", "technical", "release"].map((kind) => ({ kind }));
    const empty = ui.renderStageGatePanel({ projectId: "p", gates, hasResults: false });
    expect(empty).not.toContain('data-gate-outcome="approved"');
    const ready = ui.renderStageGatePanel({ projectId: "p", gates, hasResults: true });
    expect(ready).toContain('data-gate-outcome="approved"');
    expect(ready).not.toContain('data-gate="scope"');
    expect(ready).not.toContain('data-gate="technical"');
    expect(ready).not.toContain('data-gate="release"');
  });

  it("renders fact inference hypothesis and unknown distinctly", () => {
    const html = ui.renderResearchPage(researchFixture());
    for (const label of ["事实", "推断", "假设", "未知"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("claim-fact");
    expect(html).toContain("claim-inference");
    expect(html).toContain("claim-hypothesis");
    expect(html).toContain("claim-unknown");
    expect(html).toContain('data-open-evidence="e1"');
  });

  it("lists workbench files on the research page and offers takeover only when the run failed", () => {
    const html = ui.renderResearchPage(failedResearchFixture());
    expect(html).toContain("docs/ai-company-feasibility/00-决策摘要.md");
    expect(html).toContain("不收入公司产物");
    expect(html).toContain("在工作台打开工作区");
    expect(html).toContain("在工作台接管");
    expect(html).toContain('data-open-run="r1"');
    expect(html).toContain('data-open-workspace-file="docs/ai-company-feasibility/00-决策摘要.md"');
    expect(html).toContain('data-file-work="work-1"');
    expect(html).toContain("file-list");
    expect(html).toContain("00-决策摘要.md");
    expect(html).not.toContain("在工作中心打开");
    expect(html).not.toContain("成本");

    const openWorkbench = vi.fn();
    ui.openWorkbenchTakeover(openWorkbench, {
      runId: "r1",
      stepId: "s1",
      workItemId: "work-1",
      sessionId: "sess-1",
      cwd: "/tmp/repo",
    });
    expect(openWorkbench).toHaveBeenCalledWith("forge://workbench/run/r1", {
      workItemId: "work-1",
      sessionId: "sess-1",
      cwd: "/tmp/repo",
      stepId: "s1",
      mode: "takeover",
    });
  });

  it("keeps stage gate actions as keyboard-accessible buttons", () => {
    const html = ui.renderStageGatePanel({
      projectId: "project-1",
      actorId: "emp-1",
      gates: [
        { kind: "research", ownerName: "乔麦", latest: { outcome: "approved", nextAction: "enter_product_definition" } },
        { kind: "release", ownerName: "林川" },
      ],
    });
    expect(html).toContain('type="button"');
    expect(html).not.toMatch(/onmouseover|hover-only|:hover \{ display/);
    expect(html).toContain('data-followup="implementation"');
    expect(html).not.toContain('data-gate="release"');
    expect(html).toContain("已批准");
    expect(html).toContain("决策记录");
  });

  it("advances the delivery loop from intake to research gates", () => {
    expect(ui.deliveryActiveStep({ hasIntake: false, hasClaims: false, gates: {} })).toBe("intake");
    expect(ui.deliveryActiveStep({ hasIntake: true, hasClaims: false, gates: {} })).toBe("research");
    expect(ui.deliveryActiveStep({
      hasIntake: true,
      hasClaims: true,
      gates: { research: { outcome: "approved" } },
    })).toBe("gates");
    expect(ui.deliveryActiveStep({
      hasIntake: true,
      hasClaims: true,
      gates: { research: { outcome: "stopped" } },
    })).toBe("research");
    expect(ui.labelOutcome("approved")).toBe("已批准");
    expect(ui.labelState("waiting_approval")).toBe("待验收");
  });

  it("renders research reports as markdown, not raw tags", () => {
    const html = ui.renderDocument("结论：**有条件可行**\n\n| 底线 | 结果 |\n| --- | --- |\n| 技术 | 通过 |");
    expect(html).toContain("<strong>有条件可行</strong>");
    expect(html).toContain("<table>");
    expect(html).not.toContain("**有条件可行**");
    expect(html).not.toContain("| 底线 |");
  });
});

describe("research report highlights", () => {
  it("extracts only explicit sections and preserves missing information", () => {
    const result = ui.researchHighlights("# 报告\n## 一句话结论\n值得做小规模验证。\n## 风险\n样本不足。\n## 下一步建议\n访谈五位用户。");
    expect(result.conclusion).toBe("值得做小规模验证。");
    expect(result.risks).toBe("样本不足。");
    expect(result.evidence).toBe("");
    expect(ui.researchHighlights("用户需求：做一个应用").conclusion).toBe("");
  });
  it("does not interpret headings inside code blocks as conclusions", () => {
    expect(ui.researchHighlights("```md\n## 一句话结论\n已完成\n```").conclusion).toBe("");
  });
});

it("keeps shorter or annotated fences inside a fenced example", () => {
  for (const inner of ["```", "````not-a-close"]) {
    expect(ui.researchHighlights(`\`\`\`\`md\n${inner}\n## 一句话结论\n示例并非结论\n\`\`\`\`\n## 风险\n真实风险`).conclusion).toBe("");
  }
});

it("prefers bound structured research fields and keeps legacy fallback for foreign provenance", () => {
  const report = { runId: "r", contentRef: "o", content: "## 结论\nLegacy conclusion", researchResult: {
    schemaVersion: 1, conclusion: "Structured conclusion", evidence: [{ claim: "Evidence claim", source: "https://example.com/source" }],
    risks: [], unknowns: ["Unverified demand"], nextActions: ["Interview users"], missingFields: ["risks"],
    source: { runId: "r", outputRef: "o", reportHash: "hash" },
  } };
  const html = ui.renderResearchPage({ reports: [report] });
  expect(html).toContain("Structured conclusion");
  expect(html).toContain("Evidence claim");
  expect(html).toContain("报告未单独提供");
  const foreign = ui.renderResearchPage({ reports: [{ ...report, researchResult: { ...report.researchResult, source: { ...report.researchResult.source, runId: "other" } } }] });
  expect(foreign).not.toContain("Structured conclusion");
  expect(foreign).toContain("Legacy conclusion");
});


describe("server-authoritative decisions", () => {
  const base = { projectId: "p", actorId: "a", hasResults: true, gates: [{ kind: "research" }] };
  it("hides actions when server inputs are not ready", () => {
    const html = ui.renderStageGatePanel({ ...base, snapshots: { research: { ready: false, projectState: "active", reason: "请先完成调研" } } });
    expect(html).not.toContain('data-gate-outcome=');
    expect(html).toContain("请先完成调研");
  });
  it("requires persisted completed state to display archived", () => {
    const gates = [{ kind: "research", latest: { outcome: "stopped" } }];
    expect(ui.renderStageGatePanel({ ...base, gates, snapshots: { research: { ready: false, projectState: "active" } } })).not.toContain("已归档");
    const archived = ui.renderStageGatePanel({ ...base, gates, snapshots: { research: { ready: false, projectState: "completed" } } });
    expect(archived).toContain("已归档");
    expect(archived).not.toContain('data-gate-outcome=');
  });
  it("disables every decision while submitting", () => {
    const html = ui.renderStageGatePanel({ ...base, pending: true, snapshots: { research: { ready: true, projectState: "active" } } });
    expect(html.match(/disabled data-gate-outcome=/g)).toHaveLength(3);
  });
  it("offers decisions on the idea-only workflow path when the snapshot is ready without classic outputs", () => {
    const html = ui.renderStageGatePanel({
      projectId: "p", actorId: "a", hasResults: false, gates: [{ kind: "research" }],
      snapshots: { research: { ready: true, projectState: "active" } },
    });
    expect(html).toContain('data-gate-outcome="approved"');
    expect(html).toContain('data-gate-outcome="stopped"');
    const notReady = ui.renderStageGatePanel({
      projectId: "p", actorId: "a", hasResults: false, gates: [{ kind: "research" }],
      snapshots: { research: { ready: false, projectState: "active", reason: "research synthesis must succeed before the research gate" } },
    });
    expect(notReady).not.toContain('data-gate-outcome=');
  });
  it("shows the waiting synthesis recommendation before the decision", () => {
    const workflow = {
      workflowRunId: "run-1", waitingAtGate: true,
      synthesisRecommendation: "enter_product_definition",
      synthesisSummary: "调研结论支持进入需求设计：基于 4 条论断，0 处冲突，0 项未知。",
    };
    const html = ui.renderStageGatePanel({
      projectId: "p", actorId: "a", hasResults: false, gates: [{ kind: "research" }], workflow,
      snapshots: { research: { ready: true, projectState: "active" } },
    });
    expect(html).toContain("系统建议：建议进入需求设计");
    expect(html).toContain("详细论断在左侧");
    expect(html.indexOf("系统建议：建议进入需求设计")).toBeLessThan(html.indexOf('data-gate-outcome="approved"'));
    const cont = ui.renderStageGatePanel({
      projectId: "p", actorId: "a", hasResults: false, gates: [{ kind: "research" }],
      workflow: { ...workflow, synthesisRecommendation: "continue_research", synthesisSummary: "建议继续补充调研：基于 3 条论断，1 处冲突，0 项未知。" },
      snapshots: { research: { ready: true, projectState: "active" } },
    });
    expect(cont).not.toContain("建议进入需求设计");
    expect(cont).toContain("系统建议：建议继续补充调研");
    const notWaiting = ui.renderStageGatePanel({
      projectId: "p", actorId: "a", hasResults: true, gates: [{ kind: "research" }], workflow: { ...workflow, waitingAtGate: false },
    });
    expect(notWaiting).not.toContain("系统建议：建议进入需求设计");
  });
  it("keeps archived demand readable without a new intake form", () => {
    const html = ui.renderIntakePage({ archived: true, existing: { problem: "Original question" } });
    expect(html).toContain("Original question");
    expect(html).not.toContain("deliveryIntakeForm");
  });
});

describe("feasibility start panel", () => {
  it("shows feasibility start only when research is runnable", () => {
    expect(ui.renderFeasibilityStart({ runnable: false })).not.toContain("评估想法可行性");
    expect(ui.renderFeasibilityStart({})).toBe("");
    expect(ui.renderFeasibilityStart({ runnable: true, briefId: "brief-1" })).toContain("评估想法可行性");
  });

  it("never offers product delivery start", () => {
    const html = ui.renderFeasibilityStart({ runnable: true, briefId: "brief-1", projectId: "p1" });
    expect(html).not.toContain("启动产品交付");
    expect(html).not.toContain("product-delivery");
  });

  it("carries start identifiers and disables the button without a brief or while pending", () => {
    const ready = ui.renderFeasibilityStart({ runnable: true, briefId: "brief<1>", projectId: "p1" });
    expect(ready).toContain('data-start-feasibility');
    expect(ready).toContain('data-brief-id="brief&lt;1&gt;"');
    expect(ready).toContain('data-project-id="p1"');
    expect(ready).not.toMatch(/data-start-feasibility[^>]*disabled/);
    expect(ui.renderFeasibilityStart({ runnable: true, projectId: "p1" })).toMatch(/data-start-feasibility[^>]*disabled/);
    expect(ui.renderFeasibilityStart({ runnable: true, briefId: "b", pending: true })).toMatch(/data-start-feasibility[^>]*disabled/);
  });

  it("shows the recommendation to enter requirement design after an approved research decision", () => {
    const html = ui.renderFeasibilityStart({ runnable: true, briefId: "b", nextAction: "enter_product_definition" });
    expect(html).toContain("建议进入需求设计");
  });

  it("shows the registered idea text in the feasibility card", () => {
    const html = ui.renderFeasibilityStart({
      runnable: true,
      briefId: "brief-1",
      idea: { problem: "ai数字人组成公司做一个app是否可行", expectedOutcome: "明确是否值得开发" },
    });
    expect(html).toContain("当前想法");
    expect(html).toContain("ai数字人组成公司做一个app是否可行");
    expect(html).toContain("期望结果：明确是否值得开发");
    expect(html).toContain("简报已就绪");
  });

  it("renders the formal research report instead of the template memo", () => {
    const html = ui.renderResearchPage({
      reports: [],
      researchItems: [{ id: "w1", title: "闲置互换", problem: "是否用贝壳互换" }],
      workflow: {
        runState: "waiting",
        waitingAtGate: true,
        synthesisRecommendation: "stop",
        formalReport: [
          "# 闲置互换 调研报告",
          "结论：不做原想法",
          "## 一、结论",
          "现金二手更可能做成。",
          "## 关键指标",
          "- 二手规模：约 1.82 万亿元（市场段）",
          "### 竞品与替代",
          "| 名称 | 形态 |",
          "| 闲鱼 | 现金买卖 |",
          "## 三、建议",
          "1. 推导：先做临期库存",
          "## 四、工作量参考",
          "本节只估计实现成本，不作为做或不做的依据。",
        ].join("\n"),
        readingBrief: {
          branches: [
            { id: "code-data-research", label: "代码与数据", summary: "判断：仓库没有账本。\n原因：只有静态页。\n缺口：无。", claimCount: 1 },
          ],
        },
        decisionMemo: {
          verdictLabel: "建议不做原想法（停止或改方向）",
          reasons: [],
          metrics: [],
          competitors: [],
          risks: [],
          directions: [{ title: "换非未成年人赛道", why: "套模板", nextStep: "另开" }],
          attachments: [],
          chart: { label: "规模", points: [{ name: "闲鱼", valueLabel: "1", ratio: 1 }] },
        },
      },
    });
    expect(html).toContain("调研报告");
    expect(html).toContain("现金二手更可能做成");
    expect(html).toContain("推导：先做临期库存");
    expect(html).toContain("工作量原文");
    expect(html).not.toContain("换非未成年人赛道");
    expect(html).not.toContain("memo-bars");
  });

  it("renders workflow synthesis claims on the research page without work-item reports", () => {
    const html = ui.renderResearchPage({
      reports: [],
      researchItems: [{ id: "w1", title: "周报助手", problem: "是否值得做" }],
      workflow: {
        runState: "waiting",
        waitingAtGate: true,
        synthesisRecommendation: "continue_research",
        synthesisSummary: "建议继续补充调研：基于 12 条论断，1 处冲突，2 项未知。",
        claimTotal: 13,
        readingBrief: {
          executiveSummary: "决策：继续补充调研，暂不立项\n建议方向（可直接选一条做下一轮）：\n1. 补一手证据后再决策 — 现有论断仍有缺口。 下一步：先补访谈。",
          suggestedDirections: [
            {
              title: "补一手证据后再决策",
              why: "现有论断仍有缺口或冲突，不宜直接开工。",
              nextStep: "先补访谈/定价中最关键的 1–2 项，再重跑评估。",
            },
          ],
          branches: [
            {
              id: "user-research",
              label: "用户调研",
              summary: "判断：继续调研 — 痛点真实但付费未验证。\n原因：创作者有周报整理负担。\n缺口：竞品定价仍不清晰。",
              highlights: ["创作者普遍有周报整理负担"],
              claimCount: 1,
            },
            {
              id: "market-research",
              label: "市场调研",
              summary: "判断：继续调研 — 市场尚不清楚。\n原因：工具拥挤。\n缺口：竞品定价仍不清晰。",
              highlights: ["竞品定价仍不清晰"],
              claimCount: 1,
            },
          ],
        },
        claims: [
          { id: "user-research:0", text: "创作者普遍有周报整理负担", classification: "fact", evidenceIds: ["https://example.com/a"] },
          { id: "market-research:0", text: "竞品定价仍不清晰", classification: "unknown", evidenceIds: [] },
          { id: "claim-recommendation", text: "Research recommendation: continue_research", classification: "inference", evidenceIds: [] },
        ],
      },
    });
    expect(html).toContain("① 总览结论");
    expect(html).toContain("② 建议方向");
    expect(html).toContain("补一手证据后再决策");
    expect(html).toContain("③ 分段结论");
    expect(html).toContain("继续调研");
    expect(html).toContain("结论");
    expect(html).toContain("查看原始论断（多为英文，1）");
    expect(html).toContain("已掌握的公开事实");
    expect(html).toContain("创作者普遍有周报整理负担");
    expect(html).toContain("竞品定价仍不清晰");
    expect(html).not.toContain("Research recommendation:");
    expect(html).not.toContain("尚无正文");
  });

  it("renders the formal decision memo when decisionMemo is present", () => {
    const html = ui.renderResearchPage({
      reports: [],
      researchItems: [{ id: "w1", title: "老年出行打车", problem: "是否值得做" }],
      workflow: {
        runState: "waiting",
        waitingAtGate: true,
        synthesisRecommendation: "continue_research",
        synthesisSummary: "建议继续补充调研：基于 3 条论断。",
        decisionMemo: {
          title: "老年出行打车",
          evaluatedAt: "2026-10-12",
          claimTotal: 3,
          recommendation: "continue_research",
          verdictLabel: "继续验证，暂不按原方案直接立项",
          reasons: [
            {
              text: "供给已被滴滴长辈版占据",
              sources: [{ label: "news.qq.com", url: "https://news.qq.com/a" }],
            },
          ],
          metrics: [{ label: "60+ 人口", value: "3.1 亿", sources: [{ label: "stats.gov.cn", url: "https://www.stats.gov.cn/" }] }],
          competitors: [{
            name: "滴滴长辈版",
            form: "平台内功能",
            scale: "2.65 亿次",
            implication: "获客极难",
            sources: [{ label: "news.qq.com", url: "https://news.qq.com/a" }],
          }],
          risks: [{
            text: "未持牌从事网约车经营",
            severity: "veto",
            implication: "需持牌授权",
            sources: [{ label: "gov.cn", url: "https://www.gov.cn/" }],
          }],
          directions: [{
            title: "大平台之上的适老体验层",
            why: "通用独立 App 被分流",
            nextStep: "先做 L0 观察",
          }],
          attachments: [{
            id: "market-research",
            label: "市场调研",
            summary: "判断：可推进。\n原因：细分场景。\n缺口：一手数据。",
            highlights: ["滴滴长辈版覆盖广"],
            claims: [{
              id: "market-research:0",
              text: "Didi senior rides 265 million",
              classification: "fact",
              evidenceIds: ["https://news.qq.com/a"],
            }],
          }],
        },
        claims: [],
      },
    });
    expect(html).toContain("可行性决策备忘录");
    expect(html).toContain("继续验证，暂不按原方案直接立项");
    expect(html).toContain("竞品 / 替代供给对照");
    expect(html).toContain("https://news.qq.com/a");
    expect(html).toContain("一票否决级");
    expect(html).toContain("附件（默认折叠 · 备查）");
    expect(html).toContain("Didi senior rides 265 million");
    expect(html).not.toContain("① 总览结论");
  });

  it("keeps current-idea artifacts separate from other project history", () => {
    const model = ui.buildResultsModel([
      {
        id: "current", projectId: "p", type: "research", title: "周报助手", createdAt: "2026-10-10",
        trace: { outputs: [], runs: [] },
      },
      {
        id: "old", projectId: "p", type: "research", title: "ai数字人组成公司做一个app是否可行", createdAt: "2026-09-11",
        trace: {
          runs: [{ runId: "r-old" }],
          outputs: [{ id: "out-old", runId: "r-old", content: "旧报告", createdAt: "2026-09-11", workState: "submitted" }],
        },
      },
    ], "p");
    expect(model.currentOutputs).toHaveLength(0);
    expect(model.historicalOutputs).toHaveLength(1);
    const html = ui.renderArtifactsPanel({ ...model, workflow: { synthesisRecommendation: "continue_research" } });
    expect(html).toContain("当前想法走的是");
    expect(html).toContain("同项目其他想法的历史产物（1）");
    expect(html).toContain("ai数字人组成公司做一个app是否可行");
  });

  it("points registered research toward feasibility when results are not ready yet", () => {
    const model = ui.buildResultsModel([
      { id: "w", projectId: "p", type: "research", title: "ai数字人组成公司做一个app是否可行", problem: "全文", state: "draft" },
    ], "p");
    const html = ui.renderResearchPage(model);
    expect(html).toContain("已登记想法");
    expect(html).toContain("ai数字人组成公司做一个app是否可行");
    expect(html).toContain("评估想法可行性");
    expect(html).not.toContain("全文");
  });
});
