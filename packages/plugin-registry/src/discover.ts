import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findPluginManifestPath, readPluginManifest } from "./manifest.js";
import type { DiscoveredPlugin, PluginRegistryOptions } from "./types.js";

export function discoverPlugins(
  options: PluginRegistryOptions,
): DiscoveredPlugin[] {
  return [
    ...discoverDir(options.builtinDir, "builtin"),
    ...discoverDir(options.userDir, "user"),
    ...discoverDir(options.projectDir, "project"),
  ].map((plugin) => {
    const override = options.config?.plugins?.enabled?.[plugin.manifest.id];
    return {
      ...plugin,
      enabled: override ?? plugin.enabled,
    };
  });
}

function discoverDir(
  root: string | undefined,
  source: DiscoveredPlugin["source"],
): DiscoveredPlugin[] {
  if (!root || !existsSync(root)) return [];
  const out: DiscoveredPlugin[] = [];

  for (const name of readdirSync(root)) {
    const pluginRoot = join(root, name);
    if (!findPluginManifestPath(pluginRoot)) continue;
    try {
      const manifest = readPluginManifest(pluginRoot);
      out.push({
        manifest,
        root: pluginRoot,
        source,
        enabled: Boolean(manifest.enabledByDefault),
      });
    } catch {
      /* invalid plugin manifests are ignored until plugin management UI exists */
    }
  }

  return out;
}
