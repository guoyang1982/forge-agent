#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { ReloadRuntimeResult } from "@forge/protocol";
import { DAEMON_METHODS, FORGE_DAEMON_BUILD, V2_EXECUTION_EVENT_TYPES } from "@forge/protocol";
import { loadConfig } from "@forge/config";
import { SessionStore } from "@forge/session";
import { ForgeStore } from "@forge/store";
import { AutomationStore } from "@forge/automation";
import { ChannelStore } from "@forge/channel";
import {
  applyCompanyRunTerminalEvent,
  CompanyService,
  OrganizationService,
  WorkGates,
  WorkService,
} from "@forge/company-domain";
import { AgentProfileStore } from "@forge/agent-profile";
import { ArtifactService, ValidationService } from "@forge/evidence";
import {
  ConnectorGateway,
  InMemoryCredentialProvider,
  LOCAL_PUBLISH_ACCOUNT,
  MockConnectorAdapter,
  SocialPublishService,
  TOUTIAO_BROWSER_ACCOUNT,
  ToutiaoBrowserAdapter,
  XIAOHONGSHU_BROWSER_ACCOUNT,
  XiaohongshuBrowserAdapter,
  beginToutiaoLogin,
  beginXiaohongshuLogin,
  confirmToutiaoLogin,
  confirmXiaohongshuLogin,
  connectLocalPublishAccount,
  listPublishAccountStates,
  listPublishAccounts,
  markAccountNeedsAuth,
  type ConnectorAdapter,
} from "@forge/connectors";
import { ApprovalService, PolicyEngine } from "@forge/policy";
import { BudgetLedgerService } from "@forge/usage-ledger";
import { WorkspaceGroupService, WorkspaceLeaseService } from "@forge/workspace";
import { clearMcpClientPool } from "@forge/tool-mcp";
import {
  clearProjectPluginCache,
  createForgeRuntime,
  defaultSkillsDir,
  type ForgeRuntime,
} from "./runtime.js";
import { DaemonHost } from "./host/daemon-host.js";
import { createDaemonModules } from "./modules/index.js";
import { previewCompanyApprovalForRun } from "./modules/company-module.js";
import type { ForgeDaemonContext } from "./modules/context.js";
import {
  executeAutomation,
  reconcileAutomationRuns,
} from "./services/automation-service.js";
import { AutomationSchedulerHost } from "./services/automation-scheduler-host.js";
import { CancelService } from "./services/cancel-service.js";
import { ChannelGatewayHost } from "./services/channel-gateway-host.js";
import { releaseAllAcpSessions } from "./services/runtime-service.js";
import { runSessionEndHooksOnShutdown } from "./services/session-end-service.js";
import { executeForgeRun } from "./services/run-service.js";
import { createProductionExecutionComposition } from "./services/production-execution-composition.js";
import { createProductionValidatorRegistry } from "./services/production-validators.js";
import { AutomationGovernanceService } from "./services/automation-governance.js";
import { FirstPartyRunCoordinator } from "./services/first-party-run.js";
import { createExecutorPump } from "./services/executor-pump.js";

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

function attachPublishRuntime(next: ForgeRuntime): ForgeRuntime {
  next.publish = {
    service: publishService,
    subject: publishSubject,
    db: forgeStore.db,
  };
  return next;
}

