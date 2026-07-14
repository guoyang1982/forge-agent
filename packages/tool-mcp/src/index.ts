import type { ToolDefinition } from "@forge/protocol";
import type { ToolRegistry } from "@forge/tools";
import { McpClient, type McpServerConfig } from "./client.js";
import { loadMcpFromConfig } from "./loader.js";

export type { McpServerConfig } from "./client.js";
export { McpClient } from "./client.js";
export { loadMcpFromConfig } from "./loader.js";
export {
  registryHasMcpFilesystemWrites,
} from "./filesystem.js";
export {
  McpClientPool,
  getMcpClientPool,
  clearMcpClientPool,
  mcpPoolCacheKey,
} from "./pool.js";

export async function attachMcpTools(
  registry: ToolRegistry,
  clients: McpClient[],
): Promise<number> {
  let count = 0;
  for (const client of clients) {
    const tools = await client.listTools();
    for (const t of tools) {
      const localName = `${client.prefix}${t.name}`.replace(
        /[^a-zA-Z0-9_]/g,
        "_",
      );
      const def: ToolDefinition = {
        name: localName,
        description: `[MCP:${client.config.name}] ${t.description ?? t.name}`,
        parameters: (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      };
      registry.register(def, async (args) => client.callTool(t.name, args));
      count++;
    }
  }
  return count;
}
