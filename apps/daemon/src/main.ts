#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { ReloadRuntimeResult } from "@forge/protocol";
import { DAEMON_METHODS, FORGE_DAEMON_BUILD } from "@forge/protocol";
import { loadConfig } from "@forge/config";
import { SessionStore } from "@forge/session";
import { ForgeStore } from "@forge/store";
import { AutomationStore } from "@forge/automation";
import { ChannelStore } from "@forge/channel";
import { clearMcpClientPool } from "@forge/tool-mcp";
import {
  clearProjectPluginCache,
  createForgeRuntime,
  defaultSkillsDir,
  type ForgeRuntime,
} from "./runtime.js";
import { DaemonHost } from "./host/daemon-host.js";
import { createDaemonModules } from "./modules/index.js";
import type { ForgeDaemonContext } from "./modules/context.js";
import { executeAutomation } from "./services/automation-service.js";
import { AutomationSchedulerHost } from "./services/automation-scheduler-host.js";
import { CancelService } from "./services/cancel-service.js";
import { ChannelGatewayHost } from "./services/channel-gateway-host.js";
import { releaseAllAcpSessions } from "./services/runtime-service.js";
import { runSessionEndHooksOnShutdown } from "./services/session-end-service.js";

const SERVER_VERSION = "0.2.0";
const __dirname = dirname(fileURLToPath(import.meta.url));
const developmentRoot = join(__dirname, "..", "..", "..");
// pnpm deploy places runtime assets beside dist/; source development keeps
// them at the repository root.
const monorepoRoot = existsSync(join(developmentRoot, "migrations"))
  ? developmentRoot
  : join(__dirname, "..");

const migrationsDir = join(monorepoRoot, "migrations");
const bootConfig = loadConfig();
const dbPath = join(bootConfig.daemon.dataDir, "data.db");
const forgeStore = ForgeStore.open({ dbPath, migrationsDir, owner: "daemon" });
const sessions = new SessionStore(forgeStore.db);
const automationStore = new AutomationStore(forgeStore.db);
const channelStore = new ChannelStore(forgeStore.db);
const cancelService = new CancelService();
const pidFile = join(bootConfig.daemon.dataDir, "daemon.pid");
const channelGatewayPidFile = join(bootConfig.daemon.dataDir, "channel-gateway.pid");

let runtime: ForgeRuntime | null = null;

async function createRuntimeFromCurrentConfig(): Promise<ForgeRuntime> {
  const config = loadConfig();
  return createForgeRuntime({
    dbPath,
    dataDir: config.daemon.dataDir,
    monorepoRoot,
    skillsDir: defaultSkillsDir(monorepoRoot),
    config,
  });
}

async function getRuntime(): Promise<ForgeRuntime> {
  if (!runtime) {
    runtime = await createRuntimeFromCurrentConfig();
    console.log(
      `[forge] loaded ${runtime.skills.length} skills, ${runtime.plugins.length} plugins`,
    );
  }
  return runtime;
}

async function reloadRuntime(): Promise<ReloadRuntimeResult> {
  await runtime?.browser.dispose();
  runtime?.memory.close();
  clearProjectPluginCache();
  clearMcpClientPool();
  runtime = await createRuntimeFromCurrentConfig();
  console.log(
    `[forge] reloaded ${runtime.skills.length} skills, ${runtime.plugins.length} plugins`,
  );
  return {
    ok: true,
    skills: runtime.skills.length,
    plugins: runtime.plugins.length,
  };
}

async function shutdownRuntime(): Promise<void> {
  try {
    await runSessionEndHooksOnShutdown({ sessions, getRuntime });
  } catch (error) {
    console.warn(`[forge:hook] SessionEnd shutdown hooks failed: ${String(error)}`);
  }
  await releaseAllAcpSessions().catch(() => {});
  await runtime?.browser.dispose();
  runtime?.memory.close();
  runtime = null;
}

let schedulerHost!: AutomationSchedulerHost;
schedulerHost = new AutomationSchedulerHost({
  store: automationStore,
  executeAutomation: (id, trigger) =>
    executeAutomation(id, trigger, {
      store: automationStore,
      sessions,
      scheduler: schedulerHost,
      runDeps: { sessions, getRuntime, cancelService },
      channelStore,
      cfg: loadConfig(),
    }),
});

const channelGatewayHost = new ChannelGatewayHost({
  dataDir: bootConfig.daemon.dataDir,
  pidFile: channelGatewayPidFile,
  listenHost: process.env.FORGE_CHANNEL_GATEWAY_HOST ?? "127.0.0.1",
  listenPort: Number(process.env.FORGE_CHANNEL_GATEWAY_PORT ?? "8787"),
});

const context: ForgeDaemonContext = {
  socketPath: bootConfig.daemon.socketPath,
  store: forgeStore,
  serverVersion: SERVER_VERSION,
  build: FORGE_DAEMON_BUILD,
  dataDir: bootConfig.daemon.dataDir,
  monorepoRoot,
  sessions,
  automationStore,
  channelStore,
  cancelService,
  schedulerHost,
  channelGatewayHost,
  getRuntime,
  reloadRuntime,
  shutdownRuntime,
};

const host = new DaemonHost(createDaemonModules(context), context);

function writePid(): void {
  writeFileSync(pidFile, String(process.pid));
}

function removePid(): void {
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {
    // PID file may already be removed by isolated evaluation cleanup.
  }
}

/** Single-instance guard: a live daemon answering ping on the socket wins. */
function isDaemonAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(socketPath)) return resolve(false);
    const socket = connect(socketPath);
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), 1500);
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: DAEMON_METHODS.PING }) + "\n",
      );
    });
    socket.on("data", () => done(true));
    socket.on("error", () => done(false));
  });
}

async function main(): Promise<void> {
  if (await isDaemonAlive(context.socketPath)) {
    console.log(`[forge] another daemon already serves ${context.socketPath} — exiting`);
    forgeStore.close();
    process.exit(0);
  }

  await host.start();
  writePid();
  console.log(`Forge daemon listening on ${context.socketPath}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void host.stop()
      .catch((error) => {
        console.error(`[forge] daemon shutdown failed: ${String(error)}`);
        process.exitCode = 1;
      })
      .finally(() => {
        removePid();
        process.exit();
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  removePid();
  process.exit(1);
});
