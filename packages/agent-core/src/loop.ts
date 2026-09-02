import type {
  AgentEvent,
  ChatContent,
  ChatMessage,
  ForgeConfig,
  ToolCall,
} from "@forge/protocol";
import { plainTextFromChatContent } from "@forge/protocol";
import { LlmClient } from "@forge/llm";
import type { RuntimePolicy } from "@forge/agent-profile";
import {
  ToolRegistry,
  type NetworkConfirmRequest,
  type SoftwareConfirmRequest,
  type ToolContext,
} from "@forge/tools";
import type { WorkspaceGuard } from "@forge/workspace";
import { buildSystemPrompt, type FileWriteToolsMode } from "./prompts.js";
import {
  buildDynamicStatus,
  formatDynamicStatusTail,
  type DynamicRunStatus,
} from "./dynamic-status.js";
import {
  RunCancelledError,
  AgentMaxStepsError,
  throwIfAborted,
  isAbortError,
} from "./errors.js";
import { looksLikeCodingTask } from "./intents.js";
import {
  collectToolEvidence,
  formatReflectionNudge,
  hasBlockingIssue,
  reflectOnFinal,
  resolveReviewerModel,
  shouldReflect,
} from "./reflection.js";
import { ContextCompressor } from "./context-compression.js";

const NO_TOOL_RETRY_NUDGE =
  "[forge] 这是编码/改代码任务。请在本轮使用 read_file、grep、write_patch 或 run_command 等工具完成，不要仅用文字回复。";

export interface RunAgentInput {
  config: ForgeConfig;
  guard: WorkspaceGuard;
  messages: ChatMessage[];
  tools: ToolRegistry;
  autoApply: boolean;
  /** When false, strip image_url from all messages before calling the LLM API. */
  supportsVision?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  skillRoots?: string[];
  confirmNetwork?: (req: NetworkConfirmRequest) => Promise<boolean>;
  skipNetworkConfirm?: boolean;
  confirmSoftware?: (req: SoftwareConfirmRequest) => Promise<boolean>;
  skipSoftwareConfirm?: boolean;
  confirmCommand?: (command: string) => Promise<boolean>;
  spawnSubagent?: (task: string) => Promise<string>;
  /** Restrict which tools this loop may see/call (e.g. read-only sub-agents). */
  allowTool?: (name: string) => boolean;
  runtimePolicy?: RuntimePolicy;
}

export interface RunAgentOutput {
  finalText: string;
  messages: ChatMessage[];
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n...[truncated]";
}

function diffStats(unifiedDiff: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) dels++;
  }
  return { adds, dels };
}

function forgeFileActivity(call: ToolCall, status: "running" | "done", diff?: string): AgentEvent | null {
  if (call.name !== "write_patch" && call.name !== "write_file") return null;
  const args = call.arguments as Record<string, unknown>;
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return null;
  const unifiedDiff = diff ?? (typeof args.unified_diff === "string" ? args.unified_diff : "");
  const stats = diffStats(unifiedDiff);
  return {
    type: "runtime_activity",
    runtime: "forge",
    activityKind: "file",
    status,
    callId: call.id,
    label: `${status === "running" ? "正在编辑" : "已编辑"} ${path.split("/").pop() || path}`,
    path,
    ...stats,
    ...(unifiedDiff ? { patch: { path, unifiedDiff } } : {}),
    changes: [{ path, kind: "update", ...(unifiedDiff ? { unifiedDiff } : {}), ...stats }],
  };
}

// ── Concurrency: two separate concerns ──────────────────────────────────────
// 1. SAFETY (a tool property): may this tool run concurrently without breaking
//    correctness? Read-only tools have no side effects; spawn_agent is isolated
//    (own context + pendingPatches) and same-path writes are serialized by a
//    per-path lock in @forge/tools. Direct mutating tools are not safe.
// 2. SCHEDULING (orchestrator policy): given safe-to-parallelize calls, how many
//    actually run at once. Serial-vs-parallel and the cap are policy here — NOT
//    inherent to the sub-agent/tool mechanism.
const CONCURRENCY_SAFE_TOOLS = new Set([
  "read_file",
  "list_dir",
  "grep",
  "echo",
  "spawn_agent",
]);
function isConcurrencySafe(name: string): boolean {
  return CONCURRENCY_SAFE_TOOLS.has(name);
}

/** Scheduling policy: max calls running at once (caps fan-out, e.g. 20 sub-agents). */
const MAX_TOOL_CONCURRENCY = 6;

/** Run fn over items with a concurrency cap; results preserve input order. */
async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}

