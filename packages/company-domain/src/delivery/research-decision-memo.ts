import { competitiveSignalScore } from "./research-digest.js";
import type {
  ResearchBriefClaim,
  ResearchReadingBrief,
  ResearchRecommendation,
  ResearchSuggestedDirection,
} from "./research.js";

export type MemoSource = {
  label: string;
  url?: string;
};

export type MemoReason = {
  text: string;
  sources: MemoSource[];
};

export type MemoMetric = {
  label: string;
  value: string;
  sources: MemoSource[];
};

export type MemoCompetitor = {
  name: string;
  form?: string;
  scale?: string;
  implication?: string;
  sources: MemoSource[];
};

export type MemoRisk = {
  text: string;
  severity: "veto" | "high" | "medium" | "low";
  implication?: string;
  sources: MemoSource[];
};

export type MemoChart = {
  label: string;
  points: Array<{ name: string; valueLabel: string; ratio: number }>;
};

export type MemoAttachment = {
  id: string;
  label: string;
  summary: string;
  highlights: string[];
  claims: ResearchBriefClaim[];
};

export type ResearchDecisionMemo = {
  title: string;
  evaluatedAt: string;
  claimTotal: number;
  recommendation: ResearchRecommendation;
  verdictLabel: string;
  reasons: MemoReason[];
  metrics: MemoMetric[];
  competitors: MemoCompetitor[];
  risks: MemoRisk[];
  chart?: MemoChart;
  directions: ResearchSuggestedDirection[];
  attachments: MemoAttachment[];
};

const COMPETITOR_NAME_PATTERNS: Array<{ pattern: RegExp; name: string; form: string }> = [
  // Education / essay first — avoid mobility templates on edtech briefs.
  { pattern: /科大讯飞|讯飞批改|讯飞/i, name: "科大讯飞作文批改", form: "教培产品" },
  { pattern: /作业帮/, name: "作业帮", form: "教培 App" },
  { pattern: /猿辅导|小猿/, name: "猿辅导", form: "教培 App" },
  { pattern: /学而思|好未来/, name: "学而思", form: "教培 App" },
  { pattern: /ChatGPT|Claude|豆包|文心|通义|Kimi|general[- ]purpose AI|通用大模型|通用.*AI/i, name: "通用大模型", form: "通用 AI" },
  { pattern: /作文批改|智能批改|作文助手/, name: "作文批改类产品", form: "教培工具" },
  // Elderly mobility
  { pattern: /滴滴|Didi/i, name: "滴滴长辈版 / 助老打车", form: "平台内功能" },
  { pattern: /高德|Amap/i, name: "高德助老一键叫车", form: "地图生态" },
  { pattern: /95128/, name: "95128 助老热线", form: "电话热线" },
  { pattern: /智龄/, name: "智龄出行", form: "小程序" },
  { pattern: /曹操|首汽|T3|美团|Meituan/i, name: "其他平台助老模式", form: "平台内功能" },
  { pattern: /长辈版|老年版|助老/, name: "平台长辈版 / 老年版", form: "小程序/功能" },
  { pattern: /替代供给/, name: "替代供给（热线/长辈版）", form: "多形态" },
  { pattern: /竞品|competitor/i, name: "竞品供给", form: "竞品" },
];

const MOBILITY_HINT = /助老|出行|网约车|打车|扬招|滴滴|高德|95128|长辈版|老年版/;
const ESSAY_HINT = /作文|批改|小学|学生|生成式AI|教培|作业帮|讯飞/;

