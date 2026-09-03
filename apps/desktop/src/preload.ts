import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentEvent,
  ForgeConfig,
  HubAgentId,
  HubDiscoverResult,
  HubExtensionKind,
  HubListResult,
  HubMutationResult,
  HubSyncResult,
  MobileCreatePairingRequest,
  MobileCreatePairingResult,
  MobileListDevicesRequest,
  MobileListDevicesResult,
  MobileRevokeDeviceRequest,
  MobileRevokeDeviceResult,
  MobileUpdateDeviceProjectsRequest,
  MobileUpdateDeviceProjectsResult,
  RunAttachment,
  RunRequest,
  SessionHookSource,
  TraceGetResult,
} from "@forge/protocol";
import type { HooksSettingsFile, HooksSettingsScope } from "@forge/hooks";

type RunPayload = {
  cwd: string;
  message: string;
  sessionId?: string | null;
  hookSource?: SessionHookSource;
  clientRunId?: string;
  runtime?: RunRequest["runtime"];
  autoApply?: boolean;
  files?: string[];
  attachments?: RunAttachment[];
};

const api = {
  getConfig: () => ipcRenderer.invoke("forge:get-config") as Promise<ForgeConfig>,
  getDefaultCwd: () => ipcRenderer.invoke("forge:get-default-cwd") as Promise<string>,
  getGitBranches: (payload: { cwd: string }) =>
    ipcRenderer.invoke("forge:get-git-branches", payload) as Promise<{
      isRepo: boolean;
      current: string | null;
      detached: boolean;
      branches: string[];
    }>,
  switchGitBranch: (payload: { cwd: string; branch: string }) =>
    ipcRenderer.invoke("forge:switch-git-branch", payload) as Promise<{
      ok: boolean;
      current?: string;
      message?: string;
    }>,
  pickDirectory: () =>
    ipcRenderer.invoke("forge:pick-directory") as Promise<string | null>,
  pickAttachments: () =>
    ipcRenderer.invoke("forge:pick-attachments") as Promise<{ items: RunAttachment[] }>,
  readAttachmentPaths: (paths: string[]) =>
    ipcRenderer.invoke("forge:read-attachment-paths", paths) as Promise<{
      items: RunAttachment[];
    }>,
  extractAttachmentBytes: (payload: { name: string; base64: string }) =>
    ipcRenderer.invoke("forge:extract-attachment-bytes", payload) as Promise<{
      attachment: RunAttachment | null;
    }>,
  readWorkspaceFile: (payload: { cwd: string; path: string }) =>
    ipcRenderer.invoke("forge:read-workspace-file", payload) as Promise<{
      path: string;
      content: string;
    }>,
  readWorkspaceImage: (payload: { cwd: string; path: string }) =>
    ipcRenderer.invoke("forge:read-workspace-image", payload) as Promise<{
      path: string;
      dataUrl: string;
      mimeType: string;
    }>,
  getWorkspaceTurnDiffs: (payload: { cwd: string; baseSha?: string }) =>
    ipcRenderer.invoke("forge:workspace-turn-diffs", payload) as Promise<{
      ok: boolean;
      files: Array<{ path: string; unifiedDiff: string }>;
      message?: string;
    }>,
  listWorkspaceDir: (payload: { cwd: string; path?: string }) =>
    ipcRenderer.invoke("forge:list-workspace-dir", payload) as Promise<{
      rootName: string;
      path: string;
      items: Array<{ name: string; path: string; type: "file" | "dir" }>;
    }>,
  saveConfig: (patch: Partial<ForgeConfig>) =>
    ipcRenderer.invoke("forge:save-config", patch) as Promise<ForgeConfig>,
  saveConfigJson: (fullConfig: ForgeConfig) =>
    ipcRenderer.invoke("forge:save-config-json", fullConfig) as Promise<ForgeConfig>,
  switchProfile: (profileId: string, modelId?: string) =>
    ipcRenderer.invoke("forge:switch-profile", profileId, modelId) as Promise<ForgeConfig>,
  listCodexModels: (payload?: { cwd?: string }) =>
    ipcRenderer.invoke("forge:list-codex-models", payload ?? {}) as Promise<{
      models: Array<{
        id: string;
        model: string;
        displayName: string;
        description?: string;
        defaultReasoningEffort?: string | null;
        supportedReasoningEfforts?: string[];
        isDefault?: boolean;
      }>;
    }>,
  listCursorModels: (payload?: { cwd?: string }) =>
    ipcRenderer.invoke("forge:list-cursor-models", payload ?? {}) as Promise<{
      models: Array<{
        id: string;
        model: string;
        displayName: string;
        description?: string;
        isDefault?: boolean;
      }>;
    }>,
  probeCursorRuntime: (payload?: { cwd?: string }) =>
    ipcRenderer.invoke("forge:probe-cursor-runtime", payload ?? {}) as Promise<{
      provider: string;
      status: "ready" | "needs_setup" | "binary_missing" | "auth_required";
      message?: string;
      binaryPath?: string;
      modes?: Array<{ id: string; label: string; isDefault?: boolean }>;
      models?: Array<{
        id: string;
        model: string;
        displayName: string;
        description?: string;
        isDefault?: boolean;
      }>;
    }>,
  listRuntimes: (payload?: { cwd?: string }) =>
    ipcRenderer.invoke("forge:list-runtimes", payload ?? {}) as Promise<{
      providers: Array<{
        id: string;
        label: string;
        kind: "default" | "cli" | "acp" | "app-server";
        status: "ready" | "needs_setup" | "binary_missing" | "auth_required";
        message?: string;
        binaryPath?: string;
        modes?: Array<{ id: string; label: string; isDefault?: boolean }>;
        models?: Array<{
          id: string;
          model: string;
          displayName: string;
          description?: string;
          isDefault?: boolean;
        }>;
      }>;
    }>,
  closeAcpSession: (payload: { provider?: string; sessionId: string }) =>
    ipcRenderer.invoke("forge:close-acp-session", payload) as Promise<{
      ok: true;
      released: number;
    }>,
  releaseAcpForgeSession: (payload: { sessionId: string }) =>
    ipcRenderer.invoke("forge:release-acp-forge-session", payload) as Promise<{
      released: number;
    }>,
  listWarmAcpSessions: () =>
    ipcRenderer.invoke("forge:list-warm-acp-sessions") as Promise<{
      sessions: Array<{
        providerKey: string;
        forgeSessionId: string;
        cwd: string;
        model?: string;
        mode?: string;
        lastUsedAt: number;
        prewarm?: boolean;
      }>;
    }>,
  prewarmAcpSession: (payload: {
    provider?: string;
    cwd: string;
    model?: string;
    mode?: string;
    sandboxMode?: string;
  }) =>
    ipcRenderer.invoke("forge:prewarm-acp-session", payload) as Promise<{
      ok: boolean;
      skipped?: string;
    }>,
  listSessions: (limit = 80) =>
    ipcRenderer.invoke("forge:list-sessions", { limit }) as Promise<
      | Array<{ id: string; updatedAt: string; preview: string }>
      | { sessions: Array<{ id: string; updatedAt: string; preview: string }> }
    >,
  // Omit eventLimit by default so the daemon loads the full latest-turn journal
  // from session_start (up to its internal cap). A hard default like 1500 cuts
  // off `done` on long talent runs (10k+ thinking_delta rows) and the UI never
  // gets a conclusion card.
  getSessionMessages: (sessionId: string, limit = 400, eventLimit?: number) =>
    ipcRenderer.invoke("forge:get-session-messages", {
      sessionId,
      limit,
      ...(typeof eventLimit === "number" && Number.isFinite(eventLimit)
        ? { eventLimit }
        : {}),
    }) as Promise<{
      sessionId: string;
      messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }>;
        tool_call_id?: string;
      }>;
      events?: Array<{
        sequence: number;
        sessionId: string;
        turnIndex: number | null;
        eventType: string;
        itemId?: string;
        emittedAtMs: number;
        event: Record<string, unknown>;
      }>;
      checkpoints?: Array<{ turnIndex: number; sha: string }>;
      dispatchPlans?: Array<Record<string, unknown>>;
      page?: {
        truncated: boolean;
        messageIds: number[];
        oldestMessageId: number | null;
        oldestEventSequence: number | null;
      };
    }>,
  openExternal: (url: string) =>
    ipcRenderer.invoke("forge:open-external", url) as Promise<{ ok?: boolean }>,
  revealPath: (path: string) =>
    ipcRenderer.invoke("forge:reveal-path", path) as Promise<{ ok?: boolean }>,
  readSkillFile: (payload: { path: string }) =>
    ipcRenderer.invoke("forge:read-skill-file", payload) as Promise<{
      path: string;
      content: string;
    }>,
  listSkillDir: (payload: { skillPath: string; path?: string }) =>
    ipcRenderer.invoke("forge:list-skill-dir", payload) as Promise<{
      rootName: string;
      path: string;
      items: Array<{ name: string; path: string; type: "file" | "dir" }>;
    }>,
  listPluginDir: (payload: { pluginRoot: string; path?: string }) =>
    ipcRenderer.invoke("forge:list-plugin-dir", payload) as Promise<{
      rootName: string;
      path: string;
      items: Array<{ name: string; path: string; type: "file" | "dir" }>;
    }>,
  listSkills: (cwd?: string) =>
    ipcRenderer.invoke("forge:list-skills", cwd) as Promise<{
      groups: Array<{
        id: string;
        title: string;
        skills: Array<{
          id: string;
          name: string;
          description?: string;
          triggers: string[];
          source?: string;
          format?: string;
          path?: string;
          enabled?: boolean;
          manageable?: boolean;
        }>;
      }>;
    }>,
  listTalentRoster: (payload?: { cwd?: string }) =>
    ipcRenderer.invoke("forge:list-talent-roster", payload ?? {}) as Promise<{
      talents: Array<{
        instanceId: string;
        templateId: string;
        displayName: string;
        mention: string;
        role: string;
        category: string;
        description?: string;
        emoji?: string;
        enabled: boolean;
        skills: string[];
        tools: string[];
        permissionPreset: string;
        stats: { tasksDone: number; lastUsed: string | null };
      }>;
    }>,
  syncTalents: (payload?: { categories?: string[]; sourceDir?: string }) =>
    ipcRenderer.invoke("forge:sync-talents", payload ?? {}) as Promise<{
      count: number;
      skipped: number;
      source: "remote" | "local";
      notice?: string;
    }>,
  listTalentTemplates: (payload?: { category?: string; query?: string; cwd?: string }) =>
    ipcRenderer.invoke("forge:list-talent-templates", payload ?? {}) as Promise<{
      templates: Array<{
        id: string;
        category: string;
        role: string;
        description: string;
        vibe?: string;
        emoji?: string;
        hired: boolean;
      }>;
    }>,
  hireTalent: (payload: { templateId: string; displayName?: string; mention?: string; cwd?: string }) =>
    ipcRenderer.invoke("forge:hire-talent", payload) as Promise<{
      talent: {
        instanceId: string;
        displayName: string;
        mention: string;
        role: string;
        category: string;
      };
    }>,
  fireTalent: (payload: { instanceIdOrMention: string; cwd?: string }) =>
    ipcRenderer.invoke("forge:fire-talent", payload) as Promise<{ removed: boolean }>,
  renameTalent: (payload: {
    instanceIdOrMention: string;
    displayName?: string;
    mention?: string;
    cwd?: string;
  }) =>
    ipcRenderer.invoke("forge:rename-talent", payload) as Promise<{
      talent: {
        instanceId: string;
        displayName: string;
        mention: string;
        role: string;
        category: string;
        emoji?: string;
        enabled: boolean;
        skills: string[];
        tools: string[];
      };
    }>,
  updateTalentBindings: (payload: {
    instanceIdOrMention: string;
    skills?: string[];
    tools?: string[];
    enabled?: boolean;
    strictSkills?: boolean;
    cwd?: string;
  }) =>
    ipcRenderer.invoke("forge:update-talent-bindings", payload) as Promise<{
      talent: {
        instanceId: string;
        displayName: string;
        mention: string;
        role: string;
        category: string;
        emoji?: string;
        enabled: boolean;
        skills: string[];
        tools: string[];
      };
    }>,
  getTalentTemplate: (payload: { templateId: string }) =>
    ipcRenderer.invoke("forge:get-talent-template", payload) as Promise<{
      template: {
        id: string;
        role: string;
        category: string;
        description: string;
        emoji?: string;
        systemPrompt: string;
        suggestedSkills: string[];
        suggestedTools: string[];
      } | null;
    }>,
  createCustomTalent: (payload: { talent: Record<string, unknown> }) =>
    ipcRenderer.invoke("forge:create-custom-talent", payload) as Promise<{ template: Record<string, unknown> }>,
  updateCustomTalent: (payload: { templateId: string; patch: Record<string, unknown> }) =>
    ipcRenderer.invoke("forge:update-custom-talent", payload) as Promise<{ template: Record<string, unknown> }>,
  deleteCustomTalent: (payload: { templateId: string }) =>
    ipcRenderer.invoke("forge:delete-custom-talent", payload) as Promise<{ removed: boolean }>,
  listTalentTeams: (payload?: { cwd?: string }) =>
    ipcRenderer.invoke("forge:list-talent-teams", payload ?? {}) as Promise<{ teams: Array<Record<string, unknown>> }>,
  listTalentAgentRuns: (payload?: { cwd?: string; talentInstanceId?: string; limit?: number }) =>
    ipcRenderer.invoke("forge:list-talent-agent-runs", payload ?? {}) as Promise<{ runs: Array<Record<string, unknown>> }>,
  listTalentAgentMemory: (payload: { cwd?: string; talentInstanceId: string; limit?: number }) =>
    ipcRenderer.invoke("forge:list-talent-agent-memory", payload) as Promise<{ entries: Array<Record<string, unknown>> }>,
  createTalentTeam: (payload: Record<string, unknown> & { cwd?: string }) =>
    ipcRenderer.invoke("forge:create-talent-team", payload) as Promise<{ team: Record<string, unknown> }>,
  deleteTalentTeam: (payload: { idOrMention: string; cwd?: string }) =>
    ipcRenderer.invoke("forge:delete-talent-team", payload) as Promise<{ removed: boolean }>,
  searchSkillsMarketplace: (payload?: {
    query?: string;
    mode?: "featured" | "online" | "all";
    limit?: number;
  }) =>
    ipcRenderer.invoke("forge:search-skills-marketplace", payload) as Promise<{
      items: Array<{
        id: string;
        name: string;
        description: string;
        repo: string;
        subdir?: string;
        catalogId?: string;
        installs?: number;
        source: string;
        installed: boolean;
      }>;
      hint?: string;
    }>,
  searchPluginsMarketplace: (payload?: {
    query?: string;
    mode?: "featured" | "online" | "all";
    limit?: number;
  }) =>
    ipcRenderer.invoke("forge:search-plugins-marketplace", payload) as Promise<{
      items: Array<{
        id: string;
        name: string;
        description: string;
        repo: string;
        subdir?: string;
        catalogId?: string;
        stars?: number;
        source: string;
        installed: boolean;
      }>;
      hint?: string;
    }>,
  searchCatalog: (payload?: { query?: string; kind?: "skill" | "plugin" }) =>
    ipcRenderer.invoke("forge:search-catalog", payload) as Promise<{
      items: Array<{
        id: string;
        name: string;
        description: string;
        kind: "skill" | "plugin";
        repo: string;
        tags?: string[];
      }>;
    }>,
  setSkillEnabled: (payload: {
    skillId: string;
    enabled: boolean;
    cwd?: string;
    project?: boolean;
  }) =>
    ipcRenderer.invoke("forge:set-skill-enabled", payload) as Promise<{
      ok?: boolean;
      skills?: number;
      plugins?: number;
    }>,
  setPluginEnabled: (payload: {
    pluginId: string;
    enabled: boolean;
    cwd?: string;
    project?: boolean;
  }) =>
    ipcRenderer.invoke("forge:set-plugin-enabled", payload) as Promise<{
      ok?: boolean;
      skills?: number;
      plugins?: number;
    }>,
  importSkill: (payload: {
    source?: string;
    catalogId?: string;
    subdir?: string;
    force?: boolean;
  }) =>
    ipcRenderer.invoke("forge:import-skill", payload) as Promise<{
      id: string;
      path: string;
      name: string;
    }>,
  importPlugin: (payload: { source?: string; catalogId?: string; subdir?: string; force?: boolean }) =>
    ipcRenderer.invoke("forge:import-plugin", payload) as Promise<{
      id: string;
      path: string;
      name: string;
    }>,
  hubList: () => ipcRenderer.invoke("forge:hub-list") as Promise<HubListResult>,
  detectExtension: (dir: string) =>
    ipcRenderer.invoke("forge:detect-extension", dir) as Promise<{
      kind: HubExtensionKind;
      id: string;
    } | null>,
  hubInstall: (payload: {
    kind: HubExtensionKind;
    id?: string;
    sourceDir?: string;
    source?: string;
    subdir?: string;
    agents?: HubAgentId[];
    scope?: "user" | "project";
    cwd?: string;
  }) => ipcRenderer.invoke("forge:hub-install", payload) as Promise<HubMutationResult>,
  hubDeploy: (payload: {
    extId: string;
    agents: HubAgentId[];
    scope?: "user" | "project";
    cwd?: string;
  }) => ipcRenderer.invoke("forge:hub-deploy", payload) as Promise<HubMutationResult>,
  hubUndeploy: (payload: {
    extId: string;
    agent: HubAgentId;
    scope?: "user" | "project";
    cwd?: string;
  }) => ipcRenderer.invoke("forge:hub-undeploy", payload) as Promise<HubMutationResult>,
  hubRemove: (payload: { extId: string }) =>
    ipcRenderer.invoke("forge:hub-remove", payload) as Promise<HubMutationResult>,
  hubSync: (payload?: { extId?: string; agents?: HubAgentId[] }) =>
    ipcRenderer.invoke("forge:hub-sync", payload ?? {}) as Promise<HubSyncResult>,
  hubDiscover: (payload?: {
    agents?: HubAgentId[];
    scope?: "user" | "project";
    cwd?: string;
  }) => ipcRenderer.invoke("forge:hub-discover", payload ?? {}) as Promise<HubDiscoverResult>,
  hubImport: (payload: {
    agent: HubAgentId;
    extId: string;
    kind?: HubExtensionKind;
    scope?: "user" | "project";
    cwd?: string;
  }) => ipcRenderer.invoke("forge:hub-import", payload) as Promise<HubMutationResult>,
  compactSession: (payload: { sessionId: string; keepLast?: number }) =>
    ipcRenderer.invoke("forge:compact-session", payload) as Promise<{
      sessionId: string;
      keptMessages: number;
      summarizedMessages: number;
      mode?: string;
      summaryPreview?: string;
    }>,
  listPlugins: (cwd?: string) =>
    ipcRenderer.invoke("forge:list-plugins", cwd) as Promise<{
      plugins: Array<{
        id: string;
        name: string;
        version: string;
        description?: string;
        enabled: boolean;
        source: string;
        root: string;
        capabilities?: {
          skills?: number;
          mcpServers?: number;
          commands?: number;
          workflows?: number;
        };
      }>;
    }>,
  listMcp: (cwd?: string) =>
    ipcRenderer.invoke("forge:list-mcp", cwd) as Promise<{
      installed: Array<{
        name: string;
        command: string;
        args: string[];
        enabled: boolean;
        source: string;
        managedInConfig: boolean;
      }>;
      configured: Array<{
        name: string;
        command: string;
        args: string[];
        enabled: boolean;
        source: string;
        managedInConfig: boolean;
      }>;
      unconfiguredCount: number;
    }>,
  listAutomations: (payload?: { cwd?: string }) =>
    ipcRenderer.invoke("forge:list-automations", payload ?? {}) as Promise<{
      automations: Array<{
        id: string;
        name: string;
        description?: string;
        enabled: boolean;
        cwd: string;
        trigger:
          | { type: "cron"; cron: string; timezone: string }
          | { type: "manual" };
        prompt: string;
        nextRunAt?: string;
        lastRunAt?: string;
      }>;
    }>,
  getAutomation: (payload: { id: string }) =>
    ipcRenderer.invoke("forge:get-automation", payload) as Promise<{
      automation: {
        id: string;
        name: string;
        description?: string;
        enabled: boolean;
        cwd: string;
        trigger:
          | { type: "cron"; cron: string; timezone: string }
          | { type: "manual" };
        prompt: string;
        nextRunAt?: string;
        lastRunAt?: string;
      };
    }>,
  createAutomation: (payload: {
    draft: {
      name: string;
      description?: string;
      cron?: string;
      timezone?: string;
      prompt: string;
      cwd?: string;
      enabled?: boolean;
      notify?: {
        enabled: boolean;
        channelKind?: "ilink" | "feishu" | "dingtalk" | "http";
        channelId?: string;
        threadKey?: string;
      };
    };
    skipConfirm?: boolean;
  }) =>
    ipcRenderer.invoke("forge:create-automation", payload) as Promise<{
      automation: { id: string; name: string };
    }>,
  updateAutomation: (payload: {
    id: string;
    patch: {
      name?: string;
      description?: string;
      cron?: string;
      timezone?: string;
      prompt?: string;
      cwd?: string;
      enabled?: boolean;
      notify?: {
        enabled: boolean;
        channelKind?: "ilink" | "feishu" | "dingtalk" | "http";
        channelId?: string;
        threadKey?: string;
      };
    };
  }) =>
    ipcRenderer.invoke("forge:update-automation", payload) as Promise<{
      automation: { id: string; name: string; enabled: boolean };
    }>,
  deleteAutomation: (payload: { id: string; skipConfirm?: boolean }) =>
    ipcRenderer.invoke("forge:delete-automation", payload) as Promise<{ ok: true }>,
  runAutomation: (payload: {
    id: string;
    trigger?: "schedule" | "manual" | "cli";
    skipConfirm?: boolean;
  }) =>
    ipcRenderer.invoke("forge:run-automation", payload) as Promise<{
      run: { id: string; status: string; sessionId: string };
    }>,
  listAutomationRuns: (payload: { automationId: string; limit?: number }) =>
    ipcRenderer.invoke("forge:list-automation-runs", payload) as Promise<{
      runs: Array<{
        id: string;
        automationId: string;
        sessionId: string;
        status: string;
        trigger: string;
        startedAt: string;
        finishedAt?: string;
        error?: string;
        preview?: string;
      }>;
    }>,
  parseAutomationDraft: (payload: { message: string; cwd?: string }) =>
    ipcRenderer.invoke("forge:parse-automation-draft", payload) as Promise<{
      draft?: {
        name: string;
        description?: string;
        cron?: string;
        timezone?: string;
        prompt: string;
        cwd?: string;
        enabled?: boolean;
      };
      questions?: string[];
    }>,
  listAutomationTemplates: () =>
    ipcRenderer.invoke("forge:list-automation-templates") as Promise<{
      templates: Array<{
        id: string;
        name: string;
        description: string;
        draft: {
          name: string;
          description?: string;
          cron?: string;
          timezone?: string;
          prompt: string;
          cwd?: string;
          enabled?: boolean;
        };
      }>;
    }>,
  listChannels: (payload?: { cwd?: string; includeGlobalMobile?: boolean }) =>
    ipcRenderer.invoke("forge:list-channels", payload ?? {}) as Promise<{
      channels: Array<{
        id: string;
        kind: string;
        name: string;
        description?: string;
        enabled: boolean;
        cwd: string;
        config: Record<string, unknown>;
        createdAt: string;
        updatedAt: string;
        lastError?: string;
        lastMessageAt?: string;
      }>;
    }>,
  getChannel: (payload: { id: string }) =>
    ipcRenderer.invoke("forge:get-channel", payload) as Promise<{
      channel: {
        id: string;
        kind: string;
        name: string;
        description?: string;
        enabled: boolean;
        cwd: string;
        config: Record<string, unknown>;
      };
    }>,
  createChannel: (payload: {
    draft: {
      kind: string;
      name: string;
      description?: string;
      cwd?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    };
    skipConfirm?: boolean;
  }) =>
    ipcRenderer.invoke("forge:create-channel", payload) as Promise<{
      channel: { id: string; name: string; kind: string };
    }>,
  updateChannel: (payload: {
    id: string;
    patch: {
      name?: string;
      description?: string;
      cwd?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    };
  }) =>
    ipcRenderer.invoke("forge:update-channel", payload) as Promise<{
      channel: { id: string; name: string; enabled: boolean };
    }>,
  deleteChannel: (payload: { id: string; skipConfirm?: boolean }) =>
    ipcRenderer.invoke("forge:delete-channel", payload) as Promise<{ ok: true }>,
  listChannelKinds: () =>
    ipcRenderer.invoke("forge:list-channel-kinds") as Promise<{
      kinds: Array<{
        kind: string;
        label: string;
        description: string;
        actions: string[];
      }>;
    }>,
  getChannelGatewayStatus: () =>
    ipcRenderer.invoke("forge:get-channel-gateway-status") as Promise<{
      running: boolean;
      pid?: number;
      startedAt?: string;
      listenUrl?: string;
      adapters: Array<{
        adapterId: string;
        kind: string;
        name: string;
        status: string;
        lastError?: string;
        lastMessageAt?: string;
      }>;
    }>,
  startChannelGateway: (payload?: { skipConfirm?: boolean }) =>
    ipcRenderer.invoke("forge:start-channel-gateway", payload ?? {}) as Promise<{
      ok: true;
      status: {
        running: boolean;
        listenUrl?: string;
      };
    }>,
  stopChannelGateway: () =>
    ipcRenderer.invoke("forge:stop-channel-gateway") as Promise<{
      ok: true;
      status: { running: boolean };
    }>,
  createMobilePairing: (payload: MobileCreatePairingRequest) =>
    ipcRenderer.invoke("forge:mobile-create-pairing", payload) as Promise<MobileCreatePairingResult>,
  listMobileDevices: (payload: MobileListDevicesRequest) =>
    ipcRenderer.invoke("forge:mobile-list-devices", payload) as Promise<MobileListDevicesResult>,
  revokeMobileDevice: (payload: MobileRevokeDeviceRequest) =>
    ipcRenderer.invoke("forge:mobile-revoke-device", payload) as Promise<MobileRevokeDeviceResult>,
  updateMobileDeviceProjects: (payload: MobileUpdateDeviceProjectsRequest) =>
    ipcRenderer.invoke("forge:mobile-update-device-projects", payload) as Promise<MobileUpdateDeviceProjectsResult>,
  channelStartLogin: (payload: { adapterId: string }) =>
    ipcRenderer.invoke("forge:channel-start-login", payload) as Promise<{
      login: {
        adapterId: string;
        status: string;
        qrcode?: string;
        qrcodeImgUrl?: string;
        error?: string;
      };
    }>,
  channelPollLogin: (payload: { adapterId: string }) =>
    ipcRenderer.invoke("forge:channel-poll-login", payload) as Promise<{
      login: {
        adapterId: string;
        status: string;
        qrcode?: string;
        qrcodeImgUrl?: string;
        error?: string;
      };
    }>,
  getHooksSettings: (payload: { scope: HooksSettingsScope; cwd?: string }) =>
    ipcRenderer.invoke("forge:get-hooks-settings", payload) as Promise<{
      scope: HooksSettingsScope;
      path: string;
      exists: boolean;
      editable: boolean;
      settings: HooksSettingsFile;
    }>,
  saveHooksSettings: (payload: {
    scope: HooksSettingsScope;
    cwd?: string;
    settings: HooksSettingsFile;
  }) =>
    ipcRenderer.invoke("forge:save-hooks-settings", payload) as Promise<{
      scope: HooksSettingsScope;
      path: string;
      exists: boolean;
      editable: boolean;
      settings: HooksSettingsFile;
    }>,
  listDiscoveredHooks: (cwd: string) =>
    ipcRenderer.invoke("forge:list-discovered-hooks", cwd) as Promise<
      Array<{
        source: string;
        sourceId: string;
        event: string;
        type: string;
        matcher?: string;
      }>
    >,
  run: (payload: RunPayload) =>
    ipcRenderer.invoke("forge:run", payload) as Promise<{
      sessionId: string;
      finalText: string;
    }>,
  cancelRun: (sessionId?: string) =>
    ipcRenderer.invoke("forge:cancel-run", sessionId ? { sessionId } : {}) as Promise<{
      ok: boolean;
      canceled: boolean;
    }>,
  respondPermission: (payload: {
    id: string;
    approved?: boolean;
    remember?: boolean;
    optionId?: string;
  }) =>
    ipcRenderer.invoke("forge:respond-permission", payload) as Promise<{ ok: boolean }>,
  applyPatch: (payload: { cwd: string; path: string; unifiedDiff: string }) =>
    ipcRenderer.invoke("forge:apply-patch", payload) as Promise<{
      ok?: boolean;
      message?: string;
      line?: number;
      expected?: string;
      actual?: string;
    }>,
  searchSessions: (payload: { query: string; limit?: number }) =>
    ipcRenderer.invoke("forge:search-sessions", payload) as Promise<{
      hits?: Array<{
        sessionId: string;
        cwd: string;
        updatedAt: string;
        matchCount: number;
        snippet: string;
      }>;
    }>,
  saveTextFile: (payload: { defaultName: string; content: string }) =>
    ipcRenderer.invoke("forge:save-text-file", payload) as Promise<{
      ok?: boolean;
      canceled?: boolean;
      path?: string;
    }>,
  restoreCheckpoint: (payload: {
    cwd: string;
    sha: string;
    sessionId?: string;
    turnIndex?: number;
    truncateConversation?: boolean;
  }) =>
    ipcRenderer.invoke("forge:restore-checkpoint", payload) as Promise<{
      ok?: boolean;
      message?: string;
      removedCount?: number;
      truncatedMessages?: number;
    }>,
  daemonStatus: () =>
    ipcRenderer.invoke("forge:daemon-status") as Promise<{
      version?: string;
      activeRun?: boolean;
      activeSessionIds?: string[];
      runtime?: { loaded?: boolean; skills?: number; plugins?: number };
      sessions?: { count?: number };
    }>,
  getTrace: (payload?: { runId?: string; sessionId?: string }) =>
    ipcRenderer.invoke("forge:trace-get", payload ?? {}) as Promise<TraceGetResult>,
  onEvent: (listener: (event: AgentEvent) => void) => {
    const wrapped = (_evt: unknown, data: AgentEvent) => listener(data);
    ipcRenderer.on("forge:event", wrapped);
    return () => ipcRenderer.off("forge:event", wrapped);
  },

  // --- Embedded terminal ---
  terminalCreate: (payload: { cwd?: string; cols?: number; rows?: number }) =>
    ipcRenderer.invoke("forge:terminal-create", payload) as Promise<{
      id: string;
      backend: "pty" | "pipe";
    }>,
  terminalInput: (payload: { id: string; data: string }) =>
    ipcRenderer.send("forge:terminal-input", payload),
  terminalResize: (payload: { id: string; cols: number; rows: number }) =>
    ipcRenderer.send("forge:terminal-resize", payload),
  terminalKill: (payload: { id: string }) =>
    ipcRenderer.send("forge:terminal-kill", payload),
  onTerminalData: (
    listener: (payload: { id: string; data: string }) => void,
  ) => {
    const wrapped = (_evt: unknown, data: { id: string; data: string }) =>
      listener(data);
    ipcRenderer.on("forge:terminal-data", wrapped);
    return () => ipcRenderer.off("forge:terminal-data", wrapped);
  },
  onTerminalExit: (
    listener: (payload: { id: string; exitCode: number }) => void,
  ) => {
    const wrapped = (_evt: unknown, data: { id: string; exitCode: number }) =>
      listener(data);
    ipcRenderer.on("forge:terminal-exit", wrapped);
    return () => ipcRenderer.off("forge:terminal-exit", wrapped);
  },

  // --- Embedded browser panel ---
  browserClearData: (payload: { kind: "cookies" | "cache" }) =>
    ipcRenderer.invoke("forge:browser-clear-data", payload) as Promise<{
      ok: boolean;
    }>,
};

contextBridge.exposeInMainWorld("forgeDesktop", api);
