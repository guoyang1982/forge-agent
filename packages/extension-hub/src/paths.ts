import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentId, ExtensionKind, Scope } from "./types.js";

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

interface KindPaths {
  user: string;
  project: string;
}

interface AgentPathSpec {
  skills: KindPaths;
  plugins: KindPaths;
}

/**
 * Per-agent install roots (verified against local installs on 2026-07-08).
 * Cursor plugins target `plugins/local/` (sideload) — see design doc §14.
 */
export const AGENT_PATHS: Record<AgentId, AgentPathSpec> = {
  forge: {
    skills: { user: "~/.forge-agent/skills", project: ".forge/skills" },
    plugins: { user: "~/.forge-agent/plugins", project: ".forge/plugins" },
  },
  cursor: {
    skills: { user: "~/.cursor/skills", project: ".cursor/skills" },
    plugins: { user: "~/.cursor/plugins/local", project: ".cursor/plugins/local" },
  },
  "claude-code": {
    skills: { user: "~/.claude/skills", project: ".claude/skills" },
    plugins: { user: "~/.claude/plugins", project: ".claude/plugins" },
  },
  codex: {
    skills: { user: "~/.codex/skills", project: ".codex/skills" },
    plugins: { user: "~/.codex/plugins", project: ".codex/plugins" },
  },
};

/** Default hub store location under the Forge data dir. */
export function defaultHubDir(dataDir?: string): string {
  const base = dataDir ?? expandHome("~/.forge-agent");
  return join(base, "hub");
}

export function hubStoreDir(hubDir: string, kind: ExtensionKind): string {
  return join(hubDir, "store", kind === "skill" ? "skills" : "plugins");
}

export function hubStorePath(
  hubDir: string,
  kind: ExtensionKind,
  id: string,
): string {
  return join(hubStoreDir(hubDir, kind), id);
}

export function hubRegistryPath(hubDir: string): string {
  return join(hubDir, "registry.json");
}

/**
 * Resolve the absolute target directory for an extension in a given agent.
 * For project scope, `cwd` is required and relative roots are joined onto it.
 */
export function resolveAgentTargetPath(
  agent: AgentId,
  kind: ExtensionKind,
  scope: Scope,
  id: string,
  cwd?: string,
): string {
  const spec = AGENT_PATHS[agent][kind === "skill" ? "skills" : "plugins"];
  const root = scope === "user" ? spec.user : spec.project;
  // Expand `~` first so absolute-home roots aren't mistaken for relative paths
  // and wrongly joined onto cwd (which would create a literal `~/` directory).
  const expanded = expandHome(root);
  const base = isAbsolute(expanded) ? expanded : join(cwd ?? process.cwd(), expanded);
  return join(base, id);
}
