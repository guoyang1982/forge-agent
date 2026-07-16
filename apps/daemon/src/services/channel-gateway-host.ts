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
  private desiredRunning = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private crashTimes: number[] = [];

  constructor(
    private readonly deps: {
      dataDir: string;
      pidFile: string;
      listenHost?: string;
      listenPort?: number;
      gatewayEntry?: string;
      healthTimeoutMs?: number;
      restartBaseDelayMs?: number;
      restartMaxDelayMs?: number;
      restartWindowMs?: number;
      maxRestarts?: number;
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
    if (!this.desiredRunning) this.crashTimes = [];
    this.desiredRunning = true;
    const remote = await this.fetchStatus();
    if (remote?.running) {
      this.adoptDiscoveredGateway(remote);
      return remote;
    }
    if (this.isRunning()) {
      return (await this.fetchStatus()) ?? this.fallbackStatus(true);
    }
    const gatewayEntry = this.deps.gatewayEntry ?? GATEWAY_ENTRY;
    if (!existsSync(gatewayEntry)) {
      throw new Error(
        `channel-gateway not built: ${gatewayEntry}. Run pnpm build first.`,
      );
    }

    const env = {
      ...process.env,
      FORGE_DATA_DIR: this.deps.dataDir,
      FORGE_CHANNEL_GATEWAY_HOST: this.deps.listenHost ?? "127.0.0.1",
      FORGE_CHANNEL_GATEWAY_PORT: String(this.deps.listenPort ?? 8787),
    };

    const child = spawn(process.execPath, [gatewayEntry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    this.child = child;
    this.startedAt = new Date().toISOString();
    if (this.child.pid) {
      this.writePidFile(this.child.pid);
    }

    child.stdout?.on("data", (chunk) => {
      process.stdout.write(`[channel-gateway] ${chunk}`);
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(`[channel-gateway] ${chunk}`);
    });
    child.on("exit", (code, signal) => {
      const wasCurrentChild = this.child === child;
      if (wasCurrentChild) {
        this.child = null;
        this.startedAt = null;
        this.clearPidFile();
      }
      if (wasCurrentChild && this.desiredRunning) {
        console.error(
          `[channel-gateway] exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
        );
        this.scheduleRestart();
      }
    });

    try {
      await this.waitForHealth(this.deps.healthTimeoutMs ?? 15_000);
    } catch (error) {
      if (this.child === child) child.kill("SIGTERM");
      throw error;
    }
    return (await this.fetchStatus()) ?? this.fallbackStatus(true);
  }

  async stop(): Promise<ChannelGatewayStatus> {
    this.desiredRunning = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
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

  private scheduleRestart(): void {
    if (!this.desiredRunning || this.restartTimer) return;
    const now = Date.now();
    const restartWindowMs = this.deps.restartWindowMs ?? 2 * 60_000;
    this.crashTimes = this.crashTimes.filter((time) => now - time < restartWindowMs);
    if (this.crashTimes.length >= (this.deps.maxRestarts ?? 5)) {
      this.desiredRunning = false;
      console.error("[channel-gateway] restart budget exhausted; waiting for explicit start");
      return;
    }
    this.crashTimes.push(now);
    const attempt = this.crashTimes.length;
    const base = Math.min(
      this.deps.restartMaxDelayMs ?? 30_000,
      (this.deps.restartBaseDelayMs ?? 500) * 2 ** (attempt - 1),
    );
    const delay = base + Math.floor(Math.random() * Math.max(100, base / 3));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.desiredRunning) return;
      void this.start().catch((error) => {
        console.error(`[channel-gateway] restart failed: ${String(error)}`);
        this.scheduleRestart();
      });
    }, delay);
  }

  async reload(): Promise<void> {
    const base = `http://${this.deps.listenHost ?? "127.0.0.1"}:${this.deps.listenPort ?? 8787}`;
    await fetch(`${base}/reload`, { method: "POST" }).catch(() => {});
  }

  async requestMobile<T>(
    path: "pairing" | "devices" | "revoke" | "projects",
    body: Record<string, unknown>,
  ): Promise<T> {
    const base = `http://${this.deps.listenHost ?? "127.0.0.1"}:${this.deps.listenPort ?? 8787}`;
    const response = await fetch(`${base}/mobile/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(value.error ?? "Mobile Gateway request failed");
    return value;
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
