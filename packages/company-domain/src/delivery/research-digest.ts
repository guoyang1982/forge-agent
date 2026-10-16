import type { ResearchRecommendation } from "./research.js";

export interface ResearchSuggestedDirection {
  title: string;
  why: string;
  nextStep: string;
}

/**
 * Rewrite a long branch conclusion into complete short lines.
 * Never mid-sentence ellipsis — drop lower-priority clauses instead.
 */
export function formatBranchDigestZh(text: string): string {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";

  const verdict = inferVerdictLabel(raw);
  const judgmentCore = extractJudgmentCore(raw);
  const reasons = extractReasonBullets(raw, 2);
  const gap = extractGapOneLiner(raw);

  const judgmentLine = `结论：${verdict}${judgmentCore ? ` — ${judgmentCore}` : ""}`.replace(/[。．]+$/, "");
  const reasonLine = reasons.length
    ? `为什么：${reasons.map((item) => item.replace(/[。．]+$/, "")).join("；")}`
    : "";
  const gapPlain = humanizeGap(gap.replace(/^[①②③④⑤⑥⑦⑧⑨⑩\d]+[、.．:：)\s]*/, ""));
  const gapLine = gapPlain ? `还缺什么证据：${gapPlain}` : "";
  return [
    `${judgmentLine}。`,
    reasonLine ? `${reasonLine}。` : "",
    gapLine ? (/[。！？]$/.test(gapLine) ? gapLine : `${gapLine}。`) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Turn terse/jargon gap phrases into boss-facing Chinese. */
export function humanizeGap(text: string): string {
  const raw = cleanClause(String(text || "")).replace(/[。！？]+$/g, "");
  if (!raw || raw === "无" || raw === "无。") return "";
  if (/本地零一手|零一手|本地无一手|无一手数据|无任何真实.*用户/.test(raw)) {
    return "本地还没做过真实用户访谈，结论主要靠公开资料";
  }
  if (/一手访谈/.test(raw) && /合规|定性|识别/.test(raw)) {
    return "还缺真实用户访谈、合规定性，以及关键技术指标验证";
  }
  if (/一手访谈|一手数据|一手用户/.test(raw)) {
    return "还没做过真实用户访谈，付费与使用场景未落地验证";
  }
  if (/合规定性|合规口径/.test(raw)) {
    return "合规能否过关还没有书面定性";
  }
  if (/供给授权|授权口径/.test(raw)) {
    return "能否拿到持牌平台/供给方授权还不清楚";
  }
  if (/渠道验证|渠道/.test(raw) && raw.length <= 12) {
    return "进校/分发等渠道是否跑得通还没验证";
  }
  if (/^付费/.test(raw) || raw === "付费意愿") {
    return "付费意愿和价格还没验证";
  }
  if (/Phase\s*0|价值门禁/i.test(raw)) {
    return "本地还没有真实用户数据，过不了「值不值得做」的门槛";
  }
  return shortenComplete(raw, 48);
}

/** Paraphrase long English claim highlights into short Chinese for the memo. */
export function formatHighlightZh(text: string): string {
  const raw = cleanClause(String(text || ""));
  if (!raw) return "";
  if (/325\s*cities|one-tap hail|一键叫车/i.test(raw) && /158|prefecture|地级/i.test(raw)) {
    return "多数城市已有一键叫车；158 城已接通 95128 热线";
  }
  if (/reluctant|再装|standalone|独立.*[Aa]pp/i.test(raw) && /elder|老人|wechat|微信|95128|Didi|滴滴/i.test(raw)) {
    return "老人未必愿再装独立打车 App（微信/支付宝/滴滴/95128 已够用）";
  }
  if (/phone-hail|电话叫车|95128/i.test(raw) && /Xi'?an|西安|98k|dispatch|派单/i.test(raw)) {
    return "电话叫车实际量很小（如西安 95128 多年派单有限）";
  }
  if (/Didi|滴滴/i.test(raw) && /265|million|rides|助老|senior/i.test(raw)) {
    return "滴滴助老已覆盖大规模累计单量";
  }
  if (/95128/i.test(raw) && /158|activated|上线/i.test(raw)) {
    return "95128 助老热线已在 158 城开通";
  }
  if (/general[- ]purpose AI|通用大模型|Free general/i.test(raw) && /essay|作文/i.test(raw)) {
    return "家长已在用免费通用 AI 润色/批改作文";
  }
  if (/小学.*禁止|禁止学生独自|开放式内容生成/.test(raw)) {
    return "小学阶段禁止学生独自使用开放式生成式 AI";
  }
  if (/[\u4e00-\u9fff]/.test(raw)) {
    return shortenComplete(raw, 56);
  }
  // English fallback: keep a short readable clause, not a mid-cut wall.
  return shortenComplete(raw, 72);
}

/** Build operator-facing executive summary: decision + why + next moves. */
export function formatDecisionExecutiveZh(input: {
  recommendation: ResearchRecommendation;
  branchConclusions?: Readonly<Partial<Record<string, string>>> | null;
  conflictCount?: number;
  unknownCount?: number;
}): { executiveSummary: string; suggestedDirections: ResearchSuggestedDirection[] } {
  const directions = deriveSuggestedDirections(input.recommendation, input.branchConclusions);
  const branchLines = Object.entries(input.branchConclusions ?? {})
    .filter(([, text]) => String(text || "").trim())
    .map(([id, text]) => `${branchLabel(id)}：${oneLineJudgment(String(text))}`);

  const lines = [
    `决策：${recommendationActionZh(input.recommendation)}`,
    branchLines.length ? `四段票数：\n${branchLines.map((line) => `· ${line}`).join("\n")}` : "",
    directions.length
      ? `建议方向（可直接选一条做下一轮）：\n${directions
          .map((item, index) => `${index + 1}. ${item.title} — ${item.why} 下一步：${item.nextStep}`)
          .join("\n")}`
      : "",
    input.recommendation === "enter_product_definition"
      ? "动作：在「下一步」确认进入需求设计。"
      : input.recommendation === "continue_research"
        ? `动作：先补缺口（未知 ${input.unknownCount ?? 0}、冲突 ${input.conflictCount ?? 0}），再决定是否立项。`
        : "动作：停止原想法；若采纳上方某一方向，请另开一轮短调研后再立项。",
  ].filter(Boolean);

  return { executiveSummary: lines.join("\n"), suggestedDirections: directions };
}

export function deriveSuggestedDirections(
  recommendation: ResearchRecommendation,
  branchConclusions?: Readonly<Partial<Record<string, string>>> | null,
): ResearchSuggestedDirection[] {
  const blob = Object.values(branchConclusions ?? {}).join("\n");
  const found: ResearchSuggestedDirection[] = [];
  const push = (item: ResearchSuggestedDirection) => {
    if (found.some((entry) => entry.title === item.title)) return;
    found.push(item);
  };

  // Pull explicit pivots mentioned by researchers.
  if (/教师|老师|教研|批量批改/.test(blob)) {
    push({
      title: "教师主导的批改辅助",
      why: "痛点与付费更可能在教师侧，也更贴近「辅助教师教学」政策场景。",
      nextStep: "先做 8–10 位语文教师访谈（负担、准确率接受度、付费），再开短调研。",
    });
  }
  if (/家长|监护人|复盘/.test(blob)) {
    push({
      title: "家长主导的复盘工具",
      why: "成人操作可规避「小学生独自使用开放式生成」红线，但儿童数据合规仍重。",
      nextStep: "先书面确认备案/合规定性，再做小范围家长访谈。",
    });
  }
  if (/未成年人|小学生|换赛道|非教育|类目排除/.test(blob) && /未成年|小学生|教育|作文|批改/.test(blob)) {
    push({
      title: "换非未成年人赛道",
      why: "与仓库「不做未成年人」红线一致，避免合规一票否决。",
      nextStep: "另登记一个非未成年人想法，用现有经营台能力做可行性评估。",
    });
  }
  if (/滴滴|95128|长辈版|助老打车|适老.*打车|老年出行/.test(blob) && /独立|通用|差异化|替代供给|大平台/.test(blob)) {
    push({
      title: "大平台之上的适老体验层 / 细分场景",
      why: "通用独立 App 已被滴滴长辈版、高德助老、95128 等分流；差异化更可能在无障碍、陪诊、家庭兜底。",
      nextStep: "用 L0 真人观察验证：老人是否愿为「更简单更安全」再装一个入口，再决定是否投入。",
    });
  }

  if (recommendation === "stop" && found.length === 0) {
    push({
      title: "收紧或更换目标用户后再评估",
      why: "原想法四段偏负，直接立项投入产出比差。",
      nextStep: "写清新的目标用户与使用方式，重新跑一轮短调研。",
    });
  }

  if (recommendation === "continue_research" && found.length === 0) {
    push({
      title: "补一手证据后再决策",
      why: "现有论断仍有缺口或冲突，不宜直接开工。",
      nextStep: "先补访谈/定价/合规定性中最关键的 1–2 项，再重跑评估。",
    });
  }

  return found.slice(0, 3);
}

function recommendationActionZh(recommendation: ResearchRecommendation): string {
  switch (recommendation) {
    case "stop":
      return "不做原想法（停止或改方向）";
    case "continue_research":
      return "继续补充调研，暂不立项";
    case "enter_product_definition":
      return "可以进入需求设计";
  }
}

function inferVerdictLabel(raw: string): string {
  if (/判断[：:]\s*\*?\*?stop\b|建议\s*stop|不建议开发|不宜.*立项|不成立/i.test(raw)) {
    return "不做";
  }
  if (/继续补充|继续调研|暂不立项|continue_research|先做.*验证/i.test(raw)) {
    return "继续调研";
  }
  if (/进入需求|可立项|值得做|enter_product/i.test(raw)) {
    return "可推进";
  }
  return "待定";
}

function extractJudgmentCore(raw: string): string {
  const paren = raw.match(/判断[：:]\s*\*?\*?stop\*?\*?\s*[（(]([^）)]{6,100})/i)?.[1];
  const dash = raw.match(/判断[：:][^。\n]{0,40}?(?:——|—)\s*([^。；\n]{6,80})/)?.[1];
  const plain = raw.match(/判断[：:]\s*([^。；\n]{6,80})/)?.[1];
  const core = cleanClause(paren || dash || plain || "")
    .replace(/^就\s*[\w\-]+\s*分支而言[，,]?\s*/i, "")
    .replace(/[「」『』]/g, "")
    .replace(/^\*?\*?stop\*?\*?[：:\s—\-]*/i, "");
  if (!core) return "";
  return shortenComplete(core, 42);
}

function extractReasonBullets(raw: string, limit: number): string[] {
  const block = raw.match(/理由[：:]([\s\S]*?)(?=缺口[：:]|$)/)?.[1] || "";
  if (!block.trim()) return [];
  // Do NOT cap each bullet at ~90 chars in the matcher — long competitor / supply
  // bullets were being dropped, leaving only short niche lines in the digest.
  const numbered = [
    ...block.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩]([^①②③④⑤⑥⑦⑧⑨⑩]*)/g),
  ]
    .map((item) => cleanClause(item[1] || "").replace(/^[、.．:：)\s]+/, "").replace(/[；;，,\s]+$/, ""))
    .filter((item) => item.length >= 8);
  const stripIndex = (item: string) =>
    cleanClause(item.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]+[、.．:：)\s]*/, "").split(/[（(]/)[0] || "");
  const candidates = numbered.length ? numbered : splitClauses(block);
  const picked = pickReasonBullets(candidates, limit);
  return picked.map((item) => shortenComplete(stripIndex(item), 56));
}

