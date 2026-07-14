import { join } from "node:path";
import { homedir } from "node:os";
import { createBuiltinRegistry, type ToolRegistry } from "@forge/tools";
import { buildAgentContext, formatContextForPrompt } from "@forge/context";
import { MemoryStore, registerMemoryTools } from "@forge/memory";
import { registerNetworkTools } from "@forge/tool-network";
import { registerSoftwareTools } from "@forge/tool-software";
import {
  formatActiveSkillBlock,
  listSkillBundledFiles,
  formatSkillCatalog,
  loadSkills,
  loadSkillsFromPaths,
  filterSkillsByConfig,
  type SkillDoc,
} from "@forge/skill-registry";
import {
  attachToolHooks,
  discoverHooks,
  runSessionStartHooks,
  runUserPromptSubmitHooks,
  type HookBinding,
  type HookRunContext,
  type SessionHookSource,
} from "@forge/hooks";
import { findSkillById, resolveSkill } from "@forge/skill-registry";
import { loadMcpServers } from "@forge/config";
import {
  collectPluginMcpServers,
  collectPluginSkillPaths,
  discoverPlugins,
  type DiscoveredPlugin,
} from "@forge/plugin-registry";
import {
  attachMcpTools,
  getMcpClientPool,
  registryHasMcpFilesystemWrites,
  type McpClient,
} from "@forge/tool-mcp";
import type { WorkspaceGuard } from "@forge/workspace";
import {
  buildInitialMessages,
  buildUserMessageContent,
  countImagesInUserContent,
  countParsedDocumentAttachments,
  prepareAttachmentsForVision,
} from "@forge/agent-core";
import type {
  AutomationRunContext,
  ChatMessage,
  ForgeConfig,
  RunAttachment,
} from "@forge/protocol";

export interface ForgeRuntime {
  memory: MemoryStore;
  skills: SkillDoc[];
  plugins: DiscoveredPlugin[];
  dataDir: string;
  monorepoRoot: string;
  config?: Partial<ForgeConfig>;
}

const projectPluginsByCwd = new Map<string, DiscoveredPlugin[]>();

export function clearProjectPluginCache(): void {
  projectPluginsByCwd.clear();
}

function getProjectPlugins(
  cwd: string,
  config?: Partial<ForgeConfig>,
): DiscoveredPlugin[] {
  if (!projectPluginsByCwd.has(cwd)) {
    projectPluginsByCwd.set(
      cwd,
      discoverPlugins({
        projectDir: defaultProjectPluginsDir(cwd),
        config,
      }),
    );
  }
  return projectPluginsByCwd.get(cwd)!;
}

export async function createForgeRuntime(options: {
  dbPath: string;
  skillsDir: string;
  dataDir: string;
  monorepoRoot: string;
  config?: Partial<ForgeConfig>;
}): Promise<ForgeRuntime> {
  const memory = new MemoryStore(options.dbPath);
  const plugins = discoverPlugins({
    builtinDir: defaultBuiltinPluginsDir(options.monorepoRoot),
    userDir: defaultUserPluginsDir(options.dataDir),
    config: options.config,
  });
  const pluginSkills = await loadSkillsFromPaths(collectPluginSkillPaths(plugins));
  const userSkills = await loadSkills(defaultUserSkillsDir());
  const skills = filterSkillsByConfig(
    [
      ...(await loadSkills(options.skillsDir)),
      ...pluginSkills,
      ...userSkills,
    ],
    options.config,
  );
  return {
    memory,
    skills,
    plugins,
    dataDir: options.dataDir,
    monorepoRoot: options.monorepoRoot,
    config: options.config,
  };
}

/** Outcome of resolving a focused talent's bound skill ids against the catalog. */
export interface TalentSkillResolution {
  /** Bound skill ids/names requested by the talent. */
  requested: string[];
  /** Of those, the ids that resolved to an installed skill. */
  matched: string[];
  /** Requested ids that don't match any installed skill. */
  missing: string[];
  /** Whether strict mode restricted the catalog to `matched`. */
  strict: boolean;
}

