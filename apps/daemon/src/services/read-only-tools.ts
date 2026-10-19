import type { RunRequest } from "@forge/protocol";

/**
 * Tools a read-only Forge run may call: workspace reads plus read-only
 * network lookups. Everything else (writes, commands, installs, browser
 * interaction, arbitrary API requests, downloads, MCP) is denied by default.
 */
export const READ_ONLY_RUN_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "grep",
  "update_plan",
  "echo",
  "web_fetch",
  "web_search",
  "spawn_agent",
]);

export function isReadOnlyRun(request: Pick<RunRequest, "runtime">): boolean {
  return request.runtime?.sandboxMode === "read-only";
}

export function composeReadOnlyToolGate(
  request: Pick<RunRequest, "runtime">,
  inner?: (name: string) => boolean,
): ((name: string) => boolean) | undefined {
  if (!isReadOnlyRun(request)) return inner;
  return (name) => READ_ONLY_RUN_TOOLS.has(name) && (inner ? inner(name) : true);
}
