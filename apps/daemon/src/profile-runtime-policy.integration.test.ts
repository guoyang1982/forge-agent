import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProfileStore } from "@forge/agent-profile";
import {
  ExecutionStore,
  FORGE_AGENT_STEP_KIND,
  GovernedStepExecutor,
  LegacyForgeStepExecutor,
  ManualTestClock,
  type GovernedExecutionPorts,
} from "@forge/execution";
import type { ChatMessage } from "@forge/protocol";
import { DEFAULT_CONFIG } from "@forge/protocol";
import { ForgeStore } from "@forge/store";
import { createBuiltinRegistry } from "@forge/tools";
import { WorkspaceGuard } from "@forge/workspace";

const chatInputs = vi.hoisted(() => [] as Array<{ messages: ChatMessage[] }>);
const chatDelayMs = vi.hoisted(() => ({ value: 0 }));
vi.mock("@forge/llm", () => ({
  LlmClient: class {
    async chat(input: { messages: ChatMessage[] }) {
      chatInputs.push({ messages: input.messages });
      if (chatDelayMs.value > 0) {
        await new Promise((resolve) => setTimeout(resolve, chatDelayMs.value));
      }
      return { text: "done", reasoningContent: "", toolCalls: [] };
    }
  },
  LlmError: class extends Error {},
}));

const { runReActLoop } = await import("@forge/agent-core");
const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  chatInputs.splice(0);
  chatDelayMs.value = 0;
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("published AgentProfile runtime policy integration", () => {
  it("changes observable dynamic-status heartbeat behavior in the real agent loop", async () => {
    const fx = await runtimePolicyFixture();
    chatDelayMs.value = 35;
    const statusMessages: string[] = [];

    await fx.run(
      [{ role: "user", content: "answer briefly" }],
      (event) => {
        if (event.type === "status" && event.phase === "model") {
          statusMessages.push(event.message);
        }
      },
    );

    expect(fx.snapshot.profileVersionId).toBe(fx.version.id);
    expect(statusMessages[0]).toBe("连接模型…");
    expect(
      statusMessages.filter((message) => message === "处理中…").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("compresses the actual LLM messages using the published profile threshold and budget", async () => {
    const fx = await runtimePolicyFixture();
    const oldNoise = `OLD-NOISE-${"x".repeat(240)}`;

    await fx.run([
      { role: "system", content: "Keep the current objective intact." },
      { role: "user", content: oldNoise },
      { role: "assistant", content: `STALE-ANSWER-${"y".repeat(240)}` },
      { role: "user", content: "Return the final answer." },
    ]);

    const sent = JSON.stringify(chatInputs[0]?.messages ?? []);
    expect(sent).not.toContain("OLD-NOISE");
    expect(sent).toContain("Keep the current objective intact.");
    expect(sent).toContain("Return the final answer.");
  });
});

async function runtimePolicyFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-profile-runtime-policy-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const profiles = new AgentProfileStore(store.db);
  const executionStore = new ExecutionStore(store.db);
  const modelPolicy = {
    model: "profile-model",
    dynamicStatus: {
      enabled: true,
      modelHeartbeatIntervalMs: 10,
      dedupeWindowMs: 0,
    },
    contextCompression: {
      enabled: true,
      triggerTokenEstimate: 40,
      tokenBudget: 24,
      modelFailureThreshold: 2,
      maxModelAttempts: 2,
    },
  };
  const version = profiles.publishVersion({
    name: "runtime-policy-profile",
    modelPolicy,
  });
  const snapshot = profiles.resolveSnapshot({
    profileId: version.profileId,
    profileVersionId: version.id,
    runId: "fixture-profile-policy",
  });
  const guard = await WorkspaceGuard.ensure(root);
  const config = {
    ...DEFAULT_CONFIG,
    model: { ...DEFAULT_CONFIG.model, name: snapshot.runtime.model },
    limits: { ...DEFAULT_CONFIG.limits, maxSteps: 1 },
  };
  let activeMessages: ChatMessage[] = [];
  let activeOnEvent: Parameters<typeof runReActLoop>[0]["onEvent"];
  const legacy = new LegacyForgeStepExecutor({
    run: async (request, _emit, signal, runtimePolicy) => {
      const result = await runReActLoop({
        config,
        guard,
        messages: activeMessages,
        tools: createBuiltinRegistry(),
        autoApply: false,
        runtimePolicy,
        onEvent: activeOnEvent,
        signal,
      });
      return {
        sessionId: request.sessionId ?? "runtime-policy-session",
        finalText: result.finalText,
      };
    },
  });
  const ports: GovernedExecutionPorts = {
    profile: {
      resolve: async (input) => profiles.resolveSnapshot(input),
    },
    workspace: {
      acquire: async () => {
        throw new Error("workspace lease not expected");
      },
      release: async () => {},
    },
    policy: {
      authorize: () => ({
        outcome: "allow",
        policyVersionId: "policy-runtime-test",
        reason: "runtime integration",
        inputHash: "runtime-integration-input",
      }),
    },
    approval: {
      requestApproval: () => {
        throw new Error("approval not expected");
      },
      getApproval: () => {
        throw new Error("approval not expected");
      },
    },
    budget: {
      reserve: async () => {
        throw new Error("budget reservation not expected");
      },
      commit: async () => {},
      release: async () => {},
    },
    evidence: {
      validateDelivery: async () => ({ accepted: true }),
    },
    step: {
      execute: (input, signal) => legacy.execute(input, signal),
    },
  };
  const governed = new GovernedStepExecutor(
    ports,
    executionStore,
    new ManualTestClock("2026-09-01T00:00:00.000Z"),
  );
  return {
    version,
    snapshot,
    async run(
      messages: ChatMessage[],
      onEvent?: Parameters<typeof runReActLoop>[0]["onEvent"],
    ) {
      activeMessages = messages;
      activeOnEvent = onEvent;
      const outcome = await governed.execute(
        {
          runId: "run-profile-policy",
          stepId: "agent",
          attemptId: `attempt-profile-policy-${Date.now()}`,
          attemptNumber: 1,
          kind: FORGE_AGENT_STEP_KIND,
          input: { cwd: root, message: "exercise runtime policy" },
          timeoutMs: 1_000,
          profileId: version.profileId,
          profileVersionId: version.id,
          actingSubject: { kind: "agent_profile", id: version.profileId },
          action: "agent.run",
          resource: { kind: "workspace", id: root },
          risk: "low",
          policyContext: {},
        },
        AbortSignal.timeout(1_000),
      );
      expect(outcome.state).toBe("succeeded");
    },
  };
}
