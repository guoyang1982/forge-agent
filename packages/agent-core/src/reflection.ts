import type {
  ChatMessage,
  ForgeConfig,
  ReflectionConfig,
  ReflectionIssue,
  ReflectionVerdict,
} from "@forge/protocol";
import { plainTextFromChatContent } from "@forge/protocol";
import { LlmClient } from "@forge/llm";

const VALID_DIMENSIONS = new Set([
  "completeness",
  "grounding",
  "consistency",
  "instruction",
]);

export interface ReflectionDefaults {
  maxRounds: number;
  minStepsBudget: number;
  severityGate: "blocker" | "minor";
}

export const REFLECTION_DEFAULTS: ReflectionDefaults = {
  maxRounds: 1,
  minStepsBudget: 2,
  severityGate: "blocker",
};

function num(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

/** Resolve the reviewer model: reflection.reviewerProfile, else the active model. */
export function resolveReviewerModel(
  config: ForgeConfig,
): ForgeConfig["model"] {
  const id = config.reflection?.reviewerProfile;
  const profile = id ? config.profiles?.[id] : undefined;
  if (!profile) return config.model;
  return {
    ...config.model,
    ...profile,
    apiKey: profile.apiKey || config.model.apiKey,
  };
}

/**
 * Decide whether to run a reflection pass before delivering `finalText`.
 * Budget-aware: leaves room to actually apply a fix, and caps total rounds.
 */
export function shouldReflect(args: {
  config: ForgeConfig;
  finalText: string;
  step: number;
  maxSteps: number;
  roundsUsed: number;
}): boolean {
  const cfg = args.config.reflection;
  if (!cfg?.enabled) return false;
  if (!args.finalText.trim()) return false;
  const maxRounds = num(cfg.maxRounds, REFLECTION_DEFAULTS.maxRounds);
  if (args.roundsUsed >= maxRounds) return false;
  const minBudget = num(cfg.minStepsBudget, REFLECTION_DEFAULTS.minStepsBudget);
  // step is 0-based; remaining steps after this one must cover a revise round.
  const remaining = args.maxSteps - (args.step + 1);
  if (remaining < minBudget) return false;
  return true;
}

/** True when the verdict carries an issue at or above the configured gate. */
export function hasBlockingIssue(
  verdict: ReflectionVerdict,
  cfg: ReflectionConfig | undefined,
): boolean {
  if (verdict.verdict !== "revise") return false;
  const gate = cfg?.severityGate ?? REFLECTION_DEFAULTS.severityGate;
  if (gate === "minor") return verdict.issues.length > 0;
  return verdict.issues.some((i) => i.severity === "blocker");
}

/** Compact, bounded summary of failing tool results to ground the reviewer. */
export function collectToolEvidence(
  messages: ChatMessage[],
  maxLines = 12,
  maxLineChars = 240,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    const raw = plainTextFromChatContent(m.content);
    if (!raw) continue;
    let failed = false;
    try {
      const parsed = JSON.parse(raw);
      failed = parsed?.ok === false || Boolean(parsed?.error);
    } catch {
      failed = /\b(error|failed|exception|traceback)\b|失败|报错/i.test(raw);
    }
    if (!failed) continue;
    const oneLine = raw.replace(/\s+/g, " ").trim().slice(0, maxLineChars);
    lines.push(`- ${oneLine}`);
  }
  if (!lines.length) return "（无失败/报错类工具结果）";
  return lines.slice(-maxLines).join("\n");
}

const REFLECTION_SYSTEM = [
  "你是严格的审校者。针对「原始任务」评判「候选答复」，只从四个维度判断：",
  "1. completeness 完整性：用户要求的每一项是否都被回应；有无遗漏。",
  "2. grounding 接地性：答复里的事实/数字/断言是否有工具结果支撑，而非臆测。",
  "3. consistency 一致性：答复是否自相矛盾或与已知工具结果冲突。",
  "4. instruction 指令遵从：是否遵守用户的范围/格式/约束。",
  "",
  "严重度：只有当问题严重到必须返工才标 blocker，否则标 minor。",
  "如果答复可接受，返回 {\"verdict\":\"pass\",\"issues\":[]}。",
  "只输出 JSON，不要任何解释或 Markdown 代码块。模式：",
  '{"verdict":"pass"|"revise","issues":[{"dimension":"completeness"|"grounding"|"consistency"|"instruction","severity":"blocker"|"minor","detail":"...","suggestedAction":"..."}]}',
].join("\n");

export interface ReflectionContext {
  taskText: string;
  finalText: string;
  toolEvidence: string;
}

function buildReflectionMessages(ctx: ReflectionContext): ChatMessage[] {
  const user = [
    "## 原始任务",
    ctx.taskText || "（未提供）",
    "",
    "## 候选答复",
    ctx.finalText || "（空）",
    "",
    "## 工具证据（失败/报错摘录）",
    ctx.toolEvidence,
  ].join("\n");
  return [
    { role: "system", content: REFLECTION_SYSTEM },
    { role: "user", content: user },
  ];
}

/** Extract the first balanced JSON object; tolerant of stray prose/code fences. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeIssue(raw: unknown): ReflectionIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const dimension = String(r.dimension ?? "");
  if (!VALID_DIMENSIONS.has(dimension)) return null;
  const severity = r.severity === "blocker" ? "blocker" : "minor";
  return {
    dimension: dimension as ReflectionIssue["dimension"],
    severity,
    detail: String(r.detail ?? "").slice(0, 1000),
    suggestedAction: String(r.suggestedAction ?? "").slice(0, 1000),
  };
}

/** Parse a reviewer reply into a verdict. Fail-open to `pass` on any error. */
export function parseVerdict(text: string | null | undefined): ReflectionVerdict {
  const pass: ReflectionVerdict = { verdict: "pass", issues: [] };
  if (!text) return pass;
  const json = extractJsonObject(text);
  if (!json) return pass;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const issues = Array.isArray(obj.issues)
      ? obj.issues.map(normalizeIssue).filter((i): i is ReflectionIssue => i != null)
      : [];
    const verdict = obj.verdict === "revise" ? "revise" : "pass";
    // A revise with no parseable issues can't drive a fix — treat as pass.
    if (verdict === "revise" && issues.length === 0) return pass;
    return { verdict, issues };
  } catch {
    return pass;
  }
}

/** Run one reflection pass. Never throws for model/parse errors — fails open. */
export async function reflectOnFinal(
  reviewer: LlmClient,
  ctx: ReflectionContext,
  signal?: AbortSignal,
): Promise<ReflectionVerdict> {
  try {
    const res = await reviewer.chat({
      messages: buildReflectionMessages(ctx),
      tools: [],
      signal,
    });
    return parseVerdict(res.text);
  } catch {
    return { verdict: "pass", issues: [] };
  }
}

/** Build the corrective message injected back into the loop on a revise verdict. */
export function formatReflectionNudge(verdict: ReflectionVerdict): string {
  const lines = verdict.issues.map(
    (i, idx) =>
      `${idx + 1}. [${i.dimension}/${i.severity}] ${i.detail}\n   → 建议：${i.suggestedAction}`,
  );
  return [
    "[forge] 反思发现以下问题，请先修复再给出最终答复（可使用工具核对/修正）：",
    ...lines,
    "修复后请重新输出完整、准确的最终答复。",
  ].join("\n");
}