export function resolveTalentSkillCatalog(
  configuredSkills: SkillDoc[],
  requestedTalentSkills: string[] = [],
  strictTalentSkills = false,
): { skills: SkillDoc[]; resolution?: TalentSkillResolution } {
  if (!requestedTalentSkills.length && !strictTalentSkills) {
    return { skills: configuredSkills };
  }
  const matched: string[] = [];
  const missing: string[] = [];
  const allowed = new Set<string>();
  for (const raw of requestedTalentSkills) {
    const skill = findSkillById(configuredSkills, raw);
    if (skill) {
      if (!allowed.has(skill.id)) {
        allowed.add(skill.id);
        matched.push(skill.id);
      }
    } else {
      missing.push(raw);
    }
  }
  const resolution: TalentSkillResolution = {
    requested: requestedTalentSkills,
    matched,
    missing,
    strict: strictTalentSkills,
  };
  return {
    skills: strictTalentSkills
      ? configuredSkills.filter((skill) => allowed.has(skill.id))
      : configuredSkills,
    resolution,
  };
}

export async function prepareRunContext(options: {
  runtime: ForgeRuntime;
  guard: WorkspaceGuard;
  message: string;
  sessionId?: string;
  sessionHookSource?: SessionHookSource;
  explicitFiles?: string[];
  attachments?: RunAttachment[];
  automationRun?: AutomationRunContext;
  projectId: string;
  dataDir: string;
  /** Bound skills of the focused talent, prioritized during skill matching. */
  talentSkillIds?: string[];
  /**
   * When true, the run's skill catalog is restricted to the focused talent's
   * `talentSkillIds`. Other skills are neither offered in the catalog nor
   * loadable, mirroring how the tool allowance gates tools.
   */
  strictTalentSkills?: boolean;
}): Promise<{
  messages: Awaited<ReturnType<typeof buildInitialMessages>>;
  registry: ToolRegistry;
  mcpToolCount: number;
  mcpClients: McpClient[];
  releaseMcp: () => void;
  preloadedSkill: SkillDoc | null;
  skillMatchMode: "explicit" | "implicit" | "catalog";
  hookContextBlock: string;
  hooksApplied: string[];
  hookBindings: HookBinding[];
  hookCtx: HookRunContext;
  allSkills: SkillDoc[];
  skillRoots: string[];
  loadedSkillCount: number;
  talentSkillResolution?: TalentSkillResolution;
  supportsNativeImageUrl: boolean;
  visionStrategy: import("@forge/agent-core").VisionStrategy;
  visionSkipReason?: string;
}> {
  const ctx = await buildAgentContext({
    guard: options.guard,
    userMessage: options.message,
    explicitFiles: options.explicitFiles,
  });
  const formatted = formatContextForPrompt(ctx);
  const projectPlugins = getProjectPlugins(
    options.guard.cwdPath,
    options.runtime.config,
  );
  const projectForgeSkills = await loadSkills(
    join(options.guard.cwdPath, ".forge", "skills"),
  );
  const projectSkills = await loadSkillsFromPaths(
    collectPluginSkillPaths(projectPlugins),
  );
  const configuredSkills = filterSkillsByConfig(
    [...options.runtime.skills, ...projectForgeSkills, ...projectSkills],
    options.runtime.config,
  );
  const { skills: allSkills, resolution: talentSkillResolution } =
    resolveTalentSkillCatalog(
      configuredSkills,
      options.talentSkillIds,
      Boolean(options.strictTalentSkills),
    );
  const resolved = resolveSkill(allSkills, options.message, {
    preferredSkillIds: talentSkillResolution?.matched,
  });
  const preloadedSkill =
    resolved.mode === "explicit" || resolved.mode === "implicit"
      ? resolved.skill
      : null;
  const skillMatchMode = preloadedSkill
    ? resolved.mode === "explicit"
      ? "explicit"
      : "implicit"
    : "catalog";

  const enabledPlugins = [
    ...new Map(
      [...options.runtime.plugins, ...projectPlugins]
        .filter((p) => p.enabled)
        .map((p) => [p.manifest.id, p] as const),
    ).values(),
  ];
  const hookBindings = discoverHooks({
    cwd: options.guard.cwdPath,
    dataDir: options.dataDir,
    plugins: enabledPlugins,
  });
  const hookCtx = {
    cwd: options.guard.cwdPath,
    sessionId: options.sessionId ?? "anonymous",
    message: options.message,
    source: options.sessionHookSource ?? "startup",
  };
  const sessionHook = await runSessionStartHooks({
    bindings: hookBindings,
    ctx: hookCtx,
    skills: allSkills,
  });
  const promptHook = await runUserPromptSubmitHooks({
    bindings: hookBindings,
    ctx: hookCtx,
    skills: allSkills,
  });
  if (promptHook.blocked) {
    throw new Error(
      promptHook.blockReason ?? "UserPromptSubmit hook blocked this prompt",
    );
  }
  const hookContextBlock = [sessionHook.context, promptHook.context]
    .filter(Boolean)
    .join("\n\n");
  const hookResults = [...sessionHook.results, ...promptHook.results];
  const hooksApplied = [
    ...new Set(
      hookResults.filter((r) => r.ok && r.context).map((r) => r.sourceId),
    ),
  ];

  const memoryBlock = options.runtime.memory.formatPack(
    options.projectId,
    options.message,
  );

  const registry = createBuiltinRegistry();
  attachToolHooks(registry, {
    bindings: hookBindings,
    ctx: hookCtx,
    skills: allSkills,
    toolResultMaxChars:
      (options.runtime.config as ForgeConfig | undefined)?.limits
        ?.toolResultMaxChars,
  });
  registerMemoryTools(registry, options.runtime.memory, options.projectId);

  const config = options.runtime.config as ForgeConfig | undefined;
  const networkToolCount = registerNetworkTools(registry, {
    permissions: config?.permissions,
    networkService: config?.network,
    auditDataDir: options.dataDir,
    sessionId: options.sessionId,
  });
  if (networkToolCount > 0) {
    console.log(`[forge] Network tools: ${networkToolCount} registered`);
  }

  const softwareToolCount = registerSoftwareTools(registry, {
    permissions: config?.permissions,
  });
  if (softwareToolCount > 0) {
    console.log(`[forge] Software tools: ${softwareToolCount} registered`);
  }

  const mcpServers = loadMcpServers(
    options.dataDir,
    options.guard.cwdPath,
  );
  const pluginMcpServers = collectPluginMcpServers([
    ...options.runtime.plugins,
    ...projectPlugins,
  ]);
  const allMcpServers = [...mcpServers, ...pluginMcpServers];
  const { clients: mcpClients, release: releaseMcp } =
    await getMcpClientPool().acquire(options.guard.cwdPath, allMcpServers);
  const mcpToolCount = await attachMcpTools(registry, mcpClients);

  const useMcpFileWrite = registryHasMcpFilesystemWrites(registry.definitions);
  if (useMcpFileWrite) {
    registry.remove("write_file");
    registry.remove("write_patch");
    console.log(
      "[forge] MCP filesystem write tools detected — disabled built-in write_file/write_patch",
    );
  }

  const bundledFiles = preloadedSkill
    ? await listSkillBundledFiles(preloadedSkill)
    : [];
  const skillRoots = [...new Set(allSkills.map((s) => s.root))];

  const visionPrep = config
    ? prepareAttachmentsForVision(config, options.attachments)
    : {
        attachments: options.attachments,
        supportsNativeImageUrl: false,
        strategy: "none" as const,
        skippedImages: 0,
      };
  const attachments = visionPrep.attachments;
  const supportsNativeImageUrl = visionPrep.supportsNativeImageUrl;

  const userContent = buildUserMessageContent(
    options.message,
    attachments,
    supportsNativeImageUrl,
  );
  const visionImagesInTurn = countImagesInUserContent(userContent) > 0;
  const documentFilesInTurn =
    countParsedDocumentAttachments(attachments) > 0;

  const messages = await buildInitialMessages(
    options.guard,
    options.message,
    {
      agentsMd: formatted.agentsMd,
      gitStatus: formatted.gitStatus,
      extraFiles: formatted.extraFiles,
      skillCatalogBlock: formatSkillCatalog(allSkills),
      skillBlock: preloadedSkill
        ? formatActiveSkillBlock(preloadedSkill, bundledFiles)
        : undefined,
      hookContextBlock: hookContextBlock || undefined,
      memoryBlock: memoryBlock || undefined,
      fileWriteTools: useMcpFileWrite ? "mcp" : "builtin",
      permissions: config?.permissions,
      automationRun: options.automationRun,
      userContent,
      visionImagesInTurn,
      documentFilesInTurn,
    },
  );

  return {
    messages,
    registry,
    mcpToolCount,
    mcpClients,
    releaseMcp,
    preloadedSkill,
    skillMatchMode,
    hookContextBlock,
    hooksApplied,
    hookBindings,
    hookCtx,
    allSkills,
    skillRoots,
    loadedSkillCount: allSkills.length,
    talentSkillResolution,
    supportsNativeImageUrl,
    visionStrategy: visionPrep.strategy,
    visionSkipReason: visionPrep.skipReason,
  };
}