function usesReasoningRoundTrip(config: ForgeConfig): boolean {
  return config.model.options?.thinking?.type === "enabled";
}

function assistantMessage(
  config: ForgeConfig,
  response: Awaited<ReturnType<LlmClient["chat"]>>,
  toolCalls?: ToolCall[],
): ChatMessage {
  const msg: ChatMessage = {
    role: "assistant",
    content: response.text,
  };
  if (usesReasoningRoundTrip(config)) {
    msg.reasoning_content = response.reasoningContent ?? "";
  }
  if (toolCalls?.length) {
    msg.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));
  }
  return msg;
}

export async function runReActLoop(
  input: RunAgentInput,
): Promise<RunAgentOutput> {
  const { config, guard, tools, autoApply, onEvent, signal } = input;
  const messages = compressRuntimeMessages(
    input.messages,
    input.runtimePolicy,
    onEvent,
  );
  const llm = new LlmClient(config.model);
  const maxSteps = config.limits.maxSteps;
  const maxTool = config.limits.toolResultMaxChars;
  const pendingPatches = new Map<string, string>();
  const toolCleanups = new Set<() => void>();

  // Filtered view of the shared registry — the LLM only sees allowed tools.
  const visibleToolDefs = input.allowTool
    ? tools.definitions.filter((d) => input.allowTool!(d.name))
    : tools.definitions;

  const ctx: ToolContext = {
    guard,
    autoApply,
    pendingPatches,
    signal,
    skillRoots: input.skillRoots,
    permissions: config.permissions,
    skipNetworkConfirm: input.skipNetworkConfirm ?? autoApply,
    confirmNetwork: input.confirmNetwork,
    skipSoftwareConfirm: input.skipSoftwareConfirm ?? autoApply,
    confirmSoftware: input.confirmSoftware,
    confirmCommand: input.confirmCommand,
    spawnSubagent: input.spawnSubagent,
    onCleanup: (cleanup) => toolCleanups.add(cleanup),
    toolResultMaxChars: config.limits.toolResultMaxChars,
    emit: (e) => onEvent?.(e),
  };
  const cleanupTools = () => {
    for (const cleanup of toolCleanups) {
      try {
        cleanup();
      } catch {
        // Tool cleanup is best-effort and must not mask the run result.
      }
    }
    toolCleanups.clear();
  };
  let noToolRetryUsed = false;

  const reviewerClient = config.reflection?.enabled
    ? new LlmClient(resolveReviewerModel(config))
    : null;
  let reflectRounds = 0;

  try {
    for (let step = 0; step < maxSteps; step++) {
    throwIfAborted(signal);
    const stepNum = step + 1;
    onEvent?.({ type: "step_start", step: stepNum, maxSteps });

    let modelResponseDone = false;
    const modelStarted = Date.now();
    let lastModelStatusAt = 0;
    let lastModelStatusKey = "";
    const dynamicStatus = input.runtimePolicy?.dynamicStatus;
    const statusEnabled = dynamicStatus?.enabled ?? true;
    const statusDedupeWindowMs = dynamicStatus?.dedupeWindowMs ?? 1500;
    const modelHeartbeatIntervalMs =
      dynamicStatus?.modelHeartbeatIntervalMs ?? 5000;
    const emitModelStatus = (message: string, force = false) => {
      if (!statusEnabled) return;
      const key = message;
      const now = Date.now();
      if (
        !force &&
        key === lastModelStatusKey &&
        now - lastModelStatusAt < statusDedupeWindowMs
      ) {
        return;
      }
      lastModelStatusKey = key;
      lastModelStatusAt = now;
      onEvent?.({
        type: "status",
        phase: "model",
        message,
        elapsedSec: Math.floor((Date.now() - modelStarted) / 1000),
      });
    };
    emitModelStatus("连接模型…", true);
    const modelHeartbeat = setInterval(() => {
      if (modelResponseDone) return;
      if (Date.now() - lastModelStatusAt < modelHeartbeatIntervalMs) return;
      emitModelStatus("处理中…");
    }, modelHeartbeatIntervalMs);

    let response: Awaited<ReturnType<LlmClient["chat"]>>;
    let thinkingOpen = false;
    let thinkingStartedAt = 0;
    let thinkingChars = 0;
    try {
      response = await llm.chat({
        messages,
        supportsVision: input.supportsVision,
        tools: visibleToolDefs,
        signal,
        onThinkingDelta: (delta) => {
          if (!thinkingOpen) {
            thinkingOpen = true;
            thinkingStartedAt = Date.now();
            thinkingChars = 0;
            onEvent?.({ type: "thinking_start" });
          }
          thinkingChars += delta.length;
          onEvent?.({ type: "thinking_delta", delta });
        },
        onThinkingEnd: () => {
          if (!thinkingOpen) return;
          thinkingOpen = false;
          onEvent?.({
            type: "thinking_end",
            charCount: thinkingChars,
            durationMs: Date.now() - thinkingStartedAt,
          });
          thinkingChars = 0;
        },
        onTextDelta: (delta) => {
          onEvent?.({ type: "text_delta", delta });
        },
        onStreamStatus: (message) => {
          emitModelStatus(message);
        },
      });
    } catch (e) {
      if (isAbortError(e)) throw new RunCancelledError(messages);
      throw e;
    } finally {
      modelResponseDone = true;
      clearInterval(modelHeartbeat);
    }

    if (!response.toolCalls.length) {
      const text = response.text ?? "";
      const lastUser = findLastUserMessage(messages);
      if (
        step === 0 &&
        !noToolRetryUsed &&
        lastUser &&
        looksLikeCodingTask(lastUser)
      ) {
        noToolRetryUsed = true;
        onEvent?.({
          type: "warning",
          message:
            "模型首轮未调用工具，正在要求重新使用工具（消耗 1 步）…",
        });
        messages.push({ role: "user", content: NO_TOOL_RETRY_NUDGE });
        continue;
      }
      // Reflection gate: evaluate the candidate answer before delivering it.
      // Budget/round-bounded; reviewer failures fail open (release the answer).
      if (
        reviewerClient &&
        shouldReflect({ config, finalText: text, step, maxSteps, roundsUsed: reflectRounds })
      ) {
        if (text || response.reasoningContent) {
          messages.push(assistantMessage(config, response));
        }
        reflectRounds += 1;
        onEvent?.({ type: "reflection_start", round: reflectRounds });
        const verdict = await reflectOnFinal(
          reviewerClient,
          {
            taskText: lastUser ?? text,
            finalText: text,
            toolEvidence: collectToolEvidence(messages),
          },
          signal,
        );
        const reworking = hasBlockingIssue(verdict, config.reflection);
        onEvent?.({
          type: "reflection_verdict",
          round: reflectRounds,
          verdict: verdict.verdict,
          reworking,
          issues: verdict.issues,
        });
        if (reworking) {
          messages.push({ role: "user", content: formatReflectionNudge(verdict) });
          continue;
        }
        return { finalText: text, messages };
      }
      if (text || response.reasoningContent) {
        messages.push(assistantMessage(config, response));
      }
      return { finalText: text, messages };
    }

    messages.push(assistantMessage(config, response, response.toolCalls));

    const runOneToolCall = async (call: ToolCall): Promise<ChatMessage> => {
      throwIfAborted(signal);
      if (input.allowTool && !input.allowTool(call.name)) {
        return {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            ok: false,
            error: `工具 ${call.name} 在此（只读子代理）环境中不可用。请把结果作为文本返回，由主代理写入。`,
          }),
        };
      }
      onEvent?.({
        type: "tool_start",
        callId: call.id,
        name: call.name,
        args: call.arguments,
        step: stepNum,
      });
      const startingFileActivity = forgeFileActivity(call, "running");
      if (startingFileActivity) onEvent?.(startingFileActivity);
      const toolStarted = Date.now();
      let toolActive = false;
      const toolHeartbeatIntervalMs =
        input.runtimePolicy?.dynamicStatus?.toolHeartbeatIntervalMs ?? 1500;
      const toolHeartbeat = setInterval(() => {
        if (input.runtimePolicy?.dynamicStatus?.enabled === false) return;
        if (toolActive) return;
        const elapsedSec = Math.floor((Date.now() - toolStarted) / 1000);
        onEvent?.({
          type: "status",
          phase: "tool",
          message: `${call.name}…`,
          elapsedSec,
        });
      }, toolHeartbeatIntervalMs);
      let result: string;
      try {
        result = await tools.execute(call, {
          ...ctx,
          emit: (event) => {
            ctx.emit(event);
            if (event.type !== "patch_proposed") return;
            const completed = forgeFileActivity(call, "done", event.unifiedDiff);
            if (completed) onEvent?.(completed);
          },
        });
        toolActive = true;
      } catch (e) {
        if (isAbortError(e)) throw new RunCancelledError(messages);
        throw e;
      } finally {
        clearInterval(toolHeartbeat);
      }
      const truncated = truncate(result, maxTool);
      onEvent?.({
        type: "tool_end",
        callId: call.id,
        name: call.name,
        result: truncated,
        durationMs: Date.now() - toolStarted,
      });
      return { role: "tool", tool_call_id: call.id, content: truncated };
    };

    // Scheduling: a contiguous run of concurrency-safe calls is dispatched in
    // parallel up to MAX_TOOL_CONCURRENCY; any unsafe (direct mutating) call
    // runs alone and fully completes first, preserving read-vs-write order so
    // concurrent writes can never race on the filesystem or pendingPatches.
    const calls = response.toolCalls;
    let ci = 0;
    while (ci < calls.length) {
      if (isConcurrencySafe(calls[ci].name)) {
        let j = ci;
        while (j < calls.length && isConcurrencySafe(calls[j].name)) j++;
        const batch = calls.slice(ci, j);
        const msgs =
          batch.length === 1
            ? [await runOneToolCall(batch[0])]
            : await mapWithConcurrency(batch, MAX_TOOL_CONCURRENCY, runOneToolCall);
        for (const m of msgs) messages.push(m);
        ci = j;
      } else {
        messages.push(await runOneToolCall(calls[ci]));
        ci += 1;
      }
    }
    }

    throw new AgentMaxStepsError(messages);
  } finally {
    cleanupTools();
  }
}