async function getRuntime(): Promise<ForgeRuntime> {
  if (!runtime) {
    runtime = attachPublishRuntime(await createRuntimeFromCurrentConfig());
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
  runtime = attachPublishRuntime(await createRuntimeFromCurrentConfig());
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

const channelGatewayHost = new ChannelGatewayHost({
  dataDir: bootConfig.daemon.dataDir,
  pidFile: channelGatewayPidFile,
  listenHost: process.env.FORGE_CHANNEL_GATEWAY_HOST ?? "127.0.0.1",
  listenPort: Number(process.env.FORGE_CHANNEL_GATEWAY_PORT ?? "8787"),
});

const executionClock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};
const companyClock = { now: () => executionClock.now() };
const artifactRoot = join(bootConfig.daemon.dataDir, "company");
const company = {
  companies: new CompanyService(forgeStore.db, companyClock),
  org: new OrganizationService(forgeStore.db, companyClock),
  work: new WorkService(forgeStore.db, companyClock, { artifactRoot }),
  gates: new WorkGates(forgeStore.db, companyClock, { artifactRoot }),
};
let host!: DaemonHost<ForgeDaemonContext>;
const workspaceGroups = new WorkspaceGroupService(forgeStore.db);
const workspaceLeases = new WorkspaceLeaseService(forgeStore.db);
const approvals = new ApprovalService(forgeStore.db);
const publishSubject = { kind: "human", id: "local" };
const publishCredentials = new InMemoryCredentialProvider();
publishCredentials.put(LOCAL_PUBLISH_ACCOUNT.credentialRef, "local-publish");
publishCredentials.put(XIAOHONGSHU_BROWSER_ACCOUNT.credentialRef, "browser-session");
publishCredentials.put(TOUTIAO_BROWSER_ACCOUNT.credentialRef, "browser-session");
const localPublishAdapter = new MockConnectorAdapter();
localPublishAdapter.executeImpl = async (input) => ({
  ok: true,
  externalId: `local:${input.proposalId}`,
  url: `local://publish/${encodeURIComponent(input.proposalId)}`,
  summary: "published locally",
});
const xiaohongshuBrowser = {
  async listTabs() {
    const runtime = await getRuntime();
    const tabs = await runtime.browser.listTabs();
    return tabs.map((tab) => ({ tabId: tab.id, url: tab.url, title: tab.title }));
  },
  async open(url: string) {
    const runtime = await getRuntime();
    const tab = await runtime.browser.open({ url });
    const snap = await runtime.browser.snapshot(tab.id);
    return {
      tabId: snap.tabId,
      url: snap.url,
      title: snap.title,
      text: snap.text,
      elements: snap.elements,
    };
  },
  async navigate(tabId: string, url: string) {
    const runtime = await getRuntime();
    const tab = await runtime.browser.navigate({ tabId, url });
    const snap = await runtime.browser.snapshot(tab.id);
    return {
      tabId: snap.tabId,
      url: snap.url,
      title: snap.title,
      text: snap.text,
      elements: snap.elements,
    };
  },
  async snapshot(tabId: string) {
    const runtime = await getRuntime();
    const snap = await runtime.browser.snapshot(tabId);
    return {
      tabId: snap.tabId,
      url: snap.url,
      title: snap.title,
      text: snap.text,
      elements: snap.elements,
    };
  },
  async type(tabId: string, ref: string, text: string) {
    const runtime = await getRuntime();
    await runtime.browser.type({ tabId, ref, text, clear: true });
  },
  async click(tabId: string, ref: string) {
    const runtime = await getRuntime();
    await runtime.browser.click({ tabId, ref });
  },
  async clickText(tabId: string, text: string) {
    const runtime = await getRuntime();
    await runtime.browser.clickText(tabId, text);
  },
};
const xiaohongshuAdapter = new XiaohongshuBrowserAdapter(xiaohongshuBrowser, (accountId) =>
  markAccountNeedsAuth(forgeStore.db, accountId),
);
const toutiaoAdapter = new ToutiaoBrowserAdapter(xiaohongshuBrowser, (accountId) =>
  markAccountNeedsAuth(forgeStore.db, accountId),
);
const publishService = new SocialPublishService(
  forgeStore.db,
  new ConnectorGateway({
    db: forgeStore.db,
    policy: {
      authorize: (input) => PolicyEngine.fromDatabase(forgeStore.db).authorize(input),
    },
    approvals,
    credentials: publishCredentials,
    adapters: new Map<string, ConnectorAdapter>([
      [LOCAL_PUBLISH_ACCOUNT.adapterKind, localPublishAdapter],
      [XIAOHONGSHU_BROWSER_ACCOUNT.adapterKind, xiaohongshuAdapter],
      [TOUTIAO_BROWSER_ACCOUNT.adapterKind, toutiaoAdapter],
    ]),
  }),
  approvals,
);
const localPublish = {
  listAccounts: () => listPublishAccounts(forgeStore.db, publishSubject),
  listStates: () => listPublishAccountStates(forgeStore.db, publishSubject),
  connect: () => connectLocalPublishAccount(forgeStore.db, publishCredentials, publishSubject),
  beginXiaohongshuLogin: async () => {
    try {
      return await beginXiaohongshuLogin(xiaohongshuBrowser);
    } catch (error) {
      throw new Error(browserUnavailable(error));
    }
  },
  confirmXiaohongshuLogin: async () => {
    try {
      return await confirmXiaohongshuLogin(
        xiaohongshuBrowser,
        forgeStore.db,
        publishCredentials,
        publishSubject,
      );
    } catch (error) {
      if (error instanceof Error && /还没有登录|无法确认已经登录/.test(error.message)) throw error;
      throw new Error(browserUnavailable(error));
    }
  },
  beginToutiaoLogin: async () => {
    try {
      return await beginToutiaoLogin(xiaohongshuBrowser);
    } catch (error) {
      throw new Error(browserUnavailable(error));
    }
  },
  confirmToutiaoLogin: async () => {
    try {
      return await confirmToutiaoLogin(
        xiaohongshuBrowser,
        forgeStore.db,
        publishCredentials,
        publishSubject,
      );
    } catch (error) {
      if (error instanceof Error && /还没有登录|无法确认已经登录/.test(error.message)) throw error;
      throw new Error(browserUnavailable(error));
    }
  },
};
function browserUnavailable(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unavailable|closed the connection|timed out|ENOENT/i.test(message)) {
    return "请先保持 Forge 桌面窗口打开，再连接创作者账号。";
  }
  return message;
}

