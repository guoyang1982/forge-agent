export type {
  DispatchPlanEventPayload,
  DispatchPlanWaveStep,
  PlanUpdateItem,
  RunKind,
  RunPlan,
  RunPlanSource,
  RunPlanStep,
  RunStepKind,
  RunStepStatus,
  TalentAssignmentInput,
  TalentExecutionMode,
} from "./types.js";

export { assignWaves, talentExecutionWaves } from "./waves.js";
export {
  talentArtifactDirRelPath,
  talentArtifactRelPath,
  talentArtifactSlug,
} from "./artifacts.js";
export {
  buildTalentDispatchPlan,
  summarizeIntentForAssignments,
} from "./build-heuristic.js";

export {
  materializeModelTalentDispatchPlan,
  materializeTalentDispatchDraft,
  parseModelTalentDispatchDraft,
  resolveTalentDispatchPlan,
  type ModelTalentDispatchDraft,
} from "./planning.js";

import type {
  DispatchPlanEventPayload,
  DispatchPlanWaveStep,
  PlanUpdateItem,
  RunKind,
  RunPlan,
  RunPlanStep,
  RunStepStatus,
  TalentExecutionMode,
} from "./types.js";

/** Classify a run from explicit @ mentions (no auto roster pick). */
export function classifyRunKind(mentionCount: number): RunKind {
  if (mentionCount <= 0) return "coordinator";
  if (mentionCount === 1) return "talent_foreground";
  return "talent_dispatch";
}

export function inferPlanExecutionMode(plan: RunPlan): TalentExecutionMode {
  const talents = plan.steps.filter((s) => s.kind === "talent_background");
  if (talents.length <= 1) return "parallel";
  const maxWave = talents.reduce((m, s) => Math.max(m, s.wave), 0);
  return maxWave > 0 ? "serial" : "parallel";
}

export function planToDispatchPlanEvent(plan: RunPlan): DispatchPlanEventPayload {
  const waveMap = new Map<number, DispatchPlanWaveStep[]>();
  for (const step of plan.steps) {
    const list = waveMap.get(step.wave) ?? [];
    list.push({
      id: step.id,
      kind: step.kind,
      mention: step.mention,
      displayName: step.displayName,
      role: step.role,
      emoji: step.emoji,
      avatar: step.avatar,
      task: step.task,
      status: step.status,
    });
    waveMap.set(step.wave, list);
  }
  const waves = [...waveMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, steps]) => ({ index, steps }));
  return {
    intent: plan.intent,
    source: plan.source,
    runKind: plan.runKind,
    executionMode: inferPlanExecutionMode(plan),
    waves,
  };
}

export function planToPlanUpdateItems(plan: RunPlan): PlanUpdateItem[] {
  return plan.steps
    .filter((s) => s.kind !== "coordinator")
    .sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id))
    .map((step) => ({
      text: formatPlanStepLabel(step),
      status: step.status,
    }));
}

export function markStepStatus(
  plan: RunPlan,
  stepId: string,
  status: RunStepStatus,
): RunPlan {
  return {
    ...plan,
    steps: plan.steps.map((s) => (s.id === stepId ? { ...s, status } : s)),
  };
}

export function markStepsStatus(
  plan: RunPlan,
  stepIds: string[],
  status: RunStepStatus,
): RunPlan {
  const ids = new Set(stepIds);
  return {
    ...plan,
    steps: plan.steps.map((s) => (ids.has(s.id) ? { ...s, status } : s)),
  };
}

export function formatPlanStepLabel(step: RunPlanStep): string {
  const prefix = step.emoji ? `${step.emoji} ` : "";
  const who = step.displayName ? `${prefix}${step.displayName}` : step.kind;
  return `${who} · ${step.task}`;
}
