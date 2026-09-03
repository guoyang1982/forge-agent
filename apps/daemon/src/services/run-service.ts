import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  AgentEvent,
  ChatMessage,
  ForgeConfig,
  RunRequest,
  RunResult,
} from "@forge/protocol";
import { flattenContentForTextOnlyApi, plainTextFromChatContent } from "@forge/protocol";
import { DEFAULT_CONFIG } from "@forge/protocol";
import { loadConfig } from "@forge/config";
import type { SessionStore } from "@forge/session";
import {
  AgentMaxStepsError,
  RunCancelledError,
  buildMaxStepsContinueHint,
  looksLikeCodingTask,
  countImagesInUserContent,
  countParsedDocumentAttachments,
  buildUserMessageContent,
  runReActLoop,
} from "@forge/agent-core";
import { LlmClient, LlmError } from "@forge/llm";
import { sanitizeMemoryContent } from "@forge/memory";
import { WorkspaceGuard, createWorkspaceSnapshot } from "@forge/workspace";
import type { WorkspaceGuard as WorkspaceGuardType } from "@forge/workspace";
import {
  assembleRunMessages,
  prepareRunContext,
  type ForgeRuntime,
} from "../runtime.js";
import { findSkillByReadPath } from "@forge/skill-registry";
import {
  runStopHooks,
  type HookBinding,
  type HookRunContext,
  type StopReason,
} from "@forge/hooks";
import type { SkillDoc } from "@forge/skill-registry";
import { hookSessionState } from "@forge/hooks";
import type { CancelService } from "./cancel-service.js";
import {
  createNetworkConfirmHandler,
  createCommandConfirmHandler,
  createSoftwareConfirmHandler,
} from "./network-confirm.js";
import type { NetworkConfirmRequest, SoftwareConfirmRequest, ToolRegistry } from "@forge/tools";
import {
  markStepsStatus,
  parseModelTalentDispatchDraft,
  planToDispatchPlanEvent,
  planToPlanUpdateItems,
  resolveTalentDispatchPlan,
  talentArtifactDirRelPath,
  talentArtifactRelPath,
  talentExecutionWaves,
  type ModelTalentDispatchDraft,
  type RunPlan,
} from "@forge/run-orchestrator";
import {
  buildTalentAgentMemoryBlock,
  buildPriorTalentResultsBlock,
  buildTalentSystemBlock,
  completeTalentAgentRun,
  createTalentToolAllowance,
  extractTalentMentions,
  expandTalentTeamMessage,
  findTalentTeamByMention,
  recordTalentTeamUsage,
  findHiredTalentByMention,
  isTalentForcedForeground,
  listTalentAgentMemory,
  parseTalentAssignmentsFromMessage,
  detectsSerialDependency,
  recordTalentUsage,
  rememberTalentAgentEpisode,
  resolveTalentAgentExecutionMode,
  resolveTalentAgentStatePaths,
  resolveTalentExecutionMode,
  resolveTalentStorePaths,
  resolveTalentTeamRosterPath,
  startTalentAgentRun,
  type HiredTalent,
  type TalentAgentExecutionMode,
  type TalentTemplate,
} from "@forge/talent-registry";
import { permissionService } from "./permission-service.js";
import { ensureExternalRuntimesRegistered } from "./external-runtimes.js";
import { getExternalRuntime } from "./external-runtime-registry.js";
import { buildExternalHistoryContext } from "./external-runtime-history.js";
import { createMcpServerRequestHandler } from "./mcp-permission.js";
import type { RuntimePolicy } from "@forge/agent-profile";

export interface RunServiceDeps {
  sessions: SessionStore;
  getRuntime: () => Promise<ForgeRuntime>;
  cancelService: CancelService;
}

/** Bridge used by the durable execution legacy adapter. */
export async function executeForgeRun(
  request: RunRequest,
  emit: (event: AgentEvent) => void,
  deps: RunServiceDeps,
  runtimePolicy?: RuntimePolicy,
  externalSignal?: AbortSignal,
): Promise<RunResult> {
  return handleRun(request, emit, deps, runtimePolicy, externalSignal);
}

function runPreviewFromAttachments(req: RunRequest): string {
  const message = String(req.message || "").trim();
  if (message) return message.slice(0, 120);
  const names = (req.attachments ?? []).map((item) => item.name).filter(Boolean);
  if (!names.length) return "";
  return `[${names.length} 个附件] ${names.join("、")}`.slice(0, 120);
}

