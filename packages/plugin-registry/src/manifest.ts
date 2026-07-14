import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest, PluginMcpServer } from "./types.js";

/** Manifest paths accepted as a plugin package (Forge + agent sidecars). */
export const PLUGIN_MANIFEST_CANDIDATES = [
  "plugin.json",
  ".cursor-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
] as const;

export function findPluginManifestPath(pluginRoot: string): string | null {
  for (const rel of PLUGIN_MANIFEST_CANDIDATES) {
    const full = join(pluginRoot, rel);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * Read a plugin manifest from a package root.
 * Prefers Forge `plugin.json`; falls back to Cursor/Claude/Codex pointer manifests
 * (name/displayName → id/name, version defaulted).
 */
export function readPluginManifest(pluginRoot: string): PluginManifest {
  const forgePath = join(pluginRoot, "plugin.json");
  if (existsSync(forgePath)) {
    const raw = JSON.parse(readFileSync(forgePath, "utf-8")) as PluginManifest;
    validatePluginManifest(raw);
    return raw;
  }

  for (const rel of PLUGIN_MANIFEST_CANDIDATES.slice(1)) {
    const full = join(pluginRoot, rel);
    if (!existsSync(full)) continue;
    const agent = JSON.parse(readFileSync(full, "utf-8")) as {
      name?: string;
      displayName?: string;
      description?: string;
      version?: string;
      skills?: string;
      mcpServers?: string;
    };
    const id = (agent.name || "").trim();
    if (!id) {
      throw new Error(`Plugin manifest ${rel} missing name`);
    }
    const manifest: PluginManifest = {
      id,
      name: (agent.displayName || agent.name || id).trim(),
      version: (agent.version || "0.0.0").trim(),
      description: agent.description,
      enabledByDefault: true,
    };
    const mcpServers = readMcpSidecar(pluginRoot, agent.mcpServers);
    if (agent.skills || mcpServers.length) {
      manifest.capabilities = {
        ...(agent.skills ? { skills: [agent.skills] } : {}),
        ...(mcpServers.length ? { mcpServers } : {}),
      };
    }
    validatePluginManifest(manifest);
    return manifest;
  }

  throw new Error(
    `该目录不是插件包：未找到 plugin.json / .cursor-plugin / .claude-plugin / .codex-plugin 清单（路径：${pluginRoot}）`,
  );
}

/** Convert the standard MCP sidecar shape into Forge's plugin capability shape. */
function readMcpSidecar(pluginRoot: string, configuredPath?: string): PluginMcpServer[] {
  const candidates = configuredPath ? [configuredPath] : [".mcp.json", "mcp.json"];
  for (const relativePath of candidates) {
    const path = join(pluginRoot, relativePath);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        mcpServers?: Record<string, unknown>;
        servers?: Record<string, unknown>;
      };
      const entries = Object.entries(parsed.mcpServers ?? parsed.servers ?? {});
      return entries.flatMap(([name, config]) => {
        if (!config || typeof config !== "object") return [];
        const raw = config as Record<string, unknown>;
        if (typeof raw.command !== "string" || !raw.command) return [];
        return [{
          name,
          command: raw.command,
          args: Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : undefined,
          env: isStringRecord(raw.env) ? raw.env : undefined,
          enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
          cwd: pluginRoot,
        }];
      });
    } catch {
      // Try the next conventional sidecar name.
    }
  }
  return [];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

export function validatePluginManifest(manifest: PluginManifest): void {
  if (!manifest.id) throw new Error("Plugin manifest missing id");
  if (!manifest.name) throw new Error(`Plugin ${manifest.id} missing name`);
  if (!manifest.version) {
    throw new Error(`Plugin ${manifest.id} missing version`);
  }
}
