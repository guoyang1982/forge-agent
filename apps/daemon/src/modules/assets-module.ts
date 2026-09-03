import { DAEMON_METHODS } from "@forge/protocol";
import type { DaemonModule } from "../host/types.js";
import {
  handleGetConfig,
  handleListMcp,
  handleListPlugins,
  handleListSkills,
} from "../services/app-service.js";
import {
  handleHubDeploy,
  handleHubDiscover,
  handleHubImport,
  handleHubInstall,
  handleHubList,
  handleHubRemove,
  handleHubSync,
  handleHubUndeploy,
} from "../services/hub-service.js";
import {
  handleImportPlugin,
  handleImportSkill,
  handleSearchCatalog,
  handleSearchPluginsMarketplace,
  handleSearchSkillsMarketplace,
  handleSetPluginEnabled,
  handleSetSkillEnabled,
} from "../services/marketplace-service.js";
import {
  handleCreateCustomTalent,
  handleCreateTalentTeam,
  handleDeleteCustomTalent,
  handleDeleteTalentTeam,
  handleFireTalent,
  handleGetTalentTemplate,
  handleHireTalent,
  handleListTalentAgentMemory,
  handleListTalentAgentRuns,
  handleListTalentRoster,
  handleListTalentTeams,
  handleListTalentTemplates,
  handleRenameTalent,
  handleTalentSyncTemplates,
  handleUpdateCustomTalent,
  handleUpdateTalentBindings,
  handleUpdateTalentTeam,
  seedTalentTemplates,
} from "../services/talent-service.js";
import type { ForgeDaemonContext } from "./context.js";

export function createAssetsModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "assets",
    feature: { version: 1, enabled: true },
    register(router, context) {
      const data = { dataDir: context.dataDir };
      const runtimeFiles = {
        monorepoRoot: context.monorepoRoot,
        dataDir: context.dataDir,
      };
      router.registerProduct(DAEMON_METHODS.LIST_PLUGINS, async (params) =>
        handleListPlugins(params, runtimeFiles));
      router.registerProduct(DAEMON_METHODS.LIST_SKILLS, async (params) =>
        handleListSkills(params, { getRuntime: context.getRuntime }));
      router.registerProduct(DAEMON_METHODS.LIST_MCP, async (params) =>
        handleListMcp(params, runtimeFiles));
      router.registerProduct(DAEMON_METHODS.GET_CONFIG, async (params) =>
        handleGetConfig(params));
      router.registerProduct(DAEMON_METHODS.RELOAD_RUNTIME, async () =>
        context.reloadRuntime());
      router.registerProduct(DAEMON_METHODS.SEARCH_CATALOG, async (params) =>
        handleSearchCatalog(params));
      router.registerProduct(DAEMON_METHODS.SEARCH_SKILLS_MARKETPLACE, async (params) =>
        handleSearchSkillsMarketplace(params));
      router.registerProduct(DAEMON_METHODS.SEARCH_PLUGINS_MARKETPLACE, async (params) =>
        handleSearchPluginsMarketplace(params));
      router.registerProduct(DAEMON_METHODS.HUB_LIST, async (params) =>
        handleHubList(params, data));
      router.registerProduct(DAEMON_METHODS.HUB_INSTALL, async (params) =>
        mutateAndReload(() => handleHubInstall(params, data), context));
      router.registerProduct(DAEMON_METHODS.HUB_DEPLOY, async (params) =>
        mutateAndReload(() => handleHubDeploy(params, data), context));
      router.registerProduct(DAEMON_METHODS.HUB_UNDEPLOY, async (params) =>
        mutateAndReload(() => handleHubUndeploy(params, data), context));
      router.registerProduct(DAEMON_METHODS.HUB_REMOVE, async (params) =>
        mutateAndReload(() => handleHubRemove(params, data), context));
      router.registerProduct(DAEMON_METHODS.HUB_SYNC, async (params) =>
        mutateAndReload(() => handleHubSync(params, data), context));
      router.registerProduct(DAEMON_METHODS.HUB_DISCOVER, async (params) =>
        handleHubDiscover(params, data));
      router.registerProduct(DAEMON_METHODS.HUB_IMPORT, async (params) =>
        mutateAndReload(() => handleHubImport(params, data), context));
      router.registerProduct(DAEMON_METHODS.SET_SKILL_ENABLED, async (params) =>
        handleSetSkillEnabled(params));
      router.registerProduct(DAEMON_METHODS.SET_PLUGIN_ENABLED, async (params) =>
        handleSetPluginEnabled(params));
      router.registerProduct(DAEMON_METHODS.IMPORT_SKILL, async (params) =>
        mutateAndReload(() => handleImportSkill(params, data), context));
      router.registerProduct(DAEMON_METHODS.IMPORT_PLUGIN, async (params) =>
        mutateAndReload(() => handleImportPlugin(params, data), context));
      registerTalentMethods(router, data);
    },
    async start(context) {
      try {
        const { seeded } = await seedTalentTemplates({ dataDir: context.dataDir });
        if (seeded > 0) {
          console.log(`[forge] seeded ${seeded} bundled talent templates`);
        }
      } catch (error) {
        console.warn(`[forge] talent template seeding skipped: ${String(error)}`);
      }
    },
  };
}

function registerTalentMethods(
  router: Parameters<DaemonModule<ForgeDaemonContext>["register"]>[0],
  data: { dataDir: string },
): void {
  router.registerProduct(DAEMON_METHODS.TALENTS_SYNC_TEMPLATES, async (params) =>
    handleTalentSyncTemplates(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_LIST_TEMPLATES, async (params) =>
    handleListTalentTemplates(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_HIRE, async (params) =>
    handleHireTalent(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_FIRE, async (params) =>
    handleFireTalent(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_LIST_ROSTER, async (params) =>
    handleListTalentRoster(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_RENAME, async (params) =>
    handleRenameTalent(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_UPDATE_BINDINGS, async (params) =>
    handleUpdateTalentBindings(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_GET_TEMPLATE, async (params) =>
    handleGetTalentTemplate(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_CREATE_CUSTOM, async (params) =>
    handleCreateCustomTalent(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_UPDATE_CUSTOM, async (params) =>
    handleUpdateCustomTalent(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_DELETE_CUSTOM, async (params) =>
    handleDeleteCustomTalent(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_LIST_TEAMS, async (params) =>
    handleListTalentTeams(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_CREATE_TEAM, async (params) =>
    handleCreateTalentTeam(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_UPDATE_TEAM, async (params) =>
    handleUpdateTalentTeam(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_DELETE_TEAM, async (params) =>
    handleDeleteTalentTeam(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_LIST_AGENT_RUNS, async (params) =>
    handleListTalentAgentRuns(params, data));
  router.registerProduct(DAEMON_METHODS.TALENTS_LIST_AGENT_MEMORY, async (params) =>
    handleListTalentAgentMemory(params, data));
}

async function mutateAndReload<Result>(
  operation: () => Promise<Result>,
  context: ForgeDaemonContext,
): Promise<Result> {
  const result = await operation();
  await context.reloadRuntime();
  return result;
}
