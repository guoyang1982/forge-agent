import {
  draftPlanFromDemand,
  draftSpecFromDemand,
  type DemandDraftInput,
} from "./demand-drafts.js";

export const PRODUCT_ROLE_PATTERN = /产品|规格|需求|PM/i;
export const RESEARCH_ROLE_PATTERN = /市场|调研|研究|情报/i;

export type DraftSource = "employee" | "model" | "template";

export type DrafterRef = {
  id: string;
  displayName: string;
  title?: string;
};

export type DraftTalentPack = {
  role?: string;
  skills?: string[];
  qualityGates?: string[];
  methodology?: string[];
  systemPrompt?: string;
};

export function isResearchAssignment(input: {
  type?: string | null;
  title?: string | null;
  problem?: string | null;
}): boolean {
  if (input.type === "research") return true;
  if (input.type === "implementation" || input.type === "fix") return false;
  return /调研|市场|可行|竞品|情报/.test(
    `${input.title ?? ""} ${input.problem ?? ""}`,
  );
}

function titleOf(
  employee: { positionId?: string | null },
  positions: Array<{ id: string; title: string }>,
): string {
  return positions.find((position) => position.id === employee.positionId)?.title ?? "";
}

function findByRole(
  employees: Array<{ id: string; positionId?: string | null }>,
  positions: Array<{ id: string; title: string }>,
  pattern: RegExp,
) {
  return employees.find((employee) => pattern.test(titleOf(employee, positions)));
}

export function pickDefaultDrafterId(input: {
  employees: Array<{ id: string; positionId?: string | null }>;
  positions: Array<{ id: string; title: string }>;
  ownerId?: string | null;
  kind?: "research" | "product";
}): string | null {
  if (input.kind === "research") {
    const researcher = findByRole(
      input.employees,
      input.positions,
      RESEARCH_ROLE_PATTERN,
    );
    if (researcher) return researcher.id;
  }
  const product = findByRole(input.employees, input.positions, PRODUCT_ROLE_PATTERN);
  if (product) return product.id;
  if (
    input.ownerId &&
    input.employees.some((employee) => employee.id === input.ownerId)
  ) {
    return input.ownerId;
  }
  return null;
}

export function pickDefaultAssigneeId(input: {
  employees: Array<{
    id: string;
    positionId?: string | null;
    workspaces?: Array<{ isDefault?: boolean; mode?: string }>;
  }>;
  positions: Array<{ id: string; title: string }>;
  kind?: "research" | "product";
  currentAssigneeId?: string | null;
}): string | null {
  if (
    input.currentAssigneeId &&
    input.employees.some((employee) => employee.id === input.currentAssigneeId)
  ) {
    return input.currentAssigneeId;
  }
  if (input.kind === "research") {
    const researcher = findByRole(
      input.employees,
      input.positions,
      RESEARCH_ROLE_PATTERN,
    );
    if (researcher) return researcher.id;
    const product = findByRole(
      input.employees,
      input.positions,
      PRODUCT_ROLE_PATTERN,
    );
    if (product) return product.id;
  }
  const writer = input.employees.find((employee) =>
    (employee.workspaces || []).some(
      (grant) => grant.isDefault && grant.mode === "write",
    ),
  );
  return writer?.id ?? null;
}

export function drafterLabel(drafter?: DrafterRef | null): string {
  if (!drafter) return "模型代写";
  return drafter.title
    ? `${drafter.displayName} · ${drafter.title}`
    : drafter.displayName;
}

export function attributeDraft(content: string, label: string): string {
  const line = `起草：${label}`;
  if (content.includes(line)) return content.trim();
  return `${content.trim()}\n\n---\n${line}\n`;
}

