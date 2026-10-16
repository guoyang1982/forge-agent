import { describe, expect, it } from "vitest";
import type { ResearchClaim } from "./types.js";
import {
  buildResearchReadingBrief,
  normalizeClaim,
  synthesizeResearch,
} from "./research.js";

describe("normalizeClaim", () => {
  it("downgrades a fact without evidence to hypothesis", () => {
    const result = normalizeClaim(
      claim({ text: "  用户都需要它  ", classification: "fact", evidenceIds: [] }),
    );

    expect(result).toMatchObject({
      text: "用户都需要它",
      classification: "hypothesis",
    });
  });

  it("clamps confidence to the inclusive unit interval", () => {
    expect(normalizeClaim(claim({ confidence: -0.2 })).confidence).toBe(0);
    expect(normalizeClaim(claim({ confidence: 1.4 })).confidence).toBe(1);
  });
});

describe("synthesizeResearch", () => {
  it("keeps contradictory claims and links both ids", () => {
    const result = synthesizeResearch([
      claim({ id: "claim-a", contradictions: ["claim-b"], evidenceIds: ["e-a"] }),
      claim({ id: "claim-b", contradictions: ["claim-a"], evidenceIds: ["e-b"] }),
    ]);

    expect(result.claims.map(({ id }) => id)).toEqual([
      "claim-a",
      "claim-b",
      "claim-recommendation",
    ]);
    expect(result.conflicts[0]).toMatchObject({
      claimIds: ["claim-a", "claim-b"],
    });
    expect(result.recommendation).toBe("continue_research");
  });

  it("persists recommendation as an inference claim, never a fact", () => {
    const unknown = claim({
      id: "claim-unknown",
      classification: "unknown",
      evidenceIds: [],
    });
    const result = synthesizeResearch([unknown]);

    expect(result.unknowns).toEqual([unknown]);
    expect(result.rationaleClaimIds).toEqual(["claim-unknown"]);
    const recommendationClaim = result.claims.find(({ id }) => id === "claim-recommendation");
    expect(recommendationClaim).toMatchObject({
      classification: "inference",
      contradictions: [],
      evidenceIds: ["claim-unknown"],
    });
    expect(recommendationClaim?.text).toContain("continue_research");
    expect(recommendationClaim?.classification).not.toBe("fact");
    expect(result.recommendation).toBe("continue_research");
  });

  it("stops when most branch Chinese conclusions vote stop, even with many consistent claims", () => {
    const result = synthesizeResearch(
      [
        claim({ id: "user-research:0", evidenceIds: ["e1"] }),
        claim({ id: "market-research:0", evidenceIds: ["e2"] }),
        claim({ id: "code-data-research:0", evidenceIds: ["e3"] }),
        claim({ id: "risk-research:0", evidenceIds: ["e4"] }),
      ],
      {
        branchConclusions: {
          "user-research": "判断：stop（学生自助形态不成立）。理由：用户装错了。缺口：一手访谈。",
          "market-research": "判断：stop——付费方错位。理由：免费替代品碾压。缺口：渠道验证。",
          "code-data-research": "判断：stop。理由：与未成年人红线冲突。缺口：无。",
          "risk-research": "判断：stop（不建议开发）。理由：政策正面排除。缺口：合规定性。",
        },
      },
    );
    expect(result.recommendation).toBe("stop");
    expect(result.claims.find(({ id }) => id === "claim-recommendation")?.text).toContain("stop");
  });
});

