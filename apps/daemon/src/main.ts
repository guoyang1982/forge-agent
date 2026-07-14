#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import type { AgentEvent, ReloadRuntimeResult } from "@forge/protocol";
import { DAEMON_METHODS, FORGE_DAEMON_BUILD } from "@forge/protocol";
import { DaemonServer } from "@forge/bus";
import { loadConfig } from "@forge/config";
import { SessionStore } from "@forge/session";
import { AutomationStore } from "@forge/automation";
import { ChannelStore } from "@forge/channel";
import { clearMcpClientPool } from "@forge/tool-mcp";
import {
  clearProjectPluginCache,
  createForgeRuntime,
  defaultSkillsDir,
  type ForgeRuntime,
} from "./runtime.js";
import {
  handleGetConfig,
  handleGetSessionMessages,
  handleListMcp,
  handleListPlugins,
  handleListSessions,
  handleListSkills,
  handleSearchSessions,
} from "./services/app-service.js";
import {
  handleImportPlugin,
  handleImportSkill,
  handleSearchCatalog,
  handleSearchPluginsMarketplace,
  handleSearchSkillsMarketplace,
  handleSetPluginEnabled,
  handleSetSkillEnabled,
} from "./services/marketplace-service.js";
import {
  handleHubDeploy,
  handleHubDiscover,
  handleHubImport,
  handleHubInstall,
  handleHubList,
  handleHubRemove,
  handleHubSync,
  handleHubUndeploy,
} from "./services/hub-service.js";
import { CancelService } from "./services/cancel-service.js";
import { handleCompactSession } from "./services/compact-service.js";
import { runSessionEndHooksOnShutdown } from "./services/session-end-service.js";
import { handleApplyPatch, handleRestoreCheckpoint } from "./services/patch-service.js";
import { handlePlan } from "./services/plan-service.js";
import { handleReview } from "./services/review-service.js";
import { handleRun } from "./services/run-service.js";
import { listCodexModels } from "./services/codex-runtime.js";
import { listCursorModels, probeCursorRuntime } from "./services/cursor-runtime.js";
import {
  closeAcpSession,
  listRuntimes,
  listWarmAcpSessions,
  prewarmAcpSession,
  releaseAllAcpSessions,
  releaseAcpForgeSession,
} from "./services/runtime-service.js";
import { handlePermissionResponse } from "./services/network-confirm.js";
import { handleStatus } from "./services/status-service.js";
import {
  executeAutomation,
  handleCreateAutomation,
  handleDeleteAutomation,
  handleGetAutomation,
  handleListAutomationRuns,
  handleListAutomations,
  handleListAutomationTemplates,
  handleParseAutomationDraft,
  handleRunAutomation,
  handleUpdateAutomation,
} from "./services/automation-service.js";
import { AutomationSchedulerHost } from "./services/automation-scheduler-host.js";
import { ChannelGatewayHost } from "./services/channel-gateway-host.js";
import {
  handleChannelPollLogin,
  handleChannelStartLogin,
  handleCreateChannel,
  handleDeleteChannel,
  handleGetChannel,
  handleGetChannelGatewayStatus,
  handleListChannelKinds,
  handleListChannels,
  handleStartChannelGateway,
  handleStopChannelGateway,
  handleUpdateChannel,
} from "./services/channel-service.js";
import {
  handleFireTalent,
  handleGetTalentTemplate,
  handleHireTalent,
  handleListTalentRoster,
  handleListTalentTemplates,
  handleRenameTalent,
  handleTalentSyncTemplates,
  handleUpdateTalentBindings,
  seedTalentTemplates,
} from "./services/talent-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = join(__dirname, "..", "..", "..");

const migrationsDir = join(MONOREPO_ROOT, "migrations");
const bootConfig = loadConfig();
const dbPath = join(bootConfig.daemon.dataDir, "data.db");
const sessions = new SessionStore(dbPath, migrationsDir);
const automationStore = new AutomationStore(sessions.getDb());
const channelStore = new ChannelStore(sessions.getDb());
const pidFile = join(bootConfig.daemon.dataDir, "daemon.pid");
const channelGatewayPidFile = join(bootConfig.daemon.dataDir, "channel-gateway.pid");

