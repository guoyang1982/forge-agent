import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelGatewayStatus } from "@forge/protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GATEWAY_ENTRY = join(
  MONOREPO_ROOT,
  "apps",
  "channel-gateway",
  "dist",
  "main.js",
);

export class ChannelGatewayHost {
  private child: ChildProcess | null = null;
  private startedAt: string | null = null;

  constructor(
    private readonly deps: {
      dataDir: string;
      pidFile: string;
      listenHost?: string;
      listenPort?: number;
    },
  ) {}

  isRunning(): boolean {
    if (this.child && !this.child.killed) return true;
    const pid = this.readPidFile();
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      this.clearPidFile();
      return false;
    }
  }

  private adoptDiscoveredGateway(status: ChannelGatewayStatus): void {
    if (!status.running) return;
    if (status.startedAt) this.startedAt = status.startedAt;
    if (status.pid) this.writePidFile(status.pid);
  }

  async start(): Promise<ChannelGatewayStatus> {
    const remote = await this.fetchStatus();
    if (remote?.running) {
      this.adoptDiscoveredGateway(remote);
      return remote;
    }
    if (this.isRunning()) {
      return (await this.fetchStatus()) ?? this.fallbackStatus(true);
    }
    if (!existsSync(GATEWAY_ENTRY)) {
      throw new Error(
        `channel-gateway not built: ${GATEWAY_ENTRY}. Run pnpm build first.`,
      );
    }

    const env = {
      ...process.env,
      FORGE_DATA_DIR: this.deps.dataDir,
      FORGE_CHANNEL_GATEWAY_HOST: this.deps.listenHost ?? "127.0.0.1",
      FORGE_CHANNEL_GATEWAY_PORT: String(this.deps.listenPort ?? 8787),
    };

    this.child = spawn(process.execPath, [GATEWAY_ENTRY], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    this.startedAt = new Date().toISOString();
    if (this.child.pid) {
      this.writePidFile(this.child.pid);
    }

    this.child.stdout?.on("data", (chunk) => {
      process.stdout.write(`[channel-gateway] ${chunk}`);
    });
    this.child.stderr?.on("data", (chunk) => {
      process.stderr.write(`[channel-gateway] ${chunk}`);
    });
    this.child.on("exit", () => {
      this.child = null;
      this.startedAt = null;
      this.clearPidFile();
    });

    await this.waitForHealth(15_000);
    return (await this.fetchStatus()) ?? this.fallbackStatus(true);
  }

  async stop(): Promise<ChannelGatewayStatus> {
    let pid = this.child?.pid ?? this.readPidFile() ?? undefined;
    if (!pid) {
      const remote = await this.fetchStatus();
      if (remote?.running && remote.pid) {
        pid = remote.pid;
      }
    }
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }
    this.child = null;
    this.startedAt = null;
    this.clearPidFile();
    return this.fallbackStatus(false);
  }

  async reload(): Promise<void> {
    const base = `http://${this.deps.listenHost ?? "127.0.0.1"}:${this.deps.listenPort ?? 8787}`;
    await fetch(`${base}/reload`, { method: "POST" }).catch(() => {});
  }

  async getStatus(): Promise<ChannelGatewayStatus> {
    const remote = await this.fetchStatus();
    if (remote) {
      if (remote.running) this.adoptDiscoveredGateway(remote);
      return remote;
    }
    if (this.isRunning()) return this.fallbackStatus(true);
    return this.fallbackStatus(false);
  }

  private async fetchStatus(): Promise<ChannelGatewayStatus | null> {
    const base = `http://${this.deps.listenHost ?? "127.0.0.1"}:${this.deps.listenPort ?? 8787}`;
    try {
      const res = await fetch(`${base}/status`);
      if (!res.ok) return null;
      return (await res.json()) as ChannelGatewayStatus;
    } catch {
      return null;
    }
  }

  private fallbackStatus(running: boolean): ChannelGatewayStatus {
    const pid = this.child?.pid ?? this.readPidFile() ?? undefined;
    return {
      running,
      pid,
      startedAt: this.startedAt ?? undefined,
      listenUrl: `http://${this.deps.listenHost ?? "127.0.0.1"}:${this.deps.listenPort ?? 8787}`,
      adapters: [],
    };
  }

  private readPidFile(): number | null {
    try {
      if (!existsSync(this.deps.pidFile)) return null;
      const n = Number(readFileSync(this.deps.pidFile, "utf8").trim());
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  private writePidFile(pid: number): void {
    try {
      writeFileSync(this.deps.pidFile, String(pid));
    } catch {
      /* ignore */
    }
  }

  private clearPidFile(): void {
    try {
      if (existsSync(this.deps.pidFile)) unlinkSync(this.deps.pidFile);
    } catch {
      /* ignore */
    }
  }

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const base = `http://${this.deps.listenHost ?? "127.0.0.1"}:${this.deps.listenPort ?? 8787}`;
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) return;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("channel-gateway health check timed out");
  }
}
