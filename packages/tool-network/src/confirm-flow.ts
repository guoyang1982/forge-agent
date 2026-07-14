import type { ToolContext } from "@forge/tools";
import type { NetworkGuardResult } from "./network-guard.js";

export async function ensureNetworkAllowed(
  ctx: ToolContext,
  check: NetworkGuardResult,
): Promise<{ ok: true } | { ok: false; payload: Record<string, unknown> }> {
  if (check.ok === true) return { ok: true };
  if (check.ok === false) {
    return {
      ok: false,
      payload: { ok: false, error: check.reason },
    };
  }

  if (ctx.skipNetworkConfirm) return { ok: true };

  if (ctx.confirmNetwork) {
    const approved = await ctx.confirmNetwork({
      action: check.detail.action as "search" | "web" | "api" | "download",
      summary: check.summary,
      detail: check.detail,
    });
    if (!approved) {
      return {
        ok: false,
        payload: {
          ok: false,
          error: "Network action denied by user",
          summary: check.summary,
        },
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    payload: {
      ok: false,
      error: `Confirmation required: ${check.summary}`,
      hint:
        "Set permissions.network to allow, use forge run -y / autoApply, or provide confirmNetwork in interactive mode",
    },
  };
}
