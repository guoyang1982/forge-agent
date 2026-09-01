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
  type AutomationServiceDeps,
} from "../services/automation-service.js";
import type { ForgeDaemonContext } from "./context.js";

export function createAutomationModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "automation",
    feature: { version: 1, enabled: true },
    register(router, context) {
      const deps = automationDeps(context);
      router.registerLegacy(DAEMON_METHODS.LIST_AUTOMATIONS, async (params) =>
        handleListAutomations(params, deps));
      router.registerLegacy(DAEMON_METHODS.GET_AUTOMATION, async (params) =>
        handleGetAutomation(params, deps));
      router.registerLegacy(DAEMON_METHODS.CREATE_AUTOMATION, async (params) =>
        handleCreateAutomation(params, deps));
      router.registerLegacy(DAEMON_METHODS.UPDATE_AUTOMATION, async (params) =>
        handleUpdateAutomation(params, deps));
      router.registerLegacy(DAEMON_METHODS.DELETE_AUTOMATION, async (params) =>
        handleDeleteAutomation(params, deps));
      router.registerLegacy(DAEMON_METHODS.RUN_AUTOMATION, async (params, rpc) =>
        handleRunAutomation(params, deps, rpc.emitLegacyAgentEvent));
      router.registerLegacy(DAEMON_METHODS.LIST_AUTOMATION_RUNS, async (params) =>
        handleListAutomationRuns(params, deps));
      router.registerLegacy(DAEMON_METHODS.PARSE_AUTOMATION_DRAFT, async (params) =>
        handleParseAutomationDraft(params));
      router.registerLegacy(DAEMON_METHODS.LIST_AUTOMATION_TEMPLATES, async () =>
        handleListAutomationTemplates());
    },
    start: (context) => context.schedulerHost.start(),
    stop: (context) => context.schedulerHost.stop(),
  };
}

function automationDeps(context: ForgeDaemonContext): AutomationServiceDeps {
  return {
    sessions: context.sessions,
    getStore: () => context.automationStore,
    getChannelStore: () => context.channelStore,
    getScheduler: () => context.schedulerHost,
    getRunDeps: () => ({
      sessions: context.sessions,
      getRuntime: context.getRuntime,
      cancelService: context.cancelService,
      executeDurableAutomation: context.executeDurableAutomation,
    }),
  };
}