export function buildResearchDecisionMemo(input: {
  recommendation: ResearchRecommendation;
  readingBrief: ResearchReadingBrief;
  claims: readonly ResearchBriefClaim[];
  title?: string;
  evaluatedAt?: string;
}): ResearchDecisionMemo {
  const claims = input.claims.filter((claim) => claim.id !== "claim-recommendation");
  const facts = claims.filter((claim) => claim.classification === "fact");
  const competitors = extractCompetitors(facts);
  const metrics = extractMetrics(facts);
  const risks = extractRisks(claims);
  const reasons = buildReasons(
    input.recommendation,
    input.readingBrief,
    facts,
    competitors,
    risks,
    metrics,
    String(input.title || "").trim(),
  );
  const chart = buildChart(competitors, facts);
  const attachments = (input.readingBrief.branches || []).map((branch) => ({
    id: branch.id,
    label: branch.label,
    summary: branch.summary,
    highlights: branch.highlights || [],
    claims: claims.filter((claim) => claimBranchId(claim.id) === branch.id),
  }));

  return {
    title: String(input.title || "").trim() || "可行性决策备忘录",
    evaluatedAt: String(input.evaluatedAt || "").trim() || new Date().toISOString().slice(0, 10),
    claimTotal: claims.length,
    recommendation: input.recommendation,
    verdictLabel: verdictLabel(input.recommendation),
    reasons,
    metrics,
    competitors,
    risks,
    ...(chart ? { chart } : {}),
    directions: input.readingBrief.suggestedDirections || [],
    attachments,
  };
}

function verdictLabel(recommendation: ResearchRecommendation): string {
  switch (recommendation) {
    case "enter_product_definition":
      return "建议进入需求设计";
    case "continue_research":
      return "继续验证，暂不按原方案直接立项";
    case "stop":
      return "建议不做原想法（停止或改方向）";
  }
}

function detectMemoDomain(
  readingBrief: ResearchReadingBrief,
  facts: readonly ResearchBriefClaim[],
  title = "",
): "essay" | "mobility" | "generic" {
  const blob = [
    title,
    ...(readingBrief.branches || []).map((branch) => `${branch.summary} ${(branch.highlights || []).join(" ")}`),
    ...facts.map((claim) => claim.text),
  ].join("\n");
  if (ESSAY_HINT.test(blob) && !MOBILITY_HINT.test(blob)) return "essay";
  if (MOBILITY_HINT.test(blob) && !ESSAY_HINT.test(blob)) return "mobility";
  if (ESSAY_HINT.test(blob)) return "essay";
  if (MOBILITY_HINT.test(blob)) return "mobility";
  return "generic";
}

function buildReasons(
  recommendation: ResearchRecommendation,
  readingBrief: ResearchReadingBrief,
  facts: readonly ResearchBriefClaim[],
  competitors: MemoCompetitor[],
  risks: MemoRisk[],
  metrics: MemoMetric[] = [],
  title = "",
): MemoReason[] {
  const reasons: MemoReason[] = [];
  const user = readingBrief.branches.find((branch) => branch.id === "user-research");
  const market = readingBrief.branches.find((branch) => branch.id === "market-research");
  const domain = detectMemoDomain(readingBrief, facts, title);
  const demandEvidence = pickMetricHint(
    metrics,
    domain === "essay"
      ? [/批改/, /作文/, /教师/, /家长/, /渗透/, /使用/]
      : [/出行难/, /打不/, /独立完成/, /扬招/],
  );

  // Middle length: one key number + conclusion. Avoid English mid-cuts and legal walls.
  const demandLead = demandEvidence
    ? `需求真实（${demandEvidence.label} ${demandEvidence.value}）`
    : domain === "essay"
      ? "作文批改需求存在"
      : "需求侧痛点成立";
  const summaryBlob = `${user?.summary || ""} ${market?.summary || ""}`;
  const demandTail =
    domain === "essay"
      ? /禁止|不合规|停止|红线/.test(summaryBlob)
        ? "，但学生自助形态触合规红线"
        : "，仍需一手验证再立项"
      : /独立|通用|App|APP/.test(summaryBlob) && /不|不能|不值得|不成立/.test(summaryBlob)
        ? "，但独立通用 App 尚不宜立项"
        : "，仍需一手验证再立项";
  reasons.push({
    text: clip(`${demandLead}${demandTail}`, 64),
    sources: sourcesFromClaims(facts.filter((claim) => claimBranchId(claim.id) === "user-research").slice(0, 2)),
  });

  if (competitors[0]) {
    const names = competitors.slice(0, 2).map((row) => {
      const scale = row.scale ? shortScale(row.scale) : "";
      const shortName = row.name.replace(/\s*\/\s*/, "/").replace(/长辈版\s*\/\s*/, "长辈版/");
      return scale ? `${shortName} ${scale}` : shortName;
    });
    const competitorTail =
      domain === "essay" ? "，差异化与合规形态待证" : "，通用独立 App 获客难";
    reasons.push({
      text: clip(`竞品已占位：${names.join("；")}${competitorTail}`, 68),
      sources: competitors.flatMap((row) => row.sources).filter((source) => source.url).slice(0, 3),
    });
  }

  const veto = risks.find((row) => row.severity === "veto") || risks.find((row) => row.severity === "high") || risks[0];
  if (veto) {
    const detail = veto.implication ? `——${veto.implication}` : "";
    reasons.push({
      text: clip(`最大风险：${veto.text}${detail}`, 64),
      sources: veto.sources,
    });
  }

  if (!reasons.length) {
    reasons.push({ text: clip(verdictLabel(recommendation), 48), sources: [] });
  }
  return reasons.slice(0, 3);
}

