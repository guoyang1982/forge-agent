export const QUALITY_ROLE_PATTERN = /质量|验收|QA|审核|测试|review/i;

export type ReviewRecommendation = "approved" | "rejected";

export type ReviewerRef = {
  id: string;
  displayName: string;
  title?: string;
};

export type ReviewTalentPack = {
  role?: string;
  skills?: string[];
  qualityGates?: string[];
  methodology?: string[];
  systemPrompt?: string;
};

export type ReviewPreview = {
  reviewerId: string;
  recommendation: ReviewRecommendation | null;
  summary: string;
  findings: string[];
  source: "employee" | "unavailable";
  talentRole: string;
};

export function reviewerLabel(reviewer?: ReviewerRef | null): string {
  if (!reviewer) return "未指定审批人";
  return reviewer.title
    ? `${reviewer.displayName} · ${reviewer.title}`
    : reviewer.displayName;
}

export function pickDefaultReviewerId(input: {
  employees: Array<{ id: string; positionId?: string | null }>;
  positions: Array<{ id: string; title: string }>;
  assigneeId?: string | null;
  ownerId?: string | null;
}): string | null {
  const candidates = input.employees.filter(
    (employee) => employee.id && employee.id !== input.assigneeId,
  );
  const quality = candidates.find((employee) => {
    const title =
      input.positions.find((position) => position.id === employee.positionId)
        ?.title ?? "";
    return QUALITY_ROLE_PATTERN.test(title);
  });
  if (quality) return quality.id;
  if (input.ownerId && candidates.some((employee) => employee.id === input.ownerId)) {
    return input.ownerId;
  }
  return candidates[0]?.id ?? null;
}

export const REVIEW_PREVIEW_SCHEMA = 2;

export function buildReviewPreviewPrompt(input: {
  title: string;
  problem: string;
  expectedOutcome: string;
  spec: string;
  plan: string;
  workType?: string;
  resultExcerpt?: string;
  workspaceFiles?: string[];
  runId?: string;
  reviewer: ReviewerRef;
  talent?: ReviewTalentPack | null;
  memories?: string[];
}): string {
  const talent = input.talent || {};
  const skills = (talent.skills || []).filter(Boolean);
  const gates = (talent.qualityGates || []).filter(Boolean);
  const methods = (talent.methodology || []).filter(Boolean);
  const notes = (input.memories || []).map((note) => note.trim()).filter(Boolean);
  const persona = String(talent.systemPrompt || "").trim().slice(0, 2000);
  const isResearch = input.workType === "research";
  const files = (input.workspaceFiles || []).filter(Boolean);
  return [
    `你是数字员工「${reviewerLabel(input.reviewer)}」，正在做独立验收预审，不是最终批准。`,
    talent.role ? `人才包角色：${talent.role}` : "",
    skills.length ? `技能包：${skills.join("、")}` : "技能包：未绑定，按岗位职责验收。",
    gates.length ? `质量门：${gates.join("；")}` : "",
    methods.length ? `方法论：${methods.join("；")}` : "",
    persona ? `人才包要求：\n${persona}` : "",
    notes.length ? `这个人身上的经验：\n${notes.map((note) => `- ${note}`).join("\n")}` : "",
    isResearch
      ? "这份工作是调研。验收对象是已经产出的调研报告与证据，不是执行前的计划有没有把每个字段写全。计划只作对照，交付物已补齐的缺口不要再当成驳回理由。"
      : "对照规格、计划和这次执行成果判断是否可建议通过。不要改文件。",
    isResearch
      ? "规格里的一手访谈/问卷若报告已诚实披露缺口并排入下一步，写入 findings，不要因此把整份桌面研究驳回。核心验收物（结论、七维度、证据表、评分、30天计划与停止条件）缺失才驳回。"
      : "对照验收标准；缺证据就指出缺口。",
    "只返回 JSON 对象，不要 markdown 围栏，字段：recommendation（approved 或 rejected）、summary（字符串）、findings（字符串数组）。",
    `工作类型：${input.workType || "implementation"}`,
    `标题：${input.title}`,
    `问题：${input.problem}`,
    `验收标准：${input.expectedOutcome}`,
    `规格：${input.spec}`,
    `计划：${input.plan}`,
    input.resultExcerpt ? `执行成果摘录：\n${input.resultExcerpt}` : "执行成果摘录：无保存的报告正文。",
    files.length ? `工作区写下的文件：\n${files.map((path) => `- ${path}`).join("\n")}` : "",
    input.runId ? `对应 Run：${input.runId}` : "",
  ].filter(Boolean).join("\n");
}

export function parseReviewPreview(text: string): {
  recommendation: ReviewRecommendation;
  summary: string;
  findings: string[];
} | null {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      recommendation?: unknown;
      summary?: unknown;
      findings?: unknown;
    };
    if (parsed.recommendation !== "approved" && parsed.recommendation !== "rejected") {
      return null;
    }
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) return null;
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.filter((item): item is string =>
        typeof item === "string" && item.trim() !== "").map((item) => item.trim())
      : [];
    return {
      recommendation: parsed.recommendation,
      summary,
      findings,
    };
  } catch {
    return null;
  }
}

export async function composeReviewPreview(input: {
  title: string;
  problem: string;
  expectedOutcome: string;
  spec: string;
  plan: string;
  workType?: string;
  resultExcerpt?: string;
  workspaceFiles?: string[];
  runId?: string;
  reviewer: ReviewerRef;
  talent?: ReviewTalentPack | null;
  memories?: string[];
  generate?: (prompt: string) => Promise<string>;
}): Promise<ReviewPreview> {
  const talentRole = input.talent?.role?.trim() || input.reviewer.title || "未绑定人才";
  if (input.generate) {
    try {
      const parsed = parseReviewPreview(
        await input.generate(buildReviewPreviewPrompt(input)),
      );
      if (parsed) {
        return {
          reviewerId: input.reviewer.id,
          ...parsed,
          source: "employee",
          talentRole,
        };
      }
    } catch {
      // Fall through to an explicit unavailable preview.
    }
  }
  return {
    reviewerId: input.reviewer.id,
    recommendation: null,
    summary: "预审未能完成，请人工验收。",
    findings: [],
    source: "unavailable",
    talentRole,
  };
}

export function encodeReviewPreviewReason(preview: ReviewPreview & { runId?: string }): string {
  return JSON.stringify({
    kind: "review_preview",
    schemaVersion: REVIEW_PREVIEW_SCHEMA,
    runId: preview.runId ?? null,
    recommendation: preview.recommendation,
    summary: preview.summary,
    findings: preview.findings,
    source: preview.source,
    talentRole: preview.talentRole,
  });
}

export function decodeReviewPreviewReason(reason: string | null | undefined): {
  kind: "review_preview";
  schemaVersion: number;
  runId: string | null;
  recommendation: ReviewRecommendation | null;
  summary: string;
  findings: string[];
  source: "employee" | "unavailable";
  talentRole: string;
} | null {
  if (!reason || !reason.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(reason) as Record<string, unknown>;
    if (parsed.kind !== "review_preview") return null;
    const recommendation =
      parsed.recommendation === "approved" || parsed.recommendation === "rejected"
        ? parsed.recommendation
        : null;
    return {
      kind: "review_preview",
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
      runId: typeof parsed.runId === "string" ? parsed.runId : null,
      recommendation,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.filter((item): item is string => typeof item === "string")
        : [],
      source: parsed.source === "unavailable" ? "unavailable" : "employee",
      talentRole: typeof parsed.talentRole === "string" ? parsed.talentRole : "",
    };
  } catch {
    return null;
  }
}