describe("buildResearchReadingBrief", () => {
  it("builds a Chinese executive overview and per-branch digests without requiring every claim to be read", () => {
    const brief = buildResearchReadingBrief({
      recommendation: "continue_research",
      conflictCount: 0,
      unknownCount: 2,
      claims: [
        {
          id: "user-research:0",
          text: "Creators spend hours on weekly reporting alone.",
          classification: "fact",
          evidenceIds: ["e1"],
        },
        {
          id: "user-research:1",
          text: "Willingness to pay is still unclear.",
          classification: "unknown",
          evidenceIds: [],
        },
        {
          id: "market-research:0",
          text: "Existing tools cover notes but not weekly packaging.",
          classification: "fact",
          evidenceIds: ["e2"],
        },
        {
          id: "code-data-research:0",
          text: "Prototype can reuse markdown export pipelines.",
          classification: "inference",
          evidenceIds: ["e3"],
        },
        {
          id: "risk-research:0",
          text: "Privacy concerns if reports include private drafts.",
          classification: "hypothesis",
          evidenceIds: [],
        },
        {
          id: "claim-recommendation",
          text: "Research recommendation: continue_research",
          classification: "inference",
          evidenceIds: [],
        },
      ],
    });

    expect(brief.executiveSummary).toMatch(/继续补充调研|暂不立项/);
    expect(brief.executiveSummary).toMatch(/建议方向|补一手/);
    expect(brief.suggestedDirections.length).toBeGreaterThan(0);
    expect(brief.branches).toHaveLength(4);
    expect(brief.branches[0]).toMatchObject({
      id: "user-research",
      label: "用户调研",
    });
    expect(brief.branches[0].summary).toMatch(/用户调研/);
    expect(brief.branches[0].summary).toMatch(/未知/);
    expect(brief.branches[0].highlights[0]).toContain("Creators spend hours");
    expect(brief.branches.map((branch) => branch.id)).toEqual([
      "user-research",
      "market-research",
      "code-data-research",
      "risk-research",
    ]);
  });

  it("prefers model-written Chinese branch conclusions over structural digests", () => {
    const brief = buildResearchReadingBrief({
      recommendation: "continue_research",
      conflictCount: 0,
      unknownCount: 1,
      decisionBriefZh: "综合判断：需求真实但付费意愿未验证，建议先做小范围访谈再决定是否立项。",
      branchConclusions: {
        "market-research": "市场判断：赛道大但工具拥挤，独立周报产品差异化不足，暂不宜直接开工。",
      },
      claims: [
        {
          id: "market-research:0",
          text: "Creator tools market is crowded.",
          classification: "fact",
          evidenceIds: ["e1"],
        },
      ],
    });

    expect(brief.executiveSummary).toMatch(/决策：/);
    expect(brief.branches[0].summary).toMatch(/结论：|判断：/);
    expect(brief.branches[0].summary).toContain("赛道大但工具拥挤");
    expect(brief.branches[0].summary).not.toMatch(/^市场调研共 /);
  });

  it("rewrites long branch walls into complete short digests without mid-sentence ellipsis", () => {
    const wall = [
      "判断：stop（学生自助形态不成立）——不是用户太少，而是装错了人。",
      "理由：①痛点在教师与家长；②政策禁止小学生独自使用开放式生成；③付费方错位；④免费替代品碾压；⑤与仓库未成年人红线冲突。",
      "缺口：一手访谈、合规定性、手写识别准确率。",
      "后面还有一大段不该默认展开的细节：".padEnd(400, "细"),
    ].join("");
    const brief = buildResearchReadingBrief({
      recommendation: "stop",
      branchConclusions: {
        "user-research": wall,
        "market-research": "判断：stop。理由：①教师侧付费。缺口：渠道。",
        "risk-research": "判断：stop。理由：①未成年人红线。缺口：合规定性。",
      },
      claims: [
        {
          id: "user-research:0",
          text: "Teachers grade 120 essays per cycle.",
          classification: "fact",
          evidenceIds: ["e1"],
        },
      ],
    });
    expect(brief.branches[0].summary).toMatch(/^结论：不做/);
    expect(brief.branches[0].summary).not.toContain("…");
    expect(brief.branches[0].summary).toContain("为什么：");
    expect(brief.branches[0].summary).toMatch(/还缺什么证据：/);
    expect(brief.branches[0].summary).toMatch(/真实用户访谈|合规定性/);
    expect(brief.executiveSummary).toContain("建议方向");
    expect(brief.suggestedDirections.some((item) => /教师|家长|非未成年人/.test(item.title))).toBe(true);
  });

  it("keeps long competitor supply bullets in the market digest instead of only short niche lines", () => {
    const marketWall = [
      "判断：需求真实，但必须拆成两件事看——『老年出行打车』这件事值得做；『再做一款独立、通用的适老打车 APP』不值得。",
      "理由：①需求侧被官方与平台数据双重验证：中国 60+ 人口 3.1 亿、痛点真实且基数巨大；",
      "②供给侧已被大平台免费且高覆盖占据：滴滴长辈版累计 2.65 亿次/覆盖 355 城/近 3000 个线下站牌 + 电话热线，高德助老累计 6000 万次，95128 已在 158 城上线，T3/首汽/曹操均上线助老模式，独立 APP 做通用老年打车几乎无差异化；",
      "③商业模式存疑：助老功能普遍是平台公益/合规投入而非独立盈利业务；",
      "④差异化缺口仍在细分场景：轮椅/无障碍、就医陪诊、语音 + 家庭兜底。",
      "缺口：本地无任何真实老年用户数据，Phase 0 的价值门禁。",
    ].join("");
    const brief = buildResearchReadingBrief({
      recommendation: "continue_research",
      branchConclusions: { "market-research": marketWall },
      claims: [
        {
          id: "market-research:0",
          text: "Chinese population aged 60+ reached 310 million by end-2024.",
          classification: "fact",
          evidenceIds: ["e0"],
        },
        {
          id: "market-research:1",
          text: "Didi's senior ride service had served over 265 million rides for elderly users.",
          classification: "fact",
          evidenceIds: ["e1"],
        },
        {
          id: "market-research:2",
          text: "The national unified taxi e-hailing number 95128 had been activated in 158 cities.",
          classification: "fact",
          evidenceIds: ["e2"],
        },
      ],
    });
    const market = brief.branches.find((branch) => branch.id === "market-research");
    expect(market?.summary).toMatch(/滴滴|95128|长辈版|供给侧|大平台/);
    expect(market?.summary).not.toMatch(/^判断：可推进 — 老年出行打车这件事值得做。\n原因：差异化缺口/);
    expect(market?.summary).toMatch(/还缺什么证据：.*真实用户/);
    expect(market?.highlights.some((line) => /滴滴|95128|助老|Didi|senior ride/i.test(line))).toBe(true);
  });
});

function claim(overrides: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    id: "claim-1",
    briefId: "brief-1",
    text: "用户需要它",
    classification: "fact",
    evidenceIds: ["evidence-1"],
    confidence: 0.8,
    contradictions: [],
    ...overrides,
  };
}
