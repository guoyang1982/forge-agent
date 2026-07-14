import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, formatConfigForDisplay, loadMcpServers } from "@forge/config";
import type {
  GetSessionMessagesRequest,
  GetSessionMessagesResult,
  GetConfigResult,
  ListMcpRequest,
  ListMcpResult,
  McpListItem,
  ListPluginsRequest,
  ListPluginsResult,
  ListSessionsRequest,
  ListSessionsResult,
  ListSkillsRequest,
  ListSkillsResult,
  SkillListItem,
} from "@forge/protocol";
import type { SessionStore } from "@forge/session";
import {
  loadSkills,
  loadSkillsFromPaths,
  skillEnabledInConfig,
  type SkillDoc,
} from "@forge/skill-registry";
import {
  collectPluginSkillPaths,
  discoverPlugins,
  type DiscoveredPlugin,
  type PluginMcpServer,
} from "@forge/plugin-registry";
import {
  defaultBuiltinPluginsDir,
  defaultProjectPluginsDir,
  defaultSkillsDir,
  defaultUserSkillsDir,
  defaultUserPluginsDir,
  type ForgeRuntime,
} from "../runtime.js";

export function handleSearchSessions(
  params: unknown,
  deps: { sessions: SessionStore },
): { hits: ReturnType<SessionStore["searchSessions"]> } {
  const req = params as { query?: string; limit?: number } | undefined;
  return {
    hits: deps.sessions.searchSessions(String(req?.query ?? ""), req?.limit ?? 20),
  };
}

export function handleListSessions(
  params: unknown,
  deps: { sessions: SessionStore },
): ListSessionsResult {
  const req = params as ListSessionsRequest | undefined;
  return {
    sessions: deps.sessions.listSessions(req?.limit ?? 20),
  };
}

export function handleListPlugins(
  params: unknown,
  deps: { monorepoRoot: string; dataDir: string },
): ListPluginsResult {
  const req = params as ListPluginsRequest | undefined;
  const cwd = req?.cwd ?? process.cwd();
  const plugins = discoverPlugins({
    builtinDir: defaultBuiltinPluginsDir(deps.monorepoRoot),
    userDir: defaultUserPluginsDir(deps.dataDir),
    projectDir: defaultProjectPluginsDir(cwd),
    config: loadConfig({ cwd }),
  });

  return {
    plugins: plugins.map(toPluginListItem),
  };
}

function toSkillListItem(
  skill: SkillDoc,
  groupId: string,
  cfg: ReturnType<typeof loadConfig>,
): SkillListItem {
  const manageable = groupId === "user" || groupId === "builtin";
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers,
    format: skill.format,
    path: skill.path,
    source: groupId,
    enabled: skillEnabledInConfig(skill.id, cfg),
    manageable,
  };
}

async function loadUserSkills(): Promise<SkillDoc[]> {
  return loadSkills(defaultUserSkillsDir());
}

export async function handleListSkills(
  params: unknown,
  deps: { getRuntime: () => Promise<ForgeRuntime> },
): Promise<ListSkillsResult> {
  const req = params as ListSkillsRequest | undefined;
  const cwd = req?.cwd ?? process.cwd();
  const rt = await deps.getRuntime();
  const cfg = loadConfig({ cwd });

  const builtin = await loadSkills(defaultSkillsDir(rt.monorepoRoot));
  const plugin = await loadSkillsFromPaths(
    collectPluginSkillPaths(rt.plugins.filter((p) => p.enabled)),
  );
  const projectPlugins = discoverPlugins({
    projectDir: defaultProjectPluginsDir(cwd),
    config: cfg,
  });
  const project = await loadSkillsFromPaths(
    collectPluginSkillPaths(projectPlugins.filter((p) => p.enabled)),
  );
  const user = await loadUserSkills();

  return {
    groups: [
      {
        id: "builtin",
        title: "Forge 内置",
        skills: builtin.map((s) => toSkillListItem(s, "builtin", cfg)),
      },
      {
        id: "plugin",
        title: "插件 Skill",
        skills: plugin.map((s) => toSkillListItem(s, "plugin", cfg)),
      },
      {
        id: "project",
        title: "项目 Skill",
        skills: project.map((s) => toSkillListItem(s, "project", cfg)),
      },
      {
        id: "user",
        title: "用户已安装",
        skills: user.map((s) => toSkillListItem(s, "user", cfg)),
      },
    ],
  };
}