let runtime: ForgeRuntime | null = null;
const cancelService = new CancelService();

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

const automationDeps = {
  sessions,
  getStore: () => automationStore,
  getChannelStore: () => channelStore,
  getScheduler: () => schedulerHost,
  getRunDeps: () => ({ sessions, getRuntime, cancelService }),
};

const channelGatewayHost = new ChannelGatewayHost({
  dataDir: bootConfig.daemon.dataDir,
  pidFile: channelGatewayPidFile,
});

const channelDeps = {
  getStore: () => channelStore,
  getGatewayHost: () => channelGatewayHost,
};

async function createRuntimeFromCurrentConfig(): Promise<ForgeRuntime> {
  const cfg = loadConfig();
  return createForgeRuntime({
    dbPath,
    dataDir: cfg.daemon.dataDir,
    monorepoRoot: MONOREPO_ROOT,
    skillsDir: defaultSkillsDir(MONOREPO_ROOT),
    config: cfg,
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

async function handleRpc(
  method: string,
  params: unknown,
  emit: (event: AgentEvent) => void,
): Promise<unknown> {
  if (method === DAEMON_METHODS.PING) {
    return {
      ok: true,
      version: "0.2.0",
      build: FORGE_DAEMON_BUILD,
    };
  }

  if (method === DAEMON_METHODS.STATUS) {
    return handleStatus({
      version: "0.2.0",
      sessions,
      getRuntime,
      cancelService,
    });
  }

  if (method === DAEMON_METHODS.LIST_SESSIONS) {
    return handleListSessions(params, { sessions });
  }

  if (method === DAEMON_METHODS.SEARCH_SESSIONS) {
    return handleSearchSessions(params, { sessions });
  }

  if (method === DAEMON_METHODS.GET_SESSION_MESSAGES) {
    return handleGetSessionMessages(params, { sessions });
  }

  if (method === DAEMON_METHODS.LIST_PLUGINS) {
    return handleListPlugins(params, {
      monorepoRoot: MONOREPO_ROOT,
      dataDir: bootConfig.daemon.dataDir,
    });
  }

  if (method === DAEMON_METHODS.LIST_SKILLS) {
    return handleListSkills(params, { getRuntime });
  }

  if (method === DAEMON_METHODS.LIST_MCP) {
    return handleListMcp(params, {
      monorepoRoot: MONOREPO_ROOT,
      dataDir: bootConfig.daemon.dataDir,
    });
  }

  if (method === DAEMON_METHODS.GET_CONFIG) {
    return handleGetConfig(params);
  }

  if (method === DAEMON_METHODS.RELOAD_RUNTIME) {
    return reloadRuntime();
  }

  if (method === DAEMON_METHODS.SEARCH_CATALOG) {
    return handleSearchCatalog(params);
  }

  if (method === DAEMON_METHODS.SEARCH_SKILLS_MARKETPLACE) {
    return handleSearchSkillsMarketplace(params);
  }

  if (method === DAEMON_METHODS.SEARCH_PLUGINS_MARKETPLACE) {
    return handleSearchPluginsMarketplace(params);
  }

  if (method === DAEMON_METHODS.HUB_LIST) {
    return handleHubList(params, { dataDir: bootConfig.daemon.dataDir });
  }

  if (method === DAEMON_METHODS.HUB_INSTALL) {
    const result = await handleHubInstall(params, { dataDir: bootConfig.daemon.dataDir });
    await reloadRuntime();
    return result;
  }

  if (method === DAEMON_METHODS.HUB_DEPLOY) {
    const result = await handleHubDeploy(params, { dataDir: bootConfig.daemon.dataDir });
    await reloadRuntime();
    return result;
  }

  if (method === DAEMON_METHODS.HUB_UNDEPLOY) {
    const result = await handleHubUndeploy(params, { dataDir: bootConfig.daemon.dataDir });
    await reloadRuntime();
    return result;
  }

  if (method === DAEMON_METHODS.HUB_REMOVE) {
    const result = await handleHubRemove(params, { dataDir: bootConfig.daemon.dataDir });
    await reloadRuntime();
    return result;
  }

  if (method === DAEMON_METHODS.HUB_SYNC) {
    const result = await handleHubSync(params, { dataDir: bootConfig.daemon.dataDir });
    await reloadRuntime();
    return result;
  }

  if (method === DAEMON_METHODS.HUB_DISCOVER) {
    return handleHubDiscover(params, { dataDir: bootConfig.daemon.dataDir });
  }

  if (method === DAEMON_METHODS.HUB_IMPORT) {
    const result = await handleHubImport(params, { dataDir: bootConfig.daemon.dataDir });
    await reloadRuntime();
    return result;
  }

  if (method === DAEMON_METHODS.SET_SKILL_ENABLED) {
    return handleSetSkillEnabled(params);
  }

  if (method === DAEMON_METHODS.SET_PLUGIN_ENABLED) {
    return handleSetPluginEnabled(params);
  }

  if (method === DAEMON_METHODS.IMPORT_SKILL) {
    const result = await handleImportSkill(params, { dataDir: bootConfig.daemon.dataDir });
    await reloadRuntime();
    return result;
  }

  if (method === DAEMON_METHODS.IMPORT_PLUGIN) {
    const result = await handleImportPlugin(params, { dataDir: bootConfig.daemon.dataDir });
    await reloadRuntime();
    return result;
  }

  if (method === DAEMON_METHODS.TALENTS_SYNC_TEMPLATES) {
    return handleTalentSyncTemplates(params, { dataDir: bootConfig.daemon.dataDir });
  }

  if (method === DAEMON_METHODS.TALENTS_LIST_TEMPLATES) {
    return handleListTalentTemplates(params, { dataDir: bootConfig.daemon.dataDir });
  }

  if (method === DAEMON_METHODS.TALENTS_HIRE) {
    return handleHireTalent(params, { dataDir: bootConfig.daemon.dataDir });
  }

  if (method === DAEMON_METHODS.TALENTS_FIRE) {
    return handleFireTalent(params, { dataDir: bootConfig.daemon.dataDir });
  }

  if (method === DAEMON_METHODS.TALENTS_LIST_ROSTER) {
    return handleListTalentRoster(params, { dataDir: bootConfig.daemon.dataDir });
  }

  if (method === DAEMON_METHODS.TALENTS_RENAME) {
    return handleRenameTalent(params, { dataDir: bootConfig.daemon.dataDir });
  }

  if (method === DAEMON_METHODS.TALENTS_UPDATE_BINDINGS) {
    return handleUpdateTalentBindings(params, { dataDir: bootConfig.daemon.dataDir });
  }

  if (method === DAEMON_METHODS.TALENTS_GET_TEMPLATE) {
    return handleGetTalentTemplate(params, { dataDir: bootConfig.daemon.dataDir });
  }

  if (method === DAEMON_METHODS.APPLY_PATCH) {
    return handleApplyPatch(params);
  }

  if (method === DAEMON_METHODS.RESTORE_CHECKPOINT) {
    return handleRestoreCheckpoint(params, { sessions });
  }

  if (method === DAEMON_METHODS.CANCEL_RUN) {
    const req = params as { sessionId?: string } | undefined;
    return cancelService.cancel(req?.sessionId);
  }

  if (method === DAEMON_METHODS.PERMISSION_RESPONSE) {
    return handlePermissionResponse(params);
  }

  if (method === DAEMON_METHODS.RUN) {
    return handleRun(params, emit, {
      sessions,
      getRuntime,
      cancelService,
    });
  }

  if (method === DAEMON_METHODS.LIST_CODEX_MODELS) {
    const cwd =
      typeof params === "object" && params && "cwd" in params
        ? String((params as { cwd?: unknown }).cwd ?? process.cwd())
        : process.cwd();
    return listCodexModels(cwd);
  }

  if (method === DAEMON_METHODS.LIST_CURSOR_MODELS) {
    const cwd =
      typeof params === "object" && params && "cwd" in params
        ? String((params as { cwd?: unknown }).cwd ?? process.cwd())
        : process.cwd();
    return listCursorModels(cwd);
  }

  if (method === DAEMON_METHODS.PROBE_CURSOR_RUNTIME) {
    const cwd =
      typeof params === "object" && params && "cwd" in params
        ? String((params as { cwd?: unknown }).cwd ?? process.cwd())
        : process.cwd();
    return probeCursorRuntime(cwd);
  }

  if (method === DAEMON_METHODS.LIST_RUNTIMES) {
    const cwd =
      typeof params === "object" && params && "cwd" in params
        ? String((params as { cwd?: unknown }).cwd ?? process.cwd())
        : process.cwd();
    return listRuntimes(cwd);
  }

  if (method === DAEMON_METHODS.CLOSE_ACP_SESSION) {
    const payload =
      typeof params === "object" && params
        ? (params as { provider?: unknown; sessionId?: unknown })
        : {};
    const sessionId = String(payload.sessionId ?? "");
    if (!sessionId) throw new Error("sessionId required");
    const provider =
      payload.provider === undefined || payload.provider === null
        ? undefined
        : String(payload.provider);
    return closeAcpSession({ provider, sessionId });
  }

  if (method === DAEMON_METHODS.RELEASE_ACP_FORGE_SESSION) {
    const payload =
      typeof params === "object" && params
        ? (params as { sessionId?: unknown })
        : {};
    const sessionId = String(payload.sessionId ?? "");
    if (!sessionId) throw new Error("sessionId required");
    return releaseAcpForgeSession(sessionId);
  }

  if (method === DAEMON_METHODS.LIST_WARM_ACP_SESSIONS) {
    return { sessions: listWarmAcpSessions() };
  }

  if (method === DAEMON_METHODS.PREWARM_ACP_SESSION) {
    const payload =
      typeof params === "object" && params
        ? (params as {
            provider?: unknown;
            cwd?: unknown;
            model?: unknown;
            mode?: unknown;
            sandboxMode?: unknown;
          })
        : {};
    const cwd = String(payload.cwd ?? process.cwd());
    return prewarmAcpSession({
      provider: String(payload.provider ?? "cursor"),
      cwd,
      model: payload.model ? String(payload.model) : undefined,
      mode: payload.mode ? String(payload.mode) : undefined,
      sandboxMode: payload.sandboxMode ? String(payload.sandboxMode) : undefined,
    });
  }

  if (method === DAEMON_METHODS.PLAN) {
    return handlePlan(params, emit);
  }

  if (method === DAEMON_METHODS.REVIEW) {
    return handleReview(params, emit);
  }

  if (method === DAEMON_METHODS.COMPACT_SESSION) {
    return handleCompactSession(params, emit, { sessions, getRuntime });
  }

  if (method === DAEMON_METHODS.LIST_AUTOMATIONS) {
    return handleListAutomations(params, automationDeps);
  }

  if (method === DAEMON_METHODS.GET_AUTOMATION) {
    return handleGetAutomation(params, automationDeps);
  }

  if (method === DAEMON_METHODS.CREATE_AUTOMATION) {
    return handleCreateAutomation(params, automationDeps);
  }

  if (method === DAEMON_METHODS.UPDATE_AUTOMATION) {
    return handleUpdateAutomation(params, automationDeps);
  }

  if (method === DAEMON_METHODS.DELETE_AUTOMATION) {
    return handleDeleteAutomation(params, automationDeps);
  }

  if (method === DAEMON_METHODS.RUN_AUTOMATION) {
    return handleRunAutomation(params, automationDeps, emit);
  }

  if (method === DAEMON_METHODS.LIST_AUTOMATION_RUNS) {
    return handleListAutomationRuns(params, automationDeps);
  }

  if (method === DAEMON_METHODS.PARSE_AUTOMATION_DRAFT) {
    return handleParseAutomationDraft(params);
  }

  if (method === DAEMON_METHODS.LIST_AUTOMATION_TEMPLATES) {
    return handleListAutomationTemplates();
  }

  if (method === DAEMON_METHODS.LIST_CHANNELS) {
    return handleListChannels(params, channelDeps);
  }

  if (method === DAEMON_METHODS.GET_CHANNEL) {
    return handleGetChannel(params, channelDeps);
  }

  if (method === DAEMON_METHODS.CREATE_CHANNEL) {
    return handleCreateChannel(params, channelDeps);
  }

  if (method === DAEMON_METHODS.UPDATE_CHANNEL) {
    return handleUpdateChannel(params, channelDeps);
  }

  if (method === DAEMON_METHODS.DELETE_CHANNEL) {
    return handleDeleteChannel(params, channelDeps);
  }

  if (method === DAEMON_METHODS.LIST_CHANNEL_KINDS) {
    return handleListChannelKinds();
  }

  if (method === DAEMON_METHODS.GET_CHANNEL_GATEWAY_STATUS) {
    return handleGetChannelGatewayStatus(channelDeps);
  }

  if (method === DAEMON_METHODS.START_CHANNEL_GATEWAY) {
    return handleStartChannelGateway(params, channelDeps);
  }

  if (method === DAEMON_METHODS.STOP_CHANNEL_GATEWAY) {
    return handleStopChannelGateway(channelDeps);
  }

  if (method === DAEMON_METHODS.CHANNEL_START_LOGIN) {
    return handleChannelStartLogin(params, channelDeps);
  }

  if (method === DAEMON_METHODS.CHANNEL_POLL_LOGIN) {
    return handleChannelPollLogin(params, channelDeps);
  }

  throw new Error(`Unknown method: ${method}`);
}

function writePid(): void {
  writeFileSync(pidFile, String(process.pid));
}

/** Single-instance guard: a live daemon answering ping on the socket wins. */
function isDaemonAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(socketPath)) return resolve(false);
    const sock = connect(socketPath);
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), 1500);
    sock.on("connect", () => {
      sock.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: DAEMON_METHODS.PING }) + "\n",
      );
    });
    sock.on("data", () => done(true));
    sock.on("error", () => done(false));
  });
}

