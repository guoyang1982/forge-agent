import { resolve } from "node:path";
import type { DiscoveredPlugin, PluginMcpServer } from "./types.js";

export function collectPluginSkillPaths(plugins: DiscoveredPlugin[]): string[] {
  return plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      (p.manifest.capabilities?.skills ?? []).map((skillPath) =>
        resolve(p.root, skillPath),
      ),
    );
}

export function collectPluginMcpServers(
  plugins: DiscoveredPlugin[],
): PluginMcpServer[] {
  return plugins
    .filter((p) => p.enabled)
    .flatMap((p) => p.manifest.capabilities?.mcpServers ?? []);
}