function toMcpListItem(
  m: PluginMcpServer,
  source: string,
  managedInConfig: boolean,
): McpListItem {
  return {
    name: m.name,
    command: m.command,
    args: m.args ?? [],
    enabled: m.enabled !== false,
    source,
    managedInConfig,
  };
}

export function handleListMcp(
  params: unknown,
  deps: { monorepoRoot: string; dataDir: string },
): ListMcpResult {
  const req = params as ListMcpRequest | undefined;
  const cwd = req?.cwd ?? process.cwd();
  const cfg = loadConfig({ cwd });
  const configuredNames = new Set<string>();
  const configured: McpListItem[] = [];

  for (const s of cfg.mcp?.servers ?? []) {
    configuredNames.add(s.name);
    configured.push({
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      enabled: s.enabled !== false,
      source: "config",
      managedInConfig: true,
    });
  }

  for (const s of loadMcpServers(deps.dataDir, cwd)) {
    if (configuredNames.has(s.name)) continue;
    configuredNames.add(s.name);
    configured.push({
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      enabled: s.enabled !== false,
      source: "mcp.json",
      managedInConfig: true,
    });
  }

  const plugins = discoverPlugins({
    builtinDir: defaultBuiltinPluginsDir(deps.monorepoRoot),
    userDir: defaultUserPluginsDir(deps.dataDir),
    projectDir: defaultProjectPluginsDir(cwd),
    config: cfg,
  });

  const installed: McpListItem[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    for (const m of plugin.manifest.capabilities?.mcpServers ?? []) {
      installed.push(
        toMcpListItem(m, `plugin:${plugin.manifest.id}`, configuredNames.has(m.name)),
      );
    }
  }

  const examplePath = join(deps.monorepoRoot, "mcp.json.example");
  if (existsSync(examplePath)) {
    try {
      const example = JSON.parse(readFileSync(examplePath, "utf-8")) as {
        servers?: PluginMcpServer[];
      };
      for (const m of example.servers ?? []) {
        installed.push(toMcpListItem(m, "mcp.json.example", configuredNames.has(m.name)));
      }
    } catch {
      /* ignore invalid example file */
    }
  }

  const unconfiguredCount = installed.filter((m) => !m.managedInConfig).length;

  return { installed, configured, unconfiguredCount };
}

export function handleGetConfig(params: unknown): GetConfigResult {
  const req = params as { cwd?: string } | undefined;
  return {
    config: formatConfigForDisplay(loadConfig({ cwd: req?.cwd })),
  };
}

export function handleGetSessionMessages(
  params: unknown,
  deps: { sessions: SessionStore },
): GetSessionMessagesResult {
  const req = params as GetSessionMessagesRequest;
  if (!req?.sessionId) {
    throw new Error("sessionId is required");
  }
  return {
    sessionId: req.sessionId,
    messages: deps.sessions.loadMessages(req.sessionId, req.limit ?? 400),
    checkpoints: deps.sessions.listCheckpoints(req.sessionId),
    dispatchPlans: deps.sessions.listDispatchPlans(req.sessionId),
  };
}

function toPluginListItem(plugin: DiscoveredPlugin): ListPluginsResult["plugins"][number] {
  const caps = plugin.manifest.capabilities ?? {};
  return {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    description: plugin.manifest.description,
    source: plugin.source,
    enabled: plugin.enabled,
    root: plugin.root,
    capabilities: {
      skills: caps.skills?.length ?? 0,
      mcpServers: caps.mcpServers?.length ?? 0,
      commands: caps.commands?.length ?? 0,
      workflows: caps.workflows?.length ?? 0,
    },
  };
}
