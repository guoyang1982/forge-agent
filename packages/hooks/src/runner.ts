import { spawn } from "node:child_process";
import {
  findSkillById,
  formatActiveSkillBlock,
  listSkillBundledFiles,
  type SkillDoc,
} from "@forge/skill-registry";
import type { ToolCall } from "@forge/protocol";
import type { ToolRegistry } from "@forge/tools";
import { matchesSessionSource, matchesToolName } from "./matcher.js";
import { parseHookCommandOutput } from "./output.js";
import type {
  HookBinding,
  HookRunContext,
  HookRunResult,
  PostToolUseHookContext,
  PostToolUseHookInput,
  PreToolUseHookContext,
  PreToolUseHookInput,
  SessionStartHookInput,
  PreCompactHookInput,
  SessionEndHookInput,
  SessionEndReason,
  StopHookInput,
  StopReason,
  UserPromptSubmitHookInput,
} from "./types.js";

const HOOK_TIMEOUT_MS = 30_000;
const DEFAULT_POST_TOOL_RESULT_MAX = 8_000;

type HookInputPayload =
  | SessionStartHookInput
  | UserPromptSubmitHookInput
  | PreToolUseHookInput
  | PostToolUseHookInput
  | StopHookInput
  | PreCompactHookInput
  | SessionEndHookInput;

function truncateToolResult(result: string, max: number): string {
  if (result.length <= max) return result;
  return result.slice(0, max) + "\n...[truncated]";
}

function appendHookContextToToolResult(
  result: string,
  hookContext: string,
): string {
  const trimmed = hookContext.trim();
  if (!trimmed) return result;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, hookContext: trimmed });
    }
  } catch {
    /* fall through */
  }
  return `${result}\n\n[hook context]\n${trimmed}`;
}

function hookEnv(binding: HookBinding, ctx: HookRunContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORGE_PROJECT_DIR: ctx.cwd,
    CLAUDE_PROJECT_DIR: ctx.cwd,
    FORGE_SESSION_ID: ctx.sessionId,
    FORGE_CWD: ctx.cwd,
    FORGE_HOOK_SOURCE: ctx.source,
    ...(binding.pluginRoot
      ? {
          FORGE_PLUGIN_ROOT: binding.pluginRoot,
          CLAUDE_PLUGIN_ROOT: binding.pluginRoot,
          PLUGIN_ROOT: binding.pluginRoot,
        }
      : {}),
  };
}

async function runCommandHook(
  binding: HookBinding,
  input: HookInputPayload,
  ctx: HookRunContext,
  signal?: AbortSignal,
): Promise<{ output: ReturnType<typeof parseHookCommandOutput>; exitCode: number | null }> {
  const cmd = binding.command?.trim();
  if (!cmd) return { output: {}, exitCode: 0 };
  if (signal?.aborted) return { output: {}, exitCode: null };

  if (binding.async) {
    const child = spawn(cmd, {
      shell: true,
      cwd: ctx.cwd,
      env: hookEnv(binding, ctx),
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.unref();
    return { output: {}, exitCode: 0 };
  }

  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      cwd: ctx.cwd,
      env: hookEnv(binding, ctx),
      timeout: HOOK_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: {
      output: ReturnType<typeof parseHookCommandOutput>;
      exitCode: number | null;
    }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      child.kill();
      finish({ output: {}, exitCode: null });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.on("error", () => finish({ output: {}, exitCode: 1 }));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 && code !== 2) {
        console.warn(
          `[forge:hook] ${binding.sourceId} command exit ${code}: ${stderr.slice(0, 200)}`,
        );
      }
      finish({
        output: code === 0 || code === 2 ? parseHookCommandOutput(stdout) : {},
        exitCode: code,
      });
    });
  });
}

async function runInjectSkillHook(
  binding: HookBinding,
  skills: SkillDoc[],
): Promise<string | null> {
  const id = binding.skillId?.trim();
  if (!id) return null;
  const skill = findSkillById(skills, id);
  if (!skill) {
    console.warn(
      `[forge:hook] ${binding.sourceId} inject-skill: skill not found: ${id}`,
    );
    return null;
  }
  const bundled = await listSkillBundledFiles(skill);
  return formatActiveSkillBlock(skill, bundled);
}

function runInjectTextHook(binding: HookBinding): string | null {
  const text = binding.text?.trim();
  return text || null;
}

