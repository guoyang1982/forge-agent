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
  if (isRecord(content) && typeof content.text === "string") return content.text;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (isRecord(item) && typeof item.text === "string") return item.text;
    }
  }
  return null;
}

function readString(obj: unknown, keys: string[]): string | null {
  if (!isRecord(obj)) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Normalize rawInput: parse JSON strings, ensure Record output. */
function normalizeRawInput(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch { /* not JSON */ }
  }
  return {};
}

/** Extract file path from ACP update fields + normalized args. */
function extractAcpFilePath(
  update: AcpUpdate,
  args: Record<string, unknown>,
): string | undefined {
  return (
    readString(update, ["path", "filePath"]) ??
    readString(args, [
      "path", "file_path", "filePath", "target_file", "targetFile",
      "relative_path", "relativePath", "filename", "file",
    ]) ??
    undefined
  );
}

interface AcpDiffEntry {
  path: string;
  unifiedDiff: string;
  adds: number;
  dels: number;
  kind: "add" | "update" | "delete";
}

function buildUnifiedDiffFromOldNew(path: string, oldText: string, newText: string): string {
  const cleanOld = oldText.replace(/^--\s*\/dev\/null\s*\n?/, "");
  const cleanNew = newText.replace(/^\+\+\s*b?\/\/?\S+\s*\n?/, "");
  const oldLines = cleanOld ? cleanOld.split("\n") : [];
  const newLines = cleanNew ? cleanNew.split("\n") : [];
  const isNew = !cleanOld || oldText.includes("/dev/null");
  const header = isNew
    ? `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${newLines.length} @@\n`
    : `--- a/${path}\n+++ b/${path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  const body = isNew
    ? newLines.map((line) => `+${line}`).join("\n")
    : [
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ].join("\n");
  return header + body;
}

function diffStatsFromText(diff: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) dels++;
  }
  return { adds, dels };
}

/** Extract diff entries from Cursor ACP content arrays like [{ type: "diff", path, oldText, newText }]. */
function extractAcpDiffEntries(content: unknown): AcpDiffEntry[] {
  if (!Array.isArray(content)) return [];
  const results: AcpDiffEntry[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type !== "diff") continue;
    const path = readString(item, ["path", "filePath", "file"]);
    if (!path) continue;
    const oldText = typeof item.oldText === "string" ? item.oldText : "";
    const newText = typeof item.newText === "string" ? item.newText : "";
    const unifiedDiff = buildUnifiedDiffFromOldNew(path, oldText, newText);
    const stats = diffStatsFromText(unifiedDiff);
    const isNew = !oldText || oldText.includes("/dev/null");
    const isDelete = !newText || newText.includes("/dev/null");
    results.push({
      path,
      unifiedDiff,
      adds: stats.adds,
      dels: stats.dels,
      kind: isDelete ? "delete" : isNew ? "add" : "update",
    });
  }
  return results;
}

const FILE_EDIT_TITLES = new Set([
  "edit", "editfile", "edit_file", "strreplace", "str_replace",
  "searchreplace", "search_replace", "applypatch", "apply_patch",
  "write", "writefile", "write_file", "createfile", "create_file",
  "write_patch", "writepatch",
]);

function isFileEditTitle(title: string | undefined): boolean {
  if (!title) return false;
  return FILE_EDIT_TITLES.has(title.toLowerCase().replace(/[\s_-]+/g, ""));
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
    const args = normalizeRawInput(update.rawInput);
    const filePath = extractAcpFilePath(update, args);
    if (filePath && !args.path) args.path = filePath;
    const isEdit = update.kind === "edit" || isFileEditTitle(name);
    emitRuntimeActivity(emit, sessionId, {
      runtime: "cursor",
      activityKind: isEdit ? "file" : "tool",
      status: "running",
      callId: update.toolCallId,
      label: isEdit ? "正在编辑文件…" : undefined,
      name,
      args,
      path: filePath,
    });
    return;
  }

  if (
    kind === "tool_call_update" &&
    update.toolCallId &&
    update.status &&
    update.status !== "completed" &&
    update.status !== "failed" &&
    update.status !== "cancelled" &&
    update.status !== "canceled"
  ) {
    const name = update.title ?? update.kind ?? "acp_tool";
    const args = normalizeRawInput(update.rawInput);
    const filePath = extractAcpFilePath(update, args);
    if (filePath && !args.path) args.path = filePath;
    const isEdit = update.kind === "edit" || isFileEditTitle(name);
    emitRuntimeActivity(emit, sessionId, {
      runtime: "cursor",
      activityKind: isEdit ? "file" : "tool",
      status: "running",
      callId: update.toolCallId,
      label: isEdit ? "正在编辑文件…" : undefined,
      name,
      args,
      path: filePath,
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
    const args = normalizeRawInput(update.rawInput);
    const resultText = readText(update.content) ?? "";
    const diffEntries = extractAcpDiffEntries(update.content);

    if (diffEntries.length > 0) {
      const first = diffEntries[0];
      const filePath = first.path;
      const changes = diffEntries.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        unifiedDiff: entry.unifiedDiff,
        adds: entry.adds,
        dels: entry.dels,
      }));
      const totalAdds = diffEntries.reduce((sum, e) => sum + e.adds, 0);
      const totalDels = diffEntries.reduce((sum, e) => sum + e.dels, 0);
      emitRuntimeActivity(emit, sessionId, {
        runtime: "cursor",
        activityKind: "file",
        status: "done",
        callId: update.toolCallId,
        label: diffEntries.length > 1
          ? `已编辑 ${diffEntries.length} 个文件`
          : `已编辑 ${filePath.split("/").pop() ?? filePath}`,
        name,
        args: Object.keys(args).length > 0 ? args : undefined,
        result: resultText,
        path: filePath,
        adds: totalAdds,
        dels: totalDels,
        patch: { path: filePath, unifiedDiff: first.unifiedDiff },
        changes,
      });
      return;
    }

    const filePath = extractAcpFilePath(update, args);
    const diff = readString(update, ["diff", "unifiedDiff"]) ?? undefined;
    const isEdit = isFileEditTitle(name) || isFileEditTitle(update.kind);
    emitRuntimeActivity(emit, sessionId, {
      runtime: "cursor",
      activityKind: "tool",
      status: "done",
      callId: update.toolCallId,
      name,
      args: Object.keys(args).length > 0 ? args : undefined,
      result: resultText,
      path: filePath,
      ...(diff && filePath ? { patch: { path: filePath, unifiedDiff: diff } } : {}),
      ...(isEdit && filePath ? { changes: [{ path: filePath, kind: "update" as const, adds: 0, dels: 0 }] } : {}),
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
