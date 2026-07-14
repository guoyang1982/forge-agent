import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadMcpServers } from "@forge/config";
import {
  collectPluginMcpServers,
  discoverPlugins,
} from "@forge/plugin-registry";
import type { McpServerConfig } from "@forge/tool-mcp";
import {
  defaultBuiltinPluginsDir,
  defaultProjectPluginsDir,
  defaultUserPluginsDir,
} from "../runtime.js";

const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function listEnabledForgeMcpServers(cwd: string): McpServerConfig[] {
  const cfg = loadConfig({ cwd });
  const dataDir = cfg.daemon.dataDir;
  const servers: McpServerConfig[] = [];
  const names = new Set<string>();

  for (const server of cfg.mcp?.servers ?? []) {
    if (server.enabled === false) continue;
    servers.push(server);
    names.add(server.name);
  }

  for (const server of loadMcpServers(dataDir, cwd)) {
    if (names.has(server.name) || server.enabled === false) continue;
    servers.push(server);
    names.add(server.name);
  }

  const plugins = discoverPlugins({
    builtinDir: defaultBuiltinPluginsDir(MONOREPO_ROOT),
    userDir: defaultUserPluginsDir(dataDir),
    projectDir: defaultProjectPluginsDir(cwd),
    config: cfg,
  });

  for (const server of collectPluginMcpServers(plugins)) {
    if (names.has(server.name)) continue;
    servers.push(server);
    names.add(server.name);
  }

  return servers;
}

export function toAcpMcpServer(server: McpServerConfig): Record<string, unknown> {
  const command =
    server.cwd &&
    !isAbsolute(server.command) &&
    (server.command.startsWith(".") || server.command.includes("/") || server.command.includes("\\"))
      ? resolve(server.cwd, server.command)
      : server.command;
  return {
    type: "stdio",
    name: server.name,
    command,
    args: server.args ?? [],
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
  };
}

export function loadForgeAcpMcpServers(cwd: string): unknown[] {
  return listEnabledForgeMcpServers(cwd).map(toAcpMcpServer);
}