function pickMetricHint(
  metrics: readonly MemoMetric[],
  patterns: RegExp[],
): MemoMetric | undefined {
  for (const pattern of patterns) {
    const hit = metrics.find((metric) => pattern.test(metric.label));
    if (hit) return hit;
  }
  return metrics[0];
}

function extractCompetitors(facts: readonly ResearchBriefClaim[]): MemoCompetitor[] {
  const byKey = new Map<string, MemoCompetitor>();
  const ranked = [...facts].sort((a, b) => {
    const sourceBoost = (claim: ResearchBriefClaim) =>
      (claim.evidenceIds || []).some((id) => httpUrl(id)) ? 20 : 0;
    return (
      competitiveSignalScore(b.text) + sourceBoost(b) -
      (competitiveSignalScore(a.text) + sourceBoost(a))
    );
  });
  for (const claim of ranked) {
    if (
      competitiveSignalScore(claim.text) <= 0
      && !/滴滴|高德|95128|长辈|助老|竞品|替代|讯飞|作业帮|猿辅导|作文批改|通用大模型|ChatGPT|general[- ]purpose AI|polish.*essay/i.test(claim.text)
    ) {
      continue;
    }
    const matched = COMPETITOR_NAME_PATTERNS.find((entry) => entry.pattern.test(claim.text));
    // Skip regulatory/other facts that only weakly mention mobility keywords.
    if (!matched && competitiveSignalScore(claim.text) < 3) continue;
    const name = matched?.name || competitorNameFallback(claim.text);
    const key = name.toLowerCase();
    const incoming: MemoCompetitor = {
      name,
      form: matched?.form || inferForm(claim.text),
      scale: extractScaleForCompetitor(name, claim.text),
      implication: inferImplication(claim.text),
      sources: sourcesFromClaims([claim]),
    };
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, incoming);
      continue;
    }
    // Merge: prefer scale that mentions the competitor itself; union http sources.
    byKey.set(key, {
      ...existing,
      scale: preferCompetitorScale(name, existing.scale, incoming.scale, claim.text),
      implication: existing.implication || incoming.implication,
      form: existing.form || incoming.form,
      sources: [...existing.sources, ...incoming.sources]
        .filter((source, index, all) =>
          source.url && all.findIndex((entry) => entry.url === source.url) === index,
        )
        .slice(0, 3),
    });
  }
  return [...byKey.values()]
    .sort((a, b) => Number(Boolean(b.sources[0]?.url)) - Number(Boolean(a.sources[0]?.url)))
    .slice(0, 6);
}

function extractMetrics(facts: readonly ResearchBriefClaim[]): MemoMetric[] {
  const metrics: MemoMetric[] = [];
  const seen = new Set<string>();
  const push = (label: string, value: string, claim: ResearchBriefClaim) => {
    const key = `${label}:${value}`;
    if (seen.has(key) || seen.has(`label:${label}`)) return;
    seen.add(key);
    seen.add(`label:${label}`);
    metrics.push({ label, value, sources: sourcesFromClaims([claim]) });
  };
  for (const claim of facts) {
    for (const hit of claim.text.matchAll(
      /(\d+(?:\.\d+)?)\s*(亿次|亿|万次|万人|万|%|城|座城市|地级市|million(?:\s+rides?)?|cities)/gi,
    )) {
      const rawUnit = hit[2];
      const n = Number(hit[1]);
      let value = `${hit[1]}${normalizeUnit(rawUnit)}`;
      // Present English millions in 亿 for the memo cards.
      if (/^million$/i.test(rawUnit) && Number.isFinite(n)) {
        value = `${Number((n / 100).toFixed(2))} 亿`;
      } else if (/million\s+rides?/i.test(rawUnit) && Number.isFinite(n)) {
        value = `${Number((n / 100).toFixed(2))} 亿次`;
      }
      const label = metricLabelNear(claim.text, hit.index || 0, value);
      push(label, value.replace(/\s+/g, " ").trim(), claim);
      if (metrics.length >= 6) return metrics;
    }
    if (metrics.length >= 6) return metrics;
  }
  return metrics;
}

