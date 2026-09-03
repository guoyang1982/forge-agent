import { DAEMON_METHODS } from "@forge/protocol";
import type { DaemonModule } from "../host/types.js";
import {
  handleCreateAutomation,
  handleDeleteAutomation,
  handleGetAutomation,
  handleListAutomationRuns,
  handleListAutomations,
  handleListAutomationTemplates,
  handleParseAutomationDraft,
  handleRunAutomation,
  handleUpdateAutomation,
  reconcileAutomationRuns,
  type AutomationServiceDeps,
} from "../services/automation-service.js";
import type { ForgeDaemonContext } from "./context.js";

export function createAutomationModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "automation",
    feature: { version: 1, enabled: true },
    register(router, context) {
      const deps = automationDeps(context);
      router.registerProduct(DAEMON_METHODS.LIST_AUTOMATIONS, async (params) =>
        handleListAutomations(params, deps));
      router.registerProduct(DAEMON_METHODS.GET_AUTOMATION, async (params) =>
        handleGetAutomation(params, deps));
      router.registerProduct(DAEMON_METHODS.CREATE_AUTOMATION, async (params) =>
        handleCreateAutomation(params, deps));
      router.registerProduct(DAEMON_METHODS.UPDATE_AUTOMATION, async (params) =>
        handleUpdateAutomation(params, deps));
      router.registerProduct(DAEMON_METHODS.DELETE_AUTOMATION, async (params) =>
        handleDeleteAutomation(params, deps));
      router.registerProduct(DAEMON_METHODS.RUN_AUTOMATION, async (params, rpc) =>
        handleRunAutomation(params, deps, rpc.emitAgentEvent));
      router.registerProduct(DAEMON_METHODS.LIST_AUTOMATION_RUNS, async (params) =>
        handleListAutomationRuns(params, deps));
      router.registerProduct(DAEMON_METHODS.PARSE_AUTOMATION_DRAFT, async (params) =>
        handleParseAutomationDraft(params));
      router.registerProduct(DAEMON_METHODS.LIST_AUTOMATION_TEMPLATES, async () =>
        handleListAutomationTemplates());
    },
    start: async (context) => {
      await reconcileAutomationRuns({
        store: context.automationStore,
        channelStore: context.channelStore,
        durable: {
          db: context.store.db,
          executionStore: context.executionStore,
        },
      });
      await context.schedulerHost.start();
    },
    stop: (context) => context.schedulerHost.stop(),
  };
}

function automationDeps(context: ForgeDaemonContext): AutomationServiceDeps {
  return {
    sessions: context.sessions,
    getStore: () => context.automationStore,
    getChannelStore: () => context.channelStore,
    getScheduler: () => context.schedulerHost,
    getDurable: () => ({
      db: context.store.db,
      executionStore: context.executionStore,
      executor: context.executor,
      clock: context.executionClock,
      governance: context.automationGovernance,
    }),
  };
}
