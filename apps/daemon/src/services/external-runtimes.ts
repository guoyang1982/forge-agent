import { registerExternalRuntime } from "./external-runtime-registry.js";
import { runCodexRuntime } from "./codex-runtime.js";
import { runClaudeRuntime } from "./claude-runtime.js";
import { runCursorRuntime } from "./cursor-runtime.js";

let registered = false;

export function ensureExternalRuntimesRegistered(): void {
  if (registered) return;
  registered = true;

  registerExternalRuntime({
    id: "codex",
    label: "Codex",
    capabilities: {
      itemLifecycle: true, streamingText: true, streamingReasoning: true,
      streamingPatch: true, commandOutput: true, permissions: true, subagents: true,
    },
    run: (ctx) =>
      runCodexRuntime({
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        request: ctx.request,
        priorHistory: ctx.priorHistory,
        signal: ctx.signal,
        emit: ctx.emit,
      }),
  });

  registerExternalRuntime({
    id: "claude-code",
    label: "Claude Code",
    capabilities: {
      itemLifecycle: true, streamingText: true, streamingReasoning: true,
      streamingPatch: false, commandOutput: true, permissions: true, subagents: false,
    },
    run: (ctx) =>
      runClaudeRuntime({
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        request: ctx.request,
        priorHistory: ctx.priorHistory,
        signal: ctx.signal,
        emit: ctx.emit,
      }),
  });

  registerExternalRuntime({
    id: "cursor",
    label: "Cursor Agent",
    capabilities: {
      itemLifecycle: true, streamingText: true, streamingReasoning: true,
      streamingPatch: false, commandOutput: true, permissions: true, subagents: false,
    },
    run: (ctx) =>
      runCursorRuntime({
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        request: ctx.request,
        priorHistory: ctx.priorHistory,
        signal: ctx.signal,
        emit: ctx.emit,
      }),
  });
}
