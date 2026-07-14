import type { SessionHookSource } from "./types.js";

export function matchesSessionSource(
  matcher: string | undefined,
  source: SessionHookSource,
): boolean {
  if (!matcher?.trim()) return true;
  const m = matcher.trim();
  if (!/[.*+?^${}()[\]\\]/.test(m) || m.includes("|")) {
    if (exactOrPipeMatch(m, source)) return true;
    if (m.includes("|")) return false;
  }
  try {
    return new RegExp(m, "i").test(source);
  } catch {
    return exactOrPipeMatch(m, source);
  }
}

function exactOrPipeMatch(matcher: string, value: string): boolean {
  if (matcher.includes("|")) {
    return matcher
      .split("|")
      .some((p) => p.trim().toLowerCase() === value.toLowerCase());
  }
  return matcher.trim().toLowerCase() === value.toLowerCase();
}

/** Tool-name matcher: pipe list / literal first, then regex when pattern looks like one. */
export function matchesToolName(
  matcher: string | undefined,
  toolName: string,
): boolean {
  if (!matcher?.trim()) return true;
  const m = matcher.trim();
  if (!/[.*+?^${}()[\]\\]/.test(m) || m.includes("|")) {
    if (exactOrPipeMatch(m, toolName)) return true;
    if (m.includes("|")) return false;
  }
  try {
    return new RegExp(m, "i").test(toolName);
  } catch {
    return exactOrPipeMatch(m, toolName);
  }
}