export function buildArtifactDraftPrompt(
  demand: DemandDraftInput,
  drafter?: DrafterRef | null,
  talent?: DraftTalentPack | null,
  memories: string[] = [],
): string {
  const pack = talent || {};
  const skills = (pack.skills || []).filter(Boolean);
  const gates = (pack.qualityGates || []).filter(Boolean);
  const methods = (pack.methodology || []).filter(Boolean);
  const notes = memories.map((note) => note.trim()).filter(Boolean);
  const persona = String(pack.systemPrompt || "").trim().slice(0, 2000);
  const role = drafter
    ? `你是数字员工「${drafterLabel(drafter)}」，按人才包把需求写成可执行规格和计划。`
    : "你是公司默认模型，把需求写成可执行规格和计划。";
  return [
    role,
    pack.role ? `人才包角色：${pack.role}` : "",
    skills.length ? `技能包：${skills.join("、")}` : drafter ? "技能包：未绑定，按岗位职责起草。" : "",
    gates.length ? `质量门：${gates.join("；")}` : "",
    methods.length ? `方法论：${methods.join("；")}` : "",
    persona ? `人才包要求：\n${persona}` : "",
    notes.length ? `这个人身上的经验：\n${notes.map((note) => `- ${note}`).join("\n")}` : "",
    "不要照抄需求原文。规格要写清范围、非目标、关键流程和可判定验收标准。计划要按依赖拆成可执行步骤，并写清每步如何验收。",
    "只返回 JSON 对象，不要 markdown 围栏，字段为 spec 和 plan，值是 markdown 字符串。",
    `标题：${demand.title}`,
    `问题：${demand.problem}`,
    `验收标准：${demand.expectedOutcome}`,
  ].filter(Boolean).join("\n");
}

export function parseGeneratedDrafts(
  text: string,
): { spec: string; plan: string } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { spec?: unknown; plan?: unknown };
    if (
      typeof parsed.spec === "string" &&
      typeof parsed.plan === "string" &&
      parsed.spec.trim() &&
      parsed.plan.trim()
    ) {
      return { spec: parsed.spec.trim(), plan: parsed.plan.trim() };
    }
  } catch {
    return null;
  }
  return null;
}

export async function composeArtifactDrafts(input: {
  type?: string;
  title: string;
  problem: string;
  expectedOutcome: string;
  drafter?: DrafterRef | null;
  talent?: DraftTalentPack | null;
  memories?: string[];
  generate?: (prompt: string) => Promise<string>;
}): Promise<{
  spec: string;
  plan: string;
  source: DraftSource;
  drafterId: string | null;
  talentRole: string;
  error?: string;
}> {
  const demand = {
    type: input.type,
    title: input.title,
    problem: input.problem,
    expectedOutcome: input.expectedOutcome,
  };
  const label = drafterLabel(input.drafter);
  const talentRole = input.talent?.role?.trim() || input.drafter?.title || "未绑定人才";
  let error: string | undefined;
  if (input.generate) {
    try {
      const parsed = parseGeneratedDrafts(
        await input.generate(
          buildArtifactDraftPrompt(demand, input.drafter, input.talent, input.memories),
        ),
      );
      if (parsed) {
        return {
          spec: attributeDraft(parsed.spec, label),
          plan: attributeDraft(parsed.plan, label),
          source: input.drafter ? "employee" : "model",
          drafterId: input.drafter?.id ?? null,
          talentRole,
        };
      }
      error = "模型返回了内容，但无法解析成规格和计划";
    } catch (caught) {
      error = draftErrorMessage(caught);
    }
  }
  return {
    spec: attributeDraft(draftSpecFromDemand(demand), label),
    plan: attributeDraft(draftPlanFromDemand(demand), label),
    source: "template",
    drafterId: input.drafter?.id ?? null,
    talentRole,
    ...(error ? { error } : {}),
  };
}

function draftErrorMessage(caught: unknown): string {
  if (caught instanceof DOMException && caught.name === "AbortError") {
    return "模型起草超时";
  }
  const raw = caught instanceof Error ? caught.message : String(caught);
  if (/aborted|timeout|Timeout/i.test(raw)) return "模型起草超时";
  return raw || "模型不可用";
}