async function runBinding(
  binding: HookBinding,
  input: HookInputPayload,
  ctx: HookRunContext,
  skills: SkillDoc[],
  signal?: AbortSignal,
): Promise<{
  context?: string;
  blocked?: boolean;
  blockReason?: string;
  ok: boolean;
  error?: string;
}> {
  try {
    if (binding.type === "command") {
      const { output, exitCode } = await runCommandHook(binding, input, ctx, signal);
      if (exitCode === 2) {
        return {
          ok: true,
          blocked: true,
          blockReason:
            output.permissionDecisionReason ??
            "Hook returned exit code 2",
        };
      }
      if (output.permissionDecision === "deny") {
        return {
          ok: true,
          blocked: true,
          blockReason: output.permissionDecisionReason ?? "Hook denied",
        };
      }
      return {
        ok: true,
        context: output.additionalContext,
      };
    }
    if (binding.type === "inject-skill") {
      return { ok: true, context: (await runInjectSkillHook(binding, skills)) ?? undefined };
    }
    if (binding.type === "inject-text") {
      return { ok: true, context: runInjectTextHook(binding) ?? undefined };
    }
    return { ok: false, error: `Unknown hook type: ${binding.type}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function collectResults(
  bindings: HookBinding[],
  event: HookBinding["event"],
  ctx: HookRunContext,
  skills: SkillDoc[],
  input: HookInputPayload,
  filter?: (binding: HookBinding) => boolean,
  signal?: AbortSignal,
): Promise<{
  context: string;
  results: HookRunResult[];
  blocked: boolean;
  blockReason?: string;
}> {
  const matched = bindings.filter(
    (b) => b.event === event && (filter ? filter(b) : true),
  );
  return runBindings(matched, input, ctx, skills, signal);
}

async function runBindings(
  bindings: HookBinding[],
  input: HookInputPayload,
  ctx: HookRunContext,
  skills: SkillDoc[],
  signal?: AbortSignal,
): Promise<{
  context: string;
  results: HookRunResult[];
  blocked: boolean;
  blockReason?: string;
}> {
  const results: HookRunResult[] = [];
  const chunks: string[] = [];
  let blocked = false;
  let blockReason: string | undefined;

  for (const binding of bindings) {
    if (signal?.aborted) break;
    const r = await runBinding(binding, input, ctx, skills, signal);
    if (r.context) chunks.push(r.context);
    if (r.blocked) {
      blocked = true;
      blockReason = r.blockReason ?? blockReason;
    }
    results.push({
      sourceId: binding.sourceId,
      event: binding.event,
      ok: r.ok,
      blocked: r.blocked,
      context: r.context,
      error: r.error,
    });
    if (r.error) {
      console.warn(`[forge:hook] ${binding.sourceId} failed: ${r.error}`);
    }
  }

  return {
    context: chunks.filter(Boolean).join("\n\n"),
    results,
    blocked,
    blockReason,
  };
}

export async function runSessionStartHooks(options: {
  bindings: HookBinding[];
  ctx: HookRunContext;
  skills: SkillDoc[];
}): Promise<{ context: string; results: HookRunResult[] }> {
  const input: SessionStartHookInput = {
    hook_event_name: "SessionStart",
    session_id: options.ctx.sessionId,
    cwd: options.ctx.cwd,
    source: options.ctx.source,
    prompt: options.ctx.message,
  };
  const { context, results } = await collectResults(
    options.bindings,
    "SessionStart",
    options.ctx,
    options.skills,
    input,
    (b) => matchesSessionSource(b.matcher, options.ctx.source),
  );
  return { context, results };
}

export async function runUserPromptSubmitHooks(options: {
  bindings: HookBinding[];
  ctx: HookRunContext;
  skills: SkillDoc[];
}): Promise<{
  context: string;
  results: HookRunResult[];
  blocked: boolean;
  blockReason?: string;
}> {
  const input: UserPromptSubmitHookInput = {
    hook_event_name: "UserPromptSubmit",
    session_id: options.ctx.sessionId,
    cwd: options.ctx.cwd,
    prompt: options.ctx.message,
  };
  return collectResults(
    options.bindings,
    "UserPromptSubmit",
    options.ctx,
    options.skills,
    input,
  );
}

export async function runPreToolUseHooks(options: {
  bindings: HookBinding[];
  ctx: PreToolUseHookContext;
  skills: SkillDoc[];
}): Promise<{
  context: string;
  results: HookRunResult[];
  blocked: boolean;
  blockReason?: string;
}> {
  const input: PreToolUseHookInput = {
    hook_event_name: "PreToolUse",
    session_id: options.ctx.sessionId,
    cwd: options.ctx.cwd,
    tool_name: options.ctx.toolName,
    tool_input: options.ctx.toolInput,
  };
  return collectResults(
    options.bindings,
    "PreToolUse",
    options.ctx,
    options.skills,
    input,
    (b) => matchesToolName(b.matcher, options.ctx.toolName),
  );
}

export async function runPostToolUseHooks(options: {
  bindings: HookBinding[];
  ctx: PostToolUseHookContext;
  skills: SkillDoc[];
  toolResultMaxChars?: number;
}): Promise<{
  context: string;
  results: HookRunResult[];
  warned: boolean;
  warnReason?: string;
}> {
  const max = options.toolResultMaxChars ?? DEFAULT_POST_TOOL_RESULT_MAX;
  const input: PostToolUseHookInput = {
    hook_event_name: "PostToolUse",
    session_id: options.ctx.sessionId,
    cwd: options.ctx.cwd,
    tool_name: options.ctx.toolName,
    tool_input: options.ctx.toolInput,
    tool_result: truncateToolResult(options.ctx.toolResult, max),
    duration_ms: options.ctx.durationMs,
  };
  const out = await collectResults(
    options.bindings,
    "PostToolUse",
    options.ctx,
    options.skills,
    input,
    (b) => matchesToolName(b.matcher, options.ctx.toolName),
  );
  return {
    context: out.context,
    results: out.results,
    warned: out.blocked,
    warnReason: out.blockReason,
  };
}

export async function runStopHooks(options: {
  bindings: HookBinding[];
  ctx: HookRunContext;
  skills: SkillDoc[];
  finalText: string;
  stepsUsed: number;
  toolsCalled: string[];
  reason: StopReason;
  signal?: AbortSignal;
}): Promise<{
  results: HookRunResult[];
  blocked: boolean;
  blockReason?: string;
}> {
  const input: StopHookInput = {
    hook_event_name: "Stop",
    session_id: options.ctx.sessionId,
    cwd: options.ctx.cwd,
    prompt: options.ctx.message,
    final_text: options.finalText,
    steps_used: options.stepsUsed,
    tools_called: [...new Set(options.toolsCalled)],
    reason: options.reason,
  };
  const out = await collectResults(
    options.bindings,
    "Stop",
    options.ctx,
    options.skills,
    input,
    undefined,
    options.signal,
  );
  if (out.context) {
    const sources = out.results
      .filter((r) => r.context)
      .map((r) => r.sourceId)
      .join(", ");
    console.log(`[forge:hook] Stop context from ${sources}`);
  }
  return {
    results: out.results,
    blocked: out.blocked,
    blockReason: out.blockReason,
  };
}

/** Run PreToolUse + PostToolUse hooks around each tool invocation. */
export function attachToolHooks(
  registry: ToolRegistry,
  options: {
    bindings: HookBinding[];
    ctx: Omit<PreToolUseHookContext, "toolName" | "toolInput" | "toolResult" | "durationMs">;
    skills: SkillDoc[];
    toolResultMaxChars?: number;
  },
): void {
  const original = registry.execute.bind(registry);
  registry.execute = async (call: ToolCall, toolCtx) => {
    const toolCtxBase = {
      ...options.ctx,
      toolName: call.name,
      toolInput: call.arguments,
    };
    const pre = await runPreToolUseHooks({
      bindings: options.bindings,
      ctx: toolCtxBase,
      skills: options.skills,
    });
    if (pre.blocked) {
      return JSON.stringify({
        ok: false,
        error: pre.blockReason ?? "PreToolUse hook blocked this tool call",
        hookContext: pre.context || undefined,
      });
    }
    const started = Date.now();
    let result = await original(call, toolCtx);
    if (pre.context) {
      result = appendHookContextToToolResult(result, pre.context);
    }
    const post = await runPostToolUseHooks({
      bindings: options.bindings,
      ctx: {
        ...toolCtxBase,
        toolResult: result,
        durationMs: Date.now() - started,
      },
      skills: options.skills,
      toolResultMaxChars: options.toolResultMaxChars,
    });
    if (post.warned) {
      console.warn(
        `[forge:hook] PostToolUse: ${post.warnReason ?? "hook returned deny"} (tool already executed)`,
      );
    }
    if (post.context) {
      result = appendHookContextToToolResult(result, post.context);
    }
    return result;
  };
}

export async function runPreCompactHooks(options: {
  bindings: HookBinding[];
  ctx: HookRunContext;
  skills: SkillDoc[];
  messagesToSummarize: number;
  keepLast: number;
}): Promise<{
  results: HookRunResult[];
  blocked: boolean;
  blockReason?: string;
}> {
  const input: PreCompactHookInput = {
    hook_event_name: "PreCompact",
    session_id: options.ctx.sessionId,
    cwd: options.ctx.cwd,
    messages_to_summarize: options.messagesToSummarize,
    keep_last: options.keepLast,
  };
  const out = await collectResults(
    options.bindings,
    "PreCompact",
    options.ctx,
    options.skills,
    input,
  );
  return {
    results: out.results,
    blocked: out.blocked,
    blockReason: out.blockReason,
  };
}

export async function runSessionEndHooks(options: {
  bindings: HookBinding[];
  ctx: Omit<HookRunContext, "message" | "source"> & {
    message?: string;
    source?: HookRunContext["source"];
  };
  skills: SkillDoc[];
  reason: SessionEndReason;
}): Promise<{ results: HookRunResult[] }> {
  const ctx: HookRunContext = {
    cwd: options.ctx.cwd,
    sessionId: options.ctx.sessionId,
    message: options.ctx.message ?? "",
    source: options.ctx.source ?? "startup",
  };
  const input: SessionEndHookInput = {
    hook_event_name: "SessionEnd",
    session_id: ctx.sessionId,
    cwd: ctx.cwd,
    reason: options.reason,
  };
  const out = await collectResults(
    options.bindings,
    "SessionEnd",
    ctx,
    options.skills,
    input,
  );
  return { results: out.results };
}

/** @deprecated Use attachToolHooks */
export const attachPreToolUseHooks = attachToolHooks;
