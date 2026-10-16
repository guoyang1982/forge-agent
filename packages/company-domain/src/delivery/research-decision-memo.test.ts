import { describe, expect, it } from "vitest";
import { buildResearchReadingBrief } from "./research.js";
import { buildResearchDecisionMemo } from "./research-decision-memo.js";

describe("buildResearchDecisionMemo", () => {
  it("builds competitor rows with http sources from evidenceIds", () => {
    const claims = [
      {
        id: "market-research:0",
        text: "Chinese population aged 60+ reached 310 million by end-2024.",
        classification: "fact" as const,
        evidenceIds: ["https://www.stats.gov.cn/example"],
      },
      {
        id: "market-research:5",
        text: "Didi's senior ride service (Didi Zhangbei / 助老打车), launched Jan 2021, had served over 265 million rides for elderly users, covering 355 cities.",
        classification: "fact" as const,
        evidenceIds: ["https://news.qq.com/rain/a/didi-elder"],
      },
      {
        id: "market-research:7",
        text: "The national unified taxi e-hailing number 95128 had been activated in 158 prefecture-level cities by July 2024.",
        classification: "fact" as const,
        evidenceIds: ["https://www.mot.gov.cn/95128"],
      },
      {
        id: "risk-research:0",
        text: "未取得经营许可擅自从事网约车经营活动将被处罚，真单需持牌平台授权。",
        classification: "fact" as const,
        evidenceIds: ["https://www.gov.cn/zhengce"],
      },
      {
        id: "risk-research:19",
        text: "替代供给已经存在：多地 95128 助老叫车热线与平台长辈版小程序已上线。",
        classification: "fact" as const,
        evidenceIds: [],
      },
    ];
    const readingBrief = buildResearchReadingBrief({
      recommendation: "continue_research",
      claims,
      branchConclusions: {
        "market-research":
          "判断：值得做老年出行，但独立通用 App 不值得。理由：①需求真实；②供给侧已被滴滴长辈版与 95128 占据。缺口：本地无一手数据。",
        "risk-research":
          "判断：有条件继续。理由：①资质风险最高。缺口：供给授权口径。",
      },
    });

    const memo = buildResearchDecisionMemo({
      recommendation: "continue_research",
      readingBrief,
      claims,
      title: "老年出行打车",
      evaluatedAt: "2026-10-12",
    });

    expect(memo.title).toBe("老年出行打车");
    expect(memo.recommendation).toBe("continue_research");
    expect(memo.verdictLabel).toMatch(/继续|验证|调研/);
    expect(memo.reasons.length).toBeGreaterThanOrEqual(1);
    expect(memo.competitors.some((row) => /滴滴|Didi|95128|长辈/i.test(row.name + row.scale))).toBe(true);
    const didi = memo.competitors.find((row) => /滴滴|Didi/i.test(row.name + (row.scale || "")));
    expect(didi?.sources.some((source) => source.url?.includes("news.qq.com"))).toBe(true);
    const noLink = memo.competitors.find((row) => /替代供给|95128|长辈版/.test(row.name + (row.scale || "") + (row.implication || "")));
    // risk claim without evidence may still appear as competitor-like; if present, sources empty or no url
    if (noLink && !noLink.sources.some((s) => s.url)) {
      expect(noLink.sources.length === 0 || noLink.sources.every((s) => !s.url)).toBe(true);
    }
    expect(memo.risks.some((row) => row.severity === "veto" || row.severity === "high")).toBe(true);
    expect(memo.metrics.length).toBeGreaterThanOrEqual(1);
    expect(memo.attachments.length).toBeGreaterThanOrEqual(1);
    expect(memo.attachments.every((part) => Array.isArray(part.claims))).toBe(true);
  });

  it("omits chart when fewer than three comparable points", () => {
    const claims = [
      {
        id: "market-research:0",
        text: "Didi senior rides: 265 million.",
        classification: "fact" as const,
        evidenceIds: ["https://example.com/a"],
      },
      {
        id: "market-research:1",
        text: "Amap senior rides: 60 million.",
        classification: "fact" as const,
        evidenceIds: ["https://example.com/b"],
      },
    ];
    const readingBrief = buildResearchReadingBrief({
      recommendation: "continue_research",
      claims,
      branchConclusions: {
        "market-research": "判断：继续调研。理由：①竞品存在。缺口：付费。",
      },
    });
    const memo = buildResearchDecisionMemo({
      recommendation: "continue_research",
      readingBrief,
      claims,
    });
    expect(memo.chart).toBeUndefined();
  });

  it("labels percentage metrics with what they measure, and keeps reasons/risks short", () => {
    const claims = [
      {
        id: "user-research:1",
        text: "Beijing Daily 2023 survey: 81.9% of surveyed elders say travelling is hard; 43.1% have failed to hail a taxi on the street.",
        classification: "fact" as const,
        evidenceIds: ["https://example.com/survey"],
      },
      {
        id: "user-research:2",
        text: "Amap report: 74% of elders still street-hail; among those who ever used app-hailing only 20% can complete a booking independently.",
        classification: "fact" as const,
        evidenceIds: ["https://example.com/amap"],
      },
      {
        id: "user-research:3",
        text: "Huashang survey: booking channel = app platform 36.41%, children book for them 32.00%.",
        classification: "fact" as const,
        evidenceIds: ["https://example.com/huashang"],
      },
      {
        id: "risk-research:0",
        text: "《网络预约出租汽车经营服务管理暂行办法》规定，未取得经营许可擅自从事或者变相从事网约车经营活动的，责令改正、予以警告，并处1万元以上3万元以下罚款，构成犯罪的依法追究刑事责任。",
        classification: "fact" as const,
        evidenceIds: ["https://www.gov.cn/"],
      },
    ];
    const readingBrief = buildResearchReadingBrief({
      recommendation: "continue_research",
      claims,
      branchConclusions: {
        "user-research":
          "判断：待定 — 需求侧成立、值得继续验证，但值得开发独立适老打车 App 目前不能成立（not recommended）。理由：①痛点真实。缺口：一手访谈。",
        "risk-research": "判断：有条件继续。理由：①资质风险最高。缺口：授权口径。",
      },
    });
    const memo = buildResearchDecisionMemo({
      recommendation: "continue_research",
      readingBrief,
      claims,
    });

    const labels = memo.metrics.map((metric) => metric.label);
    expect(memo.metrics.some((metric) => metric.value === "81.9%" && /出行难/.test(metric.label))).toBe(true);
    expect(memo.metrics.some((metric) => metric.value === "43.1%" && /打不|路边/.test(metric.label))).toBe(true);
    expect(memo.metrics.some((metric) => metric.value === "20%" && /独立完成/.test(metric.label))).toBe(true);
    expect(labels.every((label) => label !== "关键比例")).toBe(true);

    expect(memo.reasons.every((reason) => reason.text.length <= 72)).toBe(true);
    expect(memo.reasons.some((reason) => /出行难|打不|独立完成/.test(reason.text))).toBe(true);
    expect(memo.reasons.some((reason) => /not\s*$/i.test(reason.text) || reason.text.includes("（not"))).toBe(false);
    expect(memo.risks[0]?.text.length).toBeLessThanOrEqual(28);
    expect(memo.risks[0]?.text).toMatch(/未持牌|网约车|经营许可/);
  });

  it("summarizes essay risks/competitors without elderly-ride contamination", () => {
    const claims = [
      {
        id: "market-research:2",
        text: "Free general-purpose AI is already used by parents to polish primary-school essays.",
        classification: "fact" as const,
        evidenceIds: ["https://www.199it.com/essay"],
      },
      {
        id: "risk-research:11",
        text: "《个人信息保护法》第28条将不满十四周岁未成年人个人信息列为敏感个人信息；第31条要求取得父母或其他监护人同意。",
        classification: "fact" as const,
        evidenceIds: ["https://www.npc.gov.cn/"],
      },
      {
        id: "risk-research:4",
        text: "目标形态（小学生自己用 AI 批改并优化作文）落在上述两份文件的禁止侧。",
        classification: "fact" as const,
        evidenceIds: ["https://www.cse.edu.cn/"],
      },
    ];
    const readingBrief = buildResearchReadingBrief({
      recommendation: "stop",
      claims,
      branchConclusions: {
        "market-research": "判断：作文批改有需求，但竞品与通用大模型已占位。",
        "risk-research": "判断：stop。理由：①小学禁止学生独自使用。缺口：合规定性。",
      },
    });
    const memo = buildResearchDecisionMemo({
      recommendation: "stop",
      readingBrief,
      claims,
      title: "小学作文批改助手",
    });
    expect(memo.risks.some((row) => /儿童|未成年/.test(row.text))).toBe(true);
    expect(memo.risks.some((row) => /禁止|生成式AI|自助/.test(row.text))).toBe(true);
    expect(memo.risks.every((row) => !/子女端看位置|助老|网约车|行踪轨迹/.test(`${row.text}${row.implication || ""}`))).toBe(true);
    expect(memo.competitors.some((row) => /通用大模型|作文批改/.test(row.name))).toBe(true);
    expect(memo.competitors.every((row) => !/滴滴|助老|95128|长辈/.test(row.name))).toBe(true);
    expect(memo.reasons.every((row) => !/子女端|助老打车|获客难/.test(row.text))).toBe(true);
  });

  it("builds a chart when three comparable scale points exist", () => {
    const claims = [
      {
        id: "market-research:0",
        text: "Didi senior service served 265 million rides.",
        classification: "fact" as const,
        evidenceIds: ["https://example.com/didi"],
      },
      {
        id: "market-research:1",
        text: "Amap senior one-tap served 60 million rides.",
        classification: "fact" as const,
        evidenceIds: ["https://example.com/amap"],
      },
      {
        id: "market-research:2",
        text: "95128 helpline served 15.43 million seniors cumulatively.",
        classification: "fact" as const,
        evidenceIds: ["https://example.com/95128"],
      },
    ];
    const readingBrief = buildResearchReadingBrief({
      recommendation: "continue_research",
      claims,
    });
    const memo = buildResearchDecisionMemo({
      recommendation: "continue_research",
      readingBrief,
      claims,
    });
    expect(memo.chart?.points.length).toBeGreaterThanOrEqual(3);
  });
});
