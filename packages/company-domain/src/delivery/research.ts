import type { ResearchClaim } from "./types.js";
import {
  competitiveSignalScore,
  formatBranchDigestZh,
  formatDecisionExecutiveZh,
  formatHighlightZh,
  type ResearchSuggestedDirection,
} from "./research-digest.js";

export type { ResearchSuggestedDirection } from "./research-digest.js";
export {
  competitiveSignalScore,
  deriveSuggestedDirections,
  formatBranchDigestZh,
  formatDecisionExecutiveZh,
  formatHighlightZh,
  humanizeGap,
} from "./research-digest.js";

export interface ClaimConflict {
  claimIds: [string, string];
}

export interface ResearchSynthesis {
  claims: ResearchClaim[];
  conflicts: ClaimConflict[];
  unknowns: ResearchClaim[];
  recommendation: "stop" | "continue_research" | "enter_product_definition";
  rationaleClaimIds: string[];
}

export type ResearchRecommendation = ResearchSynthesis["recommendation"];

export interface ResearchBriefClaim {
  id: string;
  text: string;
  classification: "fact" | "inference" | "hypothesis" | "unknown";
  evidenceIds?: string[];
}

export interface ResearchBranchDigest {
  id: string;
  label: string;
  summary: string;
  highlights: string[];
  claimCount: number;
}

export interface ResearchReadingBrief {
  executiveSummary: string;
  /** Concrete next moves when stop / continue — not a passive claim dump. */
  suggestedDirections: ResearchSuggestedDirection[];
  branches: ResearchBranchDigest[];
}

const BRANCH_ORDER = [
  "user-research",
  "market-research",
  "code-data-research",
  "risk-research",
] as const;

const BRANCH_LABELS: Record<(typeof BRANCH_ORDER)[number], string> = {
  "user-research": "用户调研",
  "market-research": "市场调研",
  "code-data-research": "代码与数据",
  "risk-research": "风险研判",
};

type ClaimWithPolarity = ResearchClaim & {
  polarity?: "positive" | "negative";
};

export function normalizeClaim<T extends ResearchClaim>(claim: T): T {
  const confidence = Number.isFinite(claim.confidence)
    ? Math.min(1, Math.max(0, claim.confidence))
    : 0;
  return {
    ...claim,
    text: claim.text.trim(),
    confidence,
    classification:
      claim.classification === "fact" && claim.evidenceIds.length === 0
        ? "hypothesis"
        : claim.classification,
  };
}

export function synthesizeResearch(
  sourceClaims: readonly ClaimWithPolarity[],
  options?: {
    /** Branch `conclusionZh` texts — majority stop votes override claim-count heuristics. */
    branchConclusions?: Readonly<Partial<Record<string, string>>> | null;
  },
): ResearchSynthesis {
  const claims = sourceClaims.map(normalizeClaim);
  const conflicts = findConflicts(claims);
  const unknowns = claims.filter(({ classification }) => classification === "unknown");
  const branchVote = voteBranchConclusions(options?.branchConclusions);
  const recommendation =
    claims.length === 0 || branchVote === "stop"
      ? "stop"
      : conflicts.length > 0 || unknowns.length > 0 || branchVote === "continue_research"
        ? "continue_research"
        : "enter_product_definition";
  const rationaleClaimIds =
    recommendation === "continue_research"
      ? unique([
          ...conflicts.flatMap(({ claimIds }) => claimIds),
          ...unknowns.map(({ id }) => id),
        ])
      : claims.map(({ id }) => id);
  const recommendationClaim: ResearchClaim = {
    id: "claim-recommendation",
    briefId: claims[0]?.briefId ?? "",
    text: describeRecommendation(recommendation),
    classification: "inference",
    evidenceIds: [...rationaleClaimIds],
    confidence: 1,
    contradictions: [],
  };

  return {
    claims: [...claims, recommendationClaim],
    conflicts,
    unknowns,
    recommendation,
    rationaleClaimIds,
  };
}

function describeRecommendation(
  recommendation: ResearchSynthesis["recommendation"],
): string {
  switch (recommendation) {
    case "stop":
      return "Research recommendation: stop — insufficient claims to proceed.";
    case "continue_research":
      return "Research recommendation: continue_research — resolve conflicts or unknowns before product definition.";
    case "enter_product_definition":
      return "Research recommendation: enter_product_definition — claims are consistent and cited enough to proceed.";
  }
}

