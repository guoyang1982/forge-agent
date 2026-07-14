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
