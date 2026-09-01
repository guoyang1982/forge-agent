import type { AttemptState, RunState, StepState } from "./types.js";

export class InvalidStateTransitionError extends Error {
  constructor(
    readonly entity: "run" | "step" | "attempt",
    readonly from: string,
    readonly to: string,
  ) {
    super(`${entity} cannot transition from ${from} to ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled"],
  waiting: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const STEP_TRANSITIONS: Record<StepState, readonly StepState[]> = {
  pending: ["runnable", "skipped", "cancelled"],
  runnable: ["running", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled"],
  waiting: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  created: ["running", "cancelled", "abandoned"],
  running: ["waiting", "succeeded", "failed", "cancelled", "abandoned"],
  waiting: ["running", "failed", "cancelled", "abandoned"],
  succeeded: [],
  failed: [],
  abandoned: [],
  cancelled: [],
};

export function isTerminalRunState(state: RunState): boolean {
  return RUN_TRANSITIONS[state].length === 0;
}

export function isTerminalStepState(state: StepState): boolean {
  return STEP_TRANSITIONS[state].length === 0;
}

export function isTerminalAttemptState(state: AttemptState): boolean {
  return ATTEMPT_TRANSITIONS[state].length === 0;
}

export function transitionRun(from: RunState, to: RunState): RunState {
  return transitionState("run", from, to, RUN_TRANSITIONS);
}

export function transitionStep(from: StepState, to: StepState): StepState {
  return transitionState("step", from, to, STEP_TRANSITIONS);
}

export function transitionAttempt(
  from: AttemptState,
  to: AttemptState,
): AttemptState {
  return transitionState("attempt", from, to, ATTEMPT_TRANSITIONS);
}

function transitionState<S extends string>(
  entity: "run" | "step" | "attempt",
  from: S,
  to: S,
  transitions: Record<S, readonly S[]>,
): S {
  if (from === to) {
    return to;
  }

  const allowed = transitions[from];
  if (allowed.length === 0) {
    throw new Error(`terminal state: ${entity} cannot leave ${from}`);
  }

  if (!allowed.includes(to)) {
    throw new InvalidStateTransitionError(entity, from, to);
  }

  return to;
}

export function allowedRunTransitions(from: RunState): readonly RunState[] {
  return RUN_TRANSITIONS[from];
}

export function allowedStepTransitions(from: StepState): readonly StepState[] {
  return STEP_TRANSITIONS[from];
}

export function allowedAttemptTransitions(
  from: AttemptState,
): readonly AttemptState[] {
  return ATTEMPT_TRANSITIONS[from];
}