function extractRisks(claims: readonly ResearchBriefClaim[]): MemoRisk[] {
  const ranked = claims
    .filter((claim) =>
      /许可|合规|二清|敏感个人信息|行踪|一票否决|处罚|条例|PIPL|网约车经营|禁止|未成年人|儿童个人信息|自批自改|生成式AI|类目排除/i
        .test(claim.text),
    )
    .sort((a, b) => riskScore(b.text) - riskScore(a.text));
  const out: MemoRisk[] = [];
  const seen = new Set<string>();
  for (const claim of ranked) {
    const summarized = summarizeRisk(claim.text);
    if (seen.has(summarized.title)) continue;
    seen.add(summarized.title);
    out.push({
      text: summarized.title,
      severity: riskSeverity(claim.text),
      implication: summarized.implication,
      sources: sourcesFromClaims([claim]),
    });
    if (out.length >= 5) break;
  }
  return out;
}

/** Boss-facing risk title ≤ ~20 Chinese chars; detail goes to implication. */
function summarizeRisk(text: string): { title: string; implication?: string } {
  const raw = String(text || "");
  // Domain-specific patterns first — never hardcode another product's implication.
  if (/未取得.*(?:网约车)?经营许可|擅自.*网约车|变相从事.*网约车|未取得网约车/.test(raw)) {
    return { title: "未持牌从事网约车", implication: "真单需持牌平台授权，否则可能被罚" };
  }
  if (/二清|代付|归集.*结算|自行归集/.test(raw)) {
    return { title: "子女代付触及二清", implication: "资金须直连持牌机构/平台代付" };
  }
  if (/非银行支付|支付机构|支付业务须持牌/.test(raw)) {
    return { title: "支付业务须持牌", implication: "代收代付不能自建资金池" };
  }
  if (/小学.*禁止|禁止学生独自|学生自助|开放式内容生成/.test(raw)) {
    return { title: "小学禁止学生独自用生成式AI", implication: "学生自助批改形态不合规" };
  }
  if (/不得.*自批自改|全批全改|学生自批自改/.test(raw)) {
    return { title: "作业不得要求学生自批自改", implication: "与学生自助批改目标冲突" };
  }
  if (/自动批改结果.*最终评价|不得.*直接作为.*评价/.test(raw)) {
    return { title: "AI批改不得作最终评价", implication: "须教师复审后才能给结论" };
  }
  if (/类目排除|不做.*未成年人|未成年人.*排除|类目收窄/.test(raw)) {
    return { title: "仓库已排除未成年人类目", implication: "本需求会击穿既有红线" };
  }
  if (/未成年人网络保护条例|未成年.*罚则|5万.*50万/.test(raw)) {
    return { title: "未成年人网络保护罚则", implication: "违规可罚5万–50万元" };
  }
  if (/不满十四周岁|儿童个人信息|未成年人个人信息/.test(raw)) {
    return { title: "儿童个人信息需监护人同意", implication: "采集与上传须单独同意+专人规则" };
  }
  if (/行踪轨迹/.test(raw)) {
    return { title: "行踪轨迹需单独同意", implication: "位置类数据须告知、同意与撤回" };
  }
  if (/敏感个人信息|PIPL|个人信息保护法/.test(raw)) {
    return { title: "敏感个人信息需单独同意", implication: "须充分必要性并取得单独同意" };
  }
  if (/备案|分发|上架/.test(raw)) {
    return { title: "App 备案与分发门槛", implication: "未备案不得分发上架" };
  }
  if (/地图|配额|Key|密钥/.test(raw)) {
    return { title: "地图商用配额不足", implication: "个人认证额度难撑正式运营" };
  }
  return { title: clip(raw.replace(/《[^》]+》/g, "").replace(/规定[，,]?/, ""), 18), implication: clip(raw, 36) };
}

