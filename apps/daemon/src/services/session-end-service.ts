import type { SessionStore } from "@forge/session";
import { hookSessionState, runSessionEndHooks } from "@forge/hooks";
import { resolveProjectHooks, type ForgeRuntime } from "../runtime.js";

export async function runSessionEndHooksOnShutdown(options: {
  sessions: SessionStore;
  getRuntime: () => Promise<ForgeRuntime>;
}): Promise<void> {
  const sessionIds = hookSessionState.getTouchedSessionIds();
  if (!sessionIds.length) return;

  const runtime = await options.getRuntime();
  for (const sessionId of sessionIds) {
    const cwd = options.sessions.getSessionCwd(sessionId);
    if (!cwd) continue;
    try {
      const { bindings, skills } = await resolveProjectHooks(cwd, runtime);
      if (!bindings.some((b) => b.event === "SessionEnd")) continue;
      await runSessionEndHooks({
        bindings,
        ctx: { sessionId, cwd },
        skills,
        reason: "shutdown",
      });
    } catch (e) {
      console.warn(
        `[forge:hook] SessionEnd failed for ${sessionId}: ${String(e)}`,
      );
    }
  }
}
