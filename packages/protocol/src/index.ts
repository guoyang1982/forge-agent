/** Frozen protocol types — change sparingly after P0 */

import {
  DEFAULT_PERMISSIONS,
  type PermissionsConfig,
} from "./permissions.js";
import type { NetworkServiceConfig } from "./network-service.js";
import type { BrowserBackendSummary } from "./browser.js";

export {
  DEFAULT_PERMISSIONS,
  DEFAULT_PERSONAL_ROOTS,
  type AppsPermissions,
  type AuditPermissions,
  type AutomationPermissions,
  type ChannelsPermissions,
  type BrowserPermissions,
  type FileSystemPermissions,
  type MemoryPermissions,
  type MobilePermissions,
  type NetworkPermissions,
  type NetworkSearchMode,
  type NotificationsPermissions,
  type PermissionLevel,
  type PermissionsConfig,
  type SecretsPermissions,
  type SoftwarePermissions,
} from "./permissions.js";

export {
  DEFAULT_NETWORK_SERVICE,
  type NetworkSearchProviderId,
  type NetworkServiceConfig,
} from "./network-service.js";

export * from "./automation.js";
export * from "./channel.js";
export * from "./mobile.js";
export * from "./browser.js";

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** Request-scoped daemon event notification payload. */
export interface AgentEventNotificationParams {
  requestId: JsonRpcId;
  event: AgentEvent;
}

/** User attachment from desktop composer (images → vision API; documents → extracted text inlined). */
export interface RunAttachment {
  kind: "image" | "file";
  name: string;
  mimeType: string;
  /** data:image/...;base64,... for vision models */
  dataUrl?: string;
  /** UTF-8 text for non-image files */
  text?: string;
}

/** SessionStart hook matcher source — see @forge/hooks SessionHookSource */
export type SessionHookSource = "startup" | "resume" | "clear" | "compact";

export interface AutomationRunContext {
  name?: string;
  schedule?: { cron: string; timezone: string };
  notification?: { channelKind: "ilink" | "feishu" | "dingtalk" | "http" };
}

export interface ChannelRunContext {
  kind: string;
  label?: string;
  /** Short user-visible preview for sidebar (without channel prefix). */
  preview?: string;
}

export interface RunRequest {
  cwd: string;
  message: string;
  sessionId?: string | null;
  /**
   * Optional external agent runtime. Omitted or provider="forge" preserves the
   * existing Forge ReAct runtime path.
   */
  runtime?: {
    provider: "forge" | "codex" | "claude-code" | "cursor" | string;
    model?: string;
    /** ACP / provider operating mode (e.g. default, agent, ask, plan). */
    permissionMode?: string;
    sandboxMode?: string;
    effort?: string;
  };
  /** Desktop client id to correlate session_start with a pending run */
  clientRunId?: string;
  /** Overrides auto-detected SessionStart source (e.g. after /clear or /compact). */
  hookSource?: SessionHookSource;
  /** Scheduled/manual automation executor — injects system rules to run the task now. */
  automationRun?: AutomationRunContext;
  /** Inbound channel gateway run (WeChat iLink, etc.). */
  channelRun?: ChannelRunContext;
  autoApply?: boolean;
  files?: string[];
  attachments?: RunAttachment[];
}

export interface CancelRunRequest {
  /** Omit to cancel all active runs */
  sessionId?: string;
}

export interface RunResult {
  sessionId: string;
  finalText: string;
}

export interface RuntimeModelSummary {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts?: string[];
  isDefault?: boolean;
}

export interface RuntimeModelListResult {
  models: RuntimeModelSummary[];
}

export type RuntimeStatus = "ready" | "needs_setup" | "binary_missing" | "auth_required";

