import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DiscoveredPlugin } from "@forge/plugin-registry";
import {
  parseHooksSection,
  readDisableAllHooks,
  type RawHookGroup,
} from "./schema.js";
import type { HookBinding } from "./types.js";

export interface DiscoverHooksOptions {
  cwd: string;
  dataDir: string;
  plugins: DiscoveredPlugin[];
}

interface SettingsLayer {
  path: string;
  source: HookBinding["source"];
  sourceId: string;
}

function readSettingsHooks(path: string): Record<string, RawHookGroup[]> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      disableAllHooks?: boolean;
      hooks?: Record<string, RawHookGroup[]>;
    };
    if (readDisableAllHooks(raw)) return null;
    return raw.hooks ?? null;
  } catch {
    return null;
  }
}

function settingsLayers(cwd: string, dataDir: string): SettingsLayer[] {
  const absCwd = resolve(cwd);
  return [
    {
      path: join(dataDir, "settings.json"),
      source: "user",
      sourceId: "user",
    },
    {
      path: join(homedir(), ".claude", "settings.json"),
      source: "user",
      sourceId: "claude-user",
    },
    {
      path: join(absCwd, ".forge", "settings.json"),
      source: "project",
      sourceId: absCwd,
    },
    {
      path: join(absCwd, ".claude", "settings.json"),
      source: "project",
      sourceId: `${absCwd} (.claude)`,
    },
    {
      path: join(absCwd, ".forge", "settings.local.json"),
      source: "project-local",
      sourceId: `${absCwd} (local)`,
    },
    {
      path: join(absCwd, ".claude", "settings.local.json"),
      source: "project-local",
      sourceId: `${absCwd} (.claude local)`,
    },
  ];
}

function discoverPluginHookBindings(
  plugins: DiscoveredPlugin[],
  projectDir: string,
): HookBinding[] {
  const out: HookBinding[] = [];
  for (const plugin of plugins.filter((p) => p.enabled)) {
    const hooksJson = join(plugin.root, "hooks", "hooks.json");
    if (!existsSync(hooksJson)) continue;
    try {
      const raw = JSON.parse(readFileSync(hooksJson, "utf-8")) as {
        disableAllHooks?: boolean;
        hooks?: Record<string, RawHookGroup[]>;
      };
      if (readDisableAllHooks(raw)) continue;
      out.push(
        ...parseHooksSection(
          raw.hooks,
          "plugin",
          plugin.manifest.id,
          projectDir,
          plugin.root,
        ),
      );
    } catch {
      /* invalid hooks.json ignored */
    }
  }
  return out;
}

/**
 * Merge hook bindings from user → project → project-local → plugin layers.
 * All matching hooks in a run execute in discovery order.
 */
export function discoverHooks(options: DiscoverHooksOptions): HookBinding[] {
  const projectDir = resolve(options.cwd);
  const out: HookBinding[] = [];

  for (const layer of settingsLayers(projectDir, options.dataDir)) {
    const hooks = readSettingsHooks(layer.path);
    if (!hooks) continue;
    out.push(
      ...parseHooksSection(
        hooks,
        layer.source,
        layer.sourceId,
        projectDir,
      ),
    );
  }

  out.push(...discoverPluginHookBindings(options.plugins, projectDir));
  return out;
}
