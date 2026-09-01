import { describe, expect, it } from "vitest";
import {
  allowedAttemptTransitions,
  allowedRunTransitions,
  allowedStepTransitions,
  isTerminalAttemptState,
  isTerminalRunState,
  isTerminalStepState,
  transitionAttempt,
  transitionRun,
  transitionStep,
} from "./state-machine.js";
import type { AttemptState, RunState, StepState } from "./types.js";

describe("run state machine", () => {
  it.each<[RunState, RunState]>([
    ["queued", "running"],
    ["running", "waiting"],
    ["waiting", "running"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["queued", "cancelled"],
  ])("allows run transition %s -> %s", (from, to) => {
    expect(transitionRun(from, to)).toBe(to);
  });

  it("rejects succeeded -> running", () => {
    expect(() => transitionRun("succeeded", "running")).toThrow(/terminal state/i);
  });

  it("rejects illegal run transitions", () => {
    expect(() => transitionRun("queued", "succeeded")).toThrow(
      /cannot transition from queued to succeeded/i,
    );
  });

  it("treats terminal run states as terminal", () => {
    for (const state of ["succeeded", "failed", "cancelled"] as const) {
      expect(isTerminalRunState(state)).toBe(true);
      expect(allowedRunTransitions(state)).toEqual([]);
    }
  });

  it("allows idempotent run transitions", () => {
    expect(transitionRun("running", "running")).toBe("running");
  });
});

describe("step state machine", () => {
  it.each<[StepState, StepState]>([
    ["pending", "runnable"],
    ["pending", "skipped"],
    ["runnable", "running"],
    ["running", "waiting"],
    ["waiting", "running"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["pending", "cancelled"],
  ])("allows step transition %s -> %s", (from, to) => {
    expect(transitionStep(from, to)).toBe(to);
  });

  it("rejects succeeded -> running", () => {
    expect(() => transitionStep("succeeded", "running")).toThrow(/terminal state/i);
  });

  it("rejects pending -> running without becoming runnable first", () => {
    expect(() => transitionStep("pending", "running")).toThrow(
      /cannot transition from pending to running/i,
    );
  });

  it("treats terminal step states as terminal", () => {
    for (const state of ["succeeded", "failed", "skipped", "cancelled"] as const) {
      expect(isTerminalStepState(state)).toBe(true);
      expect(allowedStepTransitions(state)).toEqual([]);
    }
  });
});

describe("attempt state machine", () => {
  it.each<[AttemptState, AttemptState]>([
    ["created", "running"],
    ["running", "waiting"],
    ["waiting", "running"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["created", "cancelled"],
    ["running", "abandoned"],
    ["waiting", "abandoned"],
  ])("allows attempt transition %s -> %s", (from, to) => {
    expect(transitionAttempt(from, to)).toBe(to);
  });

  it("rejects succeeded -> running", () => {
    expect(() => transitionAttempt("succeeded", "running")).toThrow(
      /terminal state/i,
    );
  });

  it("rejects created -> succeeded", () => {
    expect(() => transitionAttempt("created", "succeeded")).toThrow(
      /cannot transition from created to succeeded/i,
    );
  });

  it("treats terminal attempt states as terminal", () => {
    for (const state of [
      "succeeded",
      "failed",
      "abandoned",
      "cancelled",
    ] as const) {
      expect(isTerminalAttemptState(state)).toBe(true);
      expect(allowedAttemptTransitions(state)).toEqual([]);
    }
  });
});
