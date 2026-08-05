import { resolve } from "node:path";
import type { DiscoveredPlugin, PluginMcpServer } from "./types.js";

export function collectPluginSkillPaths(plugins: DiscoveredPlugin[]): string[] {
  return resolveContributionPlugins(plugins)
    .flatMap((p) =>
      (p.manifest.capabilities?.skills ?? []).map((skillPath) =>
        resolve(p.root, skillPath),
      ),
    );
}

export function collectPluginMcpServers(
  plugins: DiscoveredPlugin[],
): PluginMcpServer[] {
  return resolveContributionPlugins(plugins)
    .flatMap((p) =>
      (p.manifest.capabilities?.mcpServers ?? []).map((server) => ({
        ...server,
        cwd: server.cwd ?? p.root,
      })),
    );
}

/**
 * Resolve duplicate plugin ids before loading executable contributions.
 * Forge-published built-ins are protected from an older package synced from
 * another agent installation; other plugins retain the usual last-one-wins
 * project/user override behavior.
 */
export function resolveContributionPlugins(
  plugins: DiscoveredPlugin[],
): DiscoveredPlugin[] {
  const resolved = new Map<string, DiscoveredPlugin>();
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const existing = resolved.get(plugin.manifest.id);
    const existingIsProtected =
      existing?.source === "builtin" && existing.manifest.publisher === "forge";
    const incomingIsProtected =
      plugin.source === "builtin" && plugin.manifest.publisher === "forge";
    if (!existingIsProtected || incomingIsProtected) {
      resolved.set(plugin.manifest.id, plugin);
    }
  }
  return [...resolved.values()];
}
