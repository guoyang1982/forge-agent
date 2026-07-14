import type { ForgeConfig } from "@forge/protocol";

export interface PluginMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  /** Package directory for sidecar MCP commands with relative file arguments. */
  cwd?: string;
}

export interface PluginCommand {
  name: string;
  description: string;
}

export interface PluginCapabilities {
  skills?: string[];
  mcpServers?: PluginMcpServer[];
  commands?: PluginCommand[];
  workflows?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  enabledByDefault?: boolean;
  capabilities?: PluginCapabilities;
  settings?: {
    required?: string[];
    schema?: Record<string, unknown>;
  };
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  root: string;
  source: "builtin" | "user" | "project";
  enabled: boolean;
}

export interface PluginRegistryOptions {
  builtinDir?: string;
  userDir?: string;
  projectDir?: string;
  config?: Partial<ForgeConfig>;
}