export async function handleRun(
  params: unknown,
  emit: (event: AgentEvent) => void,
  deps: RunServiceDeps,
  runtimePolicy?: RuntimePolicy,
  externalSignal?: AbortSignal,
): Promise<RunResult> {
  const req = params as RunRequest;
  const cwd = req.cwd || process.cwd();
  const absCwd = resolve(cwd);
  const loaded = loadConfig({ cwd: absCwd });
  const requestedModel = effectiveModelName(
    runtimePolicy?.model || req.runtime?.model,
  );
  const provider = req.runtime?.provider?.trim() || "forge";
  const config =
    provider === "forge" && requestedModel
      ? {
          ...loaded,
          model: {
            ...loaded.model,
            name: requestedModel,
          },
        }
      : loaded;
  const guard = await WorkspaceGuard.ensure(absCwd, {
    allowedRoots: config.permissions?.fileSystem.allowedRoots,
  });
  const rt = await deps.getRuntime();
  const sessionId = req.sessionId ?? deps.sessions.createSession(absCwd);
  const turnIndex = deps.sessions.countUserMessages(sessionId);
  const projectId = absCwd;
  // Set when a dispatch turn writes scratch artifacts; the outer `finally`
  // calls it so a mid-wave error/abort never leaks files into the workspace.
  let cleanupDispatchArtifacts: (() => void) | undefined;

  const runEmit = (event: AgentEvent) => {
    const normalized =
      event.type === "session_start" || event.type === "done"
        ? event
        : ({ ...event, sessionId } as AgentEvent);
    try {
      const emittedAtMs =
        "emittedAtMs" in normalized && typeof normalized.emittedAtMs === "number"
          ? normalized.emittedAtMs
          : Date.now();
      deps.sessions.appendEvent(sessionId, turnIndex, normalized, emittedAtMs);
    } catch (error) {
      console.warn("[forge] failed to persist session event", error);
    }
    emit(normalized);
  };
  // Register before publishing session_start so clients can immediately cancel
  // the run using the sessionId from that first event without racing setup.
  const abort = deps.cancelService.registerRun(sessionId);
  linkExternalAbortSignal(externalSignal, abort);

  const runPreview = req.channelRun
    ? (req.channelRun.preview
        ? `[微信] ${req.channelRun.preview}`
        : req.channelRun.label
          ? `[微信·${req.channelRun.label}] ${req.message}`
          : `[微信] ${req.message}`
      ).slice(0, 120)
    : req.automationRun
      ? (req.automationRun.name
          ? `[自动化] ${req.automationRun.name}`
          : `[自动化] ${req.message}`
        ).slice(0, 120)
      : runPreviewFromAttachments(req);

  runEmit({
    type: "session_start",
    sessionId,
    cwd: absCwd,
    preview: runPreview,
    clientRunId: req.clientRunId,
  });

  const maxContext =
    config.limits.maxContextTokens ?? DEFAULT_CONFIG.limits.maxContextTokens;
  let historyPack: ReturnType<SessionStore["loadMessagesWithBudget"]>;
  let effectiveMessage = req.message;
  const possibleTeamMentions = extractTalentMentions(req.message);
  const teamRosterPath = resolveTalentTeamRosterPath(config.daemon.dataDir, cwd);
  for (const mention of possibleTeamMentions) {
    const team = await findTalentTeamByMention(teamRosterPath, mention);
    if (!team) continue;
    effectiveMessage = expandTalentTeamMessage(req.message, team);
    await recordTalentTeamUsage(teamRosterPath, team.id);
    runEmit({
      type: "status",
      phase: "model",
      message: `已召唤人才团队「${team.name}」：${team.members.map((member) => `@${member.mention}`).join("、")}`,
    });
    break;
  }

  try {
    historyPack = deps.sessions.loadMessagesWithBudget(sessionId, maxContext);
  } catch (error) {
    deps.cancelService.clearRun(sessionId, abort);
    throw error;
  }
  runEmit({
    type: "context_usage",
    estimatedTokens: historyPack.estimatedTokens,
    maxContextTokens: maxContext,
    truncated: historyPack.truncated,
  });

  // Pre-run worktree snapshot so the user can rewind this turn's file changes.
  try {
    const snap = await createWorkspaceSnapshot(guard);
    if (snap.ok && snap.sha) {
      const turnIndex = deps.sessions.recordCheckpoint(sessionId, snap.sha);
      runEmit({ type: "checkpoint", sha: snap.sha, turnIndex });
    }
  } catch {
    /* checkpoint is best-effort */
  }
  if (historyPack.truncated) {
    runEmit({
      type: "warning",
      message: `会话历史已截断（省略较早 ${historyPack.droppedCount} 条，约 ${historyPack.estimatedTokens} tokens）`,
    });
  } else if (historyPack.nearLimit) {
    const stored = historyPack.totalEstimatedTokens;
    const sending = historyPack.estimatedTokens;
    const detail =
      stored > sending
        ? `入库约 ${stored} tokens，本轮将发送约 ${sending}`
        : `约 ${sending}`;
    runEmit({
      type: "warning",
      message: `会话接近上下文上限（${detail}/${maxContext} tokens）。请用 **/compact**（会真正压缩数据库里的历史，不是让模型“记住”）或 **/clear** 开新对话后再继续。可加参数：/compact 8 仅保留最近 8 条消息。`,
    });
  }

  let releaseMcp: (() => void) | undefined;
  let initialLen = 0;
  let stepsUsed = 0;
  const toolsCalled: string[] = [];
  let talentUsageIds: string[] = [];
  let talentToolGate: ((name: string) => boolean) | undefined;
  let talentPaths: ReturnType<typeof resolveTalentStorePaths> | undefined;
  let talentAgentStatePaths: ReturnType<typeof resolveTalentAgentStatePaths> | undefined;
  let activeTalentRun: Awaited<ReturnType<typeof startTalentAgentRun>> | null = null;
  let activeTalentExecutionMode: TalentAgentExecutionMode | null = null;
  let talentRunFinalized = false;
  const finalizeTalentRun = async (
    status: "completed" | "failed" | "cancelled",
    outcome: string,
  ): Promise<void> => {
    if (!activeTalentRun || !talentAgentStatePaths || talentRunFinalized) return;
    talentRunFinalized = true;
    await completeTalentAgentRun({
      path: talentAgentStatePaths.runsPath,
      runId: activeTalentRun.id,
      status,
      outcome,
      tools: toolsCalled,
    });
  };
  let hookBindings: HookBinding[] = [];
  let hookCtx: HookRunContext | undefined;
  let stopHookSkills: SkillDoc[] = [];
  const finishRun = async (options: {
    finalText: string;
    reason: StopReason;
  }): Promise<RunResult> => {
    let reason = abort.signal.aborted ? "cancelled" : options.reason;
    if (reason !== "cancelled" && hookCtx && hookBindings.length) {
      const stop = await runStopHooks({
        bindings: hookBindings,
        ctx: hookCtx,
        skills: stopHookSkills,
        finalText: options.finalText,
        stepsUsed,
        toolsCalled,
        reason,
        signal: abort.signal,
      });
      reason = abort.signal.aborted ? "cancelled" : reason;
      if (stop.blocked) {
        runEmit({
          type: "warning",
          message: stop.blockReason ?? "Stop hook blocked run completion",
        });
        if (reason !== "cancelled") {
          await finalizeTalentRun("failed", options.finalText || stop.blockReason || "Stop hook blocked completion");
          return { sessionId, finalText: options.finalText };
        }
      }
    }
    await finalizeTalentRun(
      reason === "completed" ? "completed" : reason === "cancelled" ? "cancelled" : "failed",
      options.finalText,
    );
    runEmit({
      type: "done",
      sessionId,
      finalText: options.finalText,
    });
    return { sessionId, finalText: options.finalText };
  };

  ensureExternalRuntimesRegistered();
  const externalRuntime = getExternalRuntime(req.runtime?.provider);
  if (externalRuntime) {
    const priorHistory = buildExternalHistoryContext(historyPack.messages);
    try {
      runEmit({
        type: "status",
        phase: "runtime",
        message: `Runtime: ${externalRuntime.label}`,
      });
      deps.sessions.appendMessage(sessionId, {
        role: "user",
        content: buildUserMessageContent(req.message, req.attachments, true),
      });
      const result = await externalRuntime.run({
        cwd: absCwd,
        sessionId,
        request: req,
        priorHistory,
        signal: abort.signal,
        emit: runEmit,
      });
      if (result.finalText) {
        deps.sessions.appendMessage(sessionId, {
          role: "assistant",
          content: result.finalText,
        });
      }
      return await finishRun({
        finalText: result.finalText,
        reason: "completed",
      });
    } finally {
      deps.cancelService.clearRun(sessionId, abort);
    }
  }

  try {
    hookSessionState.touchSession(sessionId);
    const sessionHookSource = hookSessionState.resolveSessionHookSource({
      explicit: req.hookSource,
      sessionId,
      hasHistory: historyPack.messages.length > 0,
    });
    const {
      messages: freshMessages,
      registry,
      mcpClients,
      releaseMcp: release,
      preloadedSkill,
      skillMatchMode,
      hookContextBlock,
      hooksApplied,
      hookBindings: discoveredHookBindings,
      hookCtx: discoveredHookCtx,
      allSkills,
      skillRoots,
      loadedSkillCount,
      talentSkillResolution,
      supportsNativeImageUrl,
      visionStrategy,
      visionSkipReason,
    } = await prepareRunContext({
      runtime: rt,
      guard,
      message: effectiveMessage,
      sessionId,
      sessionHookSource,
      explicitFiles: req.files,
      attachments: req.attachments,
      automationRun: req.automationRun,
      projectId,
      dataDir: config.daemon.dataDir,
      mcpServerRequestHandler: createMcpServerRequestHandler(
        runEmit,
        sessionId,
        abort.signal,
        config.permissions?.apps,
      ),
      // When the message focuses a single hired talent, prioritize (or, in
      // strict mode, restrict to) that talent's bound skills during skill
      // matching. Full talent activation happens further below.
      ...(await resolveFocusedTalentSkillContext(
        config.daemon.dataDir,
        cwd,
        effectiveMessage,
      )),
    });
    hookBindings = discoveredHookBindings;
    hookCtx = discoveredHookCtx;
    stopHookSkills = allSkills;
    // Surface mismatches between a focused talent's bound skills and the
    // installed skill set — the usual reason "@talent" doesn't seem to use its
    // own skills is that those skill ids simply aren't installed here.
    if (talentSkillResolution) {
      const { matched, missing, strict } = talentSkillResolution;
      if (missing.length) {
        runEmit({
          type: "warning",
          message: strict
            ? `严格模式：人才绑定的 skill 中 ${missing.map((s) => `「${s}」`).join("、")} 未安装，已忽略。${matched.length ? `本轮仅可用：${matched.map((s) => `「${s}」`).join("、")}。` : "本轮没有可用 skill —— 请在人才详情里把「绑定 Skills」改成已安装的 skill。"}`
            : `人才绑定的 skill 中 ${missing.map((s) => `「${s}」`).join("、")} 未安装，无法优先使用。请在人才详情里改成已安装的 skill id。`,
        });
      } else if (strict && !matched.length) {
        runEmit({
          type: "warning",
          message:
            "严格模式：该人才未绑定任何已安装 skill，本轮不会加载其它 skill。请在人才详情里填写已安装的 skill id。",
        });
      } else if (strict && matched.length) {
        runEmit({
          type: "warning",
          message: `严格模式：本轮仅使用人才绑定的 skill —— ${matched.map((s) => `「${s}」`).join("、")}。`,
        });
      }
    }
    const modelName = config.model?.name ?? "";
    const hasImageAttachments = (req.attachments ?? []).some((a) => a.kind === "image");
    releaseMcp = release;
    if (hooksApplied.length) {
      runEmit({
        type: "hooks_applied",
        count: hooksApplied.length,
        sources: hooksApplied,
        chars: hookContextBlock.length,
      });
    }
    runEmit({
      type: "skill_active",
      matchMode: skillMatchMode,
      matched: Boolean(preloadedSkill),
      skillId: preloadedSkill?.id,
      skillName: preloadedSkill?.name,
      loadedCount: loadedSkillCount,
    });
    if (mcpClients.length) {
      console.log(
        `[forge] MCP for ${cwd}: ${mcpClients.map((c) => c.config.name).join(", ")}`,
      );
    }

    let initial = assembleRunMessages(freshMessages, historyPack.messages);
    // The current user message is persisted just below. Establish the replay
    // baseline now so cancellation during intent planning cannot append the
    // entire initial prompt (and duplicate that user message) in the catch path.
    initialLen = initial.length;
    const turnUser = initial[initial.length - 1];
    const sentImages = countImagesInUserContent(turnUser?.content ?? null);
    if (sentImages > 0) {
      runEmit({
        type: "status",
        phase: "model",
        message: `已向模型发送 ${sentImages} 张图片（多模态）`,
      });
    } else if (hasImageAttachments && visionStrategy === "skipped" && visionSkipReason) {
      runEmit({
        type: "warning",
        message: visionSkipReason,
      });
    }
    const parsedDocs = countParsedDocumentAttachments(req.attachments);
    const failedDocs = (req.attachments ?? []).filter(
      (a) => a.kind === "file" && a.text?.includes("未能解析为文本"),
    ).length;
    if (parsedDocs > 0) {
      runEmit({
        type: "status",
        phase: "model",
        message: `已向模型发送 ${parsedDocs} 个文档的正文（已提取文本）`,
      });
    }
    if (failedDocs > 0) {
      runEmit({
        type: "warning",
        message: `${failedDocs} 个文档未能提取文本，请检查格式或改用 .docx/.pdf 等支持的类型。`,
      });
    }
    if (turnUser?.role === "user") {
      const storedUser = supportsNativeImageUrl
        ? turnUser
        : {
            ...turnUser,
            content: flattenContentForTextOnlyApi(turnUser.content) ?? "",
          };
      deps.sessions.appendMessage(sessionId, storedUser);
    }

    const talentMentions = extractTalentMentions(effectiveMessage);
    talentPaths = resolveTalentStorePaths(config.daemon.dataDir, cwd);
    const mentionedTalents = (
      await Promise.all(
        talentMentions.map((mention) =>
          findHiredTalentByMention(talentPaths!, mention),
        ),
      )
    ).filter((item): item is ActiveTalent => Boolean(item));
    talentAgentStatePaths = resolveTalentAgentStatePaths(config.daemon.dataDir, cwd);
    const talentMemoryByInstance = new Map<string, string>();
    if (mentionedTalents.length) {
      activeTalentExecutionMode = mentionedTalents.length > 1
        ? "team"
        : resolveTalentAgentExecutionMode(
            effectiveMessage,
            mentionedTalents[0]!.hired.mention,
          );
      for (const talent of mentionedTalents) {
        const entries = await listTalentAgentMemory(
          talentAgentStatePaths.memoryPath,
          talent.hired.instanceId,
          6,
        );
        talentMemoryByInstance.set(
          talent.hired.instanceId,
          buildTalentAgentMemoryBlock(entries),
        );
      }
      activeTalentRun = await startTalentAgentRun({
        path: talentAgentStatePaths.runsPath,
        sessionId,
        talentInstanceIds: mentionedTalents.map((talent) => talent.hired.instanceId),
        talentMentions: mentionedTalents.map((talent) => talent.hired.mention),
        mode: activeTalentExecutionMode,
        task: effectiveMessage,
      });
      runEmit({
        type: "status",
        phase: "model",
        message: activeTalentExecutionMode === "team"
          ? `人才 Agent 模式：团队协作（${mentionedTalents.length} 位）`
          : activeTalentExecutionMode === "isolated"
            ? `人才 Agent 模式：@${mentionedTalents[0]!.hired.mention} 独立上下文执行`
            : `人才 Agent 模式：@${mentionedTalents[0]!.hired.mention} 快速协助`,
      });
    }
    const rosterMentions = new Set(
      mentionedTalents.map((t) => t.hired.mention.toLowerCase()),
    );
    const unknownMentions = talentMentions.filter(
      (m) => !rosterMentions.has(m.toLowerCase()),
    );
    if (unknownMentions.length) {
      runEmit({
        type: "warning",
        message: `未在人才名册中找到：${unknownMentions.map((m) => `@${m}`).join(" ")}。请先在人才中心雇佣对应角色。`,
      });
    }
    // For multi-@ dispatch, split the message into per-talent tasks up front so
    // the single intent-understanding call can ALSO emit the execution DAG
    // (steps + `after`), rather than running a second, disconnected planning
    // call that re-derives the same dependencies from keywords.
    const isDispatch = mentionedTalents.length > 1;
    const dispatchAssignments = isDispatch
      ? buildTalentAssignments(effectiveMessage, mentionedTalents)
      : [];
    const dispatchAssignmentInputs = dispatchAssignments.map((a) => ({
      mention: a.activeTalent.hired.mention,
      displayName: a.activeTalent.hired.displayName,
      role: a.activeTalent.template.role,
      emoji: a.activeTalent.template.emoji,
      avatar: a.activeTalent.template.avatar,
      task: a.task,
    }));
    const intentPlan = await buildRunIntentPlan({
      config,
      signal: abort.signal,
      message: effectiveMessage,
      cwd: absCwd,
      runKind: intentRunKind(mentionedTalents.length),
      talents: mentionedTalents.map((t) => ({
        mention: t.hired.mention,
        displayName: t.hired.displayName,
        role: t.template.role,
      })),
      dispatchAssignments: dispatchAssignmentInputs,
      unknownMentions,
    });
    if (abort.signal.aborted) throw new RunCancelledError(initial);
    runEmit({
      type: "intent_plan",
      summary: intentPlan.summary,
      runKind: intentPlan.runKind,
      constraints: intentPlan.constraints,
      uncertainties: intentPlan.uncertainties,
      executionReason: intentPlan.executionReason,
      source: intentPlan.source,
    });

    const usedSkillIds = new Set<string>();
    const trackSkillUsage = (event: AgentEvent): void => {
      if (event.type === "step_start") {
        stepsUsed = Math.max(stepsUsed, event.step);
      }
      if (event.type === "tool_start") {
        toolsCalled.push(event.name);
      }
      if (event.type !== "tool_start" || event.name !== "read_file") return;
      const args = event.args as { path?: string } | undefined;
      const path = args?.path;
      if (!path) return;
      const skill = findSkillByReadPath(allSkills, path);
      if (!skill || usedSkillIds.has(skill.id)) return;
      usedSkillIds.add(skill.id);
      runEmit({
        type: "skill_used",
        skillId: skill.id,
        skillName: skill.name,
        path: skill.path,
      });
    };
    guard.setSkillRoots(skillRoots);

    if (mentionedTalents.length === 1) {
      const active = mentionedTalents[0]!;
      const foreground =
        isTalentForcedForeground(effectiveMessage, active.hired.mention) ||
        mentionedTalents.length === 1;
      if (foreground) {
        if (activeTalentExecutionMode === "isolated") {
          initial = assembleRunMessages(freshMessages, []);
          initialLen = initial.length;
        }
        injectSystemContext(initial, buildTalentSystemBlock(active));
        const talentMemory = talentMemoryByInstance.get(active.hired.instanceId);
        if (talentMemory) injectSystemContext(initial, talentMemory);
        talentToolGate = createTalentToolAllowance(active.hired, "foreground");
        talentUsageIds.push(active.hired.instanceId);
        runEmit({
          type: "talent_active",
          talent: talentEventInfo(active),
          mode: "foreground",
          executionMode: activeTalentExecutionMode ?? "inline",
        });
      }
    }

    // Sub-agents: a focused nested loop that inherits the workspace, tools and
    // operating rules (parent system prompt) but runs an isolated task with a
    // smaller step budget and no further nesting. Cancels with the parent.
    const parentSystem = initial.find((m) => m.role === "system");
    const subConfig = {
      ...config,
      limits: {
        ...config.limits,
        maxSteps: Math.min(config.limits.maxSteps, 20),
      },
    };
    const sharedConfirmNetwork = createNetworkConfirmHandler(
      runEmit,
      sessionId,
      abort.signal,
    );
    const sharedConfirmSoftware = createSoftwareConfirmHandler(
      runEmit,
      sessionId,
      abort.signal,
    );
    const spawnSubagent = async (task: string): Promise<string> => {
      runEmit({ type: "subagent_start", task });
      try {
        const sub = await runReActLoop({
          config: subConfig,
          guard,
          messages: [
            ...(parentSystem ? [parentSystem] : []),
            {
              role: "user",
              content: `[子任务] ${task}\n\n你是一个被派发的只读子代理：可以 read_file / list_dir / grep 来调研，但**不能写文件或执行命令**。请把产出（代码片段 / 文本 / JSON 等）完整放进你的最终回复里返回——主代理会收集所有子代理的结果后统一写入文件。不要尝试自己落盘。`,
            },
          ],
          tools: registry,
          supportsVision: supportsNativeImageUrl,
          autoApply: Boolean(req.autoApply),
          skipNetworkConfirm: Boolean(req.autoApply),
          confirmNetwork: sharedConfirmNetwork,
          skipSoftwareConfirm: Boolean(req.autoApply),
          confirmSoftware: sharedConfirmSoftware,
          signal: abort.signal,
          skillRoots,
          // No spawnSubagent here → depth capped at 1.
          // Single-writer architecture: sub-agents are read-only and return
          // fragments; only the main agent writes, so there is no concurrent
          // write contention by construction.
          allowTool: (name) =>
            ["read_file", "list_dir", "grep", "echo"].includes(name),
          // Forward only progress status so the parent stream isn't flooded.
          onEvent: (event) => {
            if (event.type === "status") runEmit(event);
          },
        });
        runEmit({ type: "subagent_end", summary: sub.finalText });
        return sub.finalText || "（子代理未返回文字结果）";
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        runEmit({ type: "subagent_end", summary: `子代理失败: ${message}` });
        return `子代理执行失败: ${message}`;
      }
    };

    let loopMessages = initial;
    if (mentionedTalents.length > 1) {
      const assignments = dispatchAssignments;
      const assignmentInputs = dispatchAssignmentInputs;
      // Fallback mode for when the unified intent call produced no usable DAG.
      const executionMode = resolveTalentExecutionMode(effectiveMessage, assignments);
      // Positive serial signal (explicit marker or back-reference) — used to
      // force-serialize a flat model plan, but never the ambiguous default.
      const forceSerialIfFlat = detectsSerialDependency(effectiveMessage, assignments);
      const dispatchTurnIndex = deps.sessions.countUserMessages(sessionId) - 1;
      cleanupDispatchArtifacts = () =>
        cleanupTalentArtifacts(absCwd, dispatchTurnIndex);
      const persistDispatchPlan = (plan: RunPlan) => {
        deps.sessions.upsertDispatchPlan(
          sessionId,
          dispatchTurnIndex,
          planToDispatchPlanEvent(plan),
        );
      };
      // The execution DAG comes from the single intent-understanding call; the
      // keyword heuristic only fills in when that call yielded no plan.
      const modelDraft = intentPlan.dispatchDraft;
      let planWarning: string | undefined;
      let plan = resolveTalentDispatchPlan({
        message: effectiveMessage,
        assignments: assignmentInputs,
        executionMode,
        modelDraft,
        forceSerialIfFlat,
      });
      if (plan.source === "heuristic" && modelDraft) {
        planWarning =
          planWarning ?? "模型派活计划无效，已改用规则计划（串行/并行由消息启发式决定）。";
      }
      if (planWarning) {
        runEmit({ type: "warning", message: planWarning });
      }
      runEmit({
        type: "dispatch_plan",
        ...planToDispatchPlanEvent(plan),
      });
      persistDispatchPlan(plan);
      runEmit({ type: "plan_update", items: planToPlanUpdateItems(plan) });
      runEmit({
        type: "status",
        phase: "model",
        message:
          plan.source === "model"
            ? `团队负责人计划（模型）：${talentExecutionWaves(plan).length} 个波次派出 ${assignments.length} 个人才…`
            : executionMode === "serial"
              ? `团队负责人计划：按 ${talentExecutionWaves(plan).length} 个波次顺序派出 ${assignments.length} 个人才…`
              : `团队负责人计划：并行派出 ${assignments.length} 个人才…`,
      });
      const byMention = new Map(
        assignments.map((a) => [a.activeTalent.hired.mention.toLowerCase(), a]),
      );
      const results: TalentResult[] = [];
      const waves = talentExecutionWaves(plan);
      const waveTotal = waves.length;
      for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
        const wave = waves[waveIdx]!;
        runEmit({
          type: "dispatch_wave_start",
          waveIndex: waveIdx + 1,
          waveTotal,
          executionMode,
          talentLabels: wave.map((step) => {
            const assignment = byMention.get((step.mention ?? "").toLowerCase());
            return assignment
              ? assignment.activeTalent.hired.displayName
              : step.displayName || step.mention || step.id;
          }),
        });
        const waveIds = wave.map((s) => s.id);
        plan = markStepsStatus(plan, waveIds, "in_progress");
        runEmit({ type: "plan_update", items: planToPlanUpdateItems(plan) });
        persistDispatchPlan(plan);
        const prior =
          results.length > 0
            ? buildPriorTalentResultsBlock(
                results.map((item) => ({
                  displayName: item.activeTalent.hired.displayName,
                  mention: item.activeTalent.hired.mention,
                  role: item.activeTalent.template.role,
                  task: item.task,
                  result: item.result,
                  artifactPath: item.artifactRelPath,
                })),
              )
            : undefined;
        const waveResults = await Promise.all(
          wave.map((step) => {
            const assignment = byMention.get((step.mention ?? "").toLowerCase());
            if (!assignment) {
              throw new Error(`RunPlan step ${step.id} missing talent @${step.mention}`);
            }
            return runTalentSubagent({
              assignment,
              taskContextPrefix: prior || undefined,
              dispatchWave: {
                index: waveIdx + 1,
                total: waveTotal,
                executionMode,
                hasPriorResults: Boolean(prior),
              },
              parentSystem,
              config: subConfig,
              guard,
              registry,
              supportsNativeImageUrl,
              autoApply: Boolean(req.autoApply),
              sharedConfirmNetwork,
              sharedConfirmSoftware,
              signal: abort.signal,
              skillRoots,
              runEmit,
              memoryBlock: talentMemoryByInstance.get(
                assignment.activeTalent.hired.instanceId,
              ),
              onUsage: (id) => talentUsageIds.push(id),
            });
          }),
        );
        // Persist this wave's outputs so later waves can read_file the full
        // documents. Only worthwhile when a later wave exists to consume them.
        const isLastWave = waveIdx === waves.length - 1;
        results.push(
          ...(isLastWave
            ? waveResults
            : persistWaveArtifacts(absCwd, dispatchTurnIndex, waveResults)),
        );
        plan = markStepsStatus(plan, waveIds, "done");
        runEmit({ type: "plan_update", items: planToPlanUpdateItems(plan) });
        persistDispatchPlan(plan);
      }
      // Scratch artifacts have served their purpose (downstream waves are done;
      // the coordinator gets full results inline). Clean up the workspace.
      cleanupTalentArtifacts(absCwd, dispatchTurnIndex);
      runEmit({
        type: "status",
        phase: "model",
        message: "团队负责人正在汇总各人才结果…",
      });
      loopMessages = [
        ...initial,
        {
          role: "user",
          content: buildCoordinatorFollowup(req.message, results),
        },
      ];
      initialLen = loopMessages.length;
    } else {
      initialLen = initial.length;
    }

    const output = await runReActLoop({
      config,
      guard,
      messages: loopMessages,
      tools: registry,
      supportsVision: supportsNativeImageUrl,
      autoApply: Boolean(req.autoApply),
      runtimePolicy,
      skipNetworkConfirm: Boolean(req.autoApply),
      confirmNetwork: sharedConfirmNetwork,
      skipSoftwareConfirm: Boolean(req.autoApply),
      confirmSoftware: sharedConfirmSoftware,
      confirmCommand:
        // autoApply is about patches, not shell — it must not silence command
        // confirmation. Only non-interactive runs (automation/channel) bypass.
        config.ui?.confirmCommands && !req.automationRun && !req.channelRun
          ? createCommandConfirmHandler(runEmit, sessionId, abort.signal)
          : undefined,
      spawnSubagent,
      signal: abort.signal,
      skillRoots,
      allowTool: talentToolGate
        ? (name) => talentToolGate!(name)
        : undefined,
      onEvent: (event) => {
        trackSkillUsage(event);
        runEmit(event);
      },
    });

    const produced = output.messages.slice(initial.length);
    for (const msg of produced) {
      deps.sessions.appendMessage(sessionId, msg);
    }

    const usedTools = produced.some((m) => m.role === "tool");
    if (!usedTools && looksLikeCodingTask(req.message)) {
      const hints = [
        "本轮未调用任何工具（模型可能只做了文字回复，未读文件/改代码）。",
        "请写明具体目标与相关 @文件路径；若会话过长可先 /compact 或 /clear 后重述完整需求。",
      ];
      if (historyPack.truncated) {
        hints.push("当前会话历史已截断，较早的任务上下文可能已丢失。");
      }
      runEmit({ type: "warning", message: hints.join(" ") });
    }

    if (output.finalText.length > 20) {
      const raw = `User: ${req.message.slice(0, 200)} → ${output.finalText.slice(0, 400)}`;
      const sanitized = sanitizeMemoryContent(raw);
      if (sanitized.ok) {
        rt.memory.upsert({
          projectId,
          memoryType: "episode",
          content: sanitized.text,
        });
      }
    }

    if (talentPaths && talentUsageIds.length) {
      await recordTalentUsage(
        talentPaths.rosterPath,
        [...new Set(talentUsageIds)],
        talentPaths.globalRosterPath,
      );
    }

    if (activeTalentRun && talentAgentStatePaths && output.finalText.length > 20) {
      const memory = sanitizeMemoryContent(
        `Task: ${req.message.slice(0, 240)} → Outcome: ${output.finalText.slice(0, 700)}`,
      );
      if (memory.ok) {
        await Promise.all(
          mentionedTalents.map((talent) =>
            rememberTalentAgentEpisode({
              path: talentAgentStatePaths!.memoryPath,
              talentInstanceId: talent.hired.instanceId,
              sourceRunId: activeTalentRun!.id,
              content: memory.text,
            }),
          ),
        );
      }
    }

    return await finishRun({
      finalText: output.finalText,
      reason: "completed",
    });
  } catch (e) {
    if (e instanceof RunCancelledError) {
      const produced = e.messages.slice(initialLen);
      for (const msg of produced) {
        deps.sessions.appendMessage(sessionId, msg);
      }
      runEmit({ type: "warning", message: e.message });
      return await finishRun({
        finalText: "",
        reason: "cancelled",
      });
    }
    if (e instanceof AgentMaxStepsError) {
      const produced = e.messages.slice(initialLen);
      for (const msg of produced) {
        deps.sessions.appendMessage(sessionId, msg);
      }
      const lastAssistant = [...e.messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.content);
      const finalText = plainTextFromChatContent(lastAssistant?.content ?? "");
      runEmit({ type: "warning", message: `${e.message}，已保存本轮部分结果` });
      runEmit({
        type: "warning",
        message: buildMaxStepsContinueHint(req.message),
      });
      return await finishRun({
        finalText,
        reason: "max_steps",
      });
    }
    if (e instanceof LlmError) {
      runEmit({ type: "error", message: e.message });
    }
    await finalizeTalentRun("failed", e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    permissionService.cancelSession(sessionId);
    deps.cancelService.clearRun(sessionId, abort);
    releaseMcp?.();
    cleanupDispatchArtifacts?.();
  }
}

