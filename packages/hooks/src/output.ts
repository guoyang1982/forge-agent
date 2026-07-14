import type { HookCommandOutput } from "./types.js";

/** Extract injected context from hook stdout JSON (Claude / Cursor / Copilot shapes). */
export function extractAdditionalContext(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  if (typeof o.additional_context === "string" && o.additional_context.trim()) {
    return o.additional_context.trim();
  }
  if (typeof o.additionalContext === "string" && o.additionalContext.trim()) {
    return o.additionalContext.trim();
  }
  const nested = o.hookSpecificOutput;
  if (nested && typeof nested === "object") {
    const ctx = (nested as Record<string, unknown>).additionalContext;
    if (typeof ctx === "string" && ctx.trim()) return ctx.trim();
  }
  return null;
}

export function parseHookCommandOutput(stdout: string): HookCommandOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return {};
  try {
    const payload = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as Record<
      string,
      unknown
    >;
    const nested =
      payload.hookSpecificOutput && typeof payload.hookSpecificOutput === "object"
        ? (payload.hookSpecificOutput as Record<string, unknown>)
        : payload;
    const additionalContext = extractAdditionalContext(payload) ?? undefined;
    const decision = nested.permissionDecision;
    const permissionDecision =
      decision === "allow" || decision === "deny" || decision === "ask"
        ? decision
        : undefined;
    const reason = nested.permissionDecisionReason;
    return {
      additionalContext,
      permissionDecision,
      permissionDecisionReason:
        typeof reason === "string" ? reason : undefined,
    };
  } catch {
    return {};
  }
}