export async function resolveProjectHooks(
  cwd: string,
  runtime: ForgeRuntime,
): Promise<{ bindings: HookBinding[]; skills: SkillDoc[] }> {
  const projectPlugins = getProjectPlugins(cwd, runtime.config);
  const enabledPlugins = [
    ...new Map(
      [...runtime.plugins, ...projectPlugins]
        .filter((p) => p.enabled)
        .map((p) => [p.manifest.id, p] as const),
    ).values(),
  ];
  const projectForgeSkills = await loadSkills(join(cwd, ".forge", "skills"));
  const projectSkills = await loadSkillsFromPaths(
    collectPluginSkillPaths(projectPlugins),
  );
  const skills = filterSkillsByConfig(
    [...runtime.skills, ...projectForgeSkills, ...projectSkills],
    runtime.config,
  );
  const bindings = discoverHooks({
    cwd,
    dataDir: runtime.dataDir,
    plugins: enabledPlugins,
  });
  return { bindings, skills };
}

export function defaultSkillsDir(monorepoRoot: string): string {
  return join(monorepoRoot, "skills");
}

export function defaultUserSkillsDir(): string {
  return join(homedir(), ".forge-agent", "skills");
}

export function defaultBuiltinPluginsDir(monorepoRoot: string): string {
  return join(monorepoRoot, "plugins");
}

export function defaultUserPluginsDir(dataDir: string): string {
  return join(dataDir, "plugins");
}

export function defaultProjectPluginsDir(cwd: string): string {
  return join(cwd, ".forge", "plugins");
}

/** Fresh system + per-turn context; replay tool history without stale system rows. */
export function assembleRunMessages(
  freshMessages: ChatMessage[],
  history: ChatMessage[],
): ChatMessage[] {
  const systemMsg = freshMessages.find((m) => m.role === "system");
  const turnUser = [...freshMessages].reverse().find((m) => m.role === "user");
  if (!systemMsg || !turnUser) return freshMessages;
  if (history.length === 0) return freshMessages;

  const hist = history.filter((m) => m.role !== "system");
  return [systemMsg, ...hist, turnUser];
}