/**
 * Build a Chinese reading brief so decision-makers can skim branch digests
 * instead of reading every raw (often English) claim.
 */
export function buildResearchReadingBrief(input: {
  recommendation: ResearchRecommendation;
  claims: readonly ResearchBriefClaim[];
  conflictCount?: number;
  unknownCount?: number;
  /** Operator-facing Chinese brief written at synthesis time. */
  decisionBriefZh?: string | null;
  /** Per-branch Chinese conclusions keyed by branch step id. */
  branchConclusions?: Readonly<Partial<Record<string, string>>> | null;
}): ResearchReadingBrief {
  const sourceClaims = input.claims.filter((claim) => claim.id !== "claim-recommendation");
  const buckets = Object.fromEntries(BRANCH_ORDER.map((id) => [id, [] as ResearchBriefClaim[]])) as Record<
    (typeof BRANCH_ORDER)[number],
    ResearchBriefClaim[]
  >;
  const other: ResearchBriefClaim[] = [];
  for (const claim of sourceClaims) {
    const branchId = branchIdFromClaim(claim.id);
    if (branchId) buckets[branchId].push(claim);
    else other.push(claim);
  }

  const branchIds = BRANCH_ORDER.filter(
    (id) => buckets[id].length > 0 || Boolean(input.branchConclusions?.[id]?.trim()),
  );
  const branches: ResearchBranchDigest[] = branchIds.map((id) =>
    digestBranch(id, BRANCH_LABELS[id], buckets[id], input.branchConclusions?.[id]),
  );
  if (other.length) {
    branches.push(digestBranch("other", "其他依据", other));
  }

  const conflictCount = input.conflictCount ?? 0;
  const unknownCount = input.unknownCount ?? sourceClaims.filter((claim) => claim.classification === "unknown").length;
  const decisionCard = formatDecisionExecutiveZh({
    recommendation: input.recommendation,
    branchConclusions: input.branchConclusions,
    conflictCount,
    unknownCount,
  });
  // Prefer the structured decision card over the raw wall-of-text decisionBriefZh.
  return {
    executiveSummary: decisionCard.executiveSummary,
    suggestedDirections: decisionCard.suggestedDirections,
    branches,
  };
}

function digestBranch(
  id: string,
  label: string,
  claims: readonly ResearchBriefClaim[],
  writtenConclusion?: string | null,
): ResearchBranchDigest {
  const highlights = pickHighlights(claims, 3);
  const written = formatBranchDigestZh(String(writtenConclusion || "").trim());
  if (written) {
    return {
      id,
      label,
      summary: written,
      highlights,
      claimCount: claims.length,
    };
  }
  const counts = {
    fact: 0,
    inference: 0,
    hypothesis: 0,
    unknown: 0,
  };
  for (const claim of claims) {
    counts[claim.classification] += 1;
  }
  const unknownHighlights = claims
    .filter((claim) => claim.classification === "unknown")
    .slice(0, 2)
    .map((claim) => clipClaimText(claim.text));
  const judgment = counts.unknown > 0
    ? "仍有未知项，结论只能作方向参考。"
    : counts.fact >= Math.max(2, Math.ceil(claims.length * 0.4))
      ? "事实依据相对充足，可作决策参考。"
      : "推断/假设偏多，需谨慎采信。";
  const summaryParts = [
    `${label}共 ${claims.length} 条（事实${counts.fact}、推断${counts.inference}、假设${counts.hypothesis}、未知${counts.unknown}）。`,
    judgment,
  ];
  if (highlights.length) {
    summaryParts.push(`关键要点：${highlights.join("；")}`);
  }
  if (unknownHighlights.length) {
    summaryParts.push(`待核实：${unknownHighlights.join("；")}`);
  }
  return {
    id,
    label,
    summary: summaryParts.join(""),
    highlights,
    claimCount: claims.length,
  };
}

function pickHighlights(claims: readonly ResearchBriefClaim[], limit: number): string[] {
  const classBoost = (classification: ResearchBriefClaim["classification"]) => {
    if (classification === "fact") return 5;
    if (classification === "inference") return 2;
    if (classification === "hypothesis") return 1;
    return 0;
  };
  const ranked = claims
    .map((claim, index) => ({
      claim,
      score: competitiveSignalScore(claim.text) * 10 + classBoost(claim.classification) - index * 0.01,
    }))
    .filter((entry) => entry.claim.classification !== "unknown")
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const highlights: string[] = [];
  for (const entry of ranked) {
    const text = formatHighlightZh(entry.claim.text) || clipClaimText(entry.claim.text);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    highlights.push(text);
    if (highlights.length >= limit) break;
  }
  return highlights;
}