type ActiveTalent = { hired: HiredTalent; template: TalentTemplate };

/**
 * When a message focuses exactly one hired talent (a single `@mention`), return
 * its bound skills so skill matching can prefer them, plus strict mode when the
 * talent has `strictSkills` enabled. Multi-@ dispatch returns nothing: each
 * dispatched talent gets its own skill context in its sub-run, so biasing the
 * coordinator would mislead.
 */
async function resolveFocusedTalentSkillContext(
  dataDir: string,
  cwd: string,
  message: string,
): Promise<{ talentSkillIds?: string[]; strictTalentSkills?: boolean }> {
  const mentions = extractTalentMentions(message);
  if (mentions.length !== 1) return {};
  try {
    const paths = resolveTalentStorePaths(dataDir, cwd);
    const focused = await findHiredTalentByMention(paths, mentions[0]!);
    const skills = focused?.hired.skills ?? [];
    const strict = Boolean(focused?.hired.strictSkills);
    if (!skills.length && !strict) return {};
    return {
      talentSkillIds: skills,
      strictTalentSkills: strict,
    };
  } catch {
    return {};
  }
}

type IntentPlanRunKind = "coordinator" | "talent_foreground" | "talent_dispatch";

interface RunIntentPlan {
  summary: string;
  runKind: IntentPlanRunKind;
  constraints: string[];
  uncertainties: string[];
  executionReason: string;
  source: "model" | "heuristic";
  /**
   * Execution DAG for multi-@ dispatch, derived in the SAME call that
   * understands the request. Undefined for non-dispatch runs or when the model
   * gave no usable steps (callers then fall back to the keyword heuristic).
   */
  dispatchDraft?: ModelTalentDispatchDraft;
}

