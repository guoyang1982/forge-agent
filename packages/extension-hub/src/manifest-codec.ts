import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginManifest } from "@forge/plugin-registry";
import { emptyCapabilities, type ExtensionCapabilities } from "./types.js";

/**
 * Directory-pointer manifest shape shared by Cursor / Claude / Codex
 * (`.{agent}-plugin/plugin.json`). Fields point at folders relative to the
 * package root; omitted fields fall back to folder auto-discovery.
 */
export interface AgentPluginManifest {
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  skills?: string;
  agents?: string;
  commands?: string;
  hooks?: string;
  mcpServers?: string;
}

export interface ManifestVariant {
  /** Relative path inside the package, e.g. `.cursor-plugin/plugin.json`. */
  path: string;
  manifest: AgentPluginManifest;
}

function baseAgentManifest(forge: PluginManifest): AgentPluginManifest {
  const m: AgentPluginManifest = { name: forge.id };
  if (forge.name) m.displayName = forge.name;
  if (forge.description) m.description = forge.description;
  if (forge.version) m.version = forge.version;

  const caps = forge.capabilities;
  if (caps?.skills?.length) m.skills = "./skills/";
  if (caps?.commands?.length) m.commands = "./commands/";
  if (caps?.mcpServers?.length) m.mcpServers = "./.mcp.json";
  return m;
}

/** Forge manifest -> Cursor `.cursor-plugin/plugin.json`. */
export function toCursorManifest(forge: PluginManifest): ManifestVariant {
  const manifest = baseAgentManifest(forge);
  if (forge.capabilities?.skills?.length) {
    manifest.hooks = "./hooks/hooks-cursor.json";
  }
  return { path: ".cursor-plugin/plugin.json", manifest };
}

/** Forge manifest -> Claude `.claude-plugin/plugin.json`. */
export function toClaudeManifest(forge: PluginManifest): ManifestVariant {
  return { path: ".claude-plugin/plugin.json", manifest: baseAgentManifest(forge) };
}

/** Forge manifest -> Codex `.codex-plugin/plugin.json`. */
export function toCodexManifest(forge: PluginManifest): ManifestVariant {
  return { path: ".codex-plugin/plugin.json", manifest: baseAgentManifest(forge) };
}

/** Relative manifest path used by each agent, for registry bookkeeping. */
export const AGENT_MANIFEST_PATH = {
  forge: "plugin.json",
  cursor: ".cursor-plugin/plugin.json",
  "claude-code": ".claude-plugin/plugin.json",
  codex: ".codex-plugin/plugin.json",
} as const;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Parse capabilities from a store package directory.
 *
 * Prefers a Forge `plugin.json` (`capabilities` block). Falls back to a bare
 * skill package (a top-level `SKILL.md` or `skills/` folder) so pure skills
 * report `skills` capability without a plugin manifest.
 */
export async function parseCapabilitiesFromDir(
  dir: string,
): Promise<ExtensionCapabilities> {
  const caps = emptyCapabilities();

  const forge = await readJson<PluginManifest>(join(dir, "plugin.json"));
  if (forge?.capabilities) {
    const c = forge.capabilities;
    if (c.skills?.length) caps.skills = [...c.skills];
    if (c.mcpServers?.length) caps.mcpServers = c.mcpServers.map((s) => s.name);
    if (c.commands?.length) caps.commands = c.commands.map((s) => s.name);
    if (c.workflows?.length) caps.commands.push(...c.workflows);
    return caps;
  }

  // Pure skill package: a directory-pointer plugin manifest or a SKILL.md.
  const agentManifest =
    (await readJson<AgentPluginManifest>(join(dir, ".cursor-plugin/plugin.json"))) ??
    (await readJson<AgentPluginManifest>(join(dir, ".claude-plugin/plugin.json"))) ??
    (await readJson<AgentPluginManifest>(join(dir, ".codex-plugin/plugin.json")));
  if (agentManifest?.skills) caps.skills = [agentManifest.skills];
  const mcp =
    (await readJson<{ mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> }>(join(dir, ".mcp.json"))) ??
    (await readJson<{ mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> }>(join(dir, "mcp.json")));
  if (mcp) caps.mcpServers = Object.keys(mcp.mcpServers ?? mcp.servers ?? {});
  return caps;
}