/** Keep the lead reason, then prefer competitor/supply bullets over short niche asides. */
function pickReasonBullets(candidates: string[], limit: number): string[] {
  if (candidates.length <= limit) return candidates.slice(0, limit);
  const picked: string[] = [];
  const take = (item: string | undefined) => {
    if (!item || picked.includes(item) || picked.length >= limit) return;
    picked.push(item);
  };
  take(candidates[0]);
  const competitive = candidates
    .slice(1)
    .filter((item) => competitiveSignalScore(item) > 0)
    .sort((a, b) => competitiveSignalScore(b) - competitiveSignalScore(a));
  for (const item of competitive) take(item);
  for (const item of candidates) take(item);
  return picked;
}

export function competitiveSignalScore(text: string): number {
  const raw = String(text || "");
  let score = 0;
  if (/竞品|替代供给|长辈版|老年版|95128|助老打车|市场份额|定价|供给侧|大平台|独立\s*APP|独立\s*App/i.test(raw)) {
    score += 4;
  }
  if (/作文批改|智能批改|教培竞品|作业帮|科大讯飞|猿辅导|学而思|general[- ]purpose AI|通用大模型|ChatGPT/i.test(raw)) {
    score += 4;
  }
  if (/滴滴|高德|美团|曹操|首汽|T3|Didi|Meituan|competitor|substitute|一键叫车/i.test(raw)) {
    score += 3;
  }
  if (/平台|小程序|热线|覆盖|polish.*essay|primary[- ]school essay/i.test(raw)) score += 1;
  if (/[\u4e00-\u9fff]/.test(raw)) score += 1;
  return score;
}

