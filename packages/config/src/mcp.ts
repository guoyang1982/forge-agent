import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@forge/tool-mcp";

/**
 * Load MCP servers from ~/.forge-agent/mcp.json only.
 * Local file read/write uses built-in tools (read_file, write_patch, …) by default.
 * Opt in to MCP (e.g. filesystem, database, browser) via mcp.json when needed.
 */
export function loadMcpServers(dataDir: string, _workspaceCwd?: string): McpServerConfig[] {
  const path = join(dataDir, "mcp.json");
  if (!existsSync(path)) {
    return [];
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    servers?: McpServerConfig[];
  };
  return raw.servers ?? [];
}
