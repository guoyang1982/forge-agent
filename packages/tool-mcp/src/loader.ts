import { McpClient, type McpServerConfig } from "./client.js";

export async function loadMcpFromConfig(
  servers: McpServerConfig[] | undefined,
): Promise<McpClient[]> {
  const clients: McpClient[] = [];
  for (const s of servers ?? []) {
    if (s.enabled === false) continue;
    try {
      const c = new McpClient(s);
      await c.start();
      clients.push(c);
    } catch (e) {
      console.error(`[forge] MCP ${s.name} failed to start:`, e);
    }
  }
  return clients;
}