const budgetLedger = new BudgetLedgerService(forgeStore.db);
const agentProfiles = new AgentProfileStore(forgeStore.db);
const artifacts = new ArtifactService(
  forgeStore.db,
  join(bootConfig.daemon.dataDir, "evidence"),
);
const validations = new ValidationService(
  forgeStore.db,
  createProductionValidatorRegistry(),
);
const automationGovernance = new AutomationGovernanceService(
  forgeStore.db,
  agentProfiles,
  budgetLedger,
  workspaceGroups,
  validations,
);
automationGovernance.ensureLocalPolicy();
const productionExecution = createProductionExecutionComposition({
  db: forgeStore.db,
  clock: executionClock,
  broadcast: (event) => {
    try {
      applyCompanyRunTerminalEvent(company.gates, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[forge:company] applyCompanyRunTerminalEvent failed eventId=${event.eventId} runId=${event.runId}: ${message}`,
      );
    }
    if (event.type === "run.succeeded" && event.runId) {
      void previewCompanyApprovalForRun(
        { store: forgeStore, company, dataDir: bootConfig.daemon.dataDir },
        event.runId,
      ).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[forge:company] previewApproval failed runId=${event.runId}: ${message}`,
        );
      });
    }
    return host.broadcastCoreEvent(event);
  },
  onDeliveryFailure: ({ event, error }) => {
    console.error(
      `[forge:events] CoreEvent delivery failed eventId=${event.eventId} runId=${event.runId}: ${error.message}`,
    );
  },
  run: process.env.FORGE_SMOKE === "1"
    ? async (_request, emit) => {
        emit({ type: "status", phase: "model", message: "replying" });
        emit({ type: "text_delta", sessionId: "session-smoke", delta: "smoke-ok" });
        emit({ type: "done", sessionId: "session-smoke", finalText: "smoke-ok" });
        return { sessionId: "session-smoke", finalText: "smoke-ok" };
      }
    : (request, emit, signal, runtimePolicy) =>
        executeForgeRun(
          request,
          emit,
          { sessions, getRuntime, cancelService },
          runtimePolicy,
          signal,
        ),
  governance: process.env.FORGE_SMOKE === "1"
    ? undefined
    : {
        profiles: agentProfiles,
        approvals,
        budgets: budgetLedger,
        leases: workspaceLeases,
        validations,
      },
});
const {
  eventStore,
  outboxDispatcher,
  executionStore,
  executor,
  executionRecovery,
  bindFirstPartyEmit,
} =
  productionExecution;
schedulerHost = new AutomationSchedulerHost({
  store: automationStore,
  db: forgeStore.db,
  executeAutomation: (id, trigger, opts) =>
    executeAutomation(id, trigger, {
      store: automationStore,
      sessions,
      scheduler: schedulerHost,
      channelStore,
      cfg: loadConfig(),
      durable: {
        db: forgeStore.db,
        executionStore,
        executor,
        clock: executionClock,
        governance: automationGovernance,
      },
    }, opts),
});
const executorPump = createExecutorPump({
  tick: (limit) => executor.tick(limit),
  afterTick: () =>
    reconcileAutomationRuns({
      store: automationStore,
      channelStore,
      durable: { db: forgeStore.db, executionStore },
    }).then(() => undefined),
  nextDueAt: () => executionStore.nextDueAt(executionClock.now()),
  nowMs: () => executionClock.nowMs(),
  onError: (error) => {
    console.error(`[forge:execution] tick failed: ${String(error)}`);
  },
});
const wakeExecutor = () => {
  executorPump.wake();
};

const firstPartyRuns = new FirstPartyRunCoordinator({
  executionStore,
  executor,
  clock: executionClock,
  sessions,
  cancelService,
  bindEmit: bindFirstPartyEmit,
  db: forgeStore.db,
});

const context: ForgeDaemonContext = {
  socketPath: bootConfig.daemon.socketPath,
  store: forgeStore,
  serverVersion: SERVER_VERSION,
  build: FORGE_DAEMON_BUILD,
  eventTypes: [...V2_EXECUTION_EVENT_TYPES],
  dataDir: bootConfig.daemon.dataDir,
  monorepoRoot,
  sessions,
  automationStore,
  channelStore,
  cancelService,
  firstPartyRuns,
  schedulerHost,
  channelGatewayHost,
  executionStore,
  eventStore,
  workspaceGroups,
  workspaceLeases,
  approvals,
  budgetLedger,
  agentProfiles,
  artifacts,
  validations,
  company,
  companyWorkflowCapabilities: productionExecution.companyWorkflowCapabilities,
  automationGovernance,
  executor,
  executionRecovery,
  executionClock,
  wakeExecutor,
  getRuntime,
  reloadRuntime,
  shutdownRuntime,
  localPublish,
};

host = new DaemonHost(createDaemonModules(context), context);
productionExecution.observeDeliveryFailures(host);

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

  try {
    await host.start();
  } catch (error) {
    // Race: another daemon bound the socket between our alive-check and listen.
    // Exit cleanly so we do not keep a second SQLite connection open (SQLITE_BUSY).
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "EADDRINUSE" || (await isDaemonAlive(context.socketPath))) {
      console.log(`[forge] another daemon already serves ${context.socketPath} — exiting`);
      forgeStore.close();
      process.exit(0);
    }
    throw error;
  }
  outboxDispatcher.start();
  writePid();
  console.log(`Forge daemon listening on ${context.socketPath}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void outboxDispatcher.stop()
      .then(() => {
        executorPump.stop();
        return host.stop();
      })
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