export interface RuntimeModeSummary {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface RuntimeProbeResult {
  provider: string;
  status: RuntimeStatus;
  message?: string;
  binaryPath?: string;
  modes?: RuntimeModeSummary[];
  models?: RuntimeModelSummary[];
}

export type RuntimeProviderKind = "default" | "cli" | "acp" | "app-server";

export interface RuntimeProviderSummary {
  id: string;
  label: string;
  kind: RuntimeProviderKind;
  status: RuntimeStatus;
  message?: string;
  binaryPath?: string;
  modes?: RuntimeModeSummary[];
  models?: RuntimeModelSummary[];
}

export interface RuntimeListResult {
  providers: RuntimeProviderSummary[];
}

export interface CloseAcpSessionRequest {
  sessionId: string;
  /** Omit or "*" to release all ACP providers for this Forge session. */
  provider?: string;
}

export interface ReleaseAcpForgeSessionRequest {
  sessionId: string;
}

export interface PlanRequest {
  cwd: string;
  message: string;
  files?: string[];
}

export interface StructuredPlanStep {
  id: string;
  title: string;
  description?: string;
}

export interface StructuredPlan {
  summary: string;
  steps: StructuredPlanStep[];
  filesToInspect: string[];
  risks: string[];
  verification: string[];
  questions?: string[];
}

export interface PlanResult {
  text: string;
  structured?: StructuredPlan;
}

export interface ReviewRequest {
  cwd: string;
  files?: string[];
}

export interface StructuredReviewFinding {
  severity: "high" | "medium" | "low";
  message: string;
  file?: string;
  suggestion?: string;
}

export interface StructuredReview {
  findings: StructuredReviewFinding[];
  verificationGaps: string[];
  summary: string;
  residualRisk?: string;
}

export interface ReviewResult {
  text: string;
  structured?: StructuredReview;
}

export interface CompactSessionRequest {
  sessionId: string;
  keepLast?: number;
}

export interface CompactSessionResult {
  sessionId: string;
  keptMessages: number;
  summarizedMessages: number;
  mode: "model" | "local";
  summaryPreview: string;
  /** True when a PreCompact hook blocked compression. */
  blocked?: boolean;
}

export interface DaemonStatusResult {
  version: string;
  activeRun: boolean;
  /** Session-scoped source of truth; persisted session_start events may be stale after a restart. */
  activeSessionIds: string[];
  runtime: {
    loaded: boolean;
    skills: number;
    plugins: number;
  };
  sessions: {
    count: number;
  };
  browser?: {
    backends: BrowserBackendSummary[];
  };
}

export interface ListSessionsRequest {
  limit?: number;
}

export interface SessionListItem {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastPreview: string;
}

export interface ListSessionsResult {
  sessions: SessionListItem[];
}

export interface GetSessionMessagesRequest {
  sessionId: string;
  limit?: number;
  /** When set, return only the most recent N session_events (tail), or a page before a cursor. */
  eventLimit?: number;
  /** Load messages with id strictly less than this (older page). */
  beforeMessageId?: number;
  /** Load events with sequence strictly less than this (older page). */
  beforeEventSequence?: number;
}

export interface SessionHistoryPageInfo {
  /** True when older messages and/or events exist before this page. */
  truncated: boolean;
  /** DB ids aligned with `messages` (same length), oldest → newest. */
  messageIds: number[];
  oldestMessageId: number | null;
  oldestEventSequence: number | null;
}

export interface GetSessionMessagesResult {
  sessionId: string;
  messages: ChatMessage[];
  /** Durable UI event journal. Empty for sessions created before migration 007. */
  events?: SessionEventRecord[];
  /** Present for bounded/paginated reads (e.g. mobile). */
  page?: SessionHistoryPageInfo;
  /** Pre-run worktree snapshots: turnIndex = 0-based ordinal among user messages. */
  checkpoints?: Array<{ turnIndex: number; sha: string }>;
  /** Latest persisted coordinator dispatch plans keyed by user-turn ordinal. */
  dispatchPlans?: Array<{
    turnIndex: number;
    intent: string;
    source: "heuristic" | "model";
    runKind: "coordinator" | "talent_foreground" | "talent_dispatch";
    waves: Array<{
      index: number;
      steps: Array<{
        id: string;
        kind: "talent_background" | "talent_foreground" | "coordinator" | "verify";
        mention?: string;
        displayName?: string;
        role?: string;
        emoji?: string;
        avatar?: string;
        task: string;
        status: "pending" | "in_progress" | "done";
      }>;
    }>;
  }>;
}

export interface SessionEventRecord {
  sequence: number;
  sessionId: string;
  turnIndex: number | null;
  eventType: AgentEvent["type"];
  itemId?: string;
  emittedAtMs: number;
  event: AgentEvent;
}

export interface RuntimeFileChange {
  path: string;
  kind: "add" | "update" | "delete";
  unifiedDiff?: string;
  adds: number;
  dels: number;
}

export interface RuntimeCapabilities {
  itemLifecycle: boolean;
  streamingText: boolean;
  streamingReasoning: boolean;
  streamingPatch: boolean;
  commandOutput: boolean;
  permissions: boolean;
  subagents: boolean;
}

export interface ListPluginsRequest {
  cwd?: string;
}

export interface PluginListItem {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: "builtin" | "user" | "project";
  enabled: boolean;
  root: string;
  capabilities: {
    skills: number;
    mcpServers: number;
    commands: number;
    workflows: number;
  };
}

export interface ListPluginsResult {
  plugins: PluginListItem[];
}

export interface ListSkillsRequest {
  cwd?: string;
}

export interface SkillListItem {
  id: string;
  name: string;
  description?: string;
  triggers: string[];
  source?: string;
  format?: string;
  path?: string;
  enabled?: boolean;
  manageable?: boolean;
}

export interface SkillListGroup {
  id: string;
  title: string;
  skills: SkillListItem[];
}

export interface ListSkillsResult {
  groups: SkillListGroup[];
}

export interface ListMcpRequest {
  cwd?: string;
}

export interface McpListItem {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  source: string;
  managedInConfig: boolean;
}

export interface ListMcpResult {
  installed: McpListItem[];
  configured: McpListItem[];
  unconfiguredCount: number;
}

export interface CatalogListItem {
  id: string;
  name: string;
  description: string;
  kind: "skill" | "plugin";
  repo: string;
  tags?: string[];
}

export interface SearchCatalogRequest {
  query?: string;
  kind?: "skill" | "plugin";
}

export interface SearchCatalogResult {
  items: CatalogListItem[];
}

export interface MarketplaceSkillItem {
  id: string;
  name: string;
  description: string;
  repo: string;
  subdir?: string;
  catalogId?: string;
  installs?: number;
  stars?: number;
  source: "featured" | "skills.sh" | "catalog";
  installed: boolean;
}

export interface SearchSkillsMarketplaceRequest {
  query?: string;
  /** featured = curated list only; online = skills.sh (needs query≥2); all = merge */
  mode?: "featured" | "online" | "all";
  limit?: number;
}

export interface SearchSkillsMarketplaceResult {
  items: MarketplaceSkillItem[];
  hint?: string;
}

export interface MarketplacePluginItem {
  id: string;
  name: string;
  description: string;
  repo: string;
  subdir?: string;
  catalogId?: string;
  stars?: number;
  source: "featured" | "github" | "catalog";
  installed: boolean;
}

export interface SearchPluginsMarketplaceRequest {
  query?: string;
  mode?: "featured" | "online" | "all";
  limit?: number;
}

export interface SearchPluginsMarketplaceResult {
  items: MarketplacePluginItem[];
  hint?: string;
}

export interface ImportSkillRequest {
  source?: string;
  catalogId?: string;
  subdir?: string;
  force?: boolean;
}

export interface SetSkillEnabledRequest {
  skillId: string;
  enabled: boolean;
  cwd?: string;
  project?: boolean;
}

export interface SetPluginEnabledRequest {
  pluginId: string;
  enabled: boolean;
  cwd?: string;
  project?: boolean;
}

export interface ImportPluginRequest {
  source?: string;
  catalogId?: string;
  subdir?: string;
  force?: boolean;
}

export interface ImportContributionResult {
  id: string;
  path: string;
  name: string;
}

/** Extension Hub (skill/plugin cross-agent distribution). */
export type HubAgentId = "forge" | "cursor" | "claude-code" | "codex";
export type HubExtensionKind = "skill" | "plugin";
export type HubDeployStatus = "synced" | "drift" | "missing" | "error";
export type HubCompatibilityStatus = "compatible" | "adaptable" | "incompatible" | "unknown";

export interface HubAgentCompatibility {
  status: HubCompatibilityStatus;
  requirements: string[];
  reason: string;
}

export interface HubDeploymentInfo {
  scope: "user" | "project";
  path: string;
  mode: string;
  status: HubDeployStatus;
  manifestVariant?: string;
  note?: string;
}

export interface HubListItem {
  id: string;
  kind: HubExtensionKind;
  name: string;
  version?: string;
  contentHash: string;
  capabilities: {
    skills: string[];
    mcpServers: string[];
    commands: string[];
    hooks: string[];
    agents: string[];
  };
  compatibility: Record<HubAgentId, HubAgentCompatibility>;
  deployments: Partial<Record<HubAgentId, HubDeploymentInfo>>;
}

export interface HubListResult {
  items: HubListItem[];
}

export interface HubInstallRequest {
  /** Local directory to import as the SSOT package. */
  sourceDir?: string;
  /** GitHub source (owner/repo[/subdir][#ref]) to clone into the store. */
  source?: string;
  subdir?: string;
  kind: HubExtensionKind;
  id?: string;
  /** Optionally deploy to these agents right after install. */
  agents?: HubAgentId[];
  scope?: "user" | "project";
  cwd?: string;
}

export interface HubDeployRequest {
  extId: string;
  agents: HubAgentId[];
  scope?: "user" | "project";
  cwd?: string;
}

export interface HubUndeployRequest {
  extId: string;
  agent: HubAgentId;
  scope?: "user" | "project";
  cwd?: string;
}

export interface HubRemoveRequest {
  extId: string;
}

export interface HubMutationResult {
  ok: true;
  item?: HubListItem;
}

export interface HubSyncRequest {
  /** Sync a single extension; omit to sync all. */
  extId?: string;
  /** Limit to these agents; omit for all. */
  agents?: HubAgentId[];
}

export interface HubSyncEntry {
  extId: string;
  agent: HubAgentId;
  before: HubDeployStatus;
  after: HubDeployStatus;
  action: "redeployed" | "skipped" | "error";
  note?: string;
}

export interface HubSyncResult {
  entries: HubSyncEntry[];
}

export interface HubDiscoverRequest {
  agents?: HubAgentId[];
  scope?: "user" | "project";
  cwd?: string;
}

export interface HubDiscoveredExt {
  id: string;
  kind: HubExtensionKind;
  path: string;
  contentHash: string;
  inHub: boolean;
  hubMatches: boolean;
}

export interface HubAgentDiscovery {
  agent: HubAgentId;
  available: boolean;
  managed: string[];
  found: HubDiscoveredExt[];
}

export interface HubDiscoverResult {
  agents: HubAgentDiscovery[];
}

export interface HubImportRequest {
  agent: HubAgentId;
  extId: string;
  kind?: HubExtensionKind;
  scope?: "user" | "project";
  cwd?: string;
}

export interface TalentTemplateListItem {
  schemaVersion?: 2;
  id: string;
  category: string;
  role: string;
  description: string;
  vibe?: string;
  emoji?: string;
  color?: string;
  avatar?: string;
  sourcePath: string;
  suggestedSkills: string[];
  suggestedTools: string[];
  methodology?: string[];
  inputRequirements?: string[];
  deliverables?: string[];
  qualityGates?: string[];
  knowledgeRefs?: string[];
  connectors?: string[];
  taskExamples?: TalentTaskExample[];
  version?: string;
  provenance?: TalentProvenance;
  hired: boolean;
}

export interface TalentTaskExample {
  title: string;
  prompt: string;
  outcome?: string;
}

export interface TalentProvenance {
  source: "bundled" | "synced" | "custom";
  author?: string;
  homepage?: string;
  reviewed?: boolean;
}

export interface HiredTalentListItem {
  instanceId: string;
  templateId: string;
  displayName: string;
  mention: string;
  role: string;
  category: string;
  description?: string;
  emoji?: string;
  color?: string;
  avatar?: string;
  version?: string;
  provenance?: TalentProvenance;
  enabled: boolean;
  skills: string[];
  tools: string[];
  /** Restrict the run's skill catalog to this talent's bound skills when focused. */
  strictSkills?: boolean;
  permissionPreset: "advisor" | "collaborator" | "operator";
  hiredAt: string;
  stats: {
    tasksDone: number;
    lastUsed: string | null;
  };
}

/** Structured talent identity on subagent timeline events. */
export interface TalentEventInfo {
  mention: string;
  displayName: string;
  role?: string;
  emoji?: string;
  avatar?: string;
}

export interface GetTalentTemplateRequest {
  templateId: string;
}

export interface GetTalentTemplateResult {
  template: {
    id: string;
    category: string;
    role: string;
    description: string;
    vibe?: string;
    emoji?: string;
    color?: string;
    avatar?: string;
    systemPrompt: string;
    suggestedSkills: string[];
    suggestedTools: string[];
    schemaVersion?: 2;
    methodology?: string[];
    inputRequirements?: string[];
    deliverables?: string[];
    qualityGates?: string[];
    knowledgeRefs?: string[];
    connectors?: string[];
    taskExamples?: TalentTaskExample[];
    version?: string;
    provenance?: TalentProvenance;
  } | null;
}

export interface CustomTalentTemplateInput {
  id?: string;
  role: string;
  category?: string;
  description: string;
  vibe?: string;
  color?: string;
  systemPrompt?: string;
  suggestedSkills?: string[];
  suggestedTools?: string[];
  methodology?: string[];
  inputRequirements?: string[];
  deliverables?: string[];
  qualityGates?: string[];
  knowledgeRefs?: string[];
  connectors?: string[];
  taskExamples?: TalentTaskExample[];
  author?: string;
}

export interface CreateCustomTalentRequest {
  talent: CustomTalentTemplateInput;
}

export interface CreateCustomTalentResult extends GetTalentTemplateResult {}

export interface UpdateCustomTalentRequest {
  templateId: string;
  patch: Partial<Omit<CustomTalentTemplateInput, "id">>;
}

export interface UpdateCustomTalentResult extends GetTalentTemplateResult {}

export interface DeleteCustomTalentRequest {
  templateId: string;
}

export interface DeleteCustomTalentResult {
  removed: boolean;
}

export interface TalentTeamMember {
  mention: string;
  responsibility: string;
  after?: string[];
}

export interface TalentTeam {
  id: string;
  name: string;
  mention: string;
  description: string;
  leadMention?: string;
  members: TalentTeamMember[];
  deliverables: string[];
  executionMode: "auto" | "parallel" | "serial";
  createdAt: string;
  stats: { tasksDone: number; lastUsed: string | null };
}

export interface ListTalentTeamsRequest { cwd?: string }
export interface ListTalentTeamsResult { teams: TalentTeam[] }
export interface CreateTalentTeamRequest {
  cwd?: string;
  name: string;
  mention?: string;
  description: string;
  leadMention?: string;
  members: TalentTeamMember[];
  deliverables?: string[];
  executionMode?: TalentTeam["executionMode"];
}
export interface CreateTalentTeamResult { team: TalentTeam }
export interface UpdateTalentTeamRequest {
  cwd?: string;
  idOrMention: string;
  patch: Partial<Pick<TalentTeam, "name" | "mention" | "description" | "leadMention" | "members" | "deliverables" | "executionMode">>;
}
export interface UpdateTalentTeamResult { team: TalentTeam }
export interface DeleteTalentTeamRequest { cwd?: string; idOrMention: string }
export interface DeleteTalentTeamResult { removed: boolean }

export type TalentAgentExecutionMode = "inline" | "isolated" | "team";
export interface TalentAgentRun {
  id: string;
  sessionId: string;
  talentInstanceIds: string[];
  talentMentions: string[];
  mode: TalentAgentExecutionMode;
  task: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  outcomePreview: string;
  tools: string[];
}
export interface TalentAgentMemoryEntry {
  id: string;
  talentInstanceId: string;
  sourceRunId?: string;
  content: string;
  createdAt: string;
}
export interface ListTalentAgentRunsRequest {
  cwd?: string;
  talentInstanceId?: string;
  limit?: number;
}
export interface ListTalentAgentRunsResult { runs: TalentAgentRun[] }
export interface ListTalentAgentMemoryRequest {
  cwd?: string;
  talentInstanceId: string;
  limit?: number;
}
export interface ListTalentAgentMemoryResult { entries: TalentAgentMemoryEntry[] }

export interface TalentSyncRequest {
  categories?: string[];
  /** Local checkout of agency-agents; skips GitHub fetch when set. */
  sourceDir?: string;
  /** Remote fetch timeout in milliseconds (default 30s). */
  timeoutMs?: number;
}

export interface TalentSyncResult {
  count: number;
  skipped: number;
  source: "remote" | "local";
  notice?: string;
}

export interface ListTalentTemplatesRequest {
  category?: string;
  query?: string;
}

export interface ListTalentTemplatesResult {
  templates: TalentTemplateListItem[];
}

export interface HireTalentRequest {
  templateId: string;
  displayName?: string;
  mention?: string;
  /** Project workspace; hires into `<cwd>/.forge/talents.json` when set. */
  cwd?: string;
}

export interface HireTalentResult {
  talent: HiredTalentListItem;
}

export interface FireTalentRequest {
  instanceIdOrMention: string;
  cwd?: string;
}

export interface FireTalentResult {
  removed: boolean;
}

export interface ListTalentRosterRequest {
  cwd?: string;
}

export interface ListTalentRosterResult {
  talents: HiredTalentListItem[];
}

export interface RenameTalentRequest {
  instanceIdOrMention: string;
  displayName?: string;
  mention?: string;
  cwd?: string;
}

export interface RenameTalentResult {
  talent: HiredTalentListItem;
}

export interface UpdateTalentBindingsRequest {
  instanceIdOrMention: string;
  skills?: string[];
  tools?: string[];
  enabled?: boolean;
  strictSkills?: boolean;
  cwd?: string;
}

export interface UpdateTalentBindingsResult {
  talent: HiredTalentListItem;
}

export interface GetConfigResult {
  config: Record<string, unknown>;
}

export interface ReloadRuntimeResult {
  ok: true;
  skills: number;
  plugins: number;
}

export type ThinkingDisplayMode = "collapse" | "stream" | "hidden";
export type ProgressDisplayMode = "compact" | "verbose";
export type ThemeDisplayMode = "system" | "dark" | "light";

export type AgentEvent =
  | {
      type: "session_start";
      sessionId: string;
      cwd: string;
      /** First user message preview for sidebar title */
      preview?: string;
      clientRunId?: string;
    }
  | { type: "text_delta"; sessionId?: string; delta: string; talent?: TalentEventInfo }
  | { type: "thinking_start"; sessionId?: string; talent?: TalentEventInfo }
  | { type: "thinking_delta"; sessionId?: string; delta: string; talent?: TalentEventInfo }
  | { type: "thinking_end"; sessionId?: string; charCount: number; durationMs?: number; talent?: TalentEventInfo }
  | { type: "step_start"; sessionId?: string; step: number; maxSteps: number; talent?: TalentEventInfo }
  | {
      type: "skill_active";
      sessionId?: string;
      /** Pre-loaded playbook. catalog = model picks from list. */
      matchMode: "explicit" | "implicit" | "catalog";
      matched: boolean;
      skillId?: string;
      skillName?: string;
      loadedCount: number;
    }
  | {
      type: "skill_used";
      sessionId?: string;
      skillId: string;
      skillName: string;
      path: string;
    }
  | {
      type: "status";
      sessionId?: string;
      phase: "model" | "tool" | "runtime";
      message: string;
      elapsedSec?: number;
      talent?: TalentEventInfo;
    }
  | {
      type: "tool_start";
      sessionId?: string;
      callId?: string;
      name: string;
      args: unknown;
      step?: number;
      talent?: TalentEventInfo;
    }
  | {
      type: "tool_end";
      sessionId?: string;
      callId?: string;
      name: string;
      result: string;
      durationMs?: number;
      talent?: TalentEventInfo;
    }
  | {
      /** Standard external runtime activity for UI adapters. */
      type: "runtime_activity";
      sessionId?: string;
      runtime: "codex" | "claude-code" | "cursor" | string;
      activityKind: "tool" | "command" | "file" | "mcp" | "search" | "read" | "think";
      status: "running" | "done" | "failed" | "declined";
      callId?: string;
      turnId?: string;
      startedAtMs?: number;
      completedAtMs?: number;
      durationMs?: number;
      emittedAtMs?: number;
      label?: string;
      name?: string;
      args?: unknown;
      result?: string;
      path?: string;
      adds?: number;
      dels?: number;
      patch?: { path: string; unifiedDiff: string };
      /** Canonical multi-file payload; legacy single-file fields remain during migration. */
      changes?: RuntimeFileChange[];
      talent?: TalentEventInfo;
    }
  | {
      type: "patch_proposed";
      sessionId?: string;
      path: string;
      unifiedDiff: string;
      applied: boolean;
    }
  | {
      /** Codex app-server activity chip (search/read/file/command). */
      type: "codex_activity";
      sessionId?: string;
      callId: string;
      icon: "search" | "read" | "command" | "file" | "mcp" | "think";
      label: string;
      status: "running" | "done";
      path?: string;
      adds?: number;
      dels?: number;
      patch?: { path: string; unifiedDiff: string };
    }
  | { type: "memory_proposed"; sessionId?: string; content: string; memoryType: string }
  | {
      /** Model-visible interpretation of the user's request, emitted before execution. */
      type: "intent_plan";
      sessionId?: string;
      summary: string;
      runKind: "coordinator" | "talent_foreground" | "talent_dispatch";
      constraints: string[];
      uncertainties: string[];
      executionReason: string;
      source: "model" | "heuristic";
    }
  | {
      type: "plan_update";
      sessionId?: string;
      items: Array<{
        text: string;
        status: "pending" | "in_progress" | "done";
      }>;
    }
  | {
      /** Structured coordinator dispatch plan (multi-@ talent, L2 orchestration). */
      type: "dispatch_plan";
      sessionId?: string;
      intent: string;
      source: "heuristic" | "model";
      runKind: "coordinator" | "talent_foreground" | "talent_dispatch";
      /** Whether talent steps run in dependency waves (serial) or one wave (parallel). */
      executionMode: "serial" | "parallel";
      waves: Array<{
        index: number;
        steps: Array<{
          id: string;
          kind: "talent_background" | "talent_foreground" | "coordinator" | "verify";
          mention?: string;
          displayName?: string;
          role?: string;
          emoji?: string;
          avatar?: string;
          task: string;
          status: "pending" | "in_progress" | "done";
        }>;
      }>;
    }
  | {
      /** One wave of talent_dispatch execution (persists on timeline for serial visibility). */
      type: "dispatch_wave_start";
      sessionId?: string;
      waveIndex: number;
      waveTotal: number;
      executionMode: "serial" | "parallel";
      talentLabels: string[];
    }
  | {
      type: "talent_active";
      sessionId?: string;
      talent: TalentEventInfo;
      /** foreground = 单 @ 前台接管；background 保留给后续扩展 */
      mode: "foreground" | "background";
      /** Runtime strategy selected for this talent invocation. */
      executionMode?: "inline" | "isolated" | "team";
    }
  | {
      type: "subagent_start";
      sessionId?: string;
      task: string;
      talent?: TalentEventInfo;
      dispatchWave?: {
        index: number;
        total: number;
        executionMode: "serial" | "parallel";
        hasPriorResults: boolean;
      };
    }
  | {
      type: "subagent_end";
      sessionId?: string;
      summary: string;
      talent?: TalentEventInfo;
    }
  | {
      /** Pre-run worktree snapshot for rewind; sha is a dangling git commit. */
      type: "checkpoint";
      sessionId?: string;
      sha: string;
      /** 0-based ordinal among user messages — anchors conversation truncation. */
      turnIndex: number;
    }
  | {
      type: "context_usage";
      sessionId?: string;
      /** Estimated tokens being sent this turn (history after budget trim). */
      estimatedTokens: number;
      maxContextTokens: number;
      truncated?: boolean;
    }
  | { type: "done"; sessionId: string; finalText?: string }
  | {
      type: "hooks_applied";
      sessionId?: string;
      count: number;
      /** Hook config origins (user, project path, plugin id, …). */
      sources: string[];
      chars: number;
    }
  | { type: "warning"; sessionId?: string; message: string; talent?: TalentEventInfo }
  | { type: "error"; sessionId?: string; message: string }
  | { type: "reflection_start"; sessionId?: string; round: number; talent?: TalentEventInfo }
  | {
      type: "reflection_verdict";
      sessionId?: string;
      round: number;
      verdict: "pass" | "revise";
      /** Whether the gate actually triggered a rework round (revise + blocking issue). */
      reworking: boolean;
      issues: ReflectionIssue[];
      talent?: TalentEventInfo;
    }
  | {
      type: "permission_request";
      sessionId?: string;
      id: string;
      kind:
        | "network"
        | "command"
        | "software"
        | "mcp"
        | "acp"
        | "codex"
        | "claude-code";
      /** Present for network kind. */
      action?: "search" | "web" | "api" | "download" | "install" | "uninstall";
      summary: string;
      detail: Record<string, unknown>;
      /** Present for external runtime tool permission prompts. */
      options?: Array<{
        optionId: string;
        name: string;
        kind?: string;
      }>;
    }
  | {
      /** Daemon closed a pending permission without a UI respond (timeout/abort/cancel). */
      type: "permission_dismissed";
      sessionId?: string;
      id: string;
      reason: "timeout" | "abort" | "cancelled";
    };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export type ChatContent = string | ChatContentPart[] | null;

/** Flatten user/assistant message content for logs, token estimates, and UI. */
export function plainTextFromChatContent(content: ChatContent | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((p) => {
      if (p.type === "text") return p.text ?? "";
      if (p.type === "image_url") return "🖼️";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Shown when image_url parts are stripped for text-only chat APIs (e.g. DeepSeek). */
export const VISION_STRIPPED_NOTE =
  "[图片附件：API 未接受 image_url，图片未发送。请换用支持视觉的模型，或在 model 中设置 vision: true。]";

/** Convert multimodal content to plain string for text-only LLM APIs. */
export function flattenContentForTextOnlyApi(content: ChatContent | undefined): ChatContent {
  if (content == null) return null;
  if (typeof content === "string") return content;
  let hasImage = false;
  const textParts: string[] = [];
  for (const p of content) {
    if (p.type === "text" && p.text) textParts.push(p.text);
    else if (p.type === "image_url") hasImage = true;
  }
  if (hasImage) textParts.push(VISION_STRIPPED_NOTE);
  const joined = textParts.join("\n\n").trim();
  if (joined) return joined;
  return hasImage ? VISION_STRIPPED_NOTE : null;
}

/** Remove image_url parts from all messages (session history + current turn). */
export function sanitizeMessagesForTextOnlyApi(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.content == null || typeof m.content === "string") return m;
    const hasImage = m.content.some((p) => p.type === "image_url");
    if (!hasImage) return m;
    return { ...m, content: flattenContentForTextOnlyApi(m.content) };
  });
}

export function llmErrorMentionsUnsupportedImages(message: string): boolean {
  return /image_url|unknown variant.*image|expected text/i.test(message);
}

export interface ChatMessage {
  role: ChatRole;
  content: ChatContent;
  /** DeepSeek thinking mode — must round-trip on next request when enabled */
  reasoning_content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** Provider-specific chat options (e.g. DeepSeek thinking / reasoning_effort). */
export interface ModelOptions {
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: "low" | "medium" | "high";
}

/** Saved credentials + model id for one vendor (stored in config profiles). */
export type ModelProfile = {
  provider?: string;
  baseUrl: string;
  apiKey: string;
  name: string;
  /** When false, profile is hidden from switchers and cannot be active (default: enabled). */
  enabled?: boolean;
  /** Force enable/disable vision for this profile (overrides name heuristic). */
  vision?: boolean;
  options?: ModelOptions;
};

export type ReflectionDimension =
  | "completeness"
  | "grounding"
  | "consistency"
  | "instruction";

export interface ReflectionIssue {
  dimension: ReflectionDimension;
  severity: "blocker" | "minor";
  /** Concrete description: which claim/requirement is wrong or missing. */
  detail: string;
  /** Actionable next step the agent should take to fix it. */
  suggestedAction: string;
}

export interface ReflectionVerdict {
  verdict: "pass" | "revise";
  issues: ReflectionIssue[];
}

/** Generic finalization-gate reflection (task-type agnostic). Default off. */
export interface ReflectionConfig {
  /** Master switch; default false (zero behavior change). */
  enabled?: boolean;
  /** profiles[id] used as the reviewer model; default: the active model. */
  reviewerProfile?: string;
  /** Max revise rounds before forcing release (default 1). */
  maxRounds?: number;
  /** Skip reflection unless at least this many steps remain to apply a fix (default 2). */
  minStepsBudget?: number;
  /** Lowest severity that triggers a revise (default "blocker"). */
  severityGate?: "blocker" | "minor";
}

export interface ForgeConfig {
  /** Which entry in `profiles` is active (forge model use <id>) */
  activeProfile?: string;
  /** Named profiles — deepseek, openai, custom, … */
  profiles?: Record<string, ModelProfile>;
  model: {
    /** Catalog id: openai | deepseek | dashscope | anthropic-deepseek | custom */
    provider?: string;
    baseUrl: string;
    apiKey: string;
    name: string;
    /**
     * Image handling (default `auto`):
     * - `auto` / `native`: send image_url when model supports vision (see model.vision)
     * - `off`: ignore image attachments
     */
    visionMode?: "auto" | "native" | "off";
    /** Force enable/disable vision regardless of model id heuristic. */
    vision?: boolean;
    options?: ModelOptions;
  };
  limits: {
    maxSteps: number;
    toolResultMaxChars: number;
    /** Approx max tokens for session history replay (default 64k) */
    maxContextTokens: number;
  };
  daemon: {
    socketPath: string;
    dataDir: string;
  };
  mcp?: {
    servers: Array<{
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      enabled?: boolean;
    }>;
  };
  plugins?: {
    enabled?: Record<string, boolean>;
  };
  skills?: {
    enabled?: Record<string, boolean>;
  };
  /** Personal assistant capability permissions (fileSystem, network, software, …). */
  permissions?: PermissionsConfig;
  /** Web search provider settings (API keys, cache TTL). */
  network?: NetworkServiceConfig;
  ui?: {
    /** Projects shared by Desktop and trusted remote channels. */
    projects?: Array<{
      id: string;
      name: string;
      cwd: string;
    }>;
    /** REPL: apply write_file/write_patch immediately without end-of-turn confirm */
    autoApplyPatches?: boolean;
    /** Desktop: ask before each run_command (with a per-session "always allow"). */
    confirmCommands?: boolean;
    /**
     * Model reasoning_content display (DeepSeek thinking mode).
     * - collapse: stream live, then fold to one summary line (default)
     * - stream: keep full thinking visible + summary footer
     * - hidden: only status line with char count, then summary
     */
    thinking?: ThinkingDisplayMode;
    /**
     * CLI progress verbosity.
     * - compact: single-line progress + essential events (default)
     * - verbose: keep step separators and richer logs
     */
    progress?: ProgressDisplayMode;
    /** Desktop color theme. */
    theme?: ThemeDisplayMode;
  };
  /** Generic reflection gate run before delivering a final answer. Default off. */
  reflection?: ReflectionConfig;
}

export const DEFAULT_CONFIG: ForgeConfig = {
  model: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    name: "gpt-4o-mini",
  },
  limits: {
    maxSteps: 40,
    toolResultMaxChars: 12_000,
    maxContextTokens: 64_000,
  },
  daemon: {
    socketPath: "",
    dataDir: "",
  },
  permissions: DEFAULT_PERMISSIONS,
};

/** Bump when daemon/workspace path logic changes; desktop restarts stale daemons. */
export const FORGE_DAEMON_BUILD = "2026-07-16-shared-projects-v1";

export const DAEMON_METHODS = {
  PING: "ping",
  RUN: "run",
  LIST_CODEX_MODELS: "codex.list_models",
  LIST_CURSOR_MODELS: "cursor.list_models",
  PROBE_CURSOR_RUNTIME: "cursor.probe",
  LIST_RUNTIMES: "runtime.list",
  CLOSE_ACP_SESSION: "runtime.close_acp_session",
  RELEASE_ACP_FORGE_SESSION: "runtime.release_acp_forge_session",
  LIST_WARM_ACP_SESSIONS: "runtime.list_warm_acp_sessions",
  PREWARM_ACP_SESSION: "runtime.prewarm_acp_session",
  CANCEL_RUN: "cancel_run",
  APPLY_PATCH: "apply_patch",
  RESTORE_CHECKPOINT: "restore_checkpoint",
  PLAN: "plan",
  REVIEW: "review",
  COMPACT_SESSION: "compact_session",
  STATUS: "status",
  LIST_SESSIONS: "list_sessions",
  LIST_PROJECTS: "project.list",
  REGISTER_PROJECT: "project.register",
  SEARCH_SESSIONS: "search_sessions",
  GET_SESSION_MESSAGES: "get_session_messages",
  LIST_PLUGINS: "list_plugins",
  LIST_SKILLS: "list_skills",
  LIST_MCP: "list_mcp",
  SEARCH_CATALOG: "search_catalog",
  SET_SKILL_ENABLED: "set_skill_enabled",
  SET_PLUGIN_ENABLED: "set_plugin_enabled",
  IMPORT_SKILL: "import_skill",
  IMPORT_PLUGIN: "import_plugin",
  SEARCH_SKILLS_MARKETPLACE: "search_skills_marketplace",
  SEARCH_PLUGINS_MARKETPLACE: "search_plugins_marketplace",
  HUB_LIST: "hub.list",
  HUB_INSTALL: "hub.install",
  HUB_DEPLOY: "hub.deploy",
  HUB_UNDEPLOY: "hub.undeploy",
  HUB_REMOVE: "hub.remove",
  HUB_SYNC: "hub.sync",
  HUB_DISCOVER: "hub.discover",
  HUB_IMPORT: "hub.import",
  TALENTS_SYNC_TEMPLATES: "talents.sync_templates",
  TALENTS_LIST_TEMPLATES: "talents.list_templates",
  TALENTS_HIRE: "talents.hire",
  TALENTS_FIRE: "talents.fire",
  TALENTS_LIST_ROSTER: "talents.list_roster",
  TALENTS_RENAME: "talents.rename",
  TALENTS_UPDATE_BINDINGS: "talents.update_bindings",
  TALENTS_GET_TEMPLATE: "talents.get_template",
  TALENTS_CREATE_CUSTOM: "talents.create_custom",
  TALENTS_UPDATE_CUSTOM: "talents.update_custom",
  TALENTS_DELETE_CUSTOM: "talents.delete_custom",
  TALENTS_LIST_TEAMS: "talents.list_teams",
  TALENTS_CREATE_TEAM: "talents.create_team",
  TALENTS_UPDATE_TEAM: "talents.update_team",
  TALENTS_DELETE_TEAM: "talents.delete_team",
  TALENTS_LIST_AGENT_RUNS: "talents.list_agent_runs",
  TALENTS_LIST_AGENT_MEMORY: "talents.list_agent_memory",
  GET_CONFIG: "get_config",
  RELOAD_RUNTIME: "reload_runtime",
  LIST_AUTOMATIONS: "list_automations",
  GET_AUTOMATION: "get_automation",
  CREATE_AUTOMATION: "create_automation",
  UPDATE_AUTOMATION: "update_automation",
  DELETE_AUTOMATION: "delete_automation",
  RUN_AUTOMATION: "run_automation",
  LIST_AUTOMATION_RUNS: "list_automation_runs",
  PARSE_AUTOMATION_DRAFT: "parse_automation_draft",
  LIST_AUTOMATION_TEMPLATES: "list_automation_templates",
  LIST_CHANNELS: "list_channels",
  GET_CHANNEL: "get_channel",
  CREATE_CHANNEL: "create_channel",
  UPDATE_CHANNEL: "update_channel",
  DELETE_CHANNEL: "delete_channel",
  LIST_CHANNEL_KINDS: "list_channel_kinds",
  GET_CHANNEL_GATEWAY_STATUS: "get_channel_gateway_status",
  START_CHANNEL_GATEWAY: "start_channel_gateway",
  STOP_CHANNEL_GATEWAY: "stop_channel_gateway",
  CHANNEL_START_LOGIN: "channel_start_login",
  CHANNEL_POLL_LOGIN: "channel_poll_login",
  MOBILE_CREATE_PAIRING: "mobile.create_pairing",
  MOBILE_LIST_DEVICES: "mobile.list_devices",
  MOBILE_REVOKE_DEVICE: "mobile.revoke_device",
  MOBILE_UPDATE_DEVICE_PROJECTS: "mobile.update_device_projects",
  MOBILE_GIT_BRANCHES: "mobile.git.branches",
  MOBILE_GIT_SWITCH: "mobile.git.switch",
  MOBILE_WORKSPACE_FILES_LIST: "mobile.workspace.files.list",
  MOBILE_WORKSPACE_FILE_READ: "mobile.workspace.file.read",
  MOBILE_WORKSPACE_DIFF_LIST: "mobile.workspace.diff.list",
  MOBILE_WORKSPACE_DIFF_GET: "mobile.workspace.diff.get",
  PERMISSION_RESPONSE: "permission_response",
} as const;

export const AGENT_EVENT_METHOD = "agent.event";