interface IntentDispatchAssignment {
  mention: string;
  displayName: string;
  role: string;
  task: string;
}

function intentRunKind(talentCount: number): IntentPlanRunKind {
  if (talentCount <= 0) return "coordinator";
  if (talentCount === 1) return "talent_foreground";
  return "talent_dispatch";
}

async function buildRunIntentPlan(options: {
  config: ForgeConfig;
  signal?: AbortSignal;
  message: string;
  cwd: string;
  runKind: IntentPlanRunKind;
  talents: Array<{ mention: string; displayName: string; role: string }>;
  dispatchAssignments: IntentDispatchAssignment[];
  unknownMentions: string[];
}): Promise<RunIntentPlan> {
  const fallback = fallbackIntentPlan(options);
  try {
    const llm = new LlmClient(options.config.model);
    const res = await llm.chat({
      messages: [
        {
          role: "user",
          content: buildIntentPlanningPrompt(options),
        },
      ],
      tools: [],
      signal: options.signal,
    });
    const parsed = parseIntentPlanText(
      res.text ?? "",
      options.runKind,
      options.dispatchAssignments,
    );
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function fallbackIntentPlan(options: {
  message: string;
  runKind: IntentPlanRunKind;
  talents: Array<{ mention: string; displayName: string; role: string }>;
  unknownMentions: string[];
}): RunIntentPlan {
  const constraints = [];
  if (options.talents.length) {
    constraints.push(
      `已识别人才：${options.talents
        .map((t) => `${t.displayName} (@${t.mention})`)
        .join("、")}`,
    );
  }
  if (options.unknownMentions.length) {
    constraints.push(
      `未命中人才：${options.unknownMentions.map((m) => `@${m}`).join(" ")}`,
    );
  }
  return {
    summary: options.message.trim().replace(/\s+/g, " ").slice(0, 180) || "执行用户请求",
    runKind: options.runKind,
    constraints,
    uncertainties: ["模型理解不可用，已使用规则摘要。"],
    executionReason:
      options.runKind === "talent_dispatch"
        ? "检测到多个已雇佣人才提及，将先规划再按依赖执行。"
        : options.runKind === "talent_foreground"
          ? "检测到一个已雇佣人才提及，将由该人才前台接管本轮。"
          : "未检测到已雇佣人才提及，将由 Coordinator 直接执行。",
    source: "heuristic",
  };
}

function buildIntentPlanningPrompt(options: {
  message: string;
  cwd: string;
  runKind: IntentPlanRunKind;
  talents: Array<{ mention: string; displayName: string; role: string }>;
  dispatchAssignments: IntentDispatchAssignment[];
  unknownMentions: string[];
}): string {
  const isDispatch =
    options.runKind === "talent_dispatch" && options.dispatchAssignments.length > 0;
  const roster = isDispatch
    ? options.dispatchAssignments
        .map(
          (a) => `- @${a.mention} (${a.displayName}, ${a.role}): ${a.task}`,
        )
        .join("\n")
    : options.talents.length
      ? options.talents
          .map((t) => `- @${t.mention}: ${t.displayName} (${t.role})`)
          .join("\n")
      : "- none";
  const unknown = options.unknownMentions.length
    ? options.unknownMentions.map((m) => `@${m}`).join(", ")
    : "none";
  // For dispatch, the same understanding that names the dependencies must emit
  // the execution DAG: each talent's `after` lists the @mentions whose output
  // it builds on. Empty `after` = independent (runs in parallel). This is the
  // single source of truth for serial-vs-parallel — there is no separate pass.
  const schema = isDispatch
    ? [
        "JSON schema:",
        "{",
        '  "summary": "one sentence restating the real user goal",',
        `  "runKind": "${options.runKind}",`,
        '  "constraints": ["important constraints, dependencies, ordering, files, safety"],',
        '  "uncertainties": ["anything ambiguous, empty array if none"],',
        '  "executionReason": "why this run mode/flow is appropriate",',
        '  "steps": [',
        '    { "mention": "use ONLY a mention from the roster above, each exactly once",',
        '      "task": "refined, self-contained task for this talent",',
        '      "after": ["mentions whose OUTPUT this task depends on; [] if independent"] }',
        "  ]",
        "}",
        "Set `after` from real data dependencies, not surface keywords: if a talent needs another's result to start, list that mention.",
      ]
    : [
        "JSON schema:",
        "{",
        '  "summary": "one sentence restating the real user goal",',
        `  "runKind": "${options.runKind}",`,
        '  "constraints": ["important constraints, dependencies, ordering, files, safety"],',
        '  "uncertainties": ["anything ambiguous, empty array if none"],',
        '  "executionReason": "why this run mode/flow is appropriate"',
        "}",
      ];
  return [
    "Understand the user's request before execution.",
    "Return JSON only. Do not execute or plan tool calls here.",
    "",
    `Workspace: ${options.cwd}`,
    `Detected runKind: ${options.runKind}`,
    isDispatch ? "Hired talents and their tasks:" : "Detected hired talents:",
    roster,
    `Unknown @mentions: ${unknown}`,
    "",
    "User message:",
    options.message,
    "",
    ...schema,
  ].join("\n");
}

function parseIntentPlanText(
  text: string,
  expectedRunKind: IntentPlanRunKind,
  dispatchAssignments: IntentDispatchAssignment[],
): RunIntentPlan | undefined {
  const raw = extractFirstJsonObject(text);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const summary = stringValue(parsed.summary);
    const executionReason = stringValue(parsed.executionReason);
    if (!summary || !executionReason) return undefined;
    // Reuse the dispatch-plan parser/validator on the same JSON so the DAG is
    // held to the same roster/cycle checks as the legacy planning path.
    const dispatchDraft =
      expectedRunKind === "talent_dispatch" && dispatchAssignments.length > 0
        ? parseModelTalentDispatchDraft(raw)
        : undefined;
    return {
      summary,
      runKind: expectedRunKind,
      constraints: stringArray(parsed.constraints),
      uncertainties: stringArray(parsed.uncertainties),
      executionReason,
      source: "model",
      dispatchDraft,
    };
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    : [];
}

function extractFirstJsonObject(text: string): string | undefined {
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

interface TalentAssignment {
  activeTalent: ActiveTalent;
  task: string;
}

interface TalentResult {
  activeTalent: ActiveTalent;
  task: string;
  result: string;
  /** Workspace-relative artifact path, when the output was persisted to disk. */
  artifactRelPath?: string;
}

/** Render a talent's output as a standalone document for downstream read_file. */
function buildTalentArtifactDoc(result: TalentResult): string {
  const { hired, template } = result.activeTalent;
  return [
    `# ${hired.displayName} (@${hired.mention}) — ${template.role}`,
    "",
    `任务：${result.task}`,
    "",
    "---",
    "",
    result.result,
    "",
  ].join("\n");
}

/**
 * Persist one wave's outputs to workspace scratch files (best-effort) so the
 * next wave's talents can read the FULL document, not just the inlined prefix.
 * The orchestrator is the sole writer; sub-agents remain read-only. Returns the
 * results enriched with their artifact paths (unchanged on write failure).
 */
function persistWaveArtifacts(
  absCwd: string,
  turnIndex: number,
  waveResults: TalentResult[],
): TalentResult[] {
  return waveResults.map((result) => {
    const relPath = talentArtifactRelPath(turnIndex, result.activeTalent.hired.mention);
    const absPath = join(absCwd, relPath);
    try {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, buildTalentArtifactDoc(result), "utf8");
      return { ...result, artifactRelPath: relPath };
    } catch {
      return result;
    }
  });
}

/** Remove a dispatch turn's scratch artifacts (best-effort). */
function cleanupTalentArtifacts(absCwd: string, turnIndex: number): void {
  try {
    rmSync(join(absCwd, talentArtifactDirRelPath(turnIndex)), {
      recursive: true,
      force: true,
    });
  } catch {
    /* best-effort cleanup */
  }
}

function injectSystemContext(
  messages: { role: string; content: unknown }[],
  block: string,
): void {
  const system = messages.find((message) => message.role === "system");
  if (!system) return;
  if (typeof system.content === "string") {
    system.content = `${system.content}\n\n${block}`;
  }
}

function buildTalentAssignments(
  message: string,
  talents: ActiveTalent[],
): TalentAssignment[] {
  const byMention = new Map(
    talents.map((talent) => [talent.hired.mention.toLowerCase(), talent]),
  );
  return parseTalentAssignmentsFromMessage(
    message,
    talents.map((talent) => talent.hired.mention),
  )
    .map((parsed) => {
      const activeTalent = byMention.get(parsed.mention);
      if (!activeTalent) return null;
      return { activeTalent, task: parsed.task };
    })
    .filter((item): item is TalentAssignment => Boolean(item));
}

function talentEventInfo(active: ActiveTalent) {
  return {
    mention: active.hired.mention,
    displayName: active.hired.displayName,
    role: active.template.role,
    emoji: active.template.emoji,
    avatar: active.template.avatar,
  };
}

function describeAssignment(assignment: TalentAssignment) {
  const { hired } = assignment.activeTalent;
  return {
    activeTalentLabel: `${hired.displayName} (@${hired.mention})`,
  };
}

function buildCoordinatorFollowup(
  originalMessage: string,
  results: TalentResult[],
): string {
  const sections = results.map((item, index) => {
    const { activeTalentLabel } = describeAssignment(item);
    return [
      `### ${index + 1}. ${activeTalentLabel}`,
      `Assigned task: ${item.task}`,
      "Result:",
      item.result,
    ].join("\n");
  });
  return [
    "[团队派活结果]",
    "以下是各人才子代理的产出。请作为团队负责人汇总、统一写盘，并自行 read_file + 测试/编译/lint 验证。",
    `Original request: ${originalMessage}`,
    "",
    ...sections,
  ].join("\n\n");
}

const SUBAGENT_FORWARD_EVENTS = new Set([
  "status",
  "step_start",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "tool_start",
  "tool_end",
  "text_delta",
  "warning",
]);

function forwardTalentSubagentEvent(
  runEmit: (event: AgentEvent) => void,
  event: AgentEvent,
  talent: ReturnType<typeof talentEventInfo>,
) {
  if (!SUBAGENT_FORWARD_EVENTS.has(event.type)) return;
  if (event.type === "status") {
    runEmit({ ...event, talent } as AgentEvent);
    return;
  }
  runEmit({ ...event, talent } as AgentEvent);
}

async function runTalentSubagent(options: {
  assignment: TalentAssignment;
  taskContextPrefix?: string;
  dispatchWave?: {
    index: number;
    total: number;
    executionMode: "serial" | "parallel";
    hasPriorResults: boolean;
  };
  parentSystem: ChatMessage | undefined;
  config: ForgeConfig;
  guard: WorkspaceGuardType;
  registry: ToolRegistry;
  supportsNativeImageUrl: boolean;
  autoApply: boolean;
  sharedConfirmNetwork: (req: NetworkConfirmRequest) => Promise<boolean>;
  sharedConfirmSoftware: (req: SoftwareConfirmRequest) => Promise<boolean>;
  signal: AbortSignal;
  skillRoots: string[];
  memoryBlock?: string;
  runEmit: (event: AgentEvent) => void;
  onUsage: (instanceId: string) => void;
}): Promise<TalentResult> {
  const { activeTalentLabel } = describeAssignment(options.assignment);
  const { assignment } = options;
  const talent = talentEventInfo(assignment.activeTalent);
  const visibleTask = assignment.task;
  const executionTask = options.taskContextPrefix
    ? `${options.taskContextPrefix}\n\n${visibleTask}`
    : visibleTask;
  const task = [
    buildTalentSystemBlock(assignment.activeTalent),
    options.memoryBlock || undefined,
    "",
    `[人才后台任务] ${executionTask}`,
    "",
    "你是一个被派发的只读人才子代理：可以 read_file / list_dir / grep 来调研，但不能写文件或执行命令。",
    "在开始写结论之前，你必须至少调用一次 list_dir 或 read_file 了解当前项目（优先 list_dir 项目根目录）。",
    "请把产出（完整文件内容、审查结论、设计建议或 JSON 等）完整放进最终回复。Coordinator 会收集结果后统一写盘和校验。",
  ].filter(Boolean).join("\n");
  options.runEmit({
    type: "subagent_start",
    task: `${activeTalentLabel}: ${visibleTask}`,
    talent,
    dispatchWave: options.dispatchWave,
  });
  options.onUsage(assignment.activeTalent.hired.instanceId);
  const allowTool = createTalentToolAllowance(
    assignment.activeTalent.hired,
    "background",
  );
  try {
    const sub = await runReActLoop({
      config: options.config,
      guard: options.guard,
      messages: [
        ...(options.parentSystem ? [options.parentSystem] : []),
        { role: "user", content: task },
      ],
      tools: options.registry,
      supportsVision: options.supportsNativeImageUrl,
      autoApply: options.autoApply,
      skipNetworkConfirm: options.autoApply,
      confirmNetwork: options.sharedConfirmNetwork,
      skipSoftwareConfirm: options.autoApply,
      confirmSoftware: options.sharedConfirmSoftware,
      signal: options.signal,
      skillRoots: options.skillRoots,
      allowTool,
      onEvent: (event) => forwardTalentSubagentEvent(options.runEmit, event, talent),
    });
    const result = sub.finalText || "（人才子代理未返回文字结果）";
    options.runEmit({ type: "subagent_end", summary: `${activeTalentLabel}: ${result.slice(0, 200)}`, talent });
    return { activeTalent: assignment.activeTalent, task: visibleTask, result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    options.runEmit({
      type: "subagent_end",
      summary: `${activeTalentLabel}: 失败 — ${message}`,
      talent,
    });
    return {
      activeTalent: assignment.activeTalent,
      task: visibleTask,
      result: `人才子代理执行失败: ${message}`,
    };
  }
}

function linkExternalAbortSignal(
  externalSignal: AbortSignal | undefined,
  controller: AbortController,
): void {
  if (!externalSignal || externalSignal === controller.signal) return;
  if (externalSignal.aborted) {
    controller.abort();
    return;
  }
  externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
}

function effectiveModelName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed || trimmed === "forge-default") return undefined;
  return trimmed;
}
