import type { ToolContext } from "@forge/tools";
import type { SoftwareGuardResult } from "./software-guard.js";

export async function ensureSoftwareAllowed(
  ctx: ToolContext,
  check: SoftwareGuardResult,
): Promise<{ ok: true } | { ok: false; payload: Record<string, unknown> }> {
  if (check.ok === true) return { ok: true };
  if (check.ok === false) {
    return {
      ok: false,
      payload: { ok: false, error: check.reason },
    };
  }

  if (ctx.skipSoftwareConfirm) return { ok: true };

  if (ctx.confirmSoftware) {
    const approved = await ctx.confirmSoftware({
      action: check.detail.action as "install" | "uninstall",
      summary: check.summary,
      detail: check.detail,
    });
    if (!approved) {
      return {
        ok: false,
        payload: {
          ok: false,
          error: "Software action denied by user",
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
        "Enable permissions.software, use forge run -y / autoApply, or provide confirmSoftware in interactive mode",
    },
  };
}
