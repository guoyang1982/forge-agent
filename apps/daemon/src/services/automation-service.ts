import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentEvent,
  AutomationDraft,
  AutomationRecord,
  AutomationRunRecord,
  AutomationRunTrigger,
  ChannelAdapterRecord,
  ChannelKind,
  CreateAutomationResult,
  DeleteAutomationResult,
  ForgeConfig,
  GetAutomationResult,
  ListAutomationRunsResult,
  ListAutomationsResult,
  ListAutomationTemplatesResult,
  ParseAutomationDraftResult,
  RunAutomationResult,
  UpdateAutomationResult,
} from "@forge/protocol";
import { loadConfig } from "@forge/config";
import type { ChannelStore } from "@forge/channel";
import { credentialsFromConfig, IlinkClient } from "@forge/channel-ilink";
import { LlmClient } from "@forge/llm";
import type { SessionStore } from "@forge/session";
import type { Database } from "@forge/store";
import {
  AutomationStore,
  automationRunInput,
  automationToWorkflow,
  buildAutomationDraftParsePrompt,
  computeNextRun,
  listTemplates,
  parseAutomationDraftFromJson,
  parseAutomationDraftHeuristic,
  validateCronExpr,
  type UpdateAutomationPatch,
} from "@forge/automation";
import type {
  DurableExecutor,
  ExecutionClock,
  ExecutionStore,
  RunState,
} from "@forge/execution";
import {
  compileWorkflowRun,
  WorkflowStore,
  type WorkflowTriggerKind,
} from "@forge/workflows";
import type { AutomationSchedulerHost } from "./automation-scheduler-host.js";
import type { AutomationGovernanceService } from "./automation-governance.js";
import { readForgeRunResult } from "./forge-run-results.js";

export interface DurableAutomationDeps {
  db: Database;
  executionStore: ExecutionStore;
  executor: DurableExecutor;
  clock: ExecutionClock;
  governance: AutomationGovernanceService;
}

export interface AutomationServiceDeps {
  sessions: SessionStore;
  getStore: () => AutomationStore;
  getChannelStore?: () => ChannelStore;
  getScheduler: () => AutomationSchedulerHost;
  getDurable: () => DurableAutomationDeps;
}

export function assertAutomationPermission(
  cfg: ForgeConfig,
  op: "create" | "run" | "delete",
  opts: { scheduled?: boolean; skipConfirm?: boolean },
): void {
  const p = cfg.permissions?.automation;
  if (!p?.enabled) {
    throw new Error("automation disabled in permissions");
  }
  if (opts.scheduled) return;
  const level = p[op];
  if (level === "deny") {
    throw new Error(`automation ${op} denied`);
  }
  if (level === "confirm" && !opts.skipConfirm) {
    throw new Error(`automation ${op} requires confirmation`);
  }
}

function resolveCwd(cwd: string | undefined, fallback?: string): string {
  const raw = cwd ?? fallback ?? process.cwd();
  return resolve(raw);
}

