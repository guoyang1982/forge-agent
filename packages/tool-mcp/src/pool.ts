import { createHash } from "node:crypto";
import type { McpServerConfig } from "./client.js";
import { McpClient } from "./client.js";
import { loadMcpFromConfig } from "./loader.js";

const DEFAULT_IDLE_MS = 5 * 60 * 1000;

interface PoolEntry {
  clients: McpClient[];
  refCount: number;
  lastReleasedAt: number;
}

export function mcpPoolCacheKey(
  cwd: string,
  servers: McpServerConfig[],
): string {
  const normalized = servers
    .filter((s) => s.enabled !== false)
    .map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      cwd: s.cwd,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256")
    .update(JSON.stringify({ cwd, servers: normalized }))
    .digest("hex");
}

export class McpClientPool {
  private entries = new Map<string, PoolEntry>();

  constructor(private idleMs = DEFAULT_IDLE_MS) {}

  async acquire(
    cwd: string,
    servers: McpServerConfig[],
  ): Promise<{ clients: McpClient[]; release: () => void }> {
    this.sweepIdle();
    const key = mcpPoolCacheKey(cwd, servers);
    let entry = this.entries.get(key);

    if (entry && !entry.clients.every((c) => c.isRunning())) {
      for (const c of entry.clients) c.stop();
      this.entries.delete(key);
      entry = undefined;
    }

    if (!entry) {
      const clients = await loadMcpFromConfig(servers);
      entry = { clients, refCount: 0, lastReleasedAt: 0 };
      this.entries.set(key, entry);
      if (clients.length) {
        console.log(
          `[forge] MCP pool started ${clients.length} server(s) for ${cwd}`,
        );
      }
    }

    entry.refCount++;
    entry.lastReleasedAt = 0;

    return {
      clients: entry.clients,
      release: () => {
        const current = this.entries.get(key);
        if (!current) return;
        current.refCount = Math.max(0, current.refCount - 1);
        if (current.refCount === 0) {
          current.lastReleasedAt = Date.now();
        }
        this.sweepIdle();
      },
    };
  }

  sweepIdle(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (
        entry.refCount === 0 &&
        entry.lastReleasedAt > 0 &&
        now - entry.lastReleasedAt >= this.idleMs
      ) {
        for (const c of entry.clients) c.stop();
        this.entries.delete(key);
        console.log(`[forge] MCP pool evicted idle entry ${key.slice(0, 8)}…`);
      }
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      for (const c of entry.clients) c.stop();
    }
    this.entries.clear();
  }
}

let defaultPool: McpClientPool | null = null;

export function getMcpClientPool(): McpClientPool {
  if (!defaultPool) defaultPool = new McpClientPool();
  return defaultPool;
}

export function clearMcpClientPool(): void {
  defaultPool?.clear();
  defaultPool = null;
}