function clipClaimText(text: string, max = 110): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function branchIdFromClaim(id: string): (typeof BRANCH_ORDER)[number] | null {
  const prefix = String(id || "").includes(":") ? String(id).split(":")[0] : "";
  return (BRANCH_ORDER as readonly string[]).includes(prefix)
    ? (prefix as (typeof BRANCH_ORDER)[number])
    : null;
}

/** Majority branch stop → stop; any continue / mixed → continue_research; else go. */
export function voteBranchConclusions(
  branchConclusions?: Readonly<Partial<Record<string, string>>> | null,
): ResearchRecommendation | null {
  const texts = Object.values(branchConclusions ?? {})
    .map((text) => String(text || "").trim())
    .filter(Boolean);
  if (!texts.length) return null;
  let stop = 0;
  let cont = 0;
  let go = 0;
  for (const text of texts) {
    const vote = verdictFromConclusionZh(text);
    if (vote === "stop") stop += 1;
    else if (vote === "continue_research") cont += 1;
    else if (vote === "enter_product_definition") go += 1;
  }
  if (stop >= 2 || stop === texts.length) return "stop";
  if (cont > 0 || (stop > 0 && go > 0)) return "continue_research";
  if (go > 0 && stop === 0) return "enter_product_definition";
  return null;
}

export function verdictFromConclusionZh(
  text: string,
): ResearchRecommendation | null {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (
    /判断[：:]\s*\*?\*?stop\b|建议\s*stop|直接\s*stop|不建议开发|不宜.*立项|不成立|暂缓或停止|一票否决|正面冲突|不建议继续/i.test(
      normalized,
    )
  ) {
    return "stop";
  }
  if (
    /判断[：:]\s*(继续|补充调研|暂不立项)|建议继续补充|continue_research|先做.*验证|降级为/i.test(
      normalized,
    )
  ) {
    return "continue_research";
  }
  if (
    /判断[：:]\s*(go|值得|进入需求|可立项)|建议进入需求|enter_product_definition/i.test(
      normalized,
    )
  ) {
    return "enter_product_definition";
  }
  return null;
}

/** @deprecated Prefer formatBranchDigestZh — kept for callers expecting a single string. */
export function compactBranchConclusionZh(text: string, _max = 240): string {
  return formatBranchDigestZh(text).replace(/\n/g, " ");
}

/** @deprecated Prefer formatDecisionExecutiveZh. */
export function compactDecisionBriefZh(text: string, _max = 420): string {
  const raw = String(text || "").trim();
  if (!raw) return "";
  // If legacy brief is passed, rebuild from embedded branch lines when possible.
  const branchConclusions: Record<string, string> = {};
  for (const line of raw.split(/\n+/)) {
    const matched = line.match(/^(用户调研|市场调研|代码与数据|风险研判)[：:]\s*(.*)$/);
    if (!matched) continue;
    const id =
      matched[1] === "用户调研"
        ? "user-research"
        : matched[1] === "市场调研"
          ? "market-research"
          : matched[1] === "代码与数据"
            ? "code-data-research"
            : "risk-research";
    branchConclusions[id] = matched[2];
  }
  const recommendation = /不做原想法|暂缓或停止|建议\s*stop/i.test(raw)
    ? "stop"
    : /继续补充/.test(raw)
      ? "continue_research"
      : "enter_product_definition";
  return formatDecisionExecutiveZh({ recommendation, branchConclusions }).executiveSummary;
}

function findConflicts(claims: ClaimWithPolarity[]): ClaimConflict[] {
  const conflicts: ClaimConflict[] = [];
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const left = claims[leftIndex];
      const right = claims[rightIndex];
      if (areContradictory(left, right)) {
        conflicts.push({ claimIds: [left.id, right.id] });
      }
    }
  }
  return conflicts;
}

function areContradictory(
  left: ClaimWithPolarity,
  right: ClaimWithPolarity,
): boolean {
  const explicitlyLinked =
    left.contradictions.includes(right.id) &&
    right.contradictions.includes(left.id);
  const oppositePolarity =
    normalizeText(left.text) === normalizeText(right.text) &&
    left.polarity !== undefined &&
    right.polarity !== undefined &&
    left.polarity !== right.polarity;
  return explicitlyLinked || oppositePolarity;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
