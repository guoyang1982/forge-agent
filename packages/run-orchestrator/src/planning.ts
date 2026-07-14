import type { RunPlan, TalentAssignmentInput, TalentExecutionMode } from "./types.js";
import { buildTalentDispatchPlan, summarizeIntentForAssignments } from "./build-heuristic.js";
import { assignWaves } from "./waves.js";

export interface ModelTalentDispatchDraft {
  intent?: string;
  steps: Array<{
    mention: string;
    task: string;
    after?: string[];
  }>;
}

export function parseModelTalentDispatchDraft(
  text: string,
): ModelTalentDispatchDraft | undefined {
  const raw = extractJsonObject(text);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!Array.isArray(parsed.steps) || !parsed.steps.length) return undefined;
    const steps: ModelTalentDispatchDraft["steps"] = [];
    for (const item of parsed.steps) {
      if (!item || typeof item !== "object") return undefined;
      const row = item as Record<string, unknown>;
      if (!isNonEmptyString(row.mention) || !isNonEmptyString(row.task)) {
        return undefined;
      }
      const after = Array.isArray(row.after)
        ? row.after.filter((v): v is string => isNonEmptyString(v))
        : [];
      steps.push({
        mention: normalizeMention(row.mention),
        task: row.task.trim(),
        after: after.map(normalizeMention),
      });
    }
    const intent = isNonEmptyString(parsed.intent) ? parsed.intent.trim() : undefined;
    return { intent, steps };
  } catch {
    return undefined;
  }
}

/** Turn validated model JSON into a RunPlan; undefined if invalid vs roster. */
export function materializeModelTalentDispatchPlan(
  text: string,
  assignments: TalentAssignmentInput[],
): RunPlan | undefined {
  const draft = parseModelTalentDispatchDraft(text);
  if (!draft) return undefined;
  return materializeTalentDispatchDraft(draft, assignments);
}

export function materializeTalentDispatchDraft(
  draft: ModelTalentDispatchDraft,
  assignments: TalentAssignmentInput[],
): RunPlan | undefined {
  const byMention = new Map(
    assignments.map((a) => [normalizeMention(a.mention), a]),
  );
  const expected = new Set(byMention.keys());
  const seen = new Set<string>();

  const talentSteps = [];
  for (let i = 0; i < draft.steps.length; i++) {
    const step = draft.steps[i]!;
    const key = normalizeMention(step.mention);
    if (!expected.has(key) || seen.has(key)) return undefined;
    seen.add(key);
    const meta = byMention.get(key)!;
    const id = `talent-${i + 1}`;
    const mentionToId = new Map<string, string>();
    draft.steps.forEach((s, idx) => {
      mentionToId.set(normalizeMention(s.mention), `talent-${idx + 1}`);
    });
    const after = (step.after ?? [])
      .map((m) => mentionToId.get(normalizeMention(m)))
      .filter((id): id is string => Boolean(id));
    talentSteps.push({
      id,
      kind: "talent_background" as const,
      mention: meta.mention,
      displayName: meta.displayName,
      role: meta.role,
      emoji: meta.emoji,
      avatar: meta.avatar,
      task: step.task,
      after,
      wave: 0,
      status: "pending" as const,
    });
  }

  if (seen.size !== expected.size) return undefined;

  let withWaves;
  try {
    withWaves = assignWaves(talentSteps);
  } catch {
    return undefined;
  }

  const coordinatorStep = {
    id: "coordinator-summary",
    kind: "coordinator" as const,
    task: "汇总各人才产出、统一写盘并校验",
    after: withWaves.map((s) => s.id),
    wave: 0,
    status: "pending" as const,
  };
  let steps;
  try {
    steps = assignWaves([...withWaves, coordinatorStep]);
  } catch {
    return undefined;
  }

  return {
    intent: draft.intent?.trim() || summarizeIntentForAssignments("", assignments),
    source: "model",
    runKind: "talent_dispatch",
    steps,
    coordinatorFollowup: true,
  };
}

/** Model plan when valid; otherwise heuristic fallback. */
export function resolveTalentDispatchPlan(input: {
  message: string;
  assignments: TalentAssignmentInput[];
  executionMode: TalentExecutionMode;
  /** Pre-parsed model draft (preferred — comes from the unified intent call). */
  modelDraft?: ModelTalentDispatchDraft;
  /** Raw model text to parse when no draft is supplied (legacy path). */
  modelText?: string | null;
  /**
   * Force serial waves when the model returned a flat (dependency-free) plan.
   * Should reflect a *positive* serial signal (explicit marker or a later task
   * referencing earlier work) — not the ambiguous safe default, which would
   * wrongly serialize genuinely independent work the model judged parallel.
   * Defaults to the legacy behavior (`executionMode === "serial"`).
   */
  forceSerialIfFlat?: boolean;
}): RunPlan {
  const draft =
    input.modelDraft ??
    (input.modelText?.trim()
      ? parseModelTalentDispatchDraft(input.modelText)
      : undefined);
  if (draft) {
    const fromModel = materializeTalentDispatchDraft(draft, input.assignments);
    if (fromModel) {
      const forceSerial =
        input.forceSerialIfFlat ?? input.executionMode === "serial";
      if (
        forceSerial &&
        !modelPlanRespectsSerial(input.assignments.length, fromModel)
      ) {
        return buildTalentDispatchPlan({
          message: input.message,
          assignments: applyModelTasksToAssignments(input.assignments, draft),
          executionMode: "serial",
          source: "model",
          intent: draft.intent,
        });
      }
      return fromModel;
    }
  }
  return buildTalentDispatchPlan({
    message: input.message,
    assignments: input.assignments,
    executionMode: input.executionMode,
  });
}

function modelPlanRespectsSerial(
  talentCount: number,
  plan: RunPlan,
): boolean {
  if (talentCount <= 1) return true;
  const talents = plan.steps.filter((s) => s.kind === "talent_background");
  const maxWave = talents.reduce((m, s) => Math.max(m, s.wave), 0);
  return maxWave > 0;
}

function applyModelTasksToAssignments(
  assignments: TalentAssignmentInput[],
  draft: ModelTalentDispatchDraft,
): TalentAssignmentInput[] {
  const taskByMention = new Map(
    draft.steps.map((s) => [normalizeMention(s.mention), s.task]),
  );
  return assignments.map((a) => ({
    ...a,
    task: taskByMention.get(normalizeMention(a.mention)) ?? a.task,
  }));
}

function normalizeMention(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;

  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return undefined;
}