function assertCwdExists(cwd: string): void {
  if (!existsSync(cwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
}

function assertValidCron(cron: string): void {
  if (!validateCronExpr(cron)) {
    throw new Error(`invalid cron expression: ${cron}`);
  }
}

function draftPatchToStorePatch(
  patch: Partial<AutomationDraft> & { enabled?: boolean },
  existing: AutomationRecord,
): UpdateAutomationPatch {
  const result: UpdateAutomationPatch = {};
  if (patch.name !== undefined) result.name = patch.name;
  if (patch.description !== undefined) result.description = patch.description;
  if (patch.cwd !== undefined) result.cwd = patch.cwd;
  if (patch.prompt !== undefined) result.prompt = patch.prompt;
  if (patch.enabled !== undefined) result.enabled = patch.enabled;
  if (patch.notify !== undefined) result.notify = patch.notify;

  if (patch.cron !== undefined) {
    if (patch.cron) {
      result.trigger = {
        type: "cron",
        cron: patch.cron,
        timezone:
          patch.timezone ??
          (existing.trigger.type === "cron" ? existing.trigger.timezone : "UTC"),
      };
    } else {
      result.trigger = { type: "manual" };
    }
  } else if (patch.timezone !== undefined && existing.trigger.type === "cron") {
    result.trigger = {
      type: "cron",
      cron: existing.trigger.cron,
      timezone: patch.timezone,
    };
  }

  return result;
}

export interface ExecuteAutomationDeps {
  store: AutomationStore;
  channelStore?: ChannelStore;
  sessions: SessionStore;
  scheduler: AutomationSchedulerHost;
  cfg: ForgeConfig;
  durable: DurableAutomationDeps;
}

function automationResultNotificationText(
  auto: AutomationRecord,
  resultText: string,
): string {
  const title = `自动化「${auto.name}」执行完成`;
  const body = resultText.trim() || "(无结果文本)";
  return `${title}\n\n${body}`;
}

async function sendAutomationIlinkNotification(
  auto: AutomationRecord,
  resultText: string,
  deps: { channelStore: ChannelStore },
): Promise<void> {
  const notify = auto.notify;
  if (!notify?.enabled || notify.channelKind !== "ilink") return;
  const channels = notify.channelId
    ? [deps.channelStore.get(notify.channelId)].filter(Boolean)
    : deps.channelStore
        .list({ cwd: auto.cwd, enabledOnly: true })
        .filter((c) => c.kind === "ilink");
  const channel = channels[0];
  if (!channel) throw new Error("no enabled ilink channel for automation notification");

  const binding = deps.channelStore.findLatestBinding({
    channel: "ilink",
    channelId: channel.id,
    cwd: auto.cwd,
    threadKey: notify.threadKey,
  });
  if (!binding?.peerUserId || !binding.lastContextToken) {
    throw new Error("no ilink binding with reply context; message the bot once first");
  }

  const creds = credentialsFromConfig(
    channel.config,
    typeof channel.config.baseUrl === "string"
      ? channel.config.baseUrl
      : "https://ilinkai.weixin.qq.com",
  );
  if (!creds) throw new Error("ilink channel is not logged in");

  const max = 4000;
  const raw = automationResultNotificationText(auto, resultText);
  const text = raw.length > max ? `${raw.slice(0, max)}\n\n…(已截断)` : raw;
  const client = new IlinkClient(creds.baseUrl);
  const res = await client.sendTextMessage(
    creds,
    binding.peerUserId,
    text,
    binding.lastContextToken,
  );
  const code = res.ret ?? res.errcode ?? res.code;
  if (code !== undefined && code !== 0) {
    throw new Error(
      res.errmsg?.trim() || res.message?.trim() || `sendmessage code=${code}`,
    );
  }
}

function pickAutomationNotificationChannel(
  auto: AutomationRecord,
  channelStore: ChannelStore,
  kind: ChannelKind,
): ChannelAdapterRecord | null {
  if (auto.notify?.channelId) {
    const channel = channelStore.get(auto.notify.channelId);
    return channel?.kind === kind ? channel : null;
  }
  return (
    channelStore
      .list({ cwd: auto.cwd, enabledOnly: true })
      .find((channel) => channel.kind === kind) ?? null
  );
}

function configuredWebhookUrl(channel: ChannelAdapterRecord): string {
  const url = channel.config.webhookUrl;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
    throw new Error(`${channel.kind} channel missing webhookUrl`);
  }
  return url.trim();
}

function webhookPayloadForKind(
  kind: ChannelKind,
  text: string,
  auto: AutomationRecord,
): unknown {
  if (kind === "feishu") {
    return {
      msg_type: "text",
      content: { text },
    };
  }
  if (kind === "dingtalk") {
    return {
      msgtype: "text",
      text: { content: text },
    };
  }
  return {
    source: "forge",
    type: "automation_result",
    title: `自动化「${auto.name}」执行完成`,
    text,
    automation: {
      id: auto.id,
      name: auto.name,
      cwd: auto.cwd,
    },
  };
}

async function postWebhookNotification(
  channel: ChannelAdapterRecord,
  text: string,
  auto: AutomationRecord,
): Promise<void> {
  const url = configuredWebhookUrl(channel);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (channel.kind === "http" && typeof channel.config.authHeader === "string") {
    const authHeader = channel.config.authHeader.trim();
    if (authHeader) headers.Authorization = authHeader;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(webhookPayloadForKind(channel.kind, text, auto)),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`${channel.kind} webhook HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  if (bodyText.trim()) {
    try {
      const body = JSON.parse(bodyText) as {
        code?: number;
        StatusCode?: number;
        errcode?: number;
        msg?: string;
        errmsg?: string;
        message?: string;
      };
      const code = body.errcode ?? body.code ?? body.StatusCode;
      if (code !== undefined && code !== 0) {
        throw new Error(
          body.errmsg?.trim() ||
            body.msg?.trim() ||
            body.message?.trim() ||
            `${channel.kind} webhook code=${code}`,
        );
      }
    } catch (e) {
      if (e instanceof SyntaxError) return;
      throw e;
    }
  }
}

async function sendAutomationWebhookNotification(
  auto: AutomationRecord,
  resultText: string,
  deps: { channelStore: ChannelStore; kind: ChannelKind },
): Promise<void> {
  const channel = pickAutomationNotificationChannel(
    auto,
    deps.channelStore,
    deps.kind,
  );
  if (!channel) {
    throw new Error(`no enabled ${deps.kind} channel for automation notification`);
  }
  const max = 4000;
  const raw = automationResultNotificationText(auto, resultText);
  const text = raw.length > max ? `${raw.slice(0, max)}\n\n…(已截断)` : raw;
  await postWebhookNotification(channel, text, auto);
}

async function sendAutomationNotification(
  auto: AutomationRecord,
  resultText: string,
  deps: { channelStore?: ChannelStore },
): Promise<void> {
  if (!auto.notify?.enabled) return;
  if (auto.notify.channelKind === "ilink" && deps.channelStore) {
    await sendAutomationIlinkNotification(auto, resultText, {
      channelStore: deps.channelStore,
    });
    return;
  }
  if (
    deps.channelStore &&
    (auto.notify.channelKind === "feishu" ||
      auto.notify.channelKind === "dingtalk" ||
      auto.notify.channelKind === "http")
  ) {
    await sendAutomationWebhookNotification(auto, resultText, {
      channelStore: deps.channelStore,
      kind: auto.notify.channelKind,
    });
  }
}

export async function executeAutomation(
  automationId: string,
  trigger: AutomationRunTrigger,
  deps: ExecuteAutomationDeps,
  runOpts?: {
    skipConfirm?: boolean;
    emit?: (event: AgentEvent) => void;
    occurrenceRef?: string;
  },
): Promise<AutomationRunRecord> {
  const auto = deps.store.get(automationId);
  if (!auto) {
    throw new Error("automation not found");
  }

  assertAutomationPermission(deps.cfg, "run", {
    scheduled: trigger === "schedule",
    skipConfirm: runOpts?.skipConfirm,
  });

  const scheduledTriggerRef = runOpts?.occurrenceRef
    ? `automation-schedule:${runOpts.occurrenceRef}`
    : undefined;
  const existingOccurrence = scheduledTriggerRef
    ? deps.store.getRunByTriggerRef(automationId, scheduledTriggerRef)
    : null;
  if (existingOccurrence?.status === "success") {
    return existingOccurrence;
  }

  if (!existingOccurrence && deps.store.hasRunningRun(automationId)) {
    return deps.store.insertRun({
      automationId,
      status: "skipped",
      trigger,
      error: "concurrent_run",
      sessionId: "",
    });
  }

  const sessionId =
    existingOccurrence?.sessionId ||
    (auto.sessionMode === "resume" && auto.resumeSessionId
      ? auto.resumeSessionId
      : deps.sessions.createSession(auto.cwd));

  const run = existingOccurrence
    ? deps.store.updateRun(existingOccurrence.id, {
        status: "running",
        sessionId,
        finishedAt: null,
        error: null,
      })!
    : deps.store.insertRun({
        automationId,
        sessionId,
        status: "running",
        trigger,
        triggerRef: scheduledTriggerRef,
      });

  const emit = runOpts?.emit ?? (() => {});

  try {
    const outcome = await executeDurableOccurrence(
      auto,
      run,
      sessionId,
      trigger,
      deps,
    );
    if (outcome.state === "pending") {
      return deps.store.updateRun(run.id, { status: "running" })!;
    }
    const result = outcome.result;
    let preview = result.finalText.slice(0, 200);
    try {
      await sendAutomationNotification(auto, result.finalText, deps);
    } catch (e) {
      const msg = `自动化结果通知失败: ${String(e)}`;
      emit({ type: "warning", sessionId, message: msg });
      preview = `${msg}\n${result.finalText}`.slice(0, 200);
    }
    return deps.store.finishRun(run.id, {
      status: "success",
      preview,
    })!;
  } catch (e) {
    return deps.store.finishRun(run.id, {
      status: "failed",
      error: String(e),
    })!;
  } finally {
    const persisted = deps.store.getRunByTriggerRef(
      automationId,
      scheduledTriggerRef ?? "",
    );
    const durableOccurrenceCreated = scheduledTriggerRef
      ? Boolean(persisted?.workflowInstanceId && persisted.durableRunId)
      : true;
    if (durableOccurrenceCreated) {
      deps.store.touchLastRun(automationId);
      if (auto.trigger.type === "cron") {
        const next = computeNextRun(auto.trigger.cron, auto.trigger.timezone);
        deps.store.setNextRunAt(automationId, next);
        await deps.scheduler.reschedule(automationId);
      }
    }
  }
}

async function executeDurableOccurrence(
  auto: AutomationRecord,
  occurrence: AutomationRunRecord,
  sessionId: string,
  trigger: AutomationRunTrigger,
  deps: ExecuteAutomationDeps,
): Promise<
  | { state: "pending" }
  | { state: "succeeded"; result: { sessionId: string; finalText: string } }
> {
  const workflows = WorkflowStore.forDatabase(deps.durable.db);
  const definition = automationToWorkflow(auto);
  const governance = await deps.durable.governance.prepare(auto, definition, {
    userGranted: trigger === "manual",
  });
  const published =
    workflows.getLatestPublishedVersion(definition.id) ??
    workflows.publish(
      {
        id: definition.id,
        name: auto.name,
        ownerSubject: { kind: "human", id: "local-user" },
        definition,
        description: auto.description ?? auto.name,
      },
      governance.qualityGate,
    );
  const triggerRef = occurrence.triggerRef ?? `automation-run:${occurrence.id}`;
  const existing = workflows.findInstanceByTriggerRef(definition.id, triggerRef);
  if (existing?.runId) {
    deps.store.updateRun(occurrence.id, {
      workflowInstanceId: existing.id,
      durableRunId: existing.runId,
    });
    const durableRun = deps.durable.executionStore.getRun(existing.runId);
    if (
      durableRun?.state === "queued" ||
      durableRun?.state === "running" ||
      durableRun?.state === "waiting"
    ) {
      return { state: "pending" };
    }
    if (durableRun?.state !== "succeeded") {
      throw new Error(`durable automation run failed: ${durableRun?.state ?? "missing"}`);
    }
    return {
      state: "succeeded",
      result: durableAutomationResult(
        deps.durable.db,
        deps.durable.executionStore,
        existing.runId,
        sessionId,
      ),
    };
  }

  const triggerKind: WorkflowTriggerKind = trigger === "schedule" ? "cron" : "manual";
  const instance =
    existing ??
    workflows.createInstance({
      workflowId: definition.id,
      workflowVersionId: published.workflowVersionId,
      triggerKind,
      triggerRef,
      concurrencyKey: auto.id,
      runInput: {},
    });
  deps.store.updateRun(occurrence.id, {
    workflowInstanceId: instance.id,
  });
  const instanceNumber = workflows.countInstances(definition.id);
  const compiled = compileWorkflowRun(published.definition, {}, {
    workflowId: definition.id,
    instanceId: instance.id,
    instanceNumber,
    requestedBy: { kind: "human", id: "local-user" },
    actingSubject: { kind: "agent_profile", id: governance.profileId },
    objective: auto.prompt,
    policyContext: governance.policyContext,
    budgetAccountId: governance.budgetAccountId,
  });
  const spec = {
    ...compiled,
    steps: compiled.steps.map((step) => ({
      ...step,
      input: automationRunInput(auto, sessionId),
      idempotencyKey: `automation-occurrence:${triggerRef}`,
    })),
  };

  deps.durable.executionStore.createRun(spec, deps.durable.clock.now());
  workflows.linkRun(instance.id, spec.id);
  deps.store.updateRun(occurrence.id, {
    workflowInstanceId: instance.id,
    durableRunId: spec.id,
  });
  await deps.durable.executor.tick();
  const durableRun = deps.durable.executionStore.getRun(spec.id);
  if (!durableRun) {
    workflows.updateInstanceState(instance.id, "failed");
    throw new Error("durable automation run failed: missing");
  }
  workflows.updateInstanceState(instance.id, workflowStateFromRun(durableRun.state));
  if (
    durableRun.state === "queued" ||
    durableRun.state === "running" ||
    durableRun.state === "waiting"
  ) {
    return { state: "pending" };
  }
  if (durableRun.state !== "succeeded") {
    throw new Error(`durable automation run failed: ${durableRun.state}`);
  }
  return {
    state: "succeeded",
    result: durableAutomationResult(
      deps.durable.db,
      deps.durable.executionStore,
      spec.id,
      sessionId,
    ),
  };
}

export async function reconcileAutomationRuns(deps: {
  store: AutomationStore;
  channelStore?: ChannelStore;
  durable: Pick<DurableAutomationDeps, "db" | "executionStore">;
}): Promise<number> {
  const workflows = WorkflowStore.forDatabase(deps.durable.db);
  let reconciled = 0;
  for (const projection of deps.store.listRunningDurableRuns()) {
    if (!projection.durableRunId || !projection.workflowInstanceId) continue;
    const durableRun = deps.durable.executionStore.getRun(projection.durableRunId);
    if (!durableRun) continue;
    workflows.updateInstanceState(
      projection.workflowInstanceId,
      workflowStateFromRun(durableRun.state),
    );
    if (
      durableRun.state === "queued" ||
      durableRun.state === "running" ||
      durableRun.state === "waiting"
    ) {
      continue;
    }

    const automation = deps.store.get(projection.automationId);
    if (durableRun.state === "succeeded" && automation) {
      const result = durableAutomationResult(
        deps.durable.db,
        deps.durable.executionStore,
        projection.durableRunId,
        projection.sessionId,
      );
      let preview = result.finalText.slice(0, 200);
      try {
        await sendAutomationNotification(automation, result.finalText, deps);
      } catch (error) {
        preview = `自动化结果通知失败: ${String(error)}\n${result.finalText}`.slice(
          0,
          200,
        );
      }
      deps.store.finishRun(projection.id, { status: "success", preview });
    } else {
      deps.store.finishRun(projection.id, {
        status: "failed",
        error: `durable automation run failed: ${durableRun.state}`,
      });
    }
    reconciled += 1;
  }
  return reconciled;
}

function durableAutomationResult(
  db: Database,
  executionStore: ExecutionStore,
  runId: string,
  fallbackSessionId: string,
): { sessionId: string; finalText: string } {
  const outputRef = executionStore
    .listAttempts(runId, "agent")
    .find((attempt) => attempt.state === "succeeded")?.outputRef;
  return (
    readForgeRunResult(db, outputRef) ?? {
      sessionId: fallbackSessionId,
      finalText: "",
    }
  );
}

function workflowStateFromRun(
  state: RunState,
): "running" | "waiting" | "succeeded" | "failed" | "cancelled" {
  return state === "queued" ? "running" : state;
}

export async function handleListAutomations(
  params: unknown,
  deps: AutomationServiceDeps,
): Promise<ListAutomationsResult> {
  const req = params as { cwd?: string } | undefined;
  const cwd = req?.cwd ? resolveCwd(req.cwd) : undefined;
  return { automations: deps.getStore().list(cwd ? { cwd } : undefined) };
}

export async function handleGetAutomation(
  params: unknown,
  deps: AutomationServiceDeps,
): Promise<GetAutomationResult> {
  const req = params as { id: string };
  const automation = deps.getStore().get(req.id);
  if (!automation) {
    throw new Error("automation not found");
  }
  return { automation };
}

export async function handleCreateAutomation(
  params: unknown,
  deps: AutomationServiceDeps,
): Promise<CreateAutomationResult> {
  const req = params as { draft: AutomationDraft; skipConfirm?: boolean };
  const absCwd = resolveCwd(req.draft.cwd);
  assertCwdExists(absCwd);
  if (req.draft.cron) {
    assertValidCron(req.draft.cron);
  }

  const cfg = loadConfig({ cwd: absCwd });
  assertAutomationPermission(cfg, "create", { skipConfirm: req.skipConfirm });

  const automation = deps.getStore().create({
    ...req.draft,
    cwd: absCwd,
  });
  await deps.getScheduler().reschedule(automation.id);
  return { automation };
}

export async function handleUpdateAutomation(
  params: unknown,
  deps: AutomationServiceDeps,
): Promise<UpdateAutomationResult> {
  const req = params as {
    id: string;
    patch: Partial<AutomationDraft> & { enabled?: boolean };
  };
  const store = deps.getStore();
  const existing = store.get(req.id);
  if (!existing) {
    throw new Error("automation not found");
  }

  if (req.patch.cwd !== undefined) {
    const absCwd = resolveCwd(req.patch.cwd);
    assertCwdExists(absCwd);
    req.patch.cwd = absCwd;
  }
  if (req.patch.cron) {
    assertValidCron(req.patch.cron);
  }

  const storePatch = draftPatchToStorePatch(req.patch, existing);
  const automation = store.update(req.id, storePatch);
  if (!automation) {
    throw new Error("automation not found");
  }
  await deps.getScheduler().reschedule(req.id);
  return { automation };
}

export async function handleDeleteAutomation(
  params: unknown,
  deps: AutomationServiceDeps,
): Promise<DeleteAutomationResult> {
  const req = params as { id: string; skipConfirm?: boolean };
  const store = deps.getStore();
  const existing = store.get(req.id);
  if (!existing) {
    throw new Error("automation not found");
  }

  const cfg = loadConfig({ cwd: existing.cwd });
  assertAutomationPermission(cfg, "delete", { skipConfirm: req.skipConfirm });

  store.delete(req.id);
  await deps.getScheduler().reschedule(req.id);
  return { ok: true };
}

export async function handleRunAutomation(
  params: unknown,
  deps: AutomationServiceDeps,
  emit: (event: AgentEvent) => void = () => {},
): Promise<RunAutomationResult> {
  const req = params as {
    id: string;
    trigger?: AutomationRunTrigger;
    skipConfirm?: boolean;
  };
  const store = deps.getStore();
  const existing = store.get(req.id);
  if (!existing) {
    throw new Error("automation not found");
  }

  const cfg = loadConfig({ cwd: existing.cwd });

  const run = await executeAutomation(
    req.id,
    req.trigger ?? "manual",
    {
      store,
      sessions: deps.sessions,
      scheduler: deps.getScheduler(),
      durable: deps.getDurable(),
      channelStore: deps.getChannelStore?.(),
      cfg,
    },
    { skipConfirm: req.skipConfirm, emit },
  );
  return { run };
}

export async function handleListAutomationRuns(
  params: unknown,
  deps: AutomationServiceDeps,
): Promise<ListAutomationRunsResult> {
  const req = params as { automationId: string; limit?: number };
  const store = deps.getStore();
  if (!store.get(req.automationId)) {
    throw new Error("automation not found");
  }
  return {
    runs: store.listRuns(req.automationId, req.limit ?? 20),
  };
}

export async function handleParseAutomationDraft(
  params: unknown,
): Promise<ParseAutomationDraftResult> {
  const req = params as { message: string; cwd?: string };
  const absCwd = req.cwd ? resolveCwd(req.cwd) : undefined;

  const heuristic = parseAutomationDraftHeuristic(req.message, absCwd);
  if (heuristic.draft?.cron) {
    return heuristic;
  }
  if (heuristic.questions?.length) {
    return heuristic;
  }

  const cfg = loadConfig({ cwd: absCwd ?? process.cwd() });
  try {
    const llm = new LlmClient(cfg.model);
    const result = await llm.chat({
      messages: [
        {
          role: "user",
          content: buildAutomationDraftParsePrompt(req.message, absCwd),
        },
      ],
      tools: [],
    });
    const parsed = parseAutomationDraftFromJson(result.text ?? "", absCwd);
    if (parsed) return parsed;
  } catch {
    /* fall through to heuristic questions */
  }

  return (
    heuristic.questions?.length
      ? heuristic
      : {
          questions: [
            "请说明运行频率（例如：每小时、每天上午 9 点、每周一），以及每次要执行的任务内容。",
          ],
        }
  );
}

export async function handleListAutomationTemplates(): Promise<ListAutomationTemplatesResult> {
  return { templates: listTemplates() };
}
