import type {
  RunPlan,
  RunPlanStep,
  TalentAssignmentInput,
  TalentExecutionMode,
} from "./types.js";
import { assignWaves } from "./waves.js";

export function summarizeIntentForAssignments(
  message: string,
  assignments: TalentAssignmentInput[],
): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 120) {
    return trimmed || assignments.map((a) => a.task).join("；");
  }
  const names = assignments.map((a) => a.displayName).join("、");
  return `向 ${names} 派活：${trimmed.slice(0, 80)}…`;
}

/** Build a heuristic RunPlan for multi-@ talent dispatch (L2). */
export function buildTalentDispatchPlan(options: {
  message: string;
  assignments: TalentAssignmentInput[];
  executionMode: TalentExecutionMode;
  source?: RunPlan["source"];
  intent?: string;
}): RunPlan {
  const { message, assignments, executionMode } = options;
  const intent =
    options.intent?.trim() ||
    summarizeIntentForAssignments(message, assignments);
  const talentSteps: RunPlanStep[] = assignments.map((assignment, index) => {
    const id = `talent-${index + 1}`;
    const after =
      executionMode === "serial" && index > 0 ? [`talent-${index}`] : [];
    return {
      id,
      kind: "talent_background",
      mention: assignment.mention,
      displayName: assignment.displayName,
      role: assignment.role,
      emoji: assignment.emoji,
      avatar: assignment.avatar,
      task: assignment.task,
      after,
      wave: 0,
      status: "pending",
    };
  });

  const withWaves = assignWaves(talentSteps);
  const coordinatorStep: RunPlanStep = {
    id: "coordinator-summary",
    kind: "coordinator",
    task: "汇总各人才产出、统一写盘并校验",
    after: withWaves.map((s) => s.id),
    wave: 0,
    status: "pending",
  };
  const steps = assignWaves([...withWaves, coordinatorStep]);

  return {
    intent,
    source: options.source ?? "heuristic",
    runKind: "talent_dispatch",
    steps,
    coordinatorFollowup: true,
  };
}