function compressRuntimeMessages(
  input: ChatMessage[],
  runtimePolicy: RuntimePolicy | undefined,
  onEvent: RunAgentInput["onEvent"],
): ChatMessage[] {
  const policy = runtimePolicy?.contextCompression;
  if (policy?.enabled !== true || input.length < 3) {
    return [...input];
  }
  const sections = input.map((message, index) => ({
    id: `message-${index}`,
    kind:
      index === 0 && message.role === "system"
        ? "decision"
        : index === input.length - 1
          ? "remaining"
          : "history",
    text: plainTextFromChatContent(message.content),
    priority: index === 0 || index === input.length - 1 ? 100 : index,
  }));
  const totalTokenEstimate = sections.reduce(
    (total, section) => total + Math.ceil(section.text.length / 4),
    0,
  );
  if (totalTokenEstimate < (policy.triggerTokenEstimate ?? 4_000)) {
    return [...input];
  }
  const compressor = new ContextCompressor({
    modelFailureThreshold: policy.modelFailureThreshold,
    maxModelAttempts: policy.maxModelAttempts,
  });
  const compressed = compressor.compact({
    sections,
    tokenBudget: policy.tokenBudget,
  });
  const retained = new Set(compressed.retainedRefs);
  const messages = input.filter((_message, index) => retained.has(`message-${index}`));
  onEvent?.({
    type: "status",
    phase: "runtime",
    message: `上下文已按 AgentProfile 策略压缩，移除约 ${compressed.removedTokenEstimate} tokens`,
  });
  return messages;
}

