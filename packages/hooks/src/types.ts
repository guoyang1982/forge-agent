import type { SessionHookSource as ProtocolSessionHookSource } from "@forge/protocol";

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "PreCompact"
  | "SessionEnd";

export type SessionHookSource = ProtocolSessionHookSource;

export type HookConfigSource =
  | "user"
  | "project"
  | "project-local"
  | "plugin";

export type HookHandlerType = "command" | "inject-skill" | "inject-text";

export interface HookBinding {
  source: HookConfigSource;
  /** Human-readable origin: `user`, project dir, or plugin id */
  sourceId: string;
  pluginRoot?: string;
  event: HookEventName;
  matcher?: string;
  if?: string;
  type: HookHandlerType;
  command?: string;
  skillId?: string;
  text?: string;
  async?: boolean;
}

export interface HookRunContext {
  cwd: string;
  sessionId: string;
  message: string;
  source: SessionHookSource;
}

export interface PreToolUseHookContext extends HookRunContext {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface HookRunResult {
  sourceId: string;
  event: HookEventName;
  ok: boolean;
  blocked?: boolean;
  context?: string;
  error?: string;
}

export interface HookCommandOutput {
  additionalContext?: string;
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
}

export interface SessionStartHookInput {
  hook_event_name: "SessionStart";
  session_id: string;
  cwd: string;
  source: SessionHookSource;
  prompt?: string;
}

export interface UserPromptSubmitHookInput {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  cwd: string;
  prompt: string;
}

export interface PreToolUseHookInput {
  hook_event_name: "PreToolUse";
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseHookContext extends HookRunContext {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: string;
  durationMs: number;
}

export interface PostToolUseHookInput {
  hook_event_name: "PostToolUse";
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result: string;
  duration_ms: number;
}

export type StopReason = "completed" | "cancelled" | "max_steps";

export interface StopHookInput {
  hook_event_name: "Stop";
  session_id: string;
  cwd: string;
  prompt: string;
  final_text: string;
  steps_used: number;
  tools_called: string[];
  reason: StopReason;
}

export interface PreCompactHookInput {
  hook_event_name: "PreCompact";
  session_id: string;
  cwd: string;
  messages_to_summarize: number;
  keep_last: number;
}

export type SessionEndReason = "shutdown" | "deleted";

export interface SessionEndHookInput {
  hook_event_name: "SessionEnd";
  session_id: string;
  cwd: string;
  reason: SessionEndReason;
}