/** Prefer ending on a natural pause; never invent mid-sentence ellipsis. */
function shortenComplete(text: string, max: number): string {
  const raw = cleanClause(text);
  if (raw.length <= max) return raw;
  const sentenceEnd = raw.search(/[。！？]/);
  if (sentenceEnd > 0 && sentenceEnd <= max) return raw.slice(0, sentenceEnd);
  const slice = raw.slice(0, max);
  const pause = Math.max(
    slice.lastIndexOf("，"),
    slice.lastIndexOf("、"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf("："),
    slice.lastIndexOf(" "),
  );
  if (pause >= Math.floor(max * 0.4)) return cleanClause(slice.slice(0, pause));
  // Fall back to the first short clause; avoid dangling digits/quotes/Latin stubs.
  const firstClause = splitClauses(raw.replace(/[———]/g, "。"))[0];
  if (firstClause && firstClause.length <= max) return firstClause;
  return cleanClause(slice)
    .replace(/[「『"'\d]+$/g, "")
    .replace(/\s*[（(]?[A-Za-z][A-Za-z0-9\s\-_\/]*$/g, "");
}

function extractGapOneLiner(raw: string): string {
  const block = raw.match(/缺口[：:]([\s\S]*?)$/)?.[1] || "";
  if (!block.trim()) return "";
  const cleaned = cleanClause(block.replace(/^[①②③④⑤⑥⑦⑧⑨⑩\d]+[、.．:：)\s]*/, "")).split(/[（(]/)[0]
    || "";
  if (!cleaned) return "";
  const short = shortenComplete(cleaned, 40);
  return short ? `${short.replace(/[。！？]+$/g, "")}。` : "";
}

function oneLineJudgment(text: string): string {
  const digest = formatBranchDigestZh(text);
  const first = digest.split("\n")[0] || "";
  return first.replace(/^(?:结论|判断)[：:]\s*/, "").replace(/。$/, "");
}

function branchLabel(id: string): string {
  switch (id) {
    case "user-research":
      return "用户";
    case "market-research":
      return "市场";
    case "code-data-research":
      return "代码";
    case "risk-research":
      return "风险";
    default:
      return id;
  }
}

function splitClauses(text: string): string[] {
  return String(text)
    .split(/[。；;\n]+/)
    .map((part) => cleanClause(part))
    .filter((part) => part.length >= 6);
}

function cleanClause(text: string): string {
  return String(text || "")
    .replace(/^[\s，、；;:：\-—]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}