async function main(): Promise<void> {
  if (await isDaemonAlive(bootConfig.daemon.socketPath)) {
    console.log(
      `[forge] another daemon already serves ${bootConfig.daemon.socketPath} — exiting`,
    );
    sessions.close();
    process.exit(0);
  }
  await getRuntime();
  try {
    const { seeded } = await seedTalentTemplates({
      dataDir: bootConfig.daemon.dataDir,
    });
    if (seeded > 0) {
      console.log(`[forge] seeded ${seeded} bundled talent templates`);
    }
  } catch (e) {
    console.warn(`[forge] talent template seeding skipped: ${String(e)}`);
  }
  const server = new DaemonServer(bootConfig.daemon.socketPath, handleRpc);
  writePid();
  console.log(`Forge daemon listening on ${bootConfig.daemon.socketPath}`);
  await server.start();
  await schedulerHost.start();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Release the socket FIRST: slow shutdown hooks must never unlink a
    // successor's freshly bound socket (desktop respawns within ~450ms).
    server.stop();
    schedulerHost.stop();
    void channelGatewayHost.stop().catch(() => {});
    void runSessionEndHooksOnShutdown({ sessions, getRuntime })
      .catch((e) => {
        console.warn(`[forge:hook] SessionEnd shutdown hooks failed: ${String(e)}`);
      })
      .finally(() => {
        void releaseAllAcpSessions().catch(() => {});
        sessions.close();
        runtime?.memory.close();
        try {
          if (existsSync(pidFile)) unlinkSync(pidFile);
        } catch {
          /* pid file may already be removed by isolated eval cleanup */
        }
        process.exit(0);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