function buildChart(
  competitors: MemoCompetitor[],
  facts: readonly ResearchBriefClaim[],
): MemoChart | undefined {
  const points: Array<{ name: string; valueLabel: string; value: number }> = [];
  for (const row of competitors) {
    const parsed = parseMagnitude(row.scale || "");
    if (!parsed) continue;
    points.push({ name: row.name, valueLabel: row.scale || parsed.label, value: parsed.value });
  }
  if (points.length < 3) {
    for (const claim of facts) {
      if (!/rides|次|million|亿|万/i.test(claim.text)) continue;
      const matched = COMPETITOR_NAME_PATTERNS.find((entry) => entry.pattern.test(claim.text));
      const scale = extractScale(claim.text);
      const parsed = parseMagnitude(scale || claim.text);
      if (!matched || !parsed) continue;
      if (points.some((point) => point.name === matched.name)) continue;
      points.push({ name: matched.name, valueLabel: scale || parsed.label, value: parsed.value });
      if (points.length >= 4) break;
    }
  }
  if (points.length < 3) return undefined;
  const max = Math.max(...points.map((point) => point.value));
  if (!(max > 0)) return undefined;
  return {
    label: "可比规模（示意）",
    points: points.slice(0, 5).map((point) => ({
      name: point.name,
      valueLabel: point.valueLabel,
      ratio: Math.max(0.06, point.value / max),
    })),
  };
}

function sourcesFromClaims(claims: readonly ResearchBriefClaim[]): MemoSource[] {
  const out: MemoSource[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    for (const id of claim.evidenceIds || []) {
      const url = httpUrl(id);
      if (url) {
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ label: hostLabel(url), url });
      }
    }
  }
  return out.slice(0, 3);
}

