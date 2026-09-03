import { describe, expect, it, vi } from "vitest";
import type { RunRequest } from "@forge/protocol";
import type { RuntimePolicy } from "@forge/agent-profile";
import {
  finalTextToArtifactRef,
  ForgeAgentStepExecutor,
  runRequestToRunSpec,
  type ForgeAgentRunFn,
} from "./forge-agent-adapter.js";
import type { StepExecutionInput } from "./executor-types.js";

describe("forge agent adapter", () => {
  it("maps cwd + message to one forge.agent step", () => {
    expect(
      runRequestToRunSpec({ cwd: "/repo", message: "fix it" }, fixedIds()),
    ).toMatchObject({
      objective: "fix it",
      policyContext: {},
      steps: [{ kind: "forge.agent", input: { cwd: "/repo", message: "fix it" } }],
    });
  });

  it("stores finalText as an output artifact reference", async () => {
    const adapter = new ForgeAgentStepExecutor({
      run: vi.fn<ForgeAgentRunFn>().mockResolvedValue({
        sessionId: "session-1",
        finalText: "done",
      }),
    });
    const outcome = await adapter.execute(stepInput(), new AbortController().signal);
    expect(outcome).toMatchObject({
      state: "succeeded",
      outputRef: expect.stringMatching(/^artifact:session:session-1:[a-f0-9]{16}$/),
    });
  });

  it("forwards legacy agent events through the optional bridge", async () => {
    const emitAgentEvent = vi.fn();
    const adapter = new ForgeAgentStepExecutor({
      emitAgentEvent,
      run: vi.fn<ForgeAgentRunFn>().mockImplementation(async (_req, emit) => {
        emit({ type: "status", phase: "model", message: "working" });
        return { sessionId: "session-2", finalText: "ok" };
      }),
    });
    await adapter.execute(stepInput(), new AbortController().signal);
    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", message: "working" }),
      expect.objectContaining({
        runId: "run-1",
        stepId: "step-1",
        attemptId: "attempt-1",
      }),
    );
  });

  it("supplies durable execution links to the production event bridge", async () => {
    const emitAgentEvent = vi.fn();
    const adapter = new ForgeAgentStepExecutor({
      emitAgentEvent,
      run: vi.fn<ForgeAgentRunFn>().mockImplementation(async (_req, emit) => {
        emit({ type: "text_delta", sessionId: "session-2", delta: "pong" });
        return { sessionId: "session-2", finalText: "pong" };
      }),
    });

    await adapter.execute(stepInput(), new AbortController().signal);

    expect(emitAgentEvent).toHaveBeenCalledWith(
      { type: "text_delta", sessionId: "session-2", delta: "pong" },
      {
        runId: "run-1",
        stepId: "step-1",
        attemptId: "attempt-1",
      },
    );
  });

  it("forwards the governed profile runtime policy to the real legacy runtime boundary", async () => {
    const runtimePolicy: RuntimePolicy = {
      model: "profile-model",
      dynamicStatus: { modelHeartbeatIntervalMs: 25 },
      contextCompression: { triggerTokenEstimate: 100, tokenBudget: 50 },
    };
    let receivedPolicy: RuntimePolicy | undefined;
    const adapter = new ForgeAgentStepExecutor({
      run: async (_request, _emit, _signal, policy) => {
        receivedPolicy = policy;
        return { sessionId: "session-policy", finalText: "done" };
      },
    });

    await adapter.execute(
      { ...stepInput(), runtimePolicy },
      new AbortController().signal,
    );

    expect(receivedPolicy).toEqual(runtimePolicy);
  });

  it("hashes final text deterministically", () => {
    expect(finalTextToArtifactRef("s1", "hello")).toBe(
      finalTextToArtifactRef("s1", "hello"),
    );
    expect(finalTextToArtifactRef("s1", "hello")).not.toBe(
      finalTextToArtifactRef("s1", "world"),
    );
  });
});

function fixedIds(): { runId(): string; correlationId(): string; stepId(): string } {
  return {
    runId: () => "run-1",
    correlationId: () => "corr-1",
    stepId: () => "step-1",
  };
}

function stepInput(): StepExecutionInput {
  return {
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    attemptNumber: 1,
    kind: "forge.agent",
    input: { cwd: "/repo", message: "fix it" } satisfies RunRequest,
    timeoutMs: 60_000,
  };
}