function findLastUserMessage(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const c = plainTextFromChatContent(m.content).trim();
    if (!c || c.startsWith("[forge]")) continue;
    return c;
  }
  return null;
}

export async function buildInitialMessages(
  guard: WorkspaceGuard,
  userMessage: string,
  context: {
    agentsMd: string;
    gitStatus: string;
    extraFiles?: string;
    skillCatalogBlock?: string;
    skillBlock?: string;
    hookContextBlock?: string;
    memoryBlock?: string;
    fileWriteTools?: FileWriteToolsMode;
    permissions?: ForgeConfig["permissions"];
    automationRun?: {
      name?: string;
      schedule?: { cron: string; timezone: string };
    };
    userContent?: ChatContent;
    visionImagesInTurn?: boolean;
    documentFilesInTurn?: boolean;
    dynamicStatus?: DynamicRunStatus;
  },
): Promise<ChatMessage[]> {
  const system = buildSystemPrompt({
    cwd: guard.cwdPath,
    agentsMd: context.agentsMd,
    gitStatus: context.gitStatus,
    extraFiles: context.extraFiles,
    skillCatalogBlock: context.skillCatalogBlock,
    skillBlock: context.skillBlock,
    hookContextBlock: context.hookContextBlock,
    memoryBlock: context.memoryBlock,
    fileWriteTools: context.fileWriteTools,
    permissions: context.permissions,
    automationRun: context.automationRun,
    visionImagesInTurn: context.visionImagesInTurn,
    documentFilesInTurn: context.documentFilesInTurn,
    dynamicStatusBlock: context.dynamicStatus
      ? formatDynamicStatusTail(buildDynamicStatus(context.dynamicStatus))
      : undefined,
  });
  return [
    { role: "system", content: system },
    { role: "user", content: context.userContent ?? userMessage },
  ];
}
