import type { AgentEvent, RunRequest, RunResult } from "@forge/protocol";
import { AcpClient, type AcpProviderConfig, type AcpUpdate } from "./acp-client.js";
import { buildAcpPromptBlocks } from "./acp-prompt.js";
import { createAcpPermissionHandler } from "./acp-permission.js";
import { acpSessionPool } from "./acp-session-pool.js";
import { emitRuntimeActivity } from "./external-runtime-events.js";

export interface AcpRuntimeOptions {
  cwd: string;
  sessionId: string;
  request: RunRequest;
  priorHistory?: string;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
  provider: AcpProviderConfig;
  providerKey: string;
  providerLabel: string;
  acpArgsKey?: string;
  /** Called after initialize; return false to skip authenticate. */
  shouldAuthenticate?: () => boolean;
  authenticateMethodId?: string;
  buildSessionParams?: (request: RunRequest, cwd: string) => {
    model?: string;
    mode?: string;
    mcpServers?: unknown[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!isRecord(content)) return null;
  return typeof content.text === "string" ? content.text : null;
}

function emitStatus(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  message: string,
): void {
  emit({ type: "status", sessionId, phase: "model", message });
}

export function mapAcpUpdate(
  update: AcpUpdate,
  emit: (event: AgentEvent) => void,
  sessionId: string,
  finalText: { value: string },
): void {
  const kind = update.sessionUpdate;
  const text = readText(update.content);

  if (kind === "agent_message_chunk" && text) {
    finalText.value += text;
    emit({ type: "text_delta", sessionId, delta: text });
    return;
  }

  if (kind === "agent_thought_chunk" && text) {
    emit({ type: "thinking_delta", sessionId, delta: text });
    return;
  }

  if (kind === "tool_call") {
    const name = update.title ?? update.kind ?? "acp_tool";
    emitRuntimeActivity(emit, sessionId, {
      runtime: "cursor",
      activityKind: "tool",
      status: "running",
      callId: update.toolCallId,
      name,
      args: isRecord(update.rawInput) ? update.rawInput : {},
    });
    return;
  }

  if (
    kind === "tool_call_update" &&
    update.toolCallId &&
    isRecord(update.rawInput) &&
    update.status &&
    update.status !== "completed" &&
    update.status !== "failed" &&
    update.status !== "cancelled" &&
    update.status !== "canceled"
  ) {
    const name = update.title ?? update.kind ?? "acp_tool";
    emitRuntimeActivity(emit, sessionId, {
      runtime: "cursor",
      activityKind: "tool",
      status: "running",
      callId: update.toolCallId,
      name,
      args: update.rawInput,
    });
    return;
  }

  if (
    kind === "tool_call_update" &&
    (update.status === "completed" ||
      update.status === "failed" ||
      update.status === "cancelled" ||
      update.status === "canceled")
  ) {
    const name = update.title ?? "acp_tool";
    emitRuntimeActivity(emit, sessionId, {
      runtime: "cursor",
      activityKind: "tool",
      status: "done",
      callId: update.toolCallId,
      name,
      result: readText(update.content) ?? "",
    });
    return;
  }

  if (kind === "tool_call_update" && update.status) {
    const title = update.title ?? update.kind ?? "tool";
    emitStatus(emit, sessionId, `ACP ${title}: ${update.status}`);
    return;
  }

  if (kind === "current_mode_update") {
    const mode = readText(update.content) ?? update.kind;
    if (mode) emitStatus(emit, sessionId, `ACP 模式: ${mode}`);
  }
}

async function bootstrapAcpClient(options: {
  provider: AcpProviderConfig;
  cwd: string;
  request: RunRequest;
  providerLabel: string;
  emit: (event: AgentEvent) => void;
  sessionId: string;
  shouldAuthenticate?: () => boolean;
  authenticateMethodId?: string;
  buildSessionParams?: AcpRuntimeOptions["buildSessionParams"];
}): Promise<{ client: AcpClient; acpSessionId: string }> {
  const client = AcpClient.spawn(options.provider, {
    cwd: options.cwd,
    env: process.env,
  });
  client.onStderr((text) => {
    emitStatus(options.emit, options.sessionId, `${options.providerLabel}: ${text}`);
  });
  await client.initialize(options.provider.clientInfo);
  if (options.shouldAuthenticate?.() !== false && options.authenticateMethodId) {
    try {
      await client.authenticate(options.authenticateMethodId);
    } catch {
      /* auth may already be satisfied */
    }
  }
  const sessionParams = options.buildSessionParams?.(options.request, options.cwd) ?? {};
  const mcpServers = sessionParams.mcpServers;
  if (Array.isArray(mcpServers) && mcpServers.length > 0) {
    emitStatus(
      options.emit,
      options.sessionId,
      `${options.providerLabel} MCP: ${mcpServers.length} server(s) in session/new`,
    );
  }
  const acpSessionId = await client.sessionNew({
    cwd: options.cwd,
    model: sessionParams.model ?? options.request.runtime?.model,
    mode: sessionParams.mode ?? options.request.runtime?.permissionMode,
    mcpServers,
  });
  const mode = sessionParams.mode ?? options.request.runtime?.permissionMode;
  if (mode) {
    try {
      await client.sessionSetMode(acpSessionId, mode);
    } catch {
      /* mode may already be set */
    }
  }
  return { client, acpSessionId };
}

async function syncWarmSessionMode(options: {
  client: AcpClient;
  acpSessionId: string;
  providerKey: string;
  forgeSessionId: string;
  mode?: string;
  previousMode?: string;
  emit: (event: AgentEvent) => void;
  sessionId: string;
  providerLabel: string;
}): Promise<void> {
  if (!options.mode || options.mode === options.previousMode) return;
  try {
    await options.client.sessionSetMode(options.acpSessionId, options.mode);
    acpSessionPool.updateWarmSessionMode(
      options.providerKey,
      options.forgeSessionId,
      options.mode,
    );
    emitStatus(
      options.emit,
      options.sessionId,
      `${options.providerLabel} 模式已切换为 ${options.mode}`,
    );
  } catch {
    emitStatus(
      options.emit,
      options.sessionId,
      `${options.providerLabel} 模式切换失败，继续使用 ${options.previousMode ?? "default"}`,
    );
  }
}

export async function runAcpRuntime(options: AcpRuntimeOptions): Promise<RunResult> {
  return acpSessionPool.withTurn(options.providerKey, options.sessionId, () =>
    runAcpTurn(options),
  );
}

export async function prewarmAcpRuntime(
  options: Omit<AcpRuntimeOptions, "sessionId" | "priorHistory" | "signal" | "emit"> & {
    emit?: (event: AgentEvent) => void;
    sessionId?: string;
  },
): Promise<{ ok: boolean; skipped?: string }> {
  const sessionParams = options.buildSessionParams?.(options.request, options.cwd) ?? {};
  const model = sessionParams.model ?? options.request.runtime?.model;
  const mode = sessionParams.mode ?? options.request.runtime?.permissionMode;
  const acpArgsKey = options.acpArgsKey ?? JSON.stringify(options.provider.acpArgs ?? []);
  const emit = options.emit ?? (() => {});
  const sessionId = options.sessionId ?? "";
  return acpSessionPool.prewarmCwd({
    providerKey: options.providerKey,
    cwd: options.cwd,
    model,
    mode,
    acpArgsKey,
    create: async () =>
      bootstrapAcpClient({
        provider: options.provider,
        cwd: options.cwd,
        request: options.request,
        providerLabel: options.providerLabel,
        emit,
        sessionId,
        shouldAuthenticate: options.shouldAuthenticate,
        authenticateMethodId: options.authenticateMethodId,
        buildSessionParams: options.buildSessionParams,
      }),
  });
}

function scheduleAcpPrewarmRefill(
  options: Pick<
    AcpRuntimeOptions,
    | "providerKey"
    | "provider"
    | "providerLabel"
    | "cwd"
    | "request"
    | "acpArgsKey"
    | "shouldAuthenticate"
    | "authenticateMethodId"
    | "buildSessionParams"
  >,
): void {
  void prewarmAcpRuntime({
    providerKey: options.providerKey,
    provider: options.provider,
    providerLabel: options.providerLabel,
    cwd: options.cwd,
    request: options.request,
    acpArgsKey: options.acpArgsKey,
    shouldAuthenticate: options.shouldAuthenticate,
    authenticateMethodId: options.authenticateMethodId,
    buildSessionParams: options.buildSessionParams,
  }).catch(() => {});
}

async function runAcpTurn(options: AcpRuntimeOptions): Promise<RunResult> {
  const finalText = { value: "" };
  const sessionParams = options.buildSessionParams?.(options.request, options.cwd) ?? {};
  const model = sessionParams.model ?? options.request.runtime?.model;
  const mode = sessionParams.mode ?? options.request.runtime?.permissionMode;
  const acpArgsKey = options.acpArgsKey ?? JSON.stringify(options.provider.acpArgs ?? []);

  let client: AcpClient;
  let acpSessionId: string;
  let reused = false;
  let adoptedPrewarm = false;
  let previousMode: string | undefined;
  let promptBlocks!: ReturnType<typeof buildAcpPromptBlocks>;

  try {
    const acquired = await acpSessionPool.acquire({
      providerKey: options.providerKey,
      forgeSessionId: options.sessionId,
      cwd: options.cwd,
      model,
      mode,
      acpArgsKey,
      create: async () => {
        emitStatus(options.emit, options.sessionId, `${options.providerLabel} ACP 初始化中…`);
        const bootstrapped = await bootstrapAcpClient({
          provider: options.provider,
          cwd: options.cwd,
          request: options.request,
          providerLabel: options.providerLabel,
          emit: options.emit,
          sessionId: options.sessionId,
          shouldAuthenticate: options.shouldAuthenticate,
          authenticateMethodId: options.authenticateMethodId,
          buildSessionParams: options.buildSessionParams,
        });
        emitStatus(options.emit, options.sessionId, `${options.providerLabel} session 已创建`);
        return bootstrapped;
      },
    });
    client = acquired.client;
    acpSessionId = acquired.acpSessionId;
    reused = acquired.reused;
    adoptedPrewarm = Boolean(acquired.adoptedPrewarm);
    previousMode = acquired.previousMode;
    promptBlocks = buildAcpPromptBlocks(options.request, {
      priorHistory: reused ? undefined : options.priorHistory,
    });
    scheduleAcpPrewarmRefill(options);
  } catch (cause) {
    await acpSessionPool.invalidate(options.providerKey, options.sessionId);
    throw cause;
  }

  const abort = () => acpSessionPool.cancelTurn(options.providerKey, options.sessionId);
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    if (reused) {
      emitStatus(
        options.emit,
        options.sessionId,
        adoptedPrewarm
          ? `${options.providerLabel} 复用预热 session`
          : `${options.providerLabel} 复用 warm session`,
      );
      await syncWarmSessionMode({
        client,
        acpSessionId,
        providerKey: options.providerKey,
        forgeSessionId: options.sessionId,
        mode,
        previousMode,
        emit: options.emit,
        sessionId: options.sessionId,
        providerLabel: options.providerLabel,
      });
    } else {
      const historyNote = options.priorHistory ? "，已注入历史" : "";
      emitStatus(
        options.emit,
        options.sessionId,
        `${options.providerLabel} 新建 cold session${historyNote}`,
      );
    }
    emitStatus(options.emit, options.sessionId, `${options.providerLabel} turn 启动中…`);
    client.setPermissionHandler(
      createAcpPermissionHandler(options.emit, options.sessionId, options.signal),
    );
    try {
      for await (const item of client.promptStream(acpSessionId, promptBlocks)) {
        if (item.kind === "update") {
          mapAcpUpdate(item.update, options.emit, options.sessionId, finalText);
        } else {
          emitStatus(
            options.emit,
            options.sessionId,
            item.stopReason
              ? `${options.providerLabel} turn 完成 (${item.stopReason})`
              : `${options.providerLabel} turn 完成`,
          );
        }
      }
    } finally {
      client.setPermissionHandler(undefined);
    }
    return { sessionId: options.sessionId, finalText: finalText.value };
  } catch (cause) {
    await acpSessionPool.invalidate(options.providerKey, options.sessionId);
    throw cause;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