function httpUrl(value: string): string | undefined {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return undefined;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function claimBranchId(id: string): string {
  return String(id || "").includes(":") ? String(id).split(":")[0]! : "";
}

function competitorNameFallback(text: string): string {
  const brand = text.match(
    /(科大讯飞|作业帮|猿辅导|学而思|ChatGPT|Claude|豆包|文心一言|通义千问|Kimi|滴滴|高德|95128)/i,
  );
  if (brand) return brand[1]!;
  if (/general[- ]purpose AI|通用大模型|免费通用AI/i.test(text)) return "通用大模型";
  const zh = text.match(/[\u4e00-\u9fff]{4,16}/)?.[0];
  if (zh) return zh;
  return clip(text.replace(/\s+/g, " ").trim(), 22);
}

function inferForm(text: string): string {
  if (/热线|电话|95128/.test(text)) return "电话热线";
  if (/作文|批改|教培|作业/.test(text)) return "教培工具";
  if (/小程序/.test(text)) return "小程序";
  if (/App|APP|应用/.test(text)) return "独立应用";
  return "平台功能";
}

function inferImplication(text: string): string | undefined {
  if (/作文|批改|教培/.test(text) && /替代|占位|已有|主流/.test(text)) return "分流学生自助批改增量";
  if (/分流|压缩|获客|无差异化|替代/.test(text)) return "分流独立 App 增量";
  if (/细分|无障碍|轮椅|陪诊/.test(text)) return "细分场景仍有缝隙";
  return undefined;
}

function extractScale(text: string): string | undefined {
  const hit = text.match(
    /(\d+(?:\.\d+)?)\s*(亿次|亿|百万次|万次|万人|万|million\s+rides?|cities|城)/i,
  );
  if (!hit) return undefined;
  return `${hit[1]}${normalizeUnit(hit[2])}`;
}

function extractScaleForCompetitor(name: string, text: string): string | undefined {
  if (/95128/.test(name)) {
    const hit = text.match(/95128[^。；;\n]{0,80}?(\d+)\s*(prefecture-level cities|地级市|城)/i)
      || text.match(/(\d+)\s*(prefecture-level cities|地级市).*95128/i);
    if (hit) return `${hit[1]}城`;
  }
  if (/滴滴|Didi/i.test(name)) {
    const hit = text.match(/(\d+(?:\.\d+)?)\s*million\s+rides?/i)
      || text.match(/(\d+(?:\.\d+)?)\s*亿次/);
    if (hit) {
      return /亿次/.test(hit[0]) ? `${hit[1]}亿次` : `${hit[1]} million rides`;
    }
  }
  return extractScale(text);
}

function preferCompetitorScale(
  name: string,
  existing?: string,
  incoming?: string,
  claimText = "",
): string | undefined {
  if (/95128/.test(name)) {
    if (incoming && /158/.test(incoming)) return incoming;
    if (existing && /158/.test(existing)) return existing;
    if (/95128/.test(claimText) && incoming) return incoming;
  }
  return existing || incoming;
}

function normalizeUnit(unit: string): string {
  if (/million\s+rides?/i.test(unit)) return " million rides";
  if (/^million$/i.test(unit)) return " million";
  if (/cities/i.test(unit)) return " cities";
  return unit;
}

function metricLabelNear(text: string, index: number, value: string): string {
  // Prefer the clause right after the number so prior stats in the same sentence
  // (e.g. 74% street-hail before 20% independent) do not steal the label.
  const localBefore = text.slice(Math.max(0, index - 28), index);
  const localAfter = text.slice(index, Math.min(text.length, index + value.length + 56));
  const local = `${localBefore} ${localAfter}`;
  const around = text.slice(Math.max(0, index - 70), Math.min(text.length, index + value.length + 70));

  // Percentage semantics first — never fall back to bare「关键比例」.
  // Score against the clause after the number so earlier stats in the same
  // sentence cannot steal the label (81.9% hard vs 43.1% failed hail).
  if (/%/.test(value) || /%/.test(local) || /%/.test(around)) {
    const afterOnly = localAfter;
    // Education / essay metrics — checked before mobility so edtech briefs stay clean.
    if (/作文批改|智能批改|自动批改/i.test(local)) return "作文批改相关";
    if (/教师.*使用|教师渗透|老师.*用/i.test(local)) return "教师使用比例";
    if (/家长.*意愿|家长接受/i.test(local)) return "家长接受度";
    if (/准确率|批改准确/i.test(local)) return "批改准确率";
    if (/failed to hail|打不着|招手打不|路边.*失败|have failed to hail/i.test(afterOnly)) return "路边打不到车";
    if (/complete.*(booking|independently)|independently|独立完成|自行完成|能独立/i.test(afterOnly)) {
      return "App叫车能独立完成";
    }
    // Channel labels sit *before* the percent (app platform 36.41%, children 32%).
    if (/app platform|booking channel\s*=\s*app|App平台|平台叫车/i.test(localBefore)) return "选App平台叫车";
    if (/children book|子女.*代叫|子女帮叫/i.test(localBefore)) return "由子女代叫";
    if (/app platform|App平台|平台叫车/i.test(afterOnly) && !/children book/i.test(localBefore)) return "选App平台叫车";
    if (/children book|子女.*代叫/i.test(afterOnly) && !/app platform/i.test(localBefore)) return "由子女代叫";
    if (/travelling is hard|出行难|认为出行难|getting around is hard/i.test(afterOnly) || /travelling is hard|出行难/i.test(local)) {
      return "认为出行难";
    }
    if (/street-hail|street hail|路边扬招|仍.*扬招|prefer street/i.test(afterOnly) || /street-hail|路边扬招/i.test(local)) {
      return "仍路边扬招";
    }
    if (/elder mode|老年版|长辈模式/i.test(local)) return "会用老年版";
    if (/non-internet|非网民/i.test(local)) return "占非网民比例";
    if (/internet penetration|触网率|网民渗透/i.test(local)) return "老年触网率";
    if (/total population|总人口/i.test(local)) return "占总人口";
    if (/dispatch success|派单成功/i.test(local)) return "助老派单成功率";
    if (/YoY|同比/.test(local) && MOBILITY_HINT.test(around)) return "助老单量同比";
    if (/YoY|同比/.test(local)) return "同比变化";
    if (/failed to hail|打不着/i.test(around)) return "路边打不到车";
    if (/independently|独立完成/i.test(around) && MOBILITY_HINT.test(around)) return "App叫车能独立完成";
    if (/travelling is hard|出行难/i.test(around)) return "认为出行难";
    if (/street-hail|路边扬招/i.test(around)) return "仍路边扬招";
    const clause = local
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\d+(?:\.\d+)?\s*%/g, "")
      .replace(/[^A-Za-z\u4e00-\u9fff\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const zh = clause.match(/[\u4e00-\u9fff]{2,12}/)?.[0];
    if (zh) return zh;
    const en = clause.match(/\b([A-Za-z][A-Za-z\s-]{3,28})\b/)?.[1]?.trim();
    if (en) return clip(en, 14);
    return "调研比例";
  }

  if (/60\+|aged 60|老年人口|人口/.test(around)) return "60+ 人口";
  if (/滴滴|Didi/.test(around) && /rides|次|助老/.test(around)) return "滴滴助老累计";
  if (/高德|Amap/.test(around) && /rides|次|助老/.test(around)) return "高德助老累计";
  if (/95128/.test(around)) return "95128 覆盖";
  if (/城|cities/.test(around)) return "覆盖城市";
  if (/作文|批改|教培/.test(around)) return "教培相关规模";
  return "关键规模";
}

function shortScale(scale: string): string {
  return String(scale || "")
    .replace(/(\d+(?:\.\d+)?)\s*million\s+rides?/i, (_, n) => {
      const value = Number(n) / 100;
      if (!Number.isFinite(value)) return `${n}亿次级`;
      return `${Number(value.toFixed(2))}亿次`;
    })
    .replace(/(\d+(?:\.\d+)?)\s*million\b/i, (_, n) => {
      const value = Number(n) / 100;
      if (!Number.isFinite(value)) return `${n}百万`;
      return `${Number(value.toFixed(2))}亿`;
    })
    .replace(/(\d+)\s*cities/i, "$1城")
    .replace(/(\d+)\s*城$/, "$1城")
    .trim();
}

function parseMagnitude(text: string): { value: number; label: string } | undefined {
  const hit = String(text).match(/(\d+(?:\.\d+)?)\s*(亿次|亿|万次|万|million)?/i);
  if (!hit) return undefined;
  const n = Number(hit[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = hit[2] || "";
  let value = n;
  if (/亿/.test(unit)) value = n * 100_000_000;
  else if (/万/.test(unit)) value = n * 10_000;
  else if (/million/i.test(unit)) value = n * 1_000_000;
  return { value, label: `${hit[1]}${unit}` };
}

function riskScore(text: string): number {
  let score = 0;
  if (/未取得.*(?:网约车)?经营许可|擅自.*网约车|一票否决|刑事责任|责令/.test(text)) score += 5;
  if (/小学.*禁止|禁止学生独自|学生自助.*禁止|落在.*禁止侧/.test(text)) score += 5;
  if (/二清|支付|代付/.test(text)) score += 4;
  if (/类目排除|不做.*未成年人/.test(text)) score += 4;
  if (/敏感个人信息|行踪|PIPL|儿童个人信息|未成年人个人信息/.test(text)) score += 3;
  if (/自批自改|自动批改结果.*最终评价/.test(text)) score += 3;
  if (/许可|合规|条例/.test(text)) score += 2;
  return score;
}

function riskSeverity(text: string): MemoRisk["severity"] {
  if (/未取得.*(?:网约车)?经营许可|擅自.*网约车|刑事责任|一票否决|小学.*禁止|禁止学生独自|落在.*禁止侧/.test(text)) {
    return "veto";
  }
  if (/二清|代付|归集|经营许可|支付条例|非银行支付|类目排除|不做.*未成年人/.test(text)) return "high";
  if (/敏感个人信息|行踪|备案|PIPL|个人信息保护法|儿童个人信息|未成年人个人信息/.test(text)) {
    return "medium";
  }
  return "low";
}

function pickSummaryClause(summary: string, pattern: RegExp): string {
  const lines = String(summary || "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const body = line.replace(/^(判断|原因|缺口)[：:]\s*/, "");
    if (pattern.test(body)) return clip(body, 72);
  }
  return "";
}

function clip(text: string, max: number): string {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1).replace(/[，、；;\s]+$/g, "")}…`;
}
