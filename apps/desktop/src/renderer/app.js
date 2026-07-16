const $ = (id) => document.getElementById(id);

function getBridge() {
  return window.forgeDesktop;
}

function requireBridge() {
  const b = getBridge();
  if (!b) throw new Error("桌面通信桥未就绪");
  return b;
}

let notifyUserHideTimer = null;

const VALID_THEME_MODES = new Set(["system", "dark", "light"]);

function normalizeThemeMode(theme) {
  const mode = String(theme || "system");
  return VALID_THEME_MODES.has(mode) ? mode : "system";
}

function applyTheme(theme) {
  if (!document?.body) return;
  document.body.dataset.theme = normalizeThemeMode(theme);
}

function showBootstrapBanner(message) {
  const el = $("bootstrapBanner");
  if (!el) return;
  if (!message) {
    el.classList.add("hidden");
    el.textContent = "";
    el.classList.remove("is-warn");
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
}

function networkPermissionActionLabel(action) {
  switch (action) {
    case "search":
      return "搜索";
    case "web":
      return "抓取网页";
    case "api":
      return "API 请求";
    case "download":
      return "下载文件";
    default:
      return action || "网络";
  }
}

function formatNetworkPermissionMeta(ev) {
  const detail = ev.detail || {};
  const parts = [];
  if (detail.query) parts.push(`query: ${detail.query}`);
  if (detail.url) parts.push(`url: ${detail.url}`);
  if (detail.method) parts.push(`method: ${detail.method}`);
  if (detail.path) parts.push(`path: ${detail.path}`);
  return parts.join(" · ");
}

function renderNetworkPermissionBanner() {
  const host = $("networkPermissionHost");
  if (!host) return;
  const composerCard = $("composerCard");
  if (!state.pendingNetworkPermissions.size) {
    host.classList.add("hidden");
    host.innerHTML = "";
    composerCard?.classList.remove("permission-active");
    return;
  }
  host.classList.remove("hidden");
  composerCard?.classList.add("permission-active");
  host.innerHTML = [...state.pendingNetworkPermissions.values()]
    .map((ev) => {
      if (ev.kind === "acp" || ev.kind === "codex" || ev.kind === "claude-code") {
        const providerLabel =
          ev.kind === "codex"
            ? "Codex"
            : ev.kind === "claude-code"
              ? "Claude Code"
              : "ACP";
        const options = Array.isArray(ev.options) ? ev.options : [];
        const optionButtons = options.length
          ? options
              .map((option) => {
                const isAllow =
                  option.kind?.includes("allow") ||
                  /allow|允许|approve|accept/i.test(option.name || "");
                const btnClass = isAllow ? "btn primary btn-sm" : "btn secondary btn-sm";
                return `<button type="button" class="${btnClass}" data-permission-acp="${escapeHtml(ev.id)}" data-option-id="${escapeHtml(option.optionId)}">${escapeHtml(option.name || option.optionId)}</button>`;
              })
              .join("")
          : `<button type="button" class="btn secondary btn-sm" data-permission-deny="${escapeHtml(ev.id)}">拒绝</button>
             <button type="button" class="btn primary btn-sm" data-permission-allow="${escapeHtml(ev.id)}">允许</button>`;
        return `<div class="network-permission-card is-acp" data-permission-id="${escapeHtml(ev.id)}">
        <p><strong>${escapeHtml(providerLabel)} 工具授权</strong> — ${escapeHtml(ev.summary || "")}</p>
        <div class="network-permission-actions">${optionButtons}</div>
      </div>`;
      }
      if (ev.kind === "command") {
        return `<div class="network-permission-card is-command" data-permission-id="${escapeHtml(ev.id)}">
        <p><strong>执行命令</strong></p>
        <div class="network-permission-cmd"><code>${escapeHtml(ev.summary || "")}</code></div>
        <div class="network-permission-actions">
          <button type="button" class="btn secondary btn-sm" data-permission-deny="${escapeHtml(ev.id)}">拒绝</button>
          <button type="button" class="btn secondary btn-sm" data-permission-allow="${escapeHtml(ev.id)}">允许一次</button>
          <button type="button" class="btn primary btn-sm" data-permission-always="${escapeHtml(ev.id)}">本会话总是允许</button>
        </div>
      </div>`;
      }
      const meta = formatNetworkPermissionMeta(ev);
      return `<div class="network-permission-card" data-permission-id="${escapeHtml(ev.id)}">
        <p><strong>${escapeHtml(networkPermissionActionLabel(ev.action))}</strong> — ${escapeHtml(ev.summary || "")}</p>
        ${meta ? `<div class="network-permission-meta">${escapeHtml(meta)}</div>` : ""}
        <div class="network-permission-actions">
          <button type="button" class="btn secondary btn-sm" data-permission-deny="${escapeHtml(ev.id)}">拒绝</button>
          <button type="button" class="btn primary btn-sm" data-permission-allow="${escapeHtml(ev.id)}">允许</button>
        </div>
      </div>`;
    })
    .join("");
  host.querySelectorAll("[data-permission-acp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void respondAcpPermission(
        btn.getAttribute("data-permission-acp"),
        btn.getAttribute("data-option-id"),
      );
    });
  });
  host.querySelectorAll("[data-permission-allow]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void respondNetworkPermission(btn.getAttribute("data-permission-allow"), true);
    });
  });
  host.querySelectorAll("[data-permission-always]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void respondNetworkPermission(
        btn.getAttribute("data-permission-always"),
        true,
        true,
      );
    });
  });
  host.querySelectorAll("[data-permission-deny]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void respondNetworkPermission(btn.getAttribute("data-permission-deny"), false);
    });
  });
}

function showNetworkPermissionRequest(ev) {
  if (!ev?.id || state.pendingNetworkPermissions.has(ev.id)) return;
  state.pendingNetworkPermissions.set(ev.id, ev);
  renderNetworkPermissionBanner();
}

function clearNetworkPermissionBanner() {
  if (!state.pendingNetworkPermissions.size) return;
  state.pendingNetworkPermissions.clear();
  renderNetworkPermissionBanner();
}

async function respondAcpPermission(id, optionId) {
  if (!id || !optionId || !state.pendingNetworkPermissions.has(id)) return;
  const ev = state.pendingNetworkPermissions.get(id);
  try {
    const res = await requireBridge().respondPermission({ id, optionId });
    if (res?.ok === false) {
      notifyUser("权限响应未被 Daemon 接受（可能已超时）", "warn");
    }
  } catch (e) {
    notifyUser(`发送权限响应失败: ${String(e)}`, "err");
    return;
  }
  state.pendingNetworkPermissions.delete(id);
  renderNetworkPermissionBanner();
  const label =
    ev?.options?.find((option) => option.optionId === optionId)?.name || optionId;
  pushEvent(`ACP 授权: ${label}`, "done");
}

async function respondNetworkPermission(id, approved, remember = false) {
  if (!id || !state.pendingNetworkPermissions.has(id)) return;
  const ev = state.pendingNetworkPermissions.get(id);
  try {
    const res = await requireBridge().respondPermission({ id, approved, remember });
    if (res?.ok === false) {
      notifyUser("权限响应未被 Daemon 接受（可能已超时）", "warn");
    }
  } catch (e) {
    notifyUser(`发送权限响应失败: ${String(e)}`, "err");
    return;
  }
  state.pendingNetworkPermissions.delete(id);
  renderNetworkPermissionBanner();
  if (ev?.kind === "command") {
    pushEvent(
      approved
        ? remember
          ? "已允许执行命令（本会话不再询问）"
          : "已允许执行命令"
        : "已拒绝执行命令",
      approved ? "done" : "warn",
    );
  } else {
    pushEvent(approved ? "已允许网络操作" : "已拒绝网络操作", approved ? "done" : "warn");
  }
}

function notifyUser(message, level = "warn") {
  const text = String(message || "").trim();
  if (!text) return;
  const el = $("bootstrapBanner");
  if (el) {
    el.classList.toggle("is-warn", level === "warn");
    showBootstrapBanner(text);
    if (level !== "err") {
      clearTimeout(notifyUserHideTimer);
      notifyUserHideTimer = setTimeout(() => showBootstrapBanner(null), 4500);
    }
  }
  if (!state.chatEmpty && state.activeNav === "chat") {
    const viewingSid = sessionRuns?.getViewingSessionId?.() || "";
    const runActive = Boolean(viewingSid && state.runningSessions.has(viewingSid));
    if (!runActive) {
      pushEvent(text, level === "err" ? "err" : level === "warn" ? "warn" : "done");
    }
  }
}

/** Desktop notification when a run finishes while the window is in the background. */
function notifyRunFinishedInBackground(sessionId, ok, text) {
  try {
    if (typeof Notification === "undefined") return;
    if (document.hasFocus()) return;
    if (Notification.permission === "denied") return;
    const body =
      String(text || "").replace(/\s+/g, " ").trim().slice(0, 140) ||
      (ok ? "本轮执行已完成" : "执行过程中出现错误");
    const n = new Notification(ok ? "Forge · 任务完成" : "Forge · 执行失败", { body });
    n.onclick = () => {
      window.focus();
      if (!sessionId || sessionRuns?.isViewingSession?.(sessionId)) return;
      const cwd =
        state.sessionCwdById.get(sessionId) ||
        state.sessionsAll.find((s) => s.id === sessionId)?.cwd;
      const project =
        state.projects.find((p) => p.cwd === cwd) || getActiveProject();
      if (!project) return;
      const outgoingSid =
        state.viewingTimelineSessionId || getActiveProject()?.sessionId || "";
      const prevSid = project.sessionId;
      state.activeProjectId = project.id;
      state.expandedProjectIds.add(project.id);
      setNav("chat");
      void sessionRuns
        ?.switchSessionView(project, sessionId, prevSid, {
          outgoingSessionId: outgoingSid,
        })
        .then(() => {
          renderProjects();
          renderComposerProjectSelect();
        });
    };
  } catch {
    /* notification is best-effort */
  }
}

/** Enable with `localStorage.setItem('forgeDebugSession','1')` or `forgeSessionDebug(true)` in DevTools. */
function forgeSessionLog(label, detail) {
  try {
    if (localStorage.getItem("forgeDebugSession") !== "1") return;
    if (detail === undefined) console.log("[forge:session]", label);
    else console.log("[forge:session]", label, detail);
  } catch {
    /* ignore */
  }
}

window.forgeSessionDebug = (on = true) => {
  try {
    localStorage.setItem("forgeDebugSession", on ? "1" : "0");
    console.log(`[forge:session] debug ${on ? "enabled" : "disabled"}`);
  } catch {
    /* ignore */
  }
};

const LS_PROJECTS_KEY = "forgeDesktopProjectsV1";
const LS_ACTIVE_PROJECT_KEY = "forgeDesktopActiveProjectV1";
const LS_PROJECT_EXPANDED_KEY = "forgeDesktopExpandedProjectsV1";
const LS_SESSION_UI_KEY = "forgeDesktopSessionUiV1";
const LS_PANEL_WIDTHS_KEY = "forgeDesktopPanelWidthsV1";
const PANEL_MIN_LEFT = 200;
const PANEL_MAX_LEFT = 480;
const PANEL_MIN_RIGHT = 260;
const PANEL_MAX_RIGHT = 720;
const PANEL_DEFAULT_LEFT = 272;
const PANEL_DEFAULT_RIGHT = 380;

const state = {
  config: null,
  codexModels: [],
  selectedCodexModel: "",
  loadingCodexModels: false,
  claudeModels: [
    { id: "sonnet", model: "sonnet", displayName: "Sonnet", isDefault: true },
    { id: "opus", model: "opus", displayName: "Opus" },
    { id: "haiku", model: "haiku", displayName: "Haiku" },
  ],
  selectedClaudeModel: "sonnet",
  cursorModels: [],
  selectedCursorModel: "",
  cursorModes: [],
  selectedCursorMode: "default",
  cursorRuntimeStatus: null,
  loadingCursorModels: false,
  runtimeProviders: [],
  runtimeSelectedProvider: "forge",
  runtimeWarmSessions: [],
  acpPrewarmTimer: null,
  acpPrewarmKey: "",
  acpPrewarmInFlight: false,
  runtimePrefs: null,
  sessionsAll: [],
  plugins: [],
  pluginsSearchQuery: "",
  pluginsTab: "installed",
  /** Manage-page category: user | project | builtin | orphan */
  pluginsManageGroup: "user",
  pluginsMarketQuery: "",
  pluginsMarketItems: [],
  pluginsMarketHint: "",
  pluginsMarketLoading: false,
  pluginsMarketTimer: null,
  /** Hub list + discovery for manage cards (plugins). */
  hubPluginRows: new Map(),
  hubPluginDiscovery: [],
  /** Hub list + discovery for manage cards (skills). */
  hubSkillRows: new Map(),
  hubSkillDiscovery: [],
  running: false,
  /** Session ids with an active daemon run */
  runningSessions: new Set(),
  /** sessionId -> last daemon row version applied to the timeline (kills refresh loops:
   *  local rows carry a local-clock updatedAt that never equals the daemon's). */
  externalSessionVersionSeen: new Map(),
  /** Sessions whose run finished while not being viewed — sidebar dot until opened. */
  unreadDoneSessions: new Set(),
  /** sessionId -> { used, max, truncated } from the daemon's context_usage event. */
  contextUsageBySession: new Map(),
  /** Sessions already nudged about the 90% context threshold. */
  compactNudgedSessions: new Set(),
  /** sessionId -> [{ projectId, message, attachments }] queued while that session is running. */
  queuedRunsBySession: new Map(),
  pendingNewSessionByProject: new Set(),
  clientRuns: new Map(),
  /** sessionId -> ordered structured timeline entries (JSON source of truth). */
  normalTimelineBySession: new Map(),
  /** sessionId -> structured dispatch/talent timeline state for team runs. */
  dispatchTimelineBySession: new Map(),
  /** sessionId -> reflection-gate state (round/status/issues) for the run. */
  reflectionBySession: new Map(),
  sessionCwdById: new Map(),
  /** Bumped on each session switch; stale async restores are ignored. */
  viewSwitchGeneration: 0,
  /** Skip structured timeline writes while rebuilding DOM from JSON. */
  suppressTimelineRecording: false,
  /** Session id currently shown in #timeline (may lead project.sessionId during switch). */
  viewingTimelineSessionId: null,
  /** sessionId -> runtime provider for presentation-only timeline styling. */
  runtimeBySession: new Map(),
  eventRouteSessionId: null,
  /** Which session owns global stream/activity DOM state */
  liveRunSessionId: null,
  planCardTitle: "任务清单",
  /** After talent waves finish, block coordinator update_plan from replacing the dispatch card. */
  dispatchPlanLocked: false,
  /** Virtual timeline root while routing events for a non-viewed session */
  offscreenTimelineEl: null,
  stopRequestedBySession: new Map(),
  runConclusionBySession: new Map(),
  /** sessionId -> last conclusion markdown (survives offscreen + session switch) */
  runFinalTextBySession: new Map(),
  /** sessionId -> step narrative lines already shown inside 已处理 (dedupe conclusion) */
  stepNarrativesBySession: new Map(),
  /** Prevents duplicate 结论 blocks when done event + run() result both fire */
  conclusionDomRenderedThisTurn: new Set(),
  runPatchesBySession: new Map(),
  /** sessionId -> pre-run workspace checkpoint sha (git diff baseline for this turn) */
  runCheckpointShaBySession: new Map(),
  /** pendingToolLine key -> poll timer for git-diff path discovery during ACP edits */
  workspaceDiffPollTimers: new Map(),
  /** sessionId -> Map<eventDetailId, detail> survives timeline innerHTML restore */
  eventDetailsBySession: new Map(),
  eventSeq: 0,
  detailById: new Map(),
  /** Next run SessionStart source after /clear or /compact */
  pendingHookSource: null,
  /** permission_request id -> event */
  pendingNetworkPermissions: new Map(),
  hooksTab: "guide",
  automationCreateMode: false,
  automationEditorDraft: null,
  automationExpandedId: null,
  rightOpen: false,
  projects: [],
  activeProjectId: "",
  gitBranchByProject: new Map(),
  gitBranchRequestSeq: 0,
  gitBranchMenuOpen: false,
  gitBranchSearchQuery: "",
  gitBranchRefreshController: null,
  externalSessionRefreshTimer: null,
  externalSessionRefreshInFlight: false,
  activeNav: "chat",
  chatEmpty: true,
  expandedProjectIds: new Set(),
  pinnedSessionIds: new Set(),
  archivedSessionIds: new Set(),
  streamTextBuffer: "",
  streamTextRaw: "",
  streamTextNode: null,
  streamFlushTimer: null,
  thinkingBuffer: "",
  thinkingPre: null,
  activeThinkingTalent: null,
  /** mention -> { details, body, talent, startedAt, finalized? } for Mode B parallel subagents */
  subagentActivityByMention: new Map(),
  /** normalized mention keys currently running (Mode B) */
  activeSubagentMentions: new Set(),
  /** mention -> { pre, wrap } live text stream inside subagent card */
  subagentStreamByMention: new Map(),
  /** When set, pushEvent/thinking/tools append into this container (talent sub-timeline). */
  pushEventMountOverride: null,
  coordinatorPhaseAnnounced: false,
  statusNode: null,
  currentStepEl: null,
  currentStepBody: null,
  stepToolGroupEl: null,
  stepToolGroupBody: null,
  stepToolGroupCount: 0,
  runActivityEl: null,
  /** Live flat stream (timeline sibling) or folded `.run-activity-body` after conclusion. */
  runActivityBody: null,
  /** Real fold body inside `<details.run-activity>` (empty while streaming flat). */
  runActivityFoldBody: null,
  /** Flat stream host while the run is active (`null` after fold/unwrap). */
  runActivityStreamEl: null,
  runActivityStats: null,
  runActivityTimer: null,
  /** sessionId -> Map<relPath, provisional Codex file activity> */
  codexProvisionalFilesBySession: new Map(),
  /** sessionId -> normalized Codex commentary already rendered in 已处理 */
  codexCommentarySeenBySession: new Map(),
  activityFollowBottom: true,
  timelineFollowBottom: true,
  thinkingBlockSeq: 0,
  sawStreamTextInRun: false,
  skillsGroups: [],
  skillsSearchQuery: "",
  skillsTab: "installed",
  /** Manage-page category: builtin | plugin | project | user | orphan */
  skillsManageGroup: "user",
  skillsMarketQuery: "",
  skillsMarketItems: [],
  skillsMarketHint: "",
  skillsMarketLoading: false,
  skillsMarketTimer: null,
  skillsById: new Map(),
  activeSkillId: "",
  defaultCwd: "",
  runPatches: new Map(),
  runFinalText: "",
  /** sessionId -> in-flight tool line (tool calls run sequentially per session). */
  pendingToolLines: new Map(),
  /** Tool calls represented by canonical runtime file activity instead of a duplicate tool row. */
  normalizedFileActivityCallIds: new Set(),
  normalizedFileActivityPaths: new Set(),
  runConclusionRendered: false,
  panelLeftWidth: PANEL_DEFAULT_LEFT,
  panelRightWidth: PANEL_DEFAULT_RIGHT,
  // Which view occupies the right region: "code" (code/skill/plugin/talent
  // panel) or "terminal". The two are mutually exclusive in the same slot.
  rightMode: "code",
  workspaceExplorerOpen: false,
  workspaceExplorerExpanded: new Set(["."]),
  workspaceActiveFile: "",
  explorerMode: "workspace",
  skillExplorerSkillPath: "",
  skillExplorerRoot: "",
  skillExplorerExpanded: new Set(["."]),
  skillActiveFile: "",
  pluginsById: new Map(),
  activePluginId: "",
  pluginExplorerRoot: "",
  pluginExplorerExpanded: new Set(["."]),
  pluginActiveFile: "",
  /** @type {Array<{ id: string, attachment: import("@forge/protocol").RunAttachment }>} */
  composerAttachments: [],
  talentsRoster: [],
  talentTemplates: [],
  talentsTab: "market",
  talentMarketQuery: "",
  talentMarketCategory: "",
  talentRosterQuery: "",
  /** @type {string | null} */
  talentPreviewTemplateId: null,
  /** @type {"market" | "roster" | null} */
  talentPreviewSource: null,
  talentsLoading: false,
  /** @type {{ templateId: string, role: string, description?: string, emoji?: string, displayName?: string, mention?: string } | null} */
  talentHireDraft: null,
  /** @type {string | null} */
  talentDetailKey: null,
  /** @type {string} */
  activeTalentTemplateId: "",
  /** @type {Map<string, Set<string>>} */
  sessionTalentBusy: new Map(),
  /** @type {Map<string, number>} mention -> last activity ms (busy start/end) */
  talentActivityAt: new Map(),
  /** @type {Map<string, { mention: string, displayName: string, role?: string, emoji?: string }>} */
  foregroundTalentBySession: new Map(),
};

/** @type {ReturnType<typeof window.ForgeSessionRunUi.createSessionRunApi> | null} */
let sessionRuns = null;

function getTimelineMount() {
  return state.offscreenTimelineEl || $("timeline");
}

// Structured timeline state is updated incrementally on each mutation (O(1) per event).
function syncTimelineCacheForSession(sessionId) {
  touchTimelineState(sessionId);
}

/** No-op — kept so session-switch paths can flush before reading structured state. */
function flushTimelineCacheSync() {}

/** Paint offscreen structured timeline onto the live view when user is already on that session. */
function refreshLiveTimelineIfViewing(sessionId) {
  if (!sessionId || state.offscreenTimelineEl) return;
  if (state.viewingTimelineSessionId !== sessionId) return;
  if (sessionRuns?.getViewingSessionId() !== sessionId) return;
  const live = $("timeline");
  if (!live) return;
  const running = sessionRuns?.isSessionRunning(sessionId);
  if (!structuredTimelineCacheUsable(sessionId, running)) {
    reconcileSessionConclusion(sessionId);
    return;
  }
  const ui = captureTimelineUiState(live);
  loadSessionRunArtifacts(sessionId);
  renderTimelineFromState(sessionId, live);
  ensureConclusionCardForSession(sessionId);
  if (running) ensureLiveRunSession(sessionId);
  restoreTimelineUiState(ui, live);
}

function isViewSwitchCurrent(switchGen) {
  return switchGen == null || switchGen === state.viewSwitchGeneration;
}

function rememberSessionCwd(sessionId, cwd) {
  if (!sessionId || !cwd) return;
  state.sessionCwdById.set(sessionId, cwd);
}

function sessionBelongsToActiveProject(sessionId) {
  const project = getActiveProject();
  if (!project?.cwd || !sessionId) return true;
  const cwd =
    state.sessionCwdById.get(sessionId) ||
    state.sessionsAll.find((s) => s.id === sessionId)?.cwd;
  if (!cwd) return true;
  return sessionCwdMatches(project.cwd, cwd);
}

function captureOutgoingTimeline(outgoingSessionId) {
  if (!outgoingSessionId || state.chatEmpty) return;
  syncStructuredTimelineFromDom(outgoingSessionId);
  sanitizeStructuredTimelineCache(outgoingSessionId);
  saveSessionRunArtifacts(outgoingSessionId);
}

function recordStepNarrativeEntry(sessionId, text, markdown = false) {
  if (state.suppressTimelineRecording) return;
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  const timelineState = getNormalTimelineState(sessionId, true);
  if (!timelineState) return;
  const runEntry = findTimelineRunActivityEntry(timelineState);
  if (!runEntry) return;
  if (!runEntry.children) runEntry.children = [];
  runEntry.children.push({
    type: "step_narrative",
    id: timelineEntryId(),
    text: trimmed,
    markdown: Boolean(markdown),
    createdAt: Date.now(),
  });
  touchTimelineState(sessionId);
}

function domLineTextContent(line) {
  if (!line) return "";
  const clone = line.cloneNode(true);
  clone.querySelectorAll(".inline-diff, .md-code-copy").forEach((el) => el.remove());
  return String(clone.textContent || "").trim();
}

function snapshotDomTimelineChild(node, sessionId) {
  if (!node) return null;
  if (node.classList?.contains("codex-activity-chip")) {
    const labelEl = node.querySelector(".codex-activity-label");
    const statsText = node.querySelector(".codex-activity-stats")?.textContent || "";
    return {
      type: "codex_activity",
      id: node.dataset.timelineNodeId || timelineEntryId(),
      callId: node.dataset.codexActivityId || "",
      iconKey: node.dataset.iconKey || "command",
      label: labelEl?.textContent || "",
      status: node.classList.contains("is-running") ? "running" : "done",
      adds: Number(statsText.match(/\+(\d+)/)?.[1] || 0),
      dels: Number(statsText.match(/-(\d+)/)?.[1] || 0),
      forgeDetail: node.dataset.forgeDetail || "",
      createdAt: Date.now(),
    };
  }
  if (node.classList?.contains("codex-commentary")) {
    const host = node.querySelector(".codex-commentary-text");
    const text = domLineTextContent(host);
    if (!text) return null;
    return {
      type: "codex_commentary",
      id: node.dataset.timelineNodeId || timelineEntryId(),
      text,
      markdown: Boolean(host?.querySelector(".md-preview")),
      createdAt: Date.now(),
    };
  }
  if (node.classList?.contains("step-narrative")) {
    const host = node.querySelector(".step-narrative-text");
    const text = domLineTextContent(host);
    if (!text) return null;
    return {
      type: "step_narrative",
      id: node.dataset.timelineNodeId || timelineEntryId(),
      text,
      markdown: Boolean(host?.querySelector(".md-preview")),
      createdAt: Date.now(),
    };
  }
  if (node.classList?.contains("event")) {
    const cls = [...node.classList].filter((c) => c !== "event").join(" ");
    const entry = {
      type: "event",
      id: node.dataset.timelineNodeId || timelineEntryId(),
      text: domLineTextContent(node),
      className: cls,
      eventDetailId: node.dataset.eventDetailId || "",
      eventDetailSession: node.dataset.eventDetailSession || sessionId || "",
      forgeDetail: node.dataset.forgeDetail || "",
      isUserPrompt: node.classList.contains("user-prompt"),
      hasDetail: node.classList.contains("clickable") || Boolean(node.dataset.forgeDetail),
      createdAt: Date.now(),
    };
    return entry;
  }
  if (node.tagName === "DETAILS" && node.classList.contains("thinking")) {
    const pre = node.querySelector(".event-pre");
    return {
      type: "thinking",
      id: node.dataset.thinkingId || timelineEntryId(),
      talentMention: node.dataset.talentMention || "",
      summary: node.querySelector("summary")?.textContent || "",
      content: pre?.textContent || "",
      open: node.open,
      createdAt: Date.now(),
    };
  }
  return null;
}

function snapshotRunActivityBodyChildren(body, sessionId) {
  const children = [];
  if (!body) return children;
  const walk = (parent) => {
    for (const node of parent.children) {
      if (
        node.classList?.contains("run-conclusion-live") ||
        node.classList?.contains("run-conclusion") ||
        (node.classList?.contains("assistant-block") &&
          node.classList?.contains("narrative-buffer"))
      ) {
        continue;
      }
      if (node.matches?.("details.step-tool-group")) {
        const groupBody = node.querySelector(".step-tool-group-body");
        if (groupBody) walk(groupBody);
        continue;
      }
      const entry = snapshotDomTimelineChild(node, sessionId);
      if (entry) children.push(entry);
    }
  };
  walk(body);
  return children;
}

/** Live stream host for the active run (flat timeline sibling while running). */
function getRunActivityContentHost(activity = state.runActivityEl) {
  if (!activity) return state.runActivityStreamEl || state.runActivityBody;
  const streamId = activity.dataset.streamId;
  if (streamId) {
    const stream = activity.parentElement?.querySelector(
      `:scope > .run-activity-stream[data-stream-id="${cssEscape(streamId)}"]`,
    );
    if (stream) return stream;
  }
  if (state.runActivityEl === activity && state.runActivityStreamEl?.isConnected) {
    return state.runActivityStreamEl;
  }
  return activity.querySelector(".run-activity-body");
}

function countRunActivityContentUnits(host) {
  if (!host) return 0;
  return host.querySelectorAll(
    ".step-narrative, .tool-event, details.thinking, .codex-commentary, .codex-activity-chip, details.subagent-talent-activity, details.step-tool-group, .live-response-event",
  ).length;
}

function estimateRunActivityContentChars(host) {
  if (!host) return 0;
  return String(host.textContent || "").replace(/\s+/g, " ").trim().length;
}

/** Fold long process output into 已处理; keep short runs flat in the dialog. */
function shouldCollapseRunActivityContent(host) {
  const units = countRunActivityContentUnits(host);
  const chars = estimateRunActivityContentChars(host);
  return units >= 4 || chars >= 800;
}

function collectLiveRunActivityStreamNodes(activity, mount = getTimelineMount()) {
  if (!activity || !mount) return [];
  const nodes = [];
  let node = activity.nextElementSibling;
  while (node) {
    if (node.classList?.contains("user-prompt")) break;
    if (node.matches?.("details.run-activity") && !node.classList.contains("subagent-talent-activity")) {
      break;
    }
    if (node.classList?.contains("run-conclusion")) break;
    const next = node.nextElementSibling;
    if (node.classList?.contains("run-activity-stream")) {
      nodes.push(...[...node.children]);
    } else if (shouldHoistNodeIntoRunActivity(node) || node.matches?.("details.step-tool-group")) {
      nodes.push(node);
    }
    node = next;
  }
  return nodes;
}

function foldLiveRunActivityContent(details) {
  const foldBody = details?.querySelector?.(".run-activity-body");
  if (!foldBody) return false;
  const stream =
    getRunActivityContentHost(details) ||
    (details.dataset.streamId
      ? details.parentElement?.querySelector(
          `:scope > .run-activity-stream[data-stream-id="${cssEscape(details.dataset.streamId)}"]`,
        )
      : null);
  const nodes =
    stream?.classList?.contains("run-activity-stream")
      ? [...stream.children]
      : collectLiveRunActivityStreamNodes(details);
  for (const node of nodes) foldBody.appendChild(node);
  if (stream?.classList?.contains("run-activity-stream")) stream.remove();
  if (state.runActivityEl === details) {
    state.runActivityStreamEl = null;
    state.runActivityFoldBody = foldBody;
    state.runActivityBody = foldBody;
  }
  delete details.dataset.streamId;
  return foldBody.childElementCount > 0;
}

function unwrapLiveRunActivityContent(details) {
  const stream =
    getRunActivityContentHost(details) ||
    (details.dataset.streamId
      ? details.parentElement?.querySelector(
          `:scope > .run-activity-stream[data-stream-id="${cssEscape(details.dataset.streamId)}"]`,
        )
      : null);
  if (stream?.classList?.contains("run-activity-stream")) {
    const parent = details.parentElement;
    if (parent) {
      while (stream.firstChild) parent.insertBefore(stream.firstChild, details);
    }
    stream.remove();
  }
  const entryId = details.dataset.timelineEntryId;
  const sid = getActiveEventSessionId();
  details.remove();
  if (sid && entryId) {
    const timelineState = getNormalTimelineState(sid, false);
    if (timelineState) {
      const entries = ensureTimelineEntries(timelineState);
      const idx = entries.findIndex(
        (entry) => entry.type === "run_activity" && entry.id === entryId,
      );
      if (idx >= 0) {
        const removed = entries.splice(idx, 1)[0];
        if (timelineState.activeRunEntry === removed) timelineState.activeRunEntry = null;
        touchTimelineState(sid);
      }
    }
  }
  if (state.runActivityEl === details) {
    state.runActivityEl = null;
    state.runActivityBody = null;
    state.runActivityFoldBody = null;
    state.runActivityStreamEl = null;
  }
}

/** Flush live run-activity DOM into structured cache before session switch / restore. */
function syncStructuredTimelineFromDom(sessionId) {
  if (!sessionId || state.suppressTimelineRecording) return;
  const mount = $("timeline");
  if (!mount || state.viewingTimelineSessionId !== sessionId) return;
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return;
  const entries = ensureTimelineEntries(timelineState);
  state.suppressTimelineRecording = true;
  try {
    mount.querySelectorAll(":scope > details.run-activity").forEach((activity) => {
      const entryId = activity.dataset.timelineEntryId;
      let runEntry = entryId
        ? entries.find((entry) => entry.type === "run_activity" && entry.id === entryId)
        : null;
      if (!runEntry) {
        runEntry = {
          type: "run_activity",
          id: entryId || timelineEntryId(),
          label: activity.querySelector(".run-activity-label")?.textContent || "已处理",
          meta: activity.querySelector(".run-activity-meta")?.textContent || "",
          open: activity.open,
          active: activity.classList.contains("run-activity-active"),
          finalized: !activity.classList.contains("run-activity-active"),
          children: [],
          createdAt: Date.now(),
        };
        entries.push(runEntry);
        activity.dataset.timelineEntryId = runEntry.id;
      } else {
        runEntry.label = activity.querySelector(".run-activity-label")?.textContent || runEntry.label;
        runEntry.meta = activity.querySelector(".run-activity-meta")?.textContent || runEntry.meta;
        runEntry.open = activity.open;
        runEntry.active = activity.classList.contains("run-activity-active");
        runEntry.finalized = !activity.classList.contains("run-activity-active");
      }
      const body = activity.querySelector(".run-activity-body");
      const streamHost = getRunActivityContentHost(activity);
      const contentHost =
        streamHost && streamHost !== body && streamHost.childElementCount
          ? streamHost
          : body;
      const domChildren = snapshotRunActivityBodyChildren(contentHost, sessionId);
      if (domChildren.length >= (runEntry.children?.length ?? 0)) {
        runEntry.children = domChildren;
      }
      if (!activity.classList.contains("subagent-talent-activity")) {
        const turnIndex = inferRunActivityTurnIndexFromDom(activity, mount);
        runEntry.turnIndex = turnIndex;
        activity.dataset.turnIndex = String(turnIndex);
      }
      timelineState.activeRunEntry = runEntry;
    });
    realignRunActivitiesToTurns(mount);
    touchTimelineState(sessionId);
  } finally {
    state.suppressTimelineRecording = false;
  }
}

function getActiveEventSessionId() {
  return (
    state.eventRouteSessionId ||
    state.liveRunSessionId ||
    sessionRuns?.getViewingSessionId() ||
    ""
  );
}

function getEventDetailStore(sessionId) {
  const sid = sessionId || getActiveEventSessionId() || "_anonymous";
  if (!state.eventDetailsBySession.has(sid)) {
    state.eventDetailsBySession.set(sid, new Map());
  }
  return state.eventDetailsBySession.get(sid);
}

function getNormalTimelineState(sessionId, create = false) {
  const sid = sessionId || getActiveEventSessionId() || "_anonymous";
  if (!state.normalTimelineBySession.has(sid) && create) {
    state.normalTimelineBySession.set(sid, {
      sessionId: sid,
      entries: [],
      updatedAt: Date.now(),
    });
  }
  return state.normalTimelineBySession.get(sid) || null;
}

function ensureTimelineEntries(timelineState) {
  if (!timelineState) return [];
  if (!Array.isArray(timelineState.entries)) {
    timelineState.entries = (timelineState.nodes || []).map((node) => ({
      type: "event",
      ...node,
    }));
    delete timelineState.nodes;
  }
  hoistNestedConclusionEntries(timelineState.entries);
  return timelineState.entries;
}

function isTimelineCardEntry(entry) {
  return (
    entry?.type === "plan_card" ||
    entry?.type === "dispatch_card" ||
    entry?.type === "reflection_card"
  );
}

/** Each turn must be: 提问 → 已处理? → 结论? before the next 提问. */
function structuredTimelineTurnOrderValid(entries) {
  if (!Array.isArray(entries) || !entries.length) return true;
  let turnNeedsPrompt = true;
  let turnHasContent = false;
  let sawPrompt = false;

  for (const entry of entries) {
    if (isTimelineCardEntry(entry)) continue;

    if (entry.type === "event" && entry.isUserPrompt) {
      if (!turnNeedsPrompt) return false;
      turnNeedsPrompt = false;
      turnHasContent = false;
      sawPrompt = true;
      continue;
    }

    if (entry.type === "run_activity" || entry.type === "conclusion") {
      if (turnNeedsPrompt) return false;
      turnHasContent = true;
      if (entry.type === "conclusion") turnNeedsPrompt = true;
      continue;
    }

    if (entry.type === "event" && turnNeedsPrompt) return false;
  }

  return (
    sawPrompt ||
    !entries.some((entry) => entry.type === "run_activity" || entry.type === "conclusion")
  );
}

function countStructuredTimelinePrompts(entries) {
  if (!Array.isArray(entries)) return 0;
  return entries.filter((entry) => entry.type === "event" && entry.isUserPrompt).length;
}

function isRestoreEligibleUserTurn(turn) {
  const raw = plainUserContent(turn.user?.content).trim();
  return (
    Boolean(raw) &&
    !isTeamDispatchFollowupMessage(raw) &&
    !raw.startsWith("Conversation summary")
  );
}

function countExpectedRestoreUserTurns(messages) {
  return turnsWithDedupedPrompts(messages).filter(isRestoreEligibleUserTurn).length;
}

function countExpectedRestoreCompletedTurns(messages) {
  return turnsWithDedupedPrompts(messages).filter(
    (turn) => isRestoreEligibleUserTurn(turn) && turn.msgs.some((msg) => msg.role === "assistant"),
  ).length;
}

function countExpectedRestoreActivityTurns(messages) {
  return turnsWithDedupedPrompts(messages).filter((turn) => {
    if (!isRestoreEligibleUserTurn(turn)) return false;
    const assistants = turn.msgs.filter((msg) => msg.role === "assistant");
    if (
      assistants.some(
        (msg) => msg.reasoning_content || (msg.tool_calls?.length ?? 0) > 0,
      )
    ) {
      return true;
    }
    return assistants.length > 1;
  }).length;
}

function countCacheSubstantiveActivityTurns(entries) {
  if (!Array.isArray(entries)) return 0;
  return entries.filter(
    (entry) =>
      entry.type === "run_activity" &&
      (entry.children || []).some((child) => isSubstantiveRunActivityChild(child)),
  ).length;
}

/** Reject partial caches (e.g. turn-1 complete + turn-2 prompt only) when daemon has more. */
function structuredTimelineMatchesMessages(sessionId, messages) {
  if (!sessionId || !Array.isArray(messages) || !messages.length) return false;
  sanitizeStructuredTimelineCache(sessionId);
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return false;
  const entries = ensureTimelineEntries(timelineState);
  const cachePrompts = countStructuredTimelinePrompts(entries);
  const cacheConclusions = entries.filter((entry) => entry.type === "conclusion").length;
  const cacheActivities = entries.filter((entry) => entry.type === "run_activity").length;
  const cacheSubstantiveActivities = countCacheSubstantiveActivityTurns(entries);
  const expectedPrompts = countExpectedRestoreUserTurns(messages);
  const expectedConclusions = countExpectedRestoreCompletedTurns(messages);
  const expectedActivities = countExpectedRestoreActivityTurns(messages);
  const externalRuntime = sessionUsesExternalRuntime(sessionId, messages);
  if (cachePrompts < expectedPrompts) return false;
  if (cacheConclusions < expectedConclusions) return false;
  if (!externalRuntime && cacheActivities < expectedActivities) return false;
  if (!externalRuntime && expectedActivities > 0 && cacheSubstantiveActivities < expectedActivities) {
    return false;
  }
  // Cursor/ACP sessions don't persist tool_calls — trust substantive cached activity.
  if (externalRuntime && cacheSubstantiveActivities > 0) return true;
  return true;
}

function snapshotRunActivitiesFromCache(sessionId) {
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return [];
  const entries = ensureTimelineEntries(timelineState);
  const out = [];
  let turnIndex = -1;
  for (const entry of entries) {
    if (entry.type === "event" && entry.isUserPrompt) {
      turnIndex += 1;
      continue;
    }
    if (entry.type !== "run_activity") continue;
    out.push({
      turnIndex:
        typeof entry.turnIndex === "number" && entry.turnIndex >= 0
          ? entry.turnIndex
          : Math.max(0, turnIndex),
      label: entry.label,
      meta: entry.meta,
      open: entry.open,
      finalized: entry.finalized,
      children: JSON.parse(JSON.stringify(entry.children || [])),
    });
  }
  return out;
}

function findRunActivityDomForTurn(mount, turnIndex) {
  if (!mount || turnIndex < 0) return null;
  const tagged = mount.querySelector(
    `:scope > details.run-activity[data-turn-index="${turnIndex}"]:not(.subagent-talent-activity)`,
  );
  if (tagged) return tagged;
  const prompts = mount.querySelectorAll(":scope > .event.user-prompt");
  const prompt = prompts[turnIndex];
  if (!prompt) return null;
  let node = prompt.nextElementSibling;
  while (node && !node.classList?.contains("user-prompt")) {
    if (node.matches?.("details.run-activity") && !node.classList.contains("subagent-talent-activity")) {
      return node;
    }
    if (node.classList?.contains("run-conclusion")) return null;
    node = node.nextElementSibling;
  }
  return null;
}

function findOwningPromptForRunActivity(activity) {
  if (!activity?.parentElement) return null;
  const idx = Number(activity.dataset.turnIndex);
  if (Number.isFinite(idx) && idx >= 0) {
    return activity.parentElement.querySelectorAll(":scope > .event.user-prompt")[idx] || null;
  }
  let prev = activity.previousElementSibling;
  while (prev) {
    if (prev.classList?.contains("user-prompt")) return prev;
    if (
      prev.classList?.contains("run-conclusion") ||
      (prev.matches?.("details.run-activity") && !prev.classList.contains("subagent-talent-activity"))
    ) {
      return null;
    }
    prev = prev.previousElementSibling;
  }
  return null;
}

function inferRunActivityTurnIndexFromDom(activity, mount) {
  const tagged = Number(activity.dataset?.turnIndex);
  if (Number.isFinite(tagged) && tagged >= 0) return tagged;
  let turnIndex = -1;
  for (const node of mount.children) {
    if (node.classList?.contains("user-prompt")) turnIndex += 1;
    if (node === activity) return Math.max(0, turnIndex);
  }
  return Math.max(0, turnIndex);
}

function runActivityBodyHasSubstantiveContent(body) {
  if (!body) return false;
  return Boolean(
    body.querySelector(
      ".step-narrative, .tool-event, details.thinking, .codex-commentary, .codex-activity-chip, details.subagent-talent-activity, details.step-tool-group",
    ),
  );
}

function findTurnPromptCacheInsertIndex(entries, turnIndex) {
  if (!Array.isArray(entries)) return 0;
  let activityIdx = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "run_activity") {
      if (activityIdx === turnIndex) return i;
      activityIdx += 1;
    }
  }
  let conclusionIdx = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "conclusion") {
      if (conclusionIdx === turnIndex) return i;
      conclusionIdx += 1;
    }
  }
  return entries.length;
}

function findTurnPromptDomAnchor(mount, turnIndex) {
  if (!mount) return null;
  let activityIdx = 0;
  for (const node of mount.children) {
    if (node.matches?.("details.run-activity")) {
      if (activityIdx === turnIndex) return node;
      activityIdx += 1;
    }
  }
  let conclusionIdx = 0;
  for (const node of mount.children) {
    if (node.classList?.contains("run-conclusion")) {
      if (conclusionIdx === turnIndex) return node;
      conclusionIdx += 1;
    }
  }
  if (turnIndex === 0) {
    return mount.querySelector(":scope > .run-conclusion, :scope > details.run-activity");
  }
  return null;
}

function findLeadingTurnPromptInsertIndex(entries) {
  if (!Array.isArray(entries)) return 0;
  const turnIndex = entries.filter(
    (entry) => entry.type === "event" && entry.isUserPrompt,
  ).length;
  return findTurnPromptCacheInsertIndex(entries, turnIndex);
}

/** Conclusion belongs at timeline root — lift any nested copies out of run_activity. */
function hoistNestedConclusionEntries(entries) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (entry.type !== "run_activity" || !entry.children?.length) continue;
    for (let i = entry.children.length - 1; i >= 0; i--) {
      if (entry.children[i].type !== "conclusion") continue;
      const conclusion = entry.children.splice(i, 1)[0];
      const idx = entries.indexOf(entry);
      entries.splice(idx + 1, 0, conclusion);
    }
  }
}

function timelineEntryId() {
  return String(++state.eventSeq);
}

function shouldRecordTimelineEvent(container) {
  if (!container) return false;
  if (container.classList?.contains("dispatch-timeline-card")) return false;
  return true;
}

function findTimelineRunActivityEntry(timelineState) {
  if (!timelineState) return null;
  // run_activity entries are only ever appended, so the most-recently-pushed
  // one is also the last in array order. Cache it to avoid a tail scan on every
  // child record/sync during a run.
  if (timelineState.activeRunEntry) return timelineState.activeRunEntry;
  const entries = ensureTimelineEntries(timelineState);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "run_activity") {
      timelineState.activeRunEntry = entries[i];
      return entries[i];
    }
  }
  return null;
}

function findTimelineSubagentChild(runEntry, body) {
  if (!runEntry?.children?.length || !body) return null;
  const mention = body
    .closest?.("details.subagent-talent-activity")
    ?.dataset?.talentMention;
  if (!mention) return null;
  for (let i = runEntry.children.length - 1; i >= 0; i--) {
    const child = runEntry.children[i];
    if (child.type === "subagent" && child.talent?.mention === mention) return child;
  }
  return null;
}

function findTimelineRunActivityEntryByContainer(timelineState, container) {
  if (!timelineState || !container) return findTimelineRunActivityEntry(timelineState);
  const activity = container.closest?.("details.run-activity");
  const entryId = activity?.dataset?.timelineEntryId;
  if (entryId) {
    const entries = ensureTimelineEntries(timelineState);
    const matched = entries.find(
      (entry) => entry.type === "run_activity" && entry.id === entryId,
    );
    if (matched) return matched;
  }
  return findTimelineRunActivityEntry(timelineState);
}

function timelineChildListForContainer(sessionId, container, timelineState) {
  if (!timelineState) timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return null;
  const entries = ensureTimelineEntries(timelineState);
  if (container === getTimelineMount()) return entries;
  const runEntry = findTimelineRunActivityEntryByContainer(timelineState, container);
  if (!runEntry) return null;
  if (!runEntry.children) runEntry.children = [];
  if (container === state.runActivityBody) return runEntry.children;
  if (container === state.runActivityStreamEl) return runEntry.children;
  if (container === state.runActivityFoldBody) return runEntry.children;
  const subagent = findTimelineSubagentChild(runEntry, container);
  if (subagent) {
    if (!subagent.children) subagent.children = [];
    return subagent.children;
  }
  const activityBody = container.closest?.("details.run-activity .run-activity-body");
  if (activityBody?.contains(container)) return runEntry.children;
  if (container?.classList?.contains("run-activity-stream")) return runEntry.children;
  if (state.runActivityBody?.contains?.(container)) return runEntry.children;
  return null;
}

function findTimelineEventEntry(sessionId, entryId) {
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState || !entryId) return null;
  const indexed = timelineState.eventsById?.get(entryId);
  if (indexed) return indexed;
  const walk = (list) => {
    for (const item of list || []) {
      if (item.type === "event" && item.id === entryId) return item;
      if (item.children?.length) {
        const nested = walk(item.children);
        if (nested) return nested;
      }
    }
    return null;
  };
  // Fallback recursive scan for entries created outside recordTimelineEvent
  // (e.g. legacy nodes migrated by ensureTimelineEntries); cache the hit.
  const found = walk(ensureTimelineEntries(timelineState));
  if (found) {
    if (!timelineState.eventsById) timelineState.eventsById = new Map();
    timelineState.eventsById.set(entryId, found);
  }
  return found;
}

function touchTimelineState(sessionId) {
  const timelineState = getNormalTimelineState(sessionId, false);
  if (timelineState) timelineState.updatedAt = Date.now();
}

function recordTimelineEvent(container, line, text, cls = "", detail, options = {}) {
  if (state.suppressTimelineRecording) return;
  if (!line || !shouldRecordTimelineEvent(container)) return;
  const sid = line.dataset.eventDetailSession || getActiveEventSessionId();
  const timelineState = getNormalTimelineState(sid, true);
  if (!timelineState) return;
  const target = timelineChildListForContainer(sid, container, timelineState);
  if (!target) return;
  const entry = {
    type: "event",
    id: line.dataset.timelineNodeId || timelineEntryId(),
    text: String(text || ""),
    className: String(cls || ""),
    eventDetailId: line.dataset.eventDetailId || "",
    eventDetailSession: line.dataset.eventDetailSession || sid || "",
    forgeDetail: line.dataset.forgeDetail || "",
    isUserPrompt: line.classList.contains("user-prompt"),
    hasDetail: Boolean(detail) || Boolean(line.dataset.forgeDetail),
    createdAt: Date.now(),
  };
  line.dataset.timelineNodeId = entry.id;
  const insertIndex =
    typeof options.insertIndex === "number"
      ? options.insertIndex
      : entry.isUserPrompt && container === getTimelineMount()
        ? findLeadingTurnPromptInsertIndex(target)
        : -1;
  if (insertIndex >= 0 && insertIndex < target.length) {
    target.splice(insertIndex, 0, entry);
  } else if (insertIndex === target.length) {
    target.push(entry);
  } else {
    target.push(entry);
  }
  if (!timelineState.eventsById) timelineState.eventsById = new Map();
  timelineState.eventsById.set(entry.id, entry);
  touchTimelineState(sid);
}

function markTimelineEventUserPrompt(line) {
  const entryId = line?.dataset?.timelineNodeId;
  if (!entryId) return;
  const sid = line.dataset.eventDetailSession || getActiveEventSessionId();
  const entry = findTimelineEventEntry(sid, entryId);
  if (entry) entry.isUserPrompt = true;
}

function updateTimelineEventEntry(sessionId, entryId, patch) {
  const entry = findTimelineEventEntry(sessionId, entryId);
  if (!entry) return;
  Object.assign(entry, patch);
  touchTimelineState(sessionId);
}

function recordRunActivityShellEntry(sessionId, entryId) {
  if (state.suppressTimelineRecording) return;
  const timelineState = getNormalTimelineState(sessionId, true);
  if (!timelineState) return;
  const entries = ensureTimelineEntries(timelineState);
  const turnIndex = Math.max(0, countStructuredTimelinePrompts(entries) - 1);
  const runEntry = {
    type: "run_activity",
    id: entryId || timelineEntryId(),
    turnIndex,
    label: "处理中…",
    meta: "",
    open: true,
    active: true,
    finalized: false,
    children: [],
    createdAt: Date.now(),
  };
  entries.push(runEntry);
  timelineState.activeRunEntry = runEntry;
  touchTimelineState(sessionId);
}

function syncRunActivityShellEntry(sessionId, patch = {}) {
  if (state.suppressTimelineRecording) return;
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return;
  const runEntry = findTimelineRunActivityEntry(timelineState);
  if (!runEntry) return;
  Object.assign(runEntry, patch);
  touchTimelineState(sessionId);
}

function findTurnScopedCardIndex(entries, cardType) {
  let lastPromptIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "event" && entries[i].isUserPrompt) lastPromptIdx = i;
  }
  if (lastPromptIdx < 0) return entries.length;
  let idx = lastPromptIdx + 1;
  while (idx < entries.length) {
    const type = entries[idx].type;
    if (type === cardType) return idx;
    if (type === "plan_card" || type === "dispatch_card" || type === "reflection_card") {
      idx += 1;
      continue;
    }
    if (type === "run_activity" || type === "conclusion" || type === "event") return idx;
    idx += 1;
  }
  return idx;
}

function recordPlanCardEntry(sessionId, title, items) {
  if (state.suppressTimelineRecording) return;
  const timelineState = getNormalTimelineState(sessionId, true);
  if (!timelineState) return;
  const entries = ensureTimelineEntries(timelineState);
  const payload = {
    type: "plan_card",
    id: timelineEntryId(),
    title: String(title || "任务清单"),
    items: (items || []).map((item) => ({
      text: String(item.text || ""),
      status: item.status || "pending",
    })),
    updatedAt: Date.now(),
  };
  const idx = findTurnScopedCardIndex(entries, "plan_card");
  if (entries[idx]?.type === "plan_card") {
    Object.assign(entries[idx], payload);
  } else {
    entries.splice(idx, 0, payload);
  }
  touchTimelineState(sessionId);
}

function recordDispatchCardEntry(sessionId) {
  if (state.suppressTimelineRecording) return;
  const timelineState = getNormalTimelineState(sessionId, true);
  if (!timelineState) return;
  const entries = ensureTimelineEntries(timelineState);
  const existing = entries.findIndex((entry) => entry.type === "dispatch_card");
  if (existing >= 0) return;
  const idx = findTurnScopedCardIndex(entries, "dispatch_card");
  entries.splice(idx, 0, {
    type: "dispatch_card",
    id: timelineEntryId(),
    sessionId,
    createdAt: Date.now(),
  });
  touchTimelineState(sessionId);
}

function recordReflectionCardEntry(sessionId) {
  if (state.suppressTimelineRecording) return;
  const timelineState = getNormalTimelineState(sessionId, true);
  if (!timelineState) return;
  const entries = ensureTimelineEntries(timelineState);
  if (entries.some((entry) => entry.type === "reflection_card")) return;
  const idx = findTurnScopedCardIndex(entries, "reflection_card");
  entries.splice(idx, 0, {
    type: "reflection_card",
    id: timelineEntryId(),
    sessionId,
    createdAt: Date.now(),
  });
  touchTimelineState(sessionId);
}

function recordConclusionEntry(sessionId, finalText) {
  if (state.suppressTimelineRecording) return;
  const timelineState = getNormalTimelineState(sessionId, true);
  if (!timelineState) return;
  const entries = ensureTimelineEntries(timelineState);
  let runIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "run_activity") {
      runIdx = i;
      break;
    }
  }
  if (runIdx >= 0 && entries[runIdx + 1]?.type === "conclusion") return;
  entries.push({
    type: "conclusion",
    id: timelineEntryId(),
    sessionId,
    text: String(finalText || state.runFinalText || "").trim(),
    createdAt: Date.now(),
  });
  touchTimelineState(sessionId);
}

function recordThinkingEntry(sessionId, thinkingId, talent, summary, content) {
  if (state.suppressTimelineRecording) return;
  const timelineState = getNormalTimelineState(sessionId, true);
  if (!timelineState) return;
  const runEntry = findTimelineRunActivityEntry(timelineState);
  if (!runEntry) return;
  if (!runEntry.children) runEntry.children = [];
  const mention = talent?.mention ? normalizeTalentMention(talent.mention) : "";
  let entry = runEntry.children.find(
    (child) => child.type === "thinking" && child.id === thinkingId,
  );
  if (!entry) {
    entry = {
      type: "thinking",
      id: thinkingId,
      talentMention: mention,
      summary: "",
      content: "",
      open: false,
      createdAt: Date.now(),
    };
    runEntry.children.push(entry);
  }
  if (summary) entry.summary = summary;
  if (content != null) entry.content = content;
  touchTimelineState(sessionId);
}

function removeThinkingEntry(sessionId, thinkingId) {
  if (state.suppressTimelineRecording || !thinkingId) return;
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return;
  const removeFrom = (children) => {
    if (!Array.isArray(children)) return false;
    const idx = children.findIndex(
      (child) => child.type === "thinking" && child.id === thinkingId,
    );
    if (idx >= 0) {
      children.splice(idx, 1);
      return true;
    }
    return children.some((child) => removeFrom(child.children));
  };
  if (removeFrom(ensureTimelineEntries(timelineState))) touchTimelineState(sessionId);
}

function recordSubagentShellEntry(sessionId, talent, taskLabel, dispatchWave) {
  if (state.suppressTimelineRecording) return;
  const timelineState = getNormalTimelineState(sessionId, true);
  if (!timelineState || !talent?.mention) return;
  const runEntry = findTimelineRunActivityEntry(timelineState);
  if (!runEntry) return;
  if (!runEntry.children) runEntry.children = [];
  const mention = normalizeTalentMention(talent.mention);
  let entry = runEntry.children.find(
    (child) => child.type === "subagent" && child.talent?.mention === mention,
  );
  if (!entry) {
    entry = {
      type: "subagent",
      id: timelineEntryId(),
      talent: {
        mention,
        displayName: talent.displayName || mention,
        role: talent.role || "",
        emoji: talent.emoji || "",
        avatar: talent.avatar || "",
      },
      taskLabel: String(taskLabel || ""),
      dispatchWave: dispatchWave
        ? {
            index: dispatchWave.index,
            total: dispatchWave.total,
            hasPriorResults: Boolean(dispatchWave.hasPriorResults),
          }
        : null,
      label: "",
      meta: "进行中…",
      finalized: false,
      open: true,
      children: [],
      createdAt: Date.now(),
    };
    runEntry.children.push(entry);
  }
  touchTimelineState(sessionId);
  return entry;
}

function syncSubagentShellEntry(sessionId, talent, patch = {}) {
  if (state.suppressTimelineRecording) return;
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState || !talent?.mention) return;
  const runEntry = findTimelineRunActivityEntry(timelineState);
  const mention = normalizeTalentMention(talent.mention);
  const entry = runEntry?.children?.find(
    (child) => child.type === "subagent" && child.talent?.mention === mention,
  );
  if (!entry) return;
  Object.assign(entry, patch);
  touchTimelineState(sessionId);
}

function recordPromptCheckpoint(sessionId, entryId, sha, turnIndex) {
  const entry = findTimelineEventEntry(sessionId, entryId);
  if (!entry) return;
  entry.checkpointSha = String(sha || "");
  if (Number.isInteger(turnIndex)) entry.checkpointTurn = turnIndex;
  touchTimelineState(sessionId);
}

function structuredTimelineHasUserTurn(sessionId) {
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return false;
  return ensureTimelineEntries(timelineState).some(
    (entry) => entry.type === "event" && entry.isUserPrompt,
  );
}

function structuredTimelineHasRunActivity(sessionId) {
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return false;
  return ensureTimelineEntries(timelineState).some((entry) => entry.type === "run_activity");
}

function structuredTimelineHasConclusion(sessionId) {
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return false;
  if (ensureTimelineEntries(timelineState).some((entry) => entry.type === "conclusion")) {
    return true;
  }
  return Boolean(state.runConclusionBySession.get(sessionId));
}

function hasStructuredTimelineCache(sessionId) {
  const timelineState = getNormalTimelineState(sessionId, false);
  return Boolean(ensureTimelineEntries(timelineState).length);
}

function structuredTimelineRunActivityHasChildren(sessionId) {
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return false;
  return ensureTimelineEntries(timelineState).some(
    (entry) => entry.type === "run_activity" && (entry.children?.length ?? 0) > 0,
  );
}

function isSubstantiveRunActivityChild(child) {
  if (!child) return false;
  if (
    child.type === "thinking" ||
    child.type === "step_narrative" ||
    child.type === "codex_commentary" ||
    child.type === "codex_activity" ||
    child.type === "subagent"
  ) {
    return true;
  }
  if (child.type === "event" && String(child.className || "").includes("tool-event")) {
    return true;
  }
  return false;
}

function structuredTimelineRunActivityHasSubstantiveChildren(sessionId) {
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return false;
  return ensureTimelineEntries(timelineState).some(
    (entry) =>
      entry.type === "run_activity" &&
      (entry.children || []).some((child) => isSubstantiveRunActivityChild(child)),
  );
}

/** Drop stale structured entries before rebuilding from daemon messages. */
function clearStructuredTimelineForRestore(sessionId) {
  if (!sessionId) return;
  state.normalTimelineBySession.delete(sessionId);
  state.stepNarrativesBySession.delete(sessionId);
}

function structuredTimelineCacheUsable(sessionId, running = false) {
  sanitizeStructuredTimelineCache(sessionId);
  if (!hasStructuredTimelineCache(sessionId)) return false;
  if (!running && structuredTimelineShouldReload(sessionId)) return false;
  const entries = ensureTimelineEntries(getNormalTimelineState(sessionId, false));
  const hasConclusion =
    entries.some((entry) => entry.type === "conclusion") ||
    Boolean(state.runConclusionBySession.get(sessionId));
  const hasUserTurn = entries.some(
    (entry) => entry.type === "event" && entry.isUserPrompt,
  );
  const hasRunActivity = entries.some((entry) => entry.type === "run_activity");
  const hasActivityChildren = structuredTimelineRunActivityHasSubstantiveChildren(sessionId);
  const firstRunOrConclusion = entries.findIndex(
    (entry) => entry.type === "run_activity" || entry.type === "conclusion",
  );
  const hasLeadingPrompt =
    firstRunOrConclusion < 0 ||
    entries
      .slice(0, firstRunOrConclusion)
      .some((entry) => entry.type === "event" && entry.isUserPrompt);
  const leadingPromptOk =
    firstRunOrConclusion < 0 || hasLeadingPrompt || !hasUserTurn;
  const turnOrderOk = structuredTimelineTurnOrderValid(entries);
  // A cache that only captured the conclusion card cannot rebuild the turn.
  if (hasConclusion && !hasUserTurn && !hasRunActivity) return false;
  if (!leadingPromptOk) return false;
  if (!turnOrderOk) return false;
  if (!running && hasConclusion && !hasUserTurn) return false;
  if (!running && !hasConclusion) return false;
  if (running && !hasUserTurn && !hasRunActivity) return false;
  // Empty 已处理 shells are not trustworthy once a turn has finished.
  if (!running && hasRunActivity && !hasActivityChildren && hasConclusion) return false;
  return true;
}

function renderStructuredEventLine(entry, container, sessionId) {
  const line = document.createElement("div");
  line.className = `event ${entry.className || ""}`.trim();
  line.textContent = entry.text || "";
  line.dataset.timelineNodeId = entry.id;
  if (entry.isUserPrompt) line.classList.add("user-prompt");
  if (entry.forgeDetail) {
    line.dataset.forgeDetail = entry.forgeDetail;
    line.classList.add("clickable");
    try {
      const detail = JSON.parse(entry.forgeDetail);
      if (detail?.patch?.unifiedDiff) {
        const inlineDiff = buildInlineDiffHtml(detail.patch);
        if (inlineDiff) line.insertAdjacentHTML("beforeend", inlineDiff);
      }
    } catch {
      /* ignore malformed detail */
    }
  }
  if (entry.eventDetailId) {
    line.dataset.eventDetailId = entry.eventDetailId;
    line.dataset.eventDetailSession = entry.eventDetailSession || sessionId || "";
    const detail = getEventDetailStore(entry.eventDetailSession || sessionId).get(
      Number(entry.eventDetailId),
    );
    if (detail) {
      const serialized = serializeEventDetail(detail);
      if (serialized) line.dataset.forgeDetail = serialized;
      line.classList.add("clickable");
      if (detail.patch?.unifiedDiff) {
        const inlineDiff = buildInlineDiffHtml(detail.patch);
        if (inlineDiff) line.insertAdjacentHTML("beforeend", inlineDiff);
      }
    }
  }
  if (entry.checkpointSha) {
    decoratePromptWithCheckpoint(line, entry.checkpointSha, entry.checkpointTurn);
  }
  container.appendChild(line);
  return line;
}

function renderStructuredThinkingEntry(entry, container) {
  const wrap = document.createElement("details");
  wrap.className = "event thinking";
  wrap.dataset.thinkingId = entry.id;
  if (entry.talentMention) wrap.dataset.talentMention = entry.talentMention;
  wrap.open = Boolean(entry.open);
  const summary = entry.summary || "思考中（可展开）";
  wrap.innerHTML = `<summary>${escapeHtml(summary)}</summary><pre class="event-pre"></pre>`;
  const pre = wrap.querySelector(".event-pre");
  if (pre && entry.content) pre.textContent = entry.content;
  container.appendChild(wrap);
  return wrap;
}

function renderStructuredSubagentEntry(entry, container, sessionId) {
  const talent = entry.talent || {};
  const details = document.createElement("details");
  details.className = `run-activity subagent-talent-activity${
    entry.finalized ? "" : " subagent-talent-active"
  }`;
  details.open = entry.open !== false;
  details.dataset.talentMention = talent.mention || "";
  const emoji = talent.emoji || "🧑";
  const label =
    entry.label ||
    `${emoji} ${talent.displayName || talent.mention || "人才"} · ${entry.taskLabel || ""}`;
  details.innerHTML = `
    <summary class="run-activity-summary">
      <span class="run-activity-chevron" aria-hidden="true">›</span>
      <span class="run-activity-label">${escapeHtml(label)}</span>
      <span class="run-activity-meta">${escapeHtml(entry.meta || "")}</span>
    </summary>
    <div class="run-activity-body subagent-talent-body"></div>`;
  bindRunActivityPin(details);
  const body = details.querySelector(".subagent-talent-body");
  bindRunActivityScroll(body, details);
  container.appendChild(details);
  for (const child of entry.children || []) {
    renderStructuredTimelineChild(child, body, sessionId);
  }
  return details;
}

function renderStructuredRunActivityEntry(entry, mount, sessionId) {
  const details = document.createElement("details");
  const isActive = Boolean(entry.active) && !entry.finalized;
  details.className = `run-activity${isActive ? " run-activity-active" : ""}`;
  // Active runs stay collapsed; content streams flat beside the chip.
  details.open = isActive ? false : entry.finalized ? false : entry.open !== false;
  details.dataset.timelineEntryId = entry.id;
  if (typeof entry.turnIndex === "number" && entry.turnIndex >= 0) {
    details.dataset.turnIndex = String(entry.turnIndex);
  }
  details.innerHTML = `
    <summary class="run-activity-summary">
      <span class="run-activity-chevron" aria-hidden="true">›</span>
      <span class="run-activity-label">${escapeHtml(entry.label || "处理中…")}</span>
      <span class="run-activity-meta">${escapeHtml(entry.meta || "")}</span>
    </summary>
    <div class="run-activity-body"></div>`;
  bindRunActivityPin(details);
  const foldBody = details.querySelector(".run-activity-body");
  bindRunActivityScroll(foldBody, details);
  mount.appendChild(details);
  let contentHost = foldBody;
  if (isActive) {
    const stream = document.createElement("div");
    const streamId = `stream-${entry.id}`;
    stream.className = "run-activity-stream";
    stream.dataset.streamId = streamId;
    stream.dataset.timelineEntryId = entry.id;
    details.dataset.streamId = streamId;
    mount.appendChild(stream);
    contentHost = stream;
  }
  renderRunActivityChildrenIntoBody(entry.children || [], contentHost, sessionId);
  return details;
}

function renderRunActivityChildrenIntoBody(children, body, sessionId) {
  if (!body) return;
  let restoredToolGroup = null;
  let restoredToolGroupBody = null;
  let restoredToolGroupCount = 0;
  const closeRestoredToolGroup = () => {
    if (!restoredToolGroup) return;
    updateStepToolGroupSummary(restoredToolGroup, restoredToolGroupCount);
    restoredToolGroup.open = false;
    restoredToolGroup = null;
    restoredToolGroupBody = null;
    restoredToolGroupCount = 0;
  };
  for (const child of children || []) {
    if (isStructuredToolGroupChild(child)) {
      if (!restoredToolGroup) {
        restoredToolGroup = createStepToolGroupElement(false);
        restoredToolGroupBody = restoredToolGroup.querySelector(".step-tool-group-body");
        body.appendChild(restoredToolGroup);
      }
      renderStructuredTimelineChild(child, restoredToolGroupBody || body, sessionId);
      restoredToolGroupCount += 1;
      updateStepToolGroupSummary(restoredToolGroup, restoredToolGroupCount);
    } else {
      closeRestoredToolGroup();
      renderStructuredTimelineChild(child, body, sessionId);
    }
  }
  closeRestoredToolGroup();
}

function mergeRunActivitySnapshot(sessionId, snapshot) {
  if (!sessionId || !snapshot?.length) return;
  const mount = $("timeline");
  if (!mount) return;
  const timelineState = getNormalTimelineState(sessionId, true);
  const entries = ensureTimelineEntries(timelineState);

  snapshot.forEach((saved, snapshotIndex) => {
    if (!saved?.children?.some((child) => isSubstantiveRunActivityChild(child))) return;
    const turnIndex =
      typeof saved.turnIndex === "number" && saved.turnIndex >= 0
        ? saved.turnIndex
        : snapshotIndex;

    let activity =
      mount.querySelector(
        `:scope > details.run-activity[data-turn-index="${turnIndex}"]:not(.subagent-talent-activity)`,
      ) || findRunActivityDomForTurn(mount, turnIndex);
    if (!activity) {
      activity = insertRestoredRunActivityShell(mount, turnIndex, saved);
      if (!activity) return;
      const runEntry = {
        type: "run_activity",
        id: activity.dataset.timelineEntryId,
        turnIndex,
        label: saved.label || "已处理",
        meta: saved.meta || "",
        open: saved.open !== false,
        active: false,
        finalized: saved.finalized !== false,
        children: [],
        createdAt: Date.now(),
      };
      const insertIdx = findRunActivityCacheInsertIndex(entries, turnIndex);
      entries.splice(insertIdx, 0, runEntry);
    } else {
      activity.dataset.turnIndex = String(turnIndex);
    }

    const body = activity.querySelector(".run-activity-body");
    if (!body || runActivityBodyHasSubstantiveContent(body)) return;

    body.replaceChildren();
    state.suppressTimelineRecording = true;
    try {
      renderRunActivityChildrenIntoBody(saved.children, body, sessionId);
    } finally {
      state.suppressTimelineRecording = false;
    }

    const runEntry =
      entries.find(
        (entry) =>
          entry.type === "run_activity" &&
          (entry.id === activity.dataset.timelineEntryId ||
            entry.turnIndex === turnIndex),
      ) || entries.filter((entry) => entry.type === "run_activity")[turnIndex];
    if (runEntry) {
      runEntry.turnIndex = turnIndex;
      runEntry.children = JSON.parse(JSON.stringify(saved.children));
      if (saved.label) runEntry.label = saved.label;
      if (saved.meta) runEntry.meta = saved.meta;
      if (saved.finalized != null) {
        runEntry.finalized = saved.finalized;
        runEntry.active = !saved.finalized;
      }
      activity.classList.toggle("run-activity-active", Boolean(runEntry.active));
      const labelEl = activity.querySelector(".run-activity-label");
      const metaEl = activity.querySelector(".run-activity-meta");
      if (labelEl) labelEl.textContent = runEntry.label || "已处理";
      if (metaEl) metaEl.textContent = runEntry.meta || "";
    }
  });
  realignRunActivitiesToTurns(mount);
  touchTimelineState(sessionId);
}

function buildRunConclusionFilesHtml(files, patchSource) {
  const map = patchSource instanceof Map ? patchSource : state.runPatches;
  return files
    .map((path) => {
      const item = map.get(path);
      const hasRuntimeStats = Number.isFinite(item?.adds) && Number.isFinite(item?.dels);
      const status = hasRuntimeStats
        ? diffStatsHtml(item.adds, item.dels)
        : item?.patch?.unifiedDiff
          ? patchStatsHtml(item.patch.unifiedDiff)
        : escapeHtml(item?.meta || "已编辑");
      const norm = normalizeWorkspaceRelPath(getActiveProject()?.cwd, path);
      const slash = norm.lastIndexOf("/");
      const dirPart = slash >= 0 ? norm.slice(0, slash + 1) : "";
      const basePart = slash >= 0 ? norm.slice(slash + 1) : norm;
      return `<button type="button" class="modified-file-btn" data-path="${escapeHtml(norm || path)}" title="${escapeHtml(norm || path)}">
            <span class="modified-file-path">
              ${dirPart ? `<span class="modified-file-dir">${escapeHtml(dirPart)}</span>` : ""}
              <span class="modified-file-base">${escapeHtml(basePart)}</span>
            </span>
            <span class="modified-file-status">${status}</span>
          </button>`;
    })
    .join("");
}

const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function isImageFilePath(path) {
  return IMAGE_FILE_EXT_RE.test(String(path || "").split(/[?#]/, 1)[0]);
}

function extractImagePathsFromText(text) {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const value = String(raw || "").trim().replace(/^file:\/\//i, "");
    if (!value || !isImageFilePath(value)) return;
    const norm = normalizeWorkspaceRelPath(getActiveProject()?.cwd, value) || value;
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };
  const source = String(text || "");
  for (const match of source.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)) push(match[1]);
  for (const match of source.matchAll(/[`"']?((?:[A-Za-z]:)?[~./\w@-][^`"'\s，。；、:：)]*\.(?:png|jpe?g|gif|webp|bmp|svg))[`"']?/gi)) {
    push(match[1]);
  }
  return out.slice(0, 12);
}

function buildRunGeneratedImagesHtml(files) {
  const images = files.filter((path) => isImageFilePath(path));
  if (!images.length) return "";
  return `<div class="run-conclusion-heading">生成的图片</div>
    <div class="generated-images-list">
      ${images
        .map((path) => {
          const norm = normalizeWorkspaceRelPath(getActiveProject()?.cwd, path) || path;
          const base = basename(norm);
          return `<button type="button" class="generated-image-card" data-generated-image-path="${escapeHtml(norm)}" title="${escapeHtml(norm)}">
            <span class="generated-image-thumb" data-image-path="${escapeHtml(norm)}">加载中…</span>
            <span class="generated-image-name">${escapeHtml(base)}</span>
          </button>`;
        })
        .join("")}
    </div>`;
}

function mergeConclusionImageFiles(files, finalText) {
  const merged = [];
  const seen = new Set();
  const push = (path) => {
    const norm = normalizeWorkspaceRelPath(getActiveProject()?.cwd, path) || path;
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    merged.push(norm);
  };
  (files || []).forEach(push);
  extractImagePathsFromText(finalText).forEach(push);
  return merged;
}

function buildRunConclusionMarkup(finalText, files, patchSource) {
  const displayFiles = mergeConclusionImageFiles(files, finalText);
  const conclusionHtml = finalText
    ? `<div class="run-conclusion-md" role="article"></div>`
    : `<p class="run-conclusion-empty">（助手未返回文字结论，请查看上方回复）</p>`;
  const filesHtml = buildRunConclusionFilesHtml(displayFiles, patchSource);
  const imagesHtml = buildRunGeneratedImagesHtml(displayFiles);
  return `
    <div class="run-conclusion-inner">
      <div class="run-conclusion-heading">结论${
        finalText
          ? `<button type="button" class="conclusion-copy-btn" data-copy-action="conclusion" title="复制结论全文">复制</button>`
          : ""
      }</div>
      ${conclusionHtml}
      ${
        displayFiles.length
          ? `<div class="run-conclusion-heading">修改的文件</div>
      <div class="modified-files-list">${filesHtml}</div>`
          : ""
      }
      ${imagesHtml}
    </div>`;
}

function populateRunConclusionElement(wrap, finalText, files, patchSource) {
  wrap.className = "event run-conclusion done";
  wrap.innerHTML = buildRunConclusionMarkup(finalText, files, patchSource);
  const mdHost = wrap.querySelector(".run-conclusion-md");
  if (mdHost && finalText) renderConclusionMarkdown(mdHost, finalText);
  hydrateGeneratedImages(wrap);
  return wrap;
}

function placePlanCardOnMount(card, mount) {
  const prompt = mount.querySelector(":scope > .event.user-prompt:last-of-type");
  if (prompt) {
    prompt.insertAdjacentElement("afterend", card);
    return;
  }
  const activity = mount.querySelector(":scope > details.run-activity");
  if (activity?.parentElement === mount) {
    mount.insertBefore(card, activity);
    return;
  }
  mount.appendChild(card);
}

function renderStructuredPlanCardEntry(entry, mount) {
  if (!entry.items?.length) return null;
  const card = document.createElement("div");
  card.className = "plan-card";
  const doneCount = entry.items.filter((item) => item.status === "done").length;
  const rows = entry.items
    .map((item) => {
      const cls =
        item.status === "done"
          ? " is-done"
          : item.status === "in_progress"
            ? " is-active"
            : "";
      const mark =
        item.status === "done" ? "✓" : item.status === "in_progress" ? "▸" : "○";
      return `<li class="plan-item${cls}"><span class="plan-mark" aria-hidden="true">${mark}</span><span class="plan-text">${escapeHtml(item.text)}</span></li>`;
    })
    .join("");
  card.innerHTML = `
    <div class="plan-card-head">${escapeHtml(entry.title || "任务清单")}<span class="plan-card-progress">${doneCount}/${entry.items.length}</span></div>
    <ul class="plan-list">${rows}</ul>`;
  placePlanCardOnMount(card, mount);
  return card;
}

function renderStructuredConclusionEntry(sessionId, mount, entry) {
  const rawText = String(
    entry?.text || state.runFinalTextBySession.get(sessionId) || "",
  ).trim();
  const activity =
    mount?.querySelector?.(":scope > details.run-activity:last-of-type") || null;
  const finalText = dedupeConclusionAgainstStepNarratives(rawText, sessionId, mount, activity);
  const patchMap = state.runPatchesBySession.get(sessionId);
  const files = patchMap ? [...patchMap.keys()] : [];
  if (!mount) return null;
  const wrap = document.createElement("div");
  populateRunConclusionElement(wrap, finalText, files, patchMap || state.runPatches);
  mount.appendChild(wrap);
  return wrap;
}

function renderStructuredCodexActivityEntry(entry, container) {
  const wrap = document.createElement("div");
  wrap.className = `codex-activity-chip${entry.status === "running" ? " is-running" : " is-done"}`;
  wrap.dataset.codexActivityId = entry.callId || "";
  wrap.dataset.timelineNodeId = entry.id;
  if (entry.forgeDetail) {
    wrap.dataset.forgeDetail = entry.forgeDetail;
    wrap.classList.add("clickable");
  }
  const iconKey = String(entry.iconKey || entry.icon || "command");
  const stats = codexActivityStatsHtml(entry.adds, entry.dels, iconKey === "file");
  let expand = "";
  if (entry.forgeDetail) {
    try {
      if (JSON.parse(entry.forgeDetail)?.kind === "command") {
        expand = '<span class="codex-activity-expand" aria-hidden="true">⌄</span>';
      }
    } catch {
      /* ignore malformed command detail */
    }
  }
  wrap.dataset.codexStats = `${Number(entry.adds || 0)}:${Number(entry.dels || 0)}`;
  wrap.innerHTML = `<span class="codex-activity-icon" aria-hidden="true">${codexActivityIconMarkup(iconKey)}</span><span class="codex-activity-label">${escapeHtml(entry.label || "")}</span>${stats}${expand}`;
  container.appendChild(wrap);
  return wrap;
}

function renderStructuredCodexCommentaryEntry(entry, container) {
  const wrap = document.createElement("div");
  wrap.className = "codex-commentary";
  wrap.dataset.timelineNodeId = entry.id;
  wrap.innerHTML = `<div class="codex-commentary-text" role="note"></div>`;
  const host = wrap.querySelector(".codex-commentary-text");
  if (host && entry.text) {
    if (entry.markdown) renderConclusionMarkdown(host, entry.text);
    else host.textContent = entry.text;
  }
  container.appendChild(wrap);
  return wrap;
}

function renderStructuredStepNarrativeEntry(entry, container) {
  const wrap = document.createElement("div");
  wrap.className = "event step-narrative done";
  wrap.dataset.timelineNodeId = entry.id;
  wrap.innerHTML = `<div class="step-narrative-text" role="note"></div>`;
  const host = wrap.querySelector(".step-narrative-text");
  if (host && entry.text) {
    if (entry.markdown) renderConclusionMarkdown(host, entry.text);
    else host.textContent = entry.text;
  }
  container.appendChild(wrap);
  return wrap;
}

function renderStructuredTimelineChild(entry, container, sessionId) {
  if (!entry) return null;
  if (entry.type === "codex_activity") {
    return renderStructuredCodexActivityEntry(entry, container);
  }
  if (entry.type === "codex_commentary") {
    return renderStructuredCodexCommentaryEntry(entry, container);
  }
  if (entry.type === "step_narrative") {
    return renderStructuredStepNarrativeEntry(entry, container);
  }
  if (entry.type === "event") return renderStructuredEventLine(entry, container, sessionId);
  if (entry.type === "thinking") return renderStructuredThinkingEntry(entry, container);
  if (entry.type === "subagent") return renderStructuredSubagentEntry(entry, container, sessionId);
  return null;
}

function renderStructuredTimelineEntry(entry, mount, sessionId) {
  if (!entry) return null;
  if (entry.type === "event") return renderStructuredEventLine(entry, mount, sessionId);
  if (entry.type === "plan_card") return renderStructuredPlanCardEntry(entry, mount);
  if (entry.type === "dispatch_card") {
    const dispatchState = getDispatchTimelineState(entry.sessionId || sessionId, false);
    if (dispatchState) renderDispatchTimelineCard(dispatchState);
    return mount.querySelector(
      `:scope > .dispatch-timeline-card[data-dispatch-session="${cssEscape(dispatchState?.sessionId || sessionId)}"]`,
    );
  }
  if (entry.type === "reflection_card") {
    const reflectionState = getReflectionState(entry.sessionId || sessionId, false);
    if (reflectionState) renderReflectionCard(reflectionState);
    return mount.querySelector(
      `:scope > .reflection-card[data-reflection-session="${cssEscape(reflectionState?.sessionId || sessionId)}"]`,
    );
  }
  if (entry.type === "run_activity") return renderStructuredRunActivityEntry(entry, mount, sessionId);
  if (entry.type === "conclusion") return renderStructuredConclusionEntry(sessionId, mount, entry);
  return null;
}

function renderTimelineFromState(sessionId, mount = getTimelineMount()) {
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!mount || !timelineState) return false;
  const entries = ensureTimelineEntries(timelineState);
  if (!entries.length) return false;
  setTimelineRuntimeForSession(sessionId);
  state.suppressTimelineRecording = true;
  try {
    mount.replaceChildren();
    resetRunActivityState();
    state.runConclusionRendered = Boolean(state.runConclusionBySession.get(sessionId));
    for (const entry of entries) {
      renderStructuredTimelineEntry(entry, mount, sessionId);
    }
    repairTimelineDomStructure(mount);
    rebindTimelineAfterRestore(mount);
  } finally {
    state.suppressTimelineRecording = false;
  }
  return true;
}

function applyDispatchTimelineEvent(ev) {
  const dispatchState = reduceDispatchTimelineEvent(ev);
  if (dispatchState) renderDispatchTimelineCard(dispatchState);
  return dispatchState;
}

/** Drop every per-session cache so a rebuild can't resurrect a stale conclusion/patch. */
function forgetSessionRunCaches(sessionId) {
  if (!sessionId) return;
  state.normalTimelineBySession.delete(sessionId);
  state.dispatchTimelineBySession.delete(sessionId);
  state.reflectionBySession.delete(sessionId);
  state.runConclusionBySession.delete(sessionId);
  state.runFinalTextBySession.delete(sessionId);
  state.stepNarrativesBySession.delete(sessionId);
  state.conclusionDomRenderedThisTurn.delete(sessionId);
  state.runPatchesBySession.delete(sessionId);
}

function saveSessionRunArtifacts(sessionId) {
  if (!sessionId) return;
  saveRunPatchesForSession(sessionId);
}

function loadSessionRunArtifacts(sessionId) {
  if (!sessionId) return;
  state.runConclusionRendered = Boolean(
    state.runConclusionBySession.get(sessionId),
  );
  const patches = state.runPatchesBySession.get(sessionId);
  state.runPatches = patches ? new Map(patches) : new Map();
  state.runFinalText = state.runFinalTextBySession.get(sessionId) || "";
}

function timelineHasConclusion(root) {
  return Boolean(root?.querySelector?.(".run-conclusion"));
}

/** Repair a missing conclusion card after switch/restore using structured state. */
function reconcileSessionConclusion(sessionId) {
  if (!sessionId || state.runningSessions.has(sessionId)) return;
  const mount = $("timeline");
  if (!mount) return;

  const cachedHasConclusion = structuredTimelineHasConclusion(sessionId);
  const liveHasConclusion = timelineHasConclusion(mount);
  const liveHasPrompt = Boolean(mount.querySelector(":scope > .event.user-prompt"));
  const liveHasActivity = Boolean(mount.querySelector(":scope > details.run-activity"));
  const storedText = state.runFinalTextBySession.get(sessionId) || "";
  const concluded =
    state.runConclusionBySession.get(sessionId) ||
    cachedHasConclusion ||
    Boolean(storedText);

  forgeSessionLog("conclusion:reconcile", {
    sessionId,
    concluded,
    cachedHasConclusion,
    liveHasConclusion,
    liveHasPrompt,
    liveHasActivity,
    hasStoredText: Boolean(storedText),
  });

  const running = state.runningSessions.has(sessionId);
  const cacheUsable = structuredTimelineCacheUsable(sessionId, running);
  const cacheRicherThanLive =
    structuredTimelineHasRunActivity(sessionId) && !liveHasActivity;
  if (
    cacheUsable &&
    !liveHasConclusion &&
    (!liveHasPrompt || cacheRicherThanLive)
  ) {
    const ui = captureTimelineUiState(mount);
    loadSessionRunArtifacts(sessionId);
    renderTimelineFromState(sessionId, mount);
    restoreTimelineUiState(ui, mount);
    return;
  }

  if (concluded && !timelineHasConclusion(mount)) {
    forgeSessionLog("conclusion:repair-missing", { sessionId });
    state.conclusionDomRenderedThisTurn.delete(sessionId);
    state.runConclusionRendered = false;
    loadSessionRunArtifacts(sessionId);
    renderRunConclusion(storedText, sessionId);
  }
}

/** Re-render conclusion if a completed turn lost its card (e.g. stale session routing). */
function ensureConclusionCardForSession(sessionId) {
  reconcileSessionConclusion(sessionId);
}

function detachLiveRunSession() {
  const sid = state.liveRunSessionId;
  if (sid) {
    saveSessionRunArtifacts(sid);
    syncTimelineCacheForSession(sid);
  }
  state.liveRunSessionId = null;
  state.eventRouteSessionId = null;
  state.streamTextBuffer = "";
  state.streamTextRaw = "";
  state.streamTextNode = null;
  if (state.streamFlushTimer) {
    clearTimeout(state.streamFlushTimer);
    state.streamFlushTimer = null;
  }
  state.thinkingPre = null;
  state.currentStepEl = null;
  state.currentStepBody = null;
  state.runActivityEl = null;
  state.runActivityBody = null;
  state.runActivityFoldBody = null;
  state.runActivityStreamEl = null;
  state.runActivityStats = null;
  state.statusNode = null;
  state.sawStreamTextInRun = false;
}

function ensureLiveRunSession(sessionId) {
  if (!sessionId) return;
  if (state.liveRunSessionId === sessionId) {
    if (
      sessionRuns?.isSessionRunning(sessionId) &&
      !runActivityRefsValid()
    ) {
      reattachLiveRunDomRefs();
    }
    return;
  }
  detachLiveRunSession();
  state.liveRunSessionId = sessionId;
  state.planCardTitle = "任务清单";
  state.dispatchPlanLocked = false;
  state.runConclusionRendered = Boolean(
    state.runConclusionBySession.get(sessionId),
  );
  const patches = state.runPatchesBySession.get(sessionId);
  state.runPatches = patches ? new Map(patches) : new Map();
  state.runFinalText = "";
  state.sawStreamTextInRun = false;
  bindThinkingFromMount();
  if (sessionRuns?.isSessionRunning(sessionId)) {
    reattachLiveRunDomRefs();
  }
}

function saveRunPatchesForSession(sessionId) {
  if (!sessionId) return;
  state.runPatchesBySession.set(sessionId, new Map(state.runPatches));
}

function initSessionRuns() {
  sessionRuns = window.ForgeSessionRunUi.createSessionRunApi(() => state, {
    $,
    getActiveProject,
    showChatEmpty,
    clearTimeline,
    pushEventIn,
    saveProjects,
    renderProjects,
    renderComposerGitBranchSelect,
    renderComposerQueue,
    renderContextMeter,
    sessionCwdMatches,
    upsertSessionInWorkspace,
    restoreSessionTimeline,
    detachLiveRunSession,
    ensureLiveRunSession,
    reattachLiveRunDomRefs,
    rebindTimelineAfterRestore,
    captureTimelineUiState,
    restoreTimelineUiState,
    syncTimelineCacheForSession,
    flushTimelineCacheSync,
    saveSessionRunArtifacts,
    loadSessionRunArtifacts,
    ensureConclusionCardForSession,
    reconcileSessionConclusion,
    refreshLiveTimelineIfViewing,
    isViewSwitchCurrent,
    captureOutgoingTimeline,
    sessionBelongsToActiveProject,
    rememberSessionCwd,
    sessionCwdMatches,
    pushEvent,
    repairTimelineDomStructure,
    renderTimelineFromState,
    structuredTimelineCacheUsable,
    hasStructuredTimelineCache,
    structuredTimelineHasConclusion,
    structuredTimelineHasUserTurn,
    structuredTimelineShouldReload,
    forgetSessionRunCaches,
    finalizeRunConclusionOnMount,
    withOffscreenRoot: (sessionId, fn) => {
      const prevRoute = state.eventRouteSessionId;
      const prevLive = state.liveRunSessionId;
      const prevOffscreen = state.offscreenTimelineEl;
      state.eventRouteSessionId = sessionId;
      state.liveRunSessionId = null;
      state.runActivityEl = null;
      state.runActivityBody = null;
      state.runActivityFoldBody = null;
      state.runActivityStreamEl = null;
      state.runActivityStats = null;
      state.currentStepEl = null;
      state.currentStepBody = null;
      state.streamTextNode = null;
      state.streamTextBuffer = "";
      state.streamTextRaw = "";
      if (state.streamFlushTimer) {
        clearTimeout(state.streamFlushTimer);
        state.streamFlushTimer = null;
      }
      const virtual = document.createElement("div");
      renderTimelineFromState(sessionId, virtual);
      state.offscreenTimelineEl = virtual;
      bindThinkingFromMount();
      if (state.runningSessions.has(sessionId)) {
        reattachLiveRunDomRefs(virtual);
      }
      try {
        fn();
        repairTimelineDomStructure(virtual);
      } finally {
        state.thinkingPre = null;
        state.offscreenTimelineEl = prevOffscreen;
        state.eventRouteSessionId = prevRoute;
        state.liveRunSessionId = prevLive;
      }
      refreshLiveTimelineIfViewing(sessionId);
    },
  });
}

async function createDefaultProject() {
  let cwd = state.defaultCwd;
  const bridge = getBridge();
  if (!cwd && bridge?.getDefaultCwd) {
    try {
      cwd = await bridge.getDefaultCwd();
      state.defaultCwd = cwd;
    } catch {
      cwd = "";
    }
  }
  return {
    id: "default",
    name: "默认项目",
    cwd: cwd || "",
    sessionId: "",
  };
}

async function loadProjects() {
  let cached = [];
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PROJECTS_KEY) || "[]");
    if (Array.isArray(raw) && raw.length) {
      cached = raw.filter((p) => p && typeof p.id === "string" && p.id);
    }
  } catch {
    /* ignore */
  }
  try {
    const cfg = await getBridge()?.getConfig?.();
    const shared = sharedProjectsFromConfig(cfg);
    if (shared.length) return hydrateSharedProjects(shared, cached);
  } catch {
    /* cached projects remain a safe offline fallback */
  }
  return cached.length ? cached : [await createDefaultProject()];
}

function saveProjects() {
  localStorage.setItem(LS_PROJECTS_KEY, JSON.stringify(state.projects));
  localStorage.setItem(LS_ACTIVE_PROJECT_KEY, state.activeProjectId);
  localStorage.setItem(
    LS_PROJECT_EXPANDED_KEY,
    JSON.stringify([...state.expandedProjectIds]),
  );
  const bridge = getBridge();
  if (bridge?.saveConfig) {
    void bridge
      .saveConfig({
        ui: {
          projects: state.projects.map(({ id, name, cwd }) => ({ id, name, cwd })),
        },
      })
      .catch(() => {
        /* local cache keeps the Desktop usable while Daemon/config is unavailable */
      });
  }
}

function normalizedProjectCwd(cwd) {
  return String(cwd || "").replace(/[\\/]+$/, "");
}

function sharedProjectsFromConfig(cfg) {
  const projects = cfg?.ui?.projects;
  if (!Array.isArray(projects)) return [];
  return projects.filter(
    (project) =>
      project &&
      typeof project.id === "string" &&
      project.id &&
      typeof project.name === "string" &&
      project.name &&
      typeof project.cwd === "string" &&
      project.cwd,
  );
}

function mergeProjectLists(primary, secondary) {
  const merged = [];
  const byCwd = new Map();
  for (const project of [...primary, ...secondary]) {
    const cwdKey = normalizedProjectCwd(project?.cwd);
    if (!project?.id || !cwdKey) continue;
    const existing = byCwd.get(cwdKey);
    if (existing) {
      Object.assign(existing, { ...project, ...existing });
      continue;
    }
    const next = { ...project, cwd: project.cwd };
    byCwd.set(cwdKey, next);
    merged.push(next);
  }
  return merged;
}

function hydrateSharedProjects(shared, cached) {
  return shared.map((project) => {
    const cachedProject = cached.find(
      (item) => normalizedProjectCwd(item?.cwd) === normalizedProjectCwd(project.cwd),
    );
    return cachedProject ? { ...cachedProject, ...project } : { ...project };
  });
}

function syncProjectsFromConfig(cfg) {
  const shared = sharedProjectsFromConfig(cfg);
  if (!shared.length) return false;
  const before = state.projects.length;
  state.projects = mergeProjectLists(state.projects, shared);
  return state.projects.length !== before;
}

function loadSessionUiPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SESSION_UI_KEY) || "{}");
    if (Array.isArray(raw.pinned)) state.pinnedSessionIds = new Set(raw.pinned);
    if (Array.isArray(raw.archived)) {
      state.archivedSessionIds = new Set(raw.archived);
    }
  } catch {
    state.pinnedSessionIds = new Set();
    state.archivedSessionIds = new Set();
  }
}

function saveSessionUiPrefs() {
  localStorage.setItem(
    LS_SESSION_UI_KEY,
    JSON.stringify({
      pinned: [...state.pinnedSessionIds],
      archived: [...state.archivedSessionIds],
    }),
  );
}

function getActiveProject() {
  return (
    state.projects.find((p) => p.id === state.activeProjectId) ?? state.projects[0]
  );
}

function resetRunArtifacts() {
  state.runPatches.clear();
  state.runFinalText = "";
  state.runConclusionRendered = false;
  resetRunActivityState();
}

function createRunActivityStats() {
  return {
    startedAt: Date.now(),
    step: 0,
    maxSteps: 0,
    tools: 0,
    patches: 0,
    skills: 0,
    thinkingChars: 0,
    lastStatus: "",
    hadError: false,
    stopped: false,
  };
}

function startRunActivityTimer() {
  if (state.runActivityTimer) return;
  state.runActivityTimer = setInterval(() => {
    const details = state.runActivityEl;
    if (!details?.isConnected || !details.classList.contains("run-activity-active")) {
      stopRunActivityTimer();
      return;
    }
    updateRunActivitySummary({ tick: true });
  }, 1000);
}

function stopRunActivityTimer() {
  if (!state.runActivityTimer) return;
  clearInterval(state.runActivityTimer);
  state.runActivityTimer = null;
}

function resetRunActivityState() {
  state.runActivityEl = null;
  state.runActivityBody = null;
  state.runActivityFoldBody = null;
  state.runActivityStreamEl = null;
  state.runActivityStats = null;
  state.stepToolGroupEl = null;
  state.stepToolGroupBody = null;
  state.stepToolGroupCount = 0;
  state.subagentActivityByMention.clear();
  state.activeSubagentMentions.clear();
  state.subagentStreamByMention.clear();
  state.pushEventMountOverride = null;
  state.normalizedFileActivityCallIds.clear();
  state.normalizedFileActivityPaths.clear();
  stopRunActivityTimer();
  stopAllCodexProvisionalFiles();
  state.codexCommentarySeenBySession.clear();
}

function formatDurationMs(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function isTimelineRootMessage(text) {
  const t = String(text || "");
  return t.startsWith("开始执行:") || t.startsWith("会话摘要");
}

function timelineHasPromptText(label) {
  const wanted = normalizeUserPromptLabel(label);
  if (!wanted) return false;
  const mount = getTimelineMount();
  if (!mount?.querySelectorAll) return false;
  // Dedupe only within the CURRENT (unconcluded) turn — short replies like
  // 「可以」repeat across turns and must each render their own prompt line.
  const prompts = mount.querySelectorAll(".user-prompt");
  const last = prompts[prompts.length - 1];
  if (!last) return false;
  let node = last.nextElementSibling;
  while (node) {
    if (node.classList?.contains("run-conclusion")) return false;
    node = node.nextElementSibling;
  }
  const text = normalizeUserPromptLabel(last.textContent || "");
  if (text === wanted) return true;
  // Some providers emit the same preview with small truncation differences.
  if (text.length >= 24 && wanted.length >= 24) {
    return text.startsWith(wanted) || wanted.startsWith(text);
  }
  return false;
}

function renderUserPromptOnce(preview) {
  const label = formatUserPromptForDisplay(preview);
  const text = label || preview;
  if (!text || timelineHasPromptText(text)) return;
  pushEvent(`开始执行: ${text}`);
}

function normalizeRuntimeProvider(runtime) {
  return String(runtime?.provider || "forge").trim() || "forge";
}

function setTimelineRuntime(provider = "forge") {
  const timeline = $("timeline");
  if (!timeline) return;
  timeline.dataset.runtime = provider;
}

function setTimelineRuntimeForSession(sessionId) {
  setTimelineRuntime(state.runtimeBySession.get(sessionId) || "forge");
}

const CODEX_CHIP_PREFIX = "__codex_chip__:";

function isCodexRuntime(sessionId) {
  const sid = sessionId || getActiveEventSessionId();
  if (sid && state.runtimeBySession.get(sid) === "codex") return true;
  return getTimelineMount()?.dataset?.runtime === "codex";
}

function codexActivityIconMarkup(icon) {
  switch (icon) {
    case "search":
      return "🔍";
    case "read":
      return "📋";
    case "file":
      return "✎";
    case "mcp":
      return "📋";
    case "think":
      return "💭";
    default:
      return "⏺";
  }
}

function codexActivityStatsHtml(adds, dels, force = false) {
  const a = Number(adds || 0);
  const d = Number(dels || 0);
  if (!force && !a && !d) return "";
  return `<span class="codex-activity-stats" aria-label="变更统计"><span class="codex-activity-add">+${a}</span> <span class="codex-activity-del">-${d}</span></span>`;
}

function animateCodexStatsCountUp(chip, targetAdds, targetDels) {
  const addEl = chip.querySelector(".codex-activity-add");
  const delEl = chip.querySelector(".codex-activity-del");
  if (!addEl || !delEl) return;
  const duration = 500;
  const steps = 12;
  const interval = duration / steps;
  let step = 0;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const tick = () => {
    step++;
    const progress = ease(Math.min(step / steps, 1));
    addEl.textContent = `+${Math.round(targetAdds * progress)}`;
    delEl.textContent = `-${Math.round(targetDels * progress)}`;
    if (step < steps) setTimeout(tick, interval);
    else chip.classList.remove("stats-counting");
  };
  tick();
}

function basename(path) {
  const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || String(path || "file");
}

function normalizeCodexActivityPath(path) {
  return normalizeWorkspaceRelPath(getActiveProject()?.cwd, path || "");
}

function countTextLines(text) {
  const raw = String(text ?? "");
  if (!raw) return 0;
  return raw.split(/\r\n?|\n/).length;
}

function codexProvisionalFilesForSession(sessionId, create = false) {
  const sid = sessionId || getActiveEventSessionId() || "_anonymous";
  if (!state.codexProvisionalFilesBySession.has(sid) && create) {
    state.codexProvisionalFilesBySession.set(sid, new Map());
  }
  return state.codexProvisionalFilesBySession.get(sid) || null;
}

function extractCodexMentionedFiles(text) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const path = normalizeCodexActivityPath(raw);
    if (!path || seen.has(path)) return;
    if (!/\.[a-z0-9]{1,8}$/i.test(path)) return;
    seen.add(path);
    out.push(path);
  };
  const source = String(text || "");
  for (const match of source.matchAll(/`([^`]+\.[A-Za-z0-9]{1,8})`/g)) push(match[1]);
  for (const match of source.matchAll(/(?:^|[\s，。；、:：])([A-Za-z0-9_.@-]+\/[A-Za-z0-9_./@-]*\.[A-Za-z0-9]{1,8}|[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8})(?=$|[\s，。；、])/g)) {
    push(match[1]);
  }
  return out.slice(0, 6);
}

function maybeStartCodexProvisionalFileActivities(text) {
  if (!isCodexRuntime()) return;
  if (!/(准备新建|新建文件|新建|开始写文件|写文件|创建文件|编辑文件|生成文件|新增文件)/.test(String(text || ""))) return;
  const sid = getActiveEventSessionId();
  if (!sid) return;
  const files = extractCodexMentionedFiles(text);
  if (!files.length) return;
  const map = codexProvisionalFilesForSession(sid, true);
  for (const path of files) {
    if (map.has(path)) continue;
    const record = {
      sessionId: sid,
      path,
      callId: `provisional:file:${path}`,
      baselineLines: null,
      lastLines: 0,
      sawMissing: false,
      stopped: false,
      timer: null,
    };
    map.set(path, record);
    renderCodexActivityChip({
      callId: record.callId,
      icon: "file",
      label: `正在编辑 ${basename(path)}`,
      status: "running",
      path,
      adds: 0,
      dels: 0,
    });
    scheduleCodexProvisionalFilePoll(record);
  }
}

function stopCodexProvisionalFile(record) {
  if (!record) return;
  record.stopped = true;
  if (record.timer) clearTimeout(record.timer);
  record.timer = null;
}

function stopCodexProvisionalFiles(sessionId) {
  const map = codexProvisionalFilesForSession(sessionId, false);
  if (!map) return;
  for (const record of map.values()) stopCodexProvisionalFile(record);
  map.clear();
}

function stopAllCodexProvisionalFiles() {
  for (const map of state.codexProvisionalFilesBySession.values()) {
    for (const record of map.values()) stopCodexProvisionalFile(record);
    map.clear();
  }
}

function collapseRepeatedCodexText(text) {
  let value = String(text || "").trim();
  let guard = 0;
  while (guard++ < 4 && value.length > 8) {
    const replayCollapsed = collapseLeadingReplayCodexText(value);
    if (replayCollapsed && replayCollapsed !== value) {
      value = replayCollapsed.trim();
      continue;
    }
    const half = Math.floor(value.length / 2);
    if (value.length % 2 === 0 && value.slice(0, half) === value.slice(half)) {
      value = value.slice(0, half).trim();
      continue;
    }
    const chunks = value.match(/^([\s\S]{12,}?)(?:\s*)\1$/);
    if (chunks?.[1]) {
      value = chunks[1].trim();
      continue;
    }
    // Near-duplicate stutter: "sentence。sentence。" with light punctuation drift.
    if (value.length >= 24) {
      const mid = Math.floor(value.length / 2);
      const left = value.slice(0, mid).trim();
      const right = value.slice(mid).trim();
      if (
        left.length >= 12 &&
        right.length >= 12 &&
        isNearDuplicateNarrative(left, right)
      ) {
        value = left.length >= right.length ? left : right;
        continue;
      }
    }
    break;
  }
  return value;
}

function collapseLeadingReplayCodexText(text) {
  const value = String(text || "").trim();
  if (value.length < 48) return value;
  const maxAnchor = Math.min(72, Math.floor(value.length / 2));
  for (let anchorLen = maxAnchor; anchorLen >= 18; anchorLen -= 6) {
    const anchor = value.slice(0, anchorLen);
    const replayStart = value.indexOf(anchor, 1);
    if (replayStart < 12) continue;
    const first = value.slice(0, replayStart).trim();
    const second = value.slice(replayStart).trim();
    if (first.length < 18 || second.length < 18) continue;
    if (!isNearDuplicateNarrative(first, second)) continue;
    return first.length >= second.length ? first : second;
  }
  return value;
}

function isNearDuplicateNarrative(a, b) {
  const left = normalizeCodexCommentaryKey(a);
  const right = normalizeCodexCommentaryKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length < 12) return false;
  // Allow light punctuation / wording drift between two stutters.
  if (shorter.length / longer.length < 0.72) return false;
  const dist = levenshteinDistance(shorter, longer);
  return dist <= Math.max(6, Math.floor(shorter.length * 0.18));
}

function normalizeCodexCommentaryKey(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function codexCommentarySeenSet(sessionId, create = false) {
  const sid = sessionId || getActiveEventSessionId() || "_anonymous";
  if (!state.codexCommentarySeenBySession.has(sid) && create) {
    state.codexCommentarySeenBySession.set(sid, new Set());
  }
  return state.codexCommentarySeenBySession.get(sid) || null;
}

function seedCodexCommentarySeenFromDom(sessionId, root = getTimelineMount()) {
  const seen = codexCommentarySeenSet(sessionId, true);
  if (!seen || !root?.querySelectorAll) return seen;
  root
    .querySelectorAll(
      "details.run-activity .codex-commentary-text, details.run-activity .step-narrative-text, .run-activity-stream .codex-commentary-text, .run-activity-stream .step-narrative-text",
    )
    .forEach((el) => {
      const key = normalizeCodexCommentaryKey(el.textContent || "");
      if (key) seen.add(key);
    });
  return seen;
}

function shouldSkipCodexCommentary(sessionId, text) {
  const key = normalizeCodexCommentaryKey(text);
  if (!key) return true;
  const seen = seedCodexCommentarySeenFromDom(sessionId);
  if (!seen) return false;
  for (const existing of seen) {
    if (isNearDuplicateNarrative(existing, key)) return true;
  }
  seen.add(key);
  return false;
}

function scheduleCodexProvisionalFilePoll(record) {
  stopCodexProvisionalFile({ timer: record.timer });
  record.timer = setTimeout(() => void pollCodexProvisionalFile(record), 900);
}

async function pollCodexProvisionalFile(record) {
  if (!record || record.stopped) return;
  const active = getActiveProject();
  const bridge = getBridge();
  if (!active?.cwd || typeof bridge?.readWorkspaceFile !== "function") return;
  try {
    const res = await bridge.readWorkspaceFile({ cwd: active.cwd, path: record.path });
    const lines = countTextLines(res?.content || "");
    if (record.baselineLines == null) {
      record.baselineLines = record.sawMissing ? 0 : Math.min(record.lastLines || lines, lines);
    }
    record.lastLines = lines;
    const adds = Math.max(0, lines - (record.baselineLines || 0));
    renderCodexActivityChip({
      callId: record.callId,
      icon: "file",
      label: `正在编辑 ${basename(record.path)}`,
      status: "running",
      path: record.path,
      adds,
      dels: 0,
    });
  } catch {
    record.sawMissing = true;
    /* File may not exist yet. Keep the visible activity and try again. */
  }
  if (!record.stopped) scheduleCodexProvisionalFilePoll(record);
}

function renderCodexActivityChip(payload) {
  ensureRunActivity();
  const body = state.runActivityBody;
  if (!body || !payload) return null;
  const runtime = payload.runtime || "codex";
  setTimelineRuntime(runtime);
  const sid = getActiveEventSessionId();
  if (sid) state.runtimeBySession.set(sid, runtime);
  const callId = String(payload.callId || "");
  const relPath = normalizeCodexActivityPath(payload.path);
  let line = callId
    ? body.querySelector(`[data-codex-activity-id="${cssEscape(callId)}"]`)
    : null;
  if (!line && relPath) {
    line = body.querySelector(`[data-codex-activity-path="${cssEscape(relPath)}"]`);
  }
  const previousStats = line?.dataset.codexStats || "";
  if (!line) {
    if (!state.stepToolGroupBody?.isConnected) beginStepToolGroup();
    const mount = getToolEventMount();
    line = document.createElement("div");
    line.className = "codex-activity-chip";
    line.dataset.codexActivityId = callId;
    line.dataset.timelineNodeId = timelineEntryId();
    line.dataset.iconKey = String(payload.icon || "command");
    mount.appendChild(line);
    bumpStepToolGroupCount();
  }
  const running = payload.status === "running";
  line.classList.toggle("is-running", running);
  line.classList.toggle("is-done", !running);
  line.dataset.iconKey = String(payload.icon || "command");
  if (callId) line.dataset.codexActivityId = callId;
  if (relPath) line.dataset.codexActivityPath = relPath;
  const fileChanges = Array.isArray(payload.changes) ? payload.changes : [];
  if (relPath && (payload.patch?.unifiedDiff || fileChanges.some((c) => c?.unifiedDiff))) {
    const map = codexProvisionalFilesForSession(sid, false);
    const provisional = map?.get(relPath);
    if (provisional) {
      stopCodexProvisionalFile(provisional);
      map.delete(relPath);
    }
  }
  let aggregateEntry = null;
  if (fileChanges.length) {
    for (const change of fileChanges) {
      if (!change?.path) continue;
      const recorded = recordRunModifiedFile(change.path, {
        patch: change.unifiedDiff
          ? { path: change.path, unifiedDiff: change.unifiedDiff, applied: payload.status === "done" }
          : undefined,
        statKey: callId,
        adds: change.adds,
        dels: change.dels,
      });
      if (!aggregateEntry || normalizeCodexActivityPath(change.path) === relPath) {
        aggregateEntry = recorded;
      }
    }
  } else if (relPath && payload.status === "done") {
    aggregateEntry = recordRunModifiedFile(relPath, {
      patch: payload.patch,
      statKey: callId,
      adds: payload.adds,
      dels: payload.dels,
    });
  }
  const previousAdds = Number(previousStats.split(":")[0] || 0);
  const previousDels = Number(previousStats.split(":")[1] || 0);
  const payloadAdds = Number(payload.adds || 0);
  const payloadDels = Number(payload.dels || 0);
  const shouldPreserveStats =
    payload.icon === "file" &&
    !payload.patch?.unifiedDiff &&
    !payloadAdds &&
    !payloadDels &&
    (previousAdds || previousDels);
  const displayAdds = Number.isFinite(aggregateEntry?.adds)
    ? aggregateEntry.adds
    : shouldPreserveStats
      ? previousAdds
      : payloadAdds;
  const displayDels = Number.isFinite(aggregateEntry?.dels)
    ? aggregateEntry.dels
    : shouldPreserveStats
      ? previousDels
      : payloadDels;
  const nextStats = `${displayAdds}:${displayDels}`;
  const stats = codexActivityStatsHtml(displayAdds, displayDels, payload.icon === "file");
  const command = String(payload.args?.command || "");
  const commandDetail = command
    ? serializeEventDetail({
        kind: "command",
        title: "Shell",
        command,
        cwd: payload.args?.cwd || "",
        content: payload.result || "",
        exitCode: payload.args?.exitCode,
        durationMs: payload.durationMs,
        status: payload.status,
      })
    : "";
  const expand = commandDetail
    ? '<span class="codex-activity-expand" aria-hidden="true">⌄</span>'
    : "";
  line.innerHTML = `<span class="codex-activity-icon" aria-hidden="true">${codexActivityIconMarkup(payload.icon)}</span><span class="codex-activity-label">${escapeHtml(payload.label || "")}</span>${stats}${expand}`;
  if (commandDetail) {
    line.dataset.forgeDetail = commandDetail;
    line.classList.add("clickable", "has-command-detail");
  }
  const isNewStats = !previousStats && (displayAdds || displayDels);
  if (previousStats && previousStats !== nextStats) {
    line.classList.remove("stats-updated");
    void line.offsetWidth;
    line.classList.add("stats-updated");
  }
  if (isNewStats && !running && (displayAdds > 5 || displayDels > 5)) {
    line.classList.add("stats-counting");
    animateCodexStatsCountUp(line, displayAdds, displayDels);
  }
  line.dataset.codexStats = nextStats;
  const combinedDiff = fileChanges.length
    ? fileChanges.map((change) => String(change?.unifiedDiff || "")).filter(Boolean).join("\n")
    : payload.patch?.unifiedDiff;
  if (combinedDiff) {
    const detailPath = payload.path || fileChanges[0]?.path || "";
    const serialized = serializeEventDetail({
      title: fileChanges.length > 1 ? `Patch · ${fileChanges.length} 个文件` : detailPath ? `Patch · ${detailPath}` : "Patch",
      content: combinedDiff,
      ...(fileChanges.length <= 1
        ? {
            patch: {
              path: detailPath,
              unifiedDiff: combinedDiff,
              applied: payload.status === "done",
            },
          }
        : {}),
      changes: fileChanges,
    });
    if (serialized) line.dataset.forgeDetail = serialized;
    line.classList.add("clickable");
  }
  if (state.runActivityStats && payload.label) {
    state.runActivityStats.lastStatus = String(payload.label);
    updateRunActivitySummary();
  }
  updateStepToolGroupSummary();
  maybeCollapseStepToolGroup();
  maybeScrollActivityBody();
  if (sid) syncStructuredTimelineFromDom(sid);
  return line;
}

function isRuntimeUnifiedDiff(diff) {
  return /^(?:diff --git|---\s|@@\s)/m.test(String(diff || ""));
}

function normalizeRuntimeFileChangeForDisplay(change) {
  if (!change?.path) return change;
  const kind = String(change.kind || "update");
  const rawDiff = String(change.unifiedDiff || "");
  if (!rawDiff || isRuntimeUnifiedDiff(rawDiff) || kind === "update") return change;
  const content = rawDiff.endsWith("\n") ? rawDiff.slice(0, -1) : rawDiff;
  const lines = content ? content.split("\n") : [];
  const isAdd = kind === "add";
  const unifiedDiff = isAdd
    ? [
        "--- /dev/null",
        `+++ ${change.path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
      ].join("\n")
    : [
        `--- ${change.path}`,
        "+++ /dev/null",
        `@@ -1,${lines.length} +0,0 @@`,
        ...lines.map((line) => `-${line}`),
      ].join("\n");
  return {
    ...change,
    unifiedDiff,
    adds: isAdd ? lines.length : 0,
    dels: isAdd ? 0 : lines.length,
  };
}

function normalizeRuntimeFileActivityForDisplay(ev) {
  const changes = Array.isArray(ev?.changes)
    ? ev.changes.map(normalizeRuntimeFileChangeForDisplay)
    : [];
  const adds = changes.reduce((sum, change) => sum + Number(change?.adds || 0), 0);
  const dels = changes.reduce((sum, change) => sum + Number(change?.dels || 0), 0);
  const firstDiff = changes.find((change) => change?.unifiedDiff);
  return {
    ...ev,
    changes,
    adds: Number(ev?.adds || 0) || adds,
    dels: Number(ev?.dels || 0) || dels,
    patch: firstDiff
      ? { path: firstDiff.path, unifiedDiff: firstDiff.unifiedDiff }
      : ev?.patch,
  };
}

function handleCodexActivityEvent(ev) {
  finishStreamTextSegment();
  renderCodexActivityChip({
    callId: ev.callId,
    icon: ev.icon,
    label: ev.label,
    status: ev.status,
    path: ev.path,
    adds: ev.adds,
    dels: ev.dels,
    patch: ev.patch,
    changes: ev.changes,
    runtime: ev.runtime,
    name: ev.name,
    args: ev.args,
    result: ev.result,
    durationMs: ev.durationMs,
  });
}

function runtimeActivityIcon(ev) {
  const kind = String(ev?.activityKind || "");
  if (kind === "file" || kind === "mcp" || kind === "search" || kind === "read" || kind === "think") {
    return kind;
  }
  return "command";
}

function handleRuntimeActivityEvent(ev) {
  const runtime = ev.runtime || runtimeProviderFromStatusMessage(ev.runtime || "");
  if (runtime) {
    const sid = ev.sessionId || getActiveEventSessionId();
    if (sid) state.runtimeBySession.set(sid, runtime);
    setTimelineRuntime(runtime);
  }
  if (ev.activityKind === "tool") {
    finishStreamTextSegment();
    if (ev.status === "running") {
      const toolName = ev.name || "runtime_tool";
      const toolArgs = ev.args || {};
      const key = toolLineKey(toolName, ev.callId);
      if (state.pendingToolLines.has(key)) {
        refreshPendingToolLineFromArgs(toolName, toolArgs, ev.callId, ev.talent);
        return;
      }
      beginToolLine(toolName, toolArgs, ev.callId, ev.talent);
      return;
    }
    const doneName = ev.name || "runtime_tool";
    if (ev.args && typeof ev.args === "object" && Object.keys(ev.args).length > 0) {
      const key = toolLineKey(doneName, ev.callId);
      const pending = state.pendingToolLines.get(key);
      if (pending && (!pending.args || Object.keys(pending.args).length === 0)) {
        pending.args = ev.args;
      }
    }
    completeToolLine(doneName, ev.result ?? "", ev.callId);
    if (ev.path && isFileEditRuntimeTool(doneName)) {
      const relPath = normalizeWorkspaceRelPath(getActiveProject()?.cwd, ev.path);
      if (relPath) {
        recordRunModifiedFile(relPath, {
          patch: ev.patch || undefined,
        });
      }
    }
    if (Array.isArray(ev.changes)) {
      for (const change of ev.changes) {
        const changePath = normalizeWorkspaceRelPath(getActiveProject()?.cwd, change?.path);
        if (changePath) {
          recordRunModifiedFile(changePath, {
            patch: change.unifiedDiff ? { path: changePath, unifiedDiff: change.unifiedDiff, applied: true } : undefined,
            statKey: "runtime",
            adds: change.adds,
            dels: change.dels,
          });
        }
      }
    }
    return;
  }
  if (ev.activityKind === "file" && ev.callId) {
    const key = toolLineKey(ev.name || "", ev.callId);
    const pending = state.pendingToolLines.get(key);
    if (pending?.line?.isConnected) pending.line.remove();
    state.pendingToolLines.delete(key);
    state.normalizedFileActivityCallIds.add(String(ev.callId));
    for (const change of ev.changes || []) {
      const path = normalizeWorkspaceRelPath(getActiveProject()?.cwd, change?.path);
      if (path) state.normalizedFileActivityPaths.add(path);
    }
    const path = normalizeWorkspaceRelPath(getActiveProject()?.cwd, ev.path);
    if (path) state.normalizedFileActivityPaths.add(path);
  }
  if (runtime === "codex" || ev.activityKind === "file") {
    const displayEvent =
      ev.activityKind === "file" ? normalizeRuntimeFileActivityForDisplay(ev) : ev;
    handleCodexActivityEvent({
      callId: displayEvent.callId,
      icon: runtimeActivityIcon(displayEvent),
      label: displayEvent.label,
      status: displayEvent.status,
      path: displayEvent.path,
      adds: displayEvent.adds,
      dels: displayEvent.dels,
      patch: displayEvent.patch,
      changes: displayEvent.changes,
      runtime,
      name: displayEvent.name,
      args: displayEvent.args,
      result: displayEvent.result,
      durationMs: displayEvent.durationMs,
    });
    if (ev.activityKind === "file" && ev.status === "running" && ev.callId && !ev.path) {
      scheduleCodexChipDiffPoll(ev.callId);
    }
  }
}

function terminalizePendingActivityChips(root = getTimelineMount()) {
  root?.querySelectorAll?.(".codex-activity-chip.is-running").forEach((chip) => {
    chip.classList.remove("is-running");
    chip.classList.add("is-done");
    const label = chip.querySelector(".codex-activity-label");
    if (label) {
      label.textContent = String(label.textContent || "")
        .replace(/^正在运行/, "已运行")
        .replace(/^正在编辑文件…$/, "已编辑")
        .replace(/^正在编辑/, "已编辑")
        .replace(/^正在修改/, "已修改");
    }
  });
}

function appendCodexCommentaryBlock(text) {
  const trimmed = collapseRepeatedCodexText(text);
  if (!trimmed) return;
  const sid = getActiveEventSessionId();
  if (shouldSkipCodexCommentary(sid, trimmed)) return;
  ensureRunActivity();
  endStepToolGroup();
  setTimelineRuntime("codex");
  maybeStartCodexProvisionalFileActivities(trimmed);
  const mount = state.runActivityBody || getTimelineMount();
  const wrap = document.createElement("div");
  wrap.className = "codex-commentary";
  wrap.dataset.timelineNodeId = timelineEntryId();
  wrap.innerHTML = `<div class="codex-commentary-text" role="note"></div>`;
  const host = wrap.querySelector(".codex-commentary-text");
  if (host) {
    if (trimmed.includes("\n") || /^#+\s|^\s*[-*]/m.test(trimmed)) {
      renderConclusionMarkdown(host, trimmed);
    } else {
      host.textContent = trimmed;
    }
  }
  mount.appendChild(wrap);
  if (sid) {
    state.runtimeBySession.set(sid, "codex");
    recordStepNarrativeEntry(
      sid,
      trimmed,
      Boolean(host?.querySelector(".md-preview")),
    );
    syncStructuredTimelineFromDom(sid);
  }
}

function runtimeProviderFromStatusMessage(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("codex")) return "codex";
  if (text.includes("cursor")) return "cursor";
  if (text.includes("claude")) return "claude-code";
  if (text.includes("forge")) return "forge";
  return "";
}

function shouldFoldIntoRunActivity(text, cls = "") {
  if (isTimelineRootMessage(text)) return false;
  if (runActivityRefsValid()) return true;
  const routeSid = state.eventRouteSessionId;
  if (routeSid && state.runningSessions.has(routeSid)) return true;
  return Boolean(state.running);
}

/** Move tool/thinking rows that were saved outside run-activity back into its body. */
function isSessionRunConcluded(sessionId) {
  if (!sessionId) return false;
  if (state.runningSessions.has(sessionId)) return false;
  return Boolean(state.runConclusionBySession.get(sessionId));
}

/** New user message in an existing session — allow progress UI and a fresh conclusion block. */
function beginSessionTurn(sessionId) {
  if (sessionId) {
    state.runConclusionBySession.delete(sessionId);
    state.conclusionDomRenderedThisTurn.delete(sessionId);
    state.runningSessions.add(sessionId);
    state.foregroundTalentBySession.delete(sessionId);
    state.stepNarrativesBySession.set(sessionId, []);
  }
  state.runConclusionRendered = false;
  state.runFinalText = "";
  state.coordinatorPhaseAnnounced = false;
  resetRunActivityState();
  if (sessionId && sessionRuns?.isViewingSession(sessionId)) {
    ensureLiveRunSession(sessionId);
    state.viewingTimelineSessionId = sessionId;
    setTimelineRuntimeForSession(sessionId);
  }
}

/** Move stray tool/thinking rows sitting beside run-activity into its stream/body. */
function hoistOrphanNodesIntoRunActivity() {
  const mount = getTimelineMount();
  const activity = state.runActivityEl;
  const body = state.runActivityBody;
  if (!mount || !activity || !body) return;

  // While streaming flat, content already lives in the timeline stream sibling —
  // do not pull siblings into a nested fold body.
  if (body.classList?.contains("run-activity-stream")) return;

  const prompt = findPromptForRunActivity(activity);
  let node = prompt ? prompt.nextElementSibling : mount.firstElementChild;
  while (node && node !== activity) {
    const next = node.nextElementSibling;
    if (shouldHoistNodeIntoRunActivity(node)) body.appendChild(node);
    node = next;
  }
  bindThinkingFromMount();
}

function findPromptForRunActivity(activity) {
  return findOwningPromptForRunActivity(activity);
}

function realignRunActivitiesToTurns(root = getTimelineMount()) {
  if (!root) return;
  for (const activity of root.querySelectorAll(
    ":scope > details.run-activity:not(.subagent-talent-activity)",
  )) {
    const turnIndex = Number(activity.dataset.turnIndex);
    const prompts = root.querySelectorAll(":scope > .event.user-prompt");
    const prompt = Number.isFinite(turnIndex)
      ? prompts[turnIndex]
      : findOwningPromptForRunActivity(activity);
    if (!prompt) continue;
    const stream =
      activity.dataset.streamId &&
      root.querySelector(
        `:scope > .run-activity-stream[data-stream-id="${cssEscape(activity.dataset.streamId)}"]`,
      );
    let insertBefore = prompt.nextElementSibling;
    while (insertBefore && insertBefore !== activity) {
      if (
        insertBefore.matches("details.run-activity") ||
        insertBefore.classList.contains("run-conclusion") ||
        insertBefore.classList.contains("user-prompt")
      ) {
        break;
      }
      // Skip this turn's own flat stream when searching for the insert point.
      if (stream && insertBefore === stream) {
        insertBefore = insertBefore.nextElementSibling;
        continue;
      }
      insertBefore = insertBefore.nextElementSibling;
    }
    if (insertBefore === activity) continue;
    if (insertBefore) root.insertBefore(activity, insertBefore);
    else prompt.insertAdjacentElement("afterend", activity);
    if (stream) {
      const after = activity.nextElementSibling;
      if (after !== stream) {
        if (after) root.insertBefore(stream, after);
        else root.appendChild(stream);
      }
    }
  }
}

/** Keep each turn's run-activity block directly under its user-prompt (开始执行). */
function normalizeTimelineTurnOrder(root = getTimelineMount()) {
  realignRunActivitiesToTurns(root);
}

function shouldHoistNodeIntoRunActivity(node) {
  if (!node) return false;
  if (node.classList?.contains("run-conclusion")) return false;
  if (node.classList?.contains("run-activity-stream")) return false;
  if (node.classList?.contains("plan-card")) return false;
  if (node.classList?.contains("user-prompt")) return false;
  if (node.classList?.contains("event") && node.classList.contains("status")) return false;
  if (node.classList?.contains("event") && node.classList.contains("skill-hit")) return false;
  return (
    node.classList?.contains("event") ||
    (node.tagName === "DETAILS" && node.classList.contains("thinking"))
  );
}

function resolveTurnRunActivityForConclusion(container) {
  if (state.runActivityEl?.isConnected && container?.contains(state.runActivityEl)) {
    return state.runActivityEl;
  }
  const activities = container?.querySelectorAll?.(":scope > details.run-activity");
  return activities?.length ? activities[activities.length - 1] : null;
}

function turnHasConclusionAfter(activity) {
  if (!activity) return false;
  let node = activity.nextElementSibling;
  while (node) {
    if (node.classList?.contains("run-conclusion")) return true;
    if (node.classList?.contains("user-prompt")) break;
    if (
      node.matches?.("details.run-activity") &&
      !node.classList.contains("subagent-talent-activity")
    ) {
      break;
    }
    node = node.nextElementSibling;
  }
  return false;
}

function placeRunConclusionOnMount(wrap, container) {
  const activity = resolveTurnRunActivityForConclusion(container);
  if (activity?.parentElement === container) {
    let insertAfter = activity;
    let node = activity.nextElementSibling;
    while (node) {
      if (node.classList?.contains("user-prompt")) break;
      if (node.classList?.contains("run-conclusion")) break;
      if (
        node.matches?.("details.run-activity") &&
        !node.classList.contains("subagent-talent-activity")
      ) {
        break;
      }
      if (
        node.classList?.contains("run-activity-stream") ||
        shouldHoistNodeIntoRunActivity(node) ||
        node.matches?.("details.step-tool-group")
      ) {
        insertAfter = node;
        node = node.nextElementSibling;
        continue;
      }
      break;
    }
    insertAfter.insertAdjacentElement("afterend", wrap);
    return;
  }
  container.appendChild(wrap);
}

function repairTimelineDomStructure(root = $("timeline")) {
  if (!root) return;
  // Live flat stream keeps process output as timeline siblings; only repair
  // finalized folds that already nest content inside `.run-activity-body`.
  const queue = [];
  let body = null;

  const flush = () => {
    for (const node of queue) body?.appendChild(node);
    queue.length = 0;
  };

  for (const node of [...root.children]) {
    if (node.classList?.contains("run-activity-stream")) {
      flush();
      body = null;
      continue;
    }
    if (node.matches?.("details.run-activity")) {
      flush();
      const foldBody = node.querySelector(".run-activity-body");
      const streamHost = getRunActivityContentHost(node);
      // Active flat runs keep content outside the fold — don't re-nest them.
      if (
        node.classList.contains("run-activity-active") &&
        streamHost?.classList?.contains("run-activity-stream")
      ) {
        body = null;
      } else {
        body = foldBody;
      }
      continue;
    }
    if (node.classList?.contains("run-conclusion")) {
      flush();
      body = null;
      continue;
    }
    if (!body) continue;
    if (node.classList?.contains("user-prompt")) continue;
    if (node.classList?.contains("event") && node.classList.contains("status")) continue;
    if (node.classList?.contains("event") && node.classList.contains("skill-hit")) continue;
    if (
      node.classList?.contains("event") ||
      (node.tagName === "DETAILS" &&
        (node.classList.contains("thinking") || node.classList.contains("step-tool-group")))
    ) {
      queue.push(node);
    }
  }
  flush();
  normalizeTimelineTurnOrder(root);
}

const SCROLL_BOTTOM_THRESHOLD = 24;
const USER_SCROLL_INTENT_MS = 1500;
// Scroll events caused by our own scrollTop writes (or layout shifts right after
// them) must never be mistaken for user scrolling — see bindFollowBottomScroll.
const programmaticScrollUntil = new WeakMap();

function isScrollAtBottom(el, threshold = SCROLL_BOTTOM_THRESHOLD) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function markProgrammaticScroll(el, windowMs = 120) {
  if (el) programmaticScrollUntil.set(el, Date.now() + windowMs);
}

function isRecentProgrammaticScroll(el) {
  return (programmaticScrollUntil.get(el) ?? 0) >= Date.now();
}

function scrollElToBottom(el) {
  if (!el) return;
  markProgrammaticScroll(el);
  el.scrollTop = el.scrollHeight;
}

/**
 * Follow-bottom driven by user scrolling only:
 * - scrolling away from the bottom disables following;
 * - following is re-enabled only when the *user* brings the view back to the
 *   bottom (recent wheel/touch/pointer intent), so programmatic scrolls and
 *   layout-induced scrollTop clamping can never force the view down again.
 */
function bindFollowBottomScroll(el, applyFollow) {
  let userScrollIntentAt = 0;
  const markUserScrollIntent = () => {
    userScrollIntentAt = Date.now();
  };
  el.addEventListener(
    "wheel",
    (event) => {
      markUserScrollIntent();
      if (event.deltaY < 0) applyFollow(false);
    },
    { passive: true },
  );
  el.addEventListener("touchmove", markUserScrollIntent, { passive: true });
  el.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
  el.addEventListener(
    "scroll",
    () => {
      // Leaving the bottom always disables follow — even during programmatic
      // scroll bursts (scrollbar drag does not emit wheel events).
      if (!isScrollAtBottom(el)) {
        applyFollow(false);
        return;
      }
      const hasUserIntent = Date.now() - userScrollIntentAt <= USER_SCROLL_INTENT_MS;
      if (!hasUserIntent && isRecentProgrammaticScroll(el)) return;
      if (hasUserIntent) applyFollow(true);
    },
    { passive: true },
  );
}

function runActivityBodyHasPinnedDetails(body = state.runActivityBody) {
  if (!body?.querySelector) return false;
  return Boolean(
    body.querySelector(
      'details.event.thinking[open], details.event.thinking[data-user-pinned="1"]',
    ),
  );
}

function runActivityBodyShouldAutoScroll() {
  const body = state.runActivityBody;
  // Flat stream scrolls with the main timeline, not an inner fold viewport.
  if (body?.classList?.contains("run-activity-stream")) return false;
  if (!body || !state.runActivityEl?.open || !state.activityFollowBottom) return false;
  if (runActivityBodyHasPinnedDetails(body)) return false;
  return true;
}

function pauseRunActivityAutoScroll() {
  state.activityFollowBottom = false;
  state.timelineFollowBottom = false;
}

function maybeScrollActivityBody() {
  if (!runActivityBodyShouldAutoScroll()) return;
  scrollElToBottom(state.runActivityBody);
}

function maybeScrollTimeline() {
  const tl = $("timeline");
  if (!tl || tl.classList.contains("hidden") || !state.timelineFollowBottom) return;
  scrollElToBottom(tl);
}

function maybeScrollRunActivityIntoView() {
  if (!state.timelineFollowBottom) return;
  // scrollIntoView(nearest) scrolled UP when the fold's top sat above the
  // viewport — following the bottom must only ever move the view down.
  scrollElToBottom($("timeline"));
}

function scheduleRunViewScroll() {
  requestAnimationFrame(() => {
    maybeScrollActivityBody();
    // If the user scrolled up inside run-activity, do not yank the outer timeline.
    if (!state.runActivityBody || state.activityFollowBottom) {
      maybeScrollTimeline();
    }
    requestAnimationFrame(() => {
      maybeScrollActivityBody();
      if (!state.runActivityBody || state.activityFollowBottom) {
        maybeScrollTimeline();
      }
    });
  });
}

/**
 * Snapshot scroll + expanded details before an innerHTML repaint clobbers them.
 * Folds are identified by their index among same-kind elements — summary text
 * is ambiguous (every turn reads「已处理 Ns」), which used to reopen the wrong
 * turn's fold and close the one the user actually had open.
 */
function captureTimelineUiState(timeline = $("timeline")) {
  const openDetails = [];
  const activityScrolls = [];
  if (timeline?.querySelectorAll) {
    timeline.querySelectorAll("details.run-activity").forEach((el, idx) => {
      if (!el.open) return;
      openDetails.push({ kind: "run-activity", idx });
      const body = el.querySelector(".run-activity-body");
      if (body) {
        activityScrolls.push({
          idx,
          scrollTop: body.scrollTop,
          atBottom: isScrollAtBottom(body),
        });
      }
    });
    timeline.querySelectorAll("details.event.thinking").forEach((el, idx) => {
      if (!el.open) return;
      openDetails.push({ kind: "thinking", idx, thinkingId: el.dataset.thinkingId || "" });
    });
    timeline.querySelectorAll("details.tool-inline-diff").forEach((el, idx) => {
      if (el.open) openDetails.push({ kind: "inline-diff", idx });
    });
  }
  return {
    scrollTop: timeline?.scrollTop ?? 0,
    timelineFollowBottom: state.timelineFollowBottom,
    activityFollowBottom: state.activityFollowBottom,
    activityScrolls,
    openDetails,
  };
}

function restoreOpenDetails(timeline, openDetails = []) {
  if (!timeline || !openDetails.length) return;
  const activities = timeline.querySelectorAll("details.run-activity");
  const thinkings = timeline.querySelectorAll("details.event.thinking");
  const inlineDiffs = timeline.querySelectorAll("details.tool-inline-diff");
  for (const { kind, thinkingId, idx } of openDetails) {
    if (kind === "inline-diff") {
      const el = inlineDiffs[idx];
      if (el) el.open = true;
      continue;
    }
    if (kind === "run-activity") {
      const el = activities[idx];
      if (el) {
        el.open = true;
        el.dataset.userPinned = "1";
      }
      continue;
    }
    let el = thinkingId
      ? [...thinkings].find((t) => t.dataset.thinkingId === thinkingId) || null
      : null;
    if (!el) el = thinkings[idx] || null;
    if (el) {
      el.open = true;
      el.dataset.userPinned = "1";
    }
  }
}

/** Repainted HTML may carry stale `open` attrs (e.g. cache synced before a manual collapse) — close anything the pre-repaint snapshot didn't have open. */
function closeStaleOpenDetails(timeline, snapshot) {
  const wantedIdx = {
    "run-activity": new Set(),
    thinking: new Set(),
    "inline-diff": new Set(),
  };
  const wantedThinkingIds = new Set();
  for (const d of snapshot.openDetails || []) {
    if (wantedIdx[d.kind] && d.idx != null) wantedIdx[d.kind].add(d.idx);
    if (d.kind === "thinking" && d.thinkingId) wantedThinkingIds.add(d.thinkingId);
  }
  const closeUnwanted = (selector, kind, idOf) => {
    timeline.querySelectorAll(selector).forEach((el, idx) => {
      if (!el.open || wantedIdx[kind].has(idx)) return;
      if (idOf && wantedThinkingIds.has(idOf(el))) return;
      el.open = false;
      delete el.dataset.userPinned;
    });
  };
  closeUnwanted("details.run-activity", "run-activity");
  closeUnwanted("details.event.thinking", "thinking", (el) => el.dataset.thinkingId || "");
  closeUnwanted("details.tool-inline-diff", "inline-diff");
}

function restoreTimelineUiState(snapshot, timeline = $("timeline")) {
  if (!snapshot || !timeline) return;
  closeStaleOpenDetails(timeline, snapshot);
  // Open folds first: outer scroll restore depends on the final layout height.
  restoreOpenDetails(timeline, snapshot.openDetails);
  restoreScrollAfterSessionRefresh(
    timeline,
    snapshot.scrollTop,
    snapshot.timelineFollowBottom,
  );
  state.activityFollowBottom = snapshot.activityFollowBottom;
  if (sessionRuns?.isSessionRunning(state.viewingTimelineSessionId)) {
    reattachLiveRunDomRefs(timeline);
  }
  const activities = timeline.querySelectorAll("details.run-activity");
  for (const snap of snapshot.activityScrolls || []) {
    const body = activities[snap.idx]?.querySelector(".run-activity-body");
    if (!body) continue;
    if (snap.atBottom) {
      scrollElToBottom(body);
    } else {
      markProgrammaticScroll(body);
      body.scrollTop = snap.scrollTop;
    }
  }
  // User was reading inside run-activity — keep auto-scroll off after repaint.
  if ((snapshot.activityScrolls || []).some((snap) => !snap.atBottom)) {
    state.activityFollowBottom = false;
  }
  if ((snapshot.openDetails || []).some((d) => d.kind === "thinking")) {
    state.activityFollowBottom = false;
  }
}

function restoreScrollAfterSessionRefresh(timeline, previousScrollTop, shouldScrollToBottom) {
  if (!timeline) return;
  if (shouldScrollToBottom) {
    scrollElToBottom(timeline);
    state.timelineFollowBottom = true;
    return;
  }
  markProgrammaticScroll(timeline);
  timeline.scrollTop = previousScrollTop;
  state.timelineFollowBottom = isScrollAtBottom(timeline);
}

// #timeline persists across repaints, but nested run-activity nodes are
// recreated via innerHTML restores. Listener markers must live in WeakSets
// (not data-* attributes): serialized attributes would survive the restore
// while the actual listeners are lost, leaving stale "already bound" flags.
const followScrollBoundEls = new WeakSet();
const runActivityPinBoundEls = new WeakSet();
const runActivityToggleBoundEls = new WeakSet();

function bindTimelineScrollFollow() {
  const tl = $("timeline");
  if (!tl || followScrollBoundEls.has(tl)) return;
  followScrollBoundEls.add(tl);
  bindFollowBottomScroll(tl, (follow) => {
    state.timelineFollowBottom = follow;
  });
}

/** User toggles must land in the timeline cache, or the next innerHTML repaint resurrects the old open state. */
function syncViewedTimelineCacheAfterToggle() {
  syncTimelineCacheForSession(state.viewingTimelineSessionId || "");
}

function bindRunActivityPin(details) {
  if (!details || runActivityPinBoundEls.has(details)) return;
  runActivityPinBoundEls.add(details);
  details.addEventListener("toggle", () => {
    if (details.open) details.dataset.userPinned = "1";
    else delete details.dataset.userPinned;
    syncViewedTimelineCacheAfterToggle();
  });
}

function isRunActivityUserPinned(details) {
  return Boolean(details?.open && details.dataset.userPinned === "1");
}

function serializeEventDetail(detail) {
  if (!detail) return "";
  try {
    return JSON.stringify({
      title: detail.title,
      meta: detail.meta,
      content:
        typeof detail.content === "string"
          ? detail.content.slice(0, 32000)
          : detail.content,
      patch: detail.patch,
      filePath: detail.filePath || detail.patch?.path || "",
      toolFile: detail.toolFile || "",
      kind: detail.kind || "",
      command: detail.command || "",
      cwd: detail.cwd || "",
      exitCode: detail.exitCode,
      durationMs: detail.durationMs,
      status: detail.status || "",
    });
  } catch {
    return "";
  }
}

/** After innerHTML restore: rebind run-activity folds (clicks use timeline delegation). */
function rebindTimelineAfterRestore(root = $("timeline")) {
  if (!root) return;
  root.querySelectorAll("details.run-activity").forEach((details) => {
    bindRunActivityPin(details);
    bindRunActivityScroll(details.querySelector(".run-activity-body"), details);
  });
  if (state.runActivityBody?.isConnected) {
    rebuildSubagentActivityMapFromDom(getTimelineMount());
  }
}

function resolveClickableDetail(line) {
  const sid =
    line.dataset.eventDetailSession || sessionRuns?.getViewingSessionId() || "";
  const id = Number(line.dataset.eventDetailId);
  if (sid && Number.isFinite(id)) {
    const stored = state.eventDetailsBySession.get(sid)?.get(id);
    if (stored) return stored;
  }
  const raw = line.dataset.forgeDetail;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      /* ignore */
    }
  }
  const text = String(line.textContent || "");
  const patchMatch = text.match(/补丁:\s*(.+?)（(已应用|待应用)）/);
  if (patchMatch) {
    const path = patchMatch[1].trim();
    const cwd = getActiveProject()?.cwd;
    const norm = normalizeWorkspaceRelPath(cwd, path);
    const item =
      state.runPatches.get(norm) ||
      state.runPatches.get(path) ||
      [...state.runPatches.values()].find(
        (x) => x.filePath === norm || x.filePath === path || x.patch?.path === path,
      );
    if (item) return item;
  }
  return null;
}

function bindTimelineClickDelegation() {
  const tl = $("timeline");
  if (!tl || tl.dataset.timelineClickBound === "1") return;
  tl.dataset.timelineClickBound = "1";
  tl.addEventListener(
    "toggle",
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLDetailsElement) || !tl.contains(t)) return;
      if (!t.classList.contains("thinking")) return;
      if (t.open) {
        t.dataset.userPinned = "1";
        pauseRunActivityAutoScroll();
      } else {
        delete t.dataset.userPinned;
      }
    },
    true,
  );
  tl.addEventListener("click", (e) => {
    if (e.target.closest(".codex-command-detail")) return;
    const link = e.target.closest("a");
    if (link && tl.contains(link)) {
      const href = String(link.getAttribute("href") || "").trim();
      if (!/^(https?:|mailto:|tel:|data:|javascript:)/i.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        void openWorkspaceSourceLinkFromTimeline(link);
        return;
      }
    }

    const fileBtn = e.target.closest(".modified-file-btn");
    if (fileBtn && tl.contains(fileBtn)) {
      e.preventDefault();
      e.stopPropagation();
      const path = fileBtn.getAttribute("data-path");
      if (path) void openModifiedFile(path);
      return;
    }
    const copyBtn = e.target.closest("[data-copy-action]");
    if (copyBtn && tl.contains(copyBtn)) {
      e.preventDefault();
      e.stopPropagation();
      void handleTimelineCopyClick(copyBtn);
      return;
    }
    const retryBtn = e.target.closest("[data-retry-message]");
    if (retryBtn && tl.contains(retryBtn)) {
      e.preventDefault();
      e.stopPropagation();
      retryComposerMessage(retryBtn.getAttribute("data-retry-message") || "");
      return;
    }
    const cpBtn = e.target.closest("[data-checkpoint-sha]");
    if (cpBtn && tl.contains(cpBtn)) {
      e.preventDefault();
      e.stopPropagation();
      const turnAttr = cpBtn.getAttribute("data-checkpoint-turn");
      void handleCheckpointRestore(
        cpBtn.getAttribute("data-checkpoint-sha") || "",
        turnAttr == null ? null : Number(turnAttr),
      );
      return;
    }
    // The inline-diff header only toggles its <details>; don't open the right panel.
    const inlineHead = e.target.closest(".tool-inline-diff-head");
    if (inlineHead && tl.contains(inlineHead)) return;
    const line = e.target.closest(".event.clickable, .codex-activity-chip.clickable");
    if (!line || !tl.contains(line)) return;
    // Clicking a specific inline diff line scrolls the right panel to that line.
    const diffLine = e.target.closest(".tool-inline-diff-body .diff-line");
    if (diffLine?.parentElement) {
      pendingCodeDetailScroll = {
        index: [...diffLine.parentElement.children].indexOf(diffLine),
      };
    }
    const d = resolveClickableDetail(line);
    if (!d) {
      notifyUser("无法加载该行详情（可尝试重新打开该会话）", "warn");
      return;
    }
    if (d.kind === "command") {
      toggleCodexCommandDetail(line, d);
      return;
    }
    if (d?.patch?.path) void openModifiedFile(d.patch.path, d.patch);
    else if (d?.toolFile) void openToolFileDetail(d);
    else showCodeDetail({ ...d, filePath: d?.filePath || d?.patch?.path || "" });
  });
}

function toggleCodexCommandDetail(line, detail) {
  const current = line.querySelector(":scope > .codex-command-detail");
  if (current) {
    current.remove();
    line.classList.remove("is-expanded");
    return;
  }
  const panel = document.createElement("div");
  panel.className = "codex-command-detail";
  const header = document.createElement("div");
  header.className = "codex-command-detail-head";
  const meta = [];
  if (detail.cwd) meta.push(detail.cwd);
  if (Number.isFinite(detail.exitCode)) meta.push(`退出码 ${detail.exitCode}`);
  if (Number.isFinite(detail.durationMs)) meta.push(formatDurationMs(detail.durationMs));
  header.innerHTML = `<span>Shell</span><span>${escapeHtml(meta.join(" · "))}</span>`;
  const pre = document.createElement("pre");
  pre.className = "codex-command-detail-output";
  const output = String(detail.content || "").trimEnd();
  pre.textContent = `$ ${detail.command}${output ? `\n\n${output}` : detail.status === "running" ? "\n\n运行中…" : ""}`;
  panel.append(header, pre);
  line.appendChild(panel);
  line.classList.add("is-expanded");
}

/** Tool line click: show the real workspace file (with location breadcrumb) plus the tool args/result. */
async function openToolFileDetail(detail) {
  const active = getActiveProject();
  const path =
    normalizeWorkspaceRelPath(active?.cwd, detail.toolFile) || detail.toolFile;
  let fullContent = null;
  if (active?.cwd && typeof requireBridge().readWorkspaceFile === "function") {
    try {
      const res = await requireBridge().readWorkspaceFile({ cwd: active.cwd, path });
      fullContent = res?.content ?? null;
    } catch {
      fullContent = null;
    }
  }
  showCodeDetail({ ...detail, filePath: path, fullContent });
}

function runActivityHasExpandedContent(details) {
  if (isRunActivityUserPinned(details)) return true;
  const body = details.querySelector(".run-activity-body");
  if (!body) return false;
  return Boolean(
    body.querySelector('details.event.thinking[open], details.event.thinking[data-user-pinned="1"]'),
  );
}

function closeOrphanThinkingBlocks(mount = $("timeline")) {
  if (!mount?.querySelectorAll) return;
  mount.querySelectorAll("details.event.thinking").forEach((block) => {
    if (block.dataset.userPinned === "1" || block.open) return;
    const summary = block.querySelector("summary");
    if (!summary?.textContent?.includes("思考中")) return;
    const pre = block.querySelector(".event-pre");
    const chars = pre?.textContent?.length ?? 0;
    summary.textContent = `思考完成 · ${chars} 字`;
    block.open = false;
  });
  if (state.thinkingPre && !state.thinkingPre.isConnected) state.thinkingPre = null;
}

/** Point live run state at run-activity already present in the timeline (post-restore / offscreen). */
function reattachLiveRunDomRefs(mount = getTimelineMount()) {
  if (!mount?.querySelectorAll) return false;
  const activities = mount.querySelectorAll("details.run-activity");
  if (!activities.length) return false;

  let target = null;
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i].classList.contains("run-activity-active")) {
      target = activities[i];
      break;
    }
  }
  if (!target) return false;

  activities.forEach((el) => {
    if (el !== target) el.classList.remove("run-activity-active");
  });

  state.runActivityEl = target;
  state.runActivityFoldBody = target.querySelector(".run-activity-body");
  const streamHost = getRunActivityContentHost(target);
  state.runActivityStreamEl =
    streamHost?.classList?.contains("run-activity-stream") ? streamHost : null;
  state.runActivityBody = streamHost || state.runActivityFoldBody;
  if (!state.runActivityStats) state.runActivityStats = createRunActivityStats();

  const meta = target.querySelector(".run-activity-meta")?.textContent || "";
  const stepMatch = meta.match(/Step\s+(\d+)(?:\/(\d+))?/);
  if (stepMatch) {
    state.runActivityStats.step = Number(stepMatch[1]) || 0;
    if (stepMatch[2]) state.runActivityStats.maxSteps = Number(stepMatch[2]) || 0;
  }

  state.currentStepEl = target;
  state.currentStepBody = state.runActivityBody;
  startRunActivityTimer();

  bindRunActivityPin(target);
  if (state.runActivityFoldBody) {
    bindRunActivityScroll(state.runActivityFoldBody, target);
  }

  rebuildSubagentActivityMapFromDom(getTimelineMount());

  const narrative = state.runActivityBody?.querySelector(
    ".narrative-buffer .event-pre",
  );
  state.streamTextNode = narrative || null;
  bindThinkingFromMount();
  return true;
}

function bindRunActivityScroll(body, rootDetails) {
  if (body && !followScrollBoundEls.has(body)) {
    followScrollBoundEls.add(body);
    bindFollowBottomScroll(body, (follow) => {
      if (follow && runActivityBodyHasPinnedDetails(body)) follow = false;
      state.activityFollowBottom = follow;
      // Reading inside run-activity should also stop the outer timeline from auto-scrolling.
      if (!follow) state.timelineFollowBottom = false;
    });
    body.addEventListener(
      "toggle",
      (e) => {
        const t = e.target;
        if (!(t instanceof HTMLDetailsElement) || !body.contains(t)) return;
        if (t.open) {
          t.dataset.userPinned = "1";
          pauseRunActivityAutoScroll();
        } else {
          delete t.dataset.userPinned;
        }
        syncViewedTimelineCacheAfterToggle();
      },
      true,
    );
    body.addEventListener(
      "mousedown",
      () => {
        pauseRunActivityAutoScroll();
      },
      true,
    );
  }
  if (rootDetails && !runActivityToggleBoundEls.has(rootDetails)) {
    runActivityToggleBoundEls.add(rootDetails);
    rootDetails.addEventListener("toggle", () => {
      // Active flat stream keeps content outside the fold — don't open an empty body.
      if (
        rootDetails.open &&
        rootDetails.classList.contains("run-activity-active") &&
        getRunActivityContentHost(rootDetails)?.classList?.contains("run-activity-stream")
      ) {
        rootDetails.open = false;
        return;
      }
      if (rootDetails.open) {
        rootDetails.dataset.userPinned = "1";
        if (
          body &&
          isScrollAtBottom(body) &&
          !runActivityBodyHasPinnedDetails(body)
        ) {
          state.activityFollowBottom = true;
        }
      } else {
        delete rootDetails.dataset.userPinned;
      }
      syncViewedTimelineCacheAfterToggle();
    });
  }
}

function runActivityRefsValid() {
  if (!state.runActivityEl || !state.runActivityBody) return false;
  const mount = getTimelineMount();
  if (!mount?.contains(state.runActivityEl)) return false;
  if (!state.runActivityBody.isConnected) return false;
  return true;
}

function ensureRunActivity(options = {}) {
  const force = options.force === true;
  const sid = getActiveEventSessionId();
  if (!force && sid && isSessionRunConcluded(sid)) return;
  if (!force && runActivityRefsValid()) {
    hoistOrphanNodesIntoRunActivity();
    return;
  }
  state.runActivityEl = null;
  state.runActivityBody = null;
  state.runActivityFoldBody = null;
  state.runActivityStreamEl = null;
  if (reattachLiveRunDomRefs()) {
    hoistOrphanNodesIntoRunActivity();
    return;
  }
  const details = document.createElement("details");
  const stream = document.createElement("div");
  const shellEntryId = timelineEntryId();
  const streamId = `stream-${shellEntryId}`;
  const turnIndex = Math.max(
    0,
    (getTimelineMount()?.querySelectorAll(":scope > .event.user-prompt").length ?? 1) - 1,
  );
  details.className = "run-activity run-activity-active";
  details.dataset.timelineEntryId = shellEntryId;
  details.dataset.turnIndex = String(turnIndex);
  details.dataset.streamId = streamId;
  // Keep the status chip collapsed while streaming; content lives in the flat stream.
  details.open = false;
  details.innerHTML = `
    <summary class="run-activity-summary">
      <span class="run-activity-chevron" aria-hidden="true">›</span>
      <span class="run-activity-label">处理中…</span>
      <span class="run-activity-meta"></span>
    </summary>
    <div class="run-activity-body"></div>
  `;
  stream.className = "run-activity-stream";
  stream.dataset.streamId = streamId;
  stream.dataset.timelineEntryId = shellEntryId;
  bindRunActivityPin(details);
  const foldBody = details.querySelector(".run-activity-body");
  bindRunActivityScroll(foldBody, details);
  const mount = getTimelineMount();
  mount.appendChild(details);
  mount.appendChild(stream);
  state.runActivityEl = details;
  state.runActivityFoldBody = foldBody;
  state.runActivityStreamEl = stream;
  state.runActivityBody = stream;
  state.runActivityStats = createRunActivityStats();
  state.activityFollowBottom = true;
  state.currentStepEl = details;
  state.currentStepBody = state.runActivityBody;
  startRunActivityTimer();
  updateRunActivitySummary({ live: "处理中…" });
  if (sid) recordRunActivityShellEntry(sid, shellEntryId);
  normalizeTimelineTurnOrder();
  hoistOrphanNodesIntoRunActivity();
}

function normalizeTalentMention(mention) {
  return String(mention || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value || ""));
  return String(value || "").replace(/["\\]/g, "\\$&");
}

function getSubagentEntry(mention) {
  if (!mention) return null;
  const key = normalizeTalentMention(mention);
  return state.subagentActivityByMention.get(key) || null;
}

function setSubagentEntry(mention, entry) {
  const key = normalizeTalentMention(mention);
  if (!key) return;
  state.subagentActivityByMention.set(key, entry);
}

const SUBAGENT_ROUTED_EVENT_TYPES = new Set([
  "status",
  "step_start",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "tool_start",
  "tool_end",
  "text_delta",
  "warning",
]);

/** Rebind subagent card bodies after timeline innerHTML restore (stale map → detached nodes). */
function rebuildSubagentActivityMapFromDom(mount = getTimelineMount()) {
  if (!mount?.querySelectorAll) return;
  mount
    .querySelectorAll("details.subagent-talent-activity[data-talent-mention]")
    .forEach((details) => {
      const mention = details.dataset.talentMention;
      if (!mention) return;
      const body = details.querySelector(".subagent-talent-body");
      if (!body) return;
      const prev = getSubagentEntry(mention);
      const labelRaw = details.querySelector(".run-activity-label")?.textContent || "";
      const displayName =
        prev?.talent?.displayName ||
        labelRaw.replace(/^[^\s]+\s+/, "").split(" · ")[0]?.trim() ||
        mention;
      setSubagentEntry(mention, {
        details,
        body,
        talent: prev?.talent || {
          mention: prev?.talent?.mention || mention,
          displayName,
          role: prev?.talent?.role,
          emoji: prev?.talent?.emoji,
          avatar: prev?.talent?.avatar,
        },
        startedAt: prev?.startedAt || Date.now(),
        finalized: !details.classList.contains("subagent-talent-active"),
      });
    });
}

function resolveSubagentEventMount(ev) {
  let mention = ev.talent?.mention;
  if (!mention && SUBAGENT_ROUTED_EVENT_TYPES.has(ev.type)) {
    if (state.activeSubagentMentions.size === 1) {
      mention = [...state.activeSubagentMentions][0];
    }
  }
  if (!mention) return null;
  return getSubagentBodyForTalent(mention);
}

function getSubagentBodyForTalent(mention) {
  if (!mention) return null;
  const entry = getSubagentEntry(mention);
  if (entry?.body?.isConnected) return entry.body;
  rebuildSubagentActivityMapFromDom();
  const rebound = getSubagentEntry(mention);
  return rebound?.body?.isConnected ? rebound.body : null;
}

function countSubagentActivityNodes(body) {
  if (!body?.querySelectorAll) return 0;
  return body.querySelectorAll(
    ":scope > .event, :scope > details.thinking, :scope > details.narrative-buffer, :scope > .subagent-stream",
  ).length;
}

function ensureSubagentActivityVisible(body, talent, resultText) {
  if (!body || !talent || countSubagentActivityNodes(body) > 0) return;
  const preview = truncateToolSummary(String(resultText || "").trim(), 280);
  if (!preview) return;
  pushEventIn(body, `${talent.displayName} · 回复摘要`, "status", {
    title: `${talent.displayName} (@${talent.mention})`,
    meta: talent.role || "人才",
    content: resultText,
  });
}

function appendSubagentStreamText(talent, delta) {
  const text = String(delta || "");
  if (!text || !talent?.mention) return;
  const mentionKey = normalizeTalentMention(talent.mention);
  const body = getSubagentBodyForTalent(talent.mention);
  if (!body) return;
  let entry = state.subagentStreamByMention.get(mentionKey);
  if (!entry?.pre?.isConnected) {
    const wrap = document.createElement("div");
    wrap.className = "event subagent-stream";
    wrap.dataset.talentMention = mentionKey;
    const emoji = talent.emoji || "🧑";
    wrap.innerHTML = `
      <details class="assistant-block narrative-buffer" open>
        <summary>${escapeHtml(`${emoji} ${talent.displayName} 输出中…`)}</summary>
        <pre class="event-pre"></pre>
      </details>`;
    body.appendChild(wrap);
    entry = { pre: wrap.querySelector(".event-pre"), wrap };
    state.subagentStreamByMention.set(mentionKey, entry);
  }
  entry.pre.textContent += text;
  if (runActivityBodyShouldAutoScroll()) scheduleRunViewScroll();
}

function createSubagentActivityGroup(talent, taskLabel, dispatchWave) {
  if (!talent?.mention) return null;
  const mentionKey = normalizeTalentMention(talent.mention);
  const existing = getSubagentEntry(talent.mention);
  if (existing?.details?.isConnected && existing?.body?.isConnected) return existing;

  ensureRunActivity();
  if (!state.runActivityBody) return null;

  const waveHint =
    dispatchWave && dispatchWave.total > 1
      ? `波次 ${dispatchWave.index}/${dispatchWave.total}${
          dispatchWave.hasPriorResults ? " · 承接上游" : ""
        } · `
      : "";
  const details = document.createElement("details");
  details.className = "run-activity subagent-talent-activity subagent-talent-active";
  details.open = true;
  details.dataset.talentMention = mentionKey;
  const emoji = talent.emoji || "🧑";
  details.innerHTML = `
    <summary class="run-activity-summary">
      <span class="run-activity-chevron" aria-hidden="true">›</span>
      <span class="run-activity-label">${escapeHtml(`${emoji} ${talent.displayName} · ${waveHint}${taskLabel}`)}</span>
      <span class="run-activity-meta">进行中…</span>
    </summary>
    <div class="run-activity-body subagent-talent-body"></div>
  `;
  bindRunActivityPin(details);
  const body = details.querySelector(".subagent-talent-body");
  bindRunActivityScroll(body, details);
  state.runActivityBody.appendChild(details);

  const entry = { details, body, talent, startedAt: Date.now() };
  setSubagentEntry(talent.mention, entry);
  state.activeSubagentMentions.add(mentionKey);
  const sid = getActiveEventSessionId();
  if (sid) {
    recordSubagentShellEntry(sid, talent, taskLabel, dispatchWave);
    syncTimelineCacheForSession(sid);
  }
  return entry;
}

function finalizeSubagentActivityGroup(talent, resultText) {
  if (!talent?.mention) return;
  const mentionKey = normalizeTalentMention(talent.mention);
  const entry = getSubagentEntry(talent.mention);
  if (!entry) return;

  const { details } = entry;
  const body = getSubagentBodyForTalent(talent.mention) || entry.body;
  details.classList.remove("subagent-talent-active");
  const labelEl = details.querySelector(".run-activity-label");
  const metaEl = details.querySelector(".run-activity-meta");
  const emoji = talent.emoji || "🧑";
  if (labelEl) labelEl.textContent = `${emoji} ${talent.displayName} · 完成`;
  if (metaEl) {
    metaEl.textContent = formatDurationMs(Date.now() - entry.startedAt);
  }

  ensureSubagentActivityVisible(body, talent, resultText);

  pushEventIn(body, `✓ ${talent.displayName} 完成`, "done", {
    title: `${talent.displayName} (@${talent.mention})`,
    meta: talent.role || "人才",
    content: resultText,
  });

  state.subagentStreamByMention.delete(mentionKey);
  state.subagentStreamByMention.delete(talent.mention);
  state.activeSubagentMentions.delete(mentionKey);
  setSubagentEntry(talent.mention, {
    ...entry,
    body,
    finalized: true,
  });
  const sid = getActiveEventSessionId();
  if (sid) {
    syncSubagentShellEntry(sid, talent, {
      finalized: true,
      label: labelEl?.textContent || "",
      meta: metaEl?.textContent || "",
      open: details.open,
    });
    syncTimelineCacheForSession(sid);
  }
  if (runActivityBodyShouldAutoScroll()) scheduleRunViewScroll();
}

function trackRunActivityStats(text, cls = "") {
  const stats = state.runActivityStats;
  if (!stats) return;
  const t = String(text || "");
  if (t.startsWith("✓")) stats.tools += 1;
  if (t.startsWith("补丁:")) stats.patches += 1;
  if (cls === "skill-hit" || (cls !== "warn" && /\bSkill\b/.test(t))) stats.skills += 1;
  if (cls === "err") stats.hadError = true;
  if (t.includes("停止") || t.includes("已停止")) stats.stopped = true;
}

function updateRunActivitySummary(opts = {}) {
  const details = state.runActivityEl;
  const stats = state.runActivityStats;
  if (!details || !stats) return;
  const labelEl = details.querySelector(".run-activity-label");
  const metaEl = details.querySelector(".run-activity-meta");
  if (!labelEl || !metaEl) return;

  if (opts.finalized) {
    details.classList.remove("run-activity-active");
    const elapsed = Date.now() - stats.startedAt;
    const t = getForegroundTalent(
      state.eventRouteSessionId || state.liveRunSessionId,
    );
    const who = t ? `${t.displayName} · ` : "";
    if (stats.hadError) labelEl.textContent = `${who}处理失败`;
    else if (stats.stopped) labelEl.textContent = `${who}已停止`;
    else labelEl.textContent = `${who}已处理 ${formatDurationMs(elapsed)}`;
  } else if (opts.live) {
    details.classList.add("run-activity-active");
    labelEl.textContent = opts.live;
  } else if (stats.lastStatus) {
    labelEl.textContent = enrichBareEditLiveLabel(stats.lastStatus);
  }

  const parts = [];
  if (!opts.finalized && stats.step > 0) {
    parts.push(
      stats.maxSteps
        ? `Step ${stats.step}/${stats.maxSteps}`
        : `Step ${stats.step}`,
    );
  } else if (opts.finalized && stats.step > 0) {
    parts.push(stats.maxSteps ? `${stats.step} 步` : `${stats.step} 步`);
  }
  if (stats.tools > 0) parts.push(`${stats.tools} 工具`);
  const fileCount = state.runPatches.size;
  if (fileCount > 0) parts.push(`${fileCount} 文件`);
  if (stats.patches > 0) parts.push(`${stats.patches} 补丁`);
  if (stats.skills > 0) parts.push(`${stats.skills} Skill`);
  if (stats.thinkingChars > 0) parts.push(`思考 ${stats.thinkingChars} 字`);

  if (opts.finalized) {
    metaEl.textContent = parts.length ? parts.join(" · ") : "点击展开查看详情";
  } else {
    const elapsed = Math.floor((Date.now() - stats.startedAt) / 1000);
    if (elapsed > 0) metaEl.textContent = [...parts, `${elapsed}s`].join(" · ");
    else metaEl.textContent = parts.join(" · ");
  }
  const sid = getActiveEventSessionId();
  if (sid) {
    syncRunActivityShellEntry(sid, {
      label: labelEl.textContent || "",
      meta: metaEl.textContent || "",
      open: details.open,
      active: details.classList.contains("run-activity-active"),
      finalized: Boolean(opts.finalized),
    });
  }
}

function finalizeRunConclusionOnMount(finalText, sessionId) {
  finishStreamTextSegment();
  stripNarrativeFromActivity();
  if (sessionId) syncStructuredTimelineFromDom(sessionId);
  finalizeRunActivity();
  closeOrphanThinkingBlocks(getTimelineMount());
  const sid =
    sessionId ||
    state.eventRouteSessionId ||
    sessionRuns?.getViewingSessionId() ||
    state.liveRunSessionId ||
    "";
  if (sid) state.runConclusionBySession.delete(sid);
  state.runConclusionRendered = false;
  renderRunConclusion(finalText, sid);
}

function finalizeRunActivity() {
  const mount = getTimelineMount();
  if (!mount) return;
  terminalizePendingActivityChips(mount);
  stopCodexProvisionalFiles(getActiveEventSessionId());
  clearAllWorkspaceTurnDiffPolls();
  removeRunFilesChangedBars(mount);

  const actives = mount.querySelectorAll("details.run-activity.run-activity-active");
  let targets = actives.length
    ? [...actives]
    : state.runActivityEl && mount.contains(state.runActivityEl)
      ? [state.runActivityEl]
      : [];

  if (!targets.length) {
    const all = mount.querySelectorAll(
      ":scope > details.run-activity:not(.subagent-talent-activity)",
    );
    if (all.length) targets = [all[all.length - 1]];
  }
  if (!targets.length) return;

  for (const details of targets) {
    if (details.classList.contains("subagent-talent-activity")) continue;
    state.runActivityEl = details;
    const contentHost = getRunActivityContentHost(details);
    state.runActivityBody = contentHost;
    state.runActivityFoldBody = details.querySelector(".run-activity-body");
    state.runActivityStreamEl =
      contentHost?.classList?.contains("run-activity-stream") ? contentHost : null;
    if (!state.runActivityStats) state.runActivityStats = createRunActivityStats();

    const shouldFold = shouldCollapseRunActivityContent(contentHost);
    if (shouldFold) {
      foldLiveRunActivityContent(details);
      if (!runActivityHasExpandedContent(details)) details.open = false;
      updateRunActivitySummary({ finalized: true });
    } else {
      // Short runs stay as ordinary dialog output — drop the empty 已处理 chip.
      updateRunActivitySummary({ finalized: true });
      unwrapLiveRunActivityContent(details);
      continue;
    }
  }

  stopRunActivityTimer();
  clearLiveStatusLine();
  endStepToolGroup();
  state.currentStepEl = null;
  state.currentStepBody = null;
  state.statusNode = null;
  state.streamTextNode = null;
  state.streamTextBuffer = "";
  state.streamTextRaw = "";
  state.runActivityStats = null;
  closeOrphanThinkingBlocks(mount);
  state.thinkingPre = null;
}

function recordRunPatch(ev) {
  const path = normalizeWorkspaceRelPath(getActiveProject()?.cwd, ev.path);
  const sid = state.eventRouteSessionId || state.liveRunSessionId;
  const existing = state.runPatches.get(path) || {};
  state.runPatches.set(path, {
    ...existing,
    filePath: path,
    title: `Patch · ${path}`,
    meta: ev.applied ? "已应用" : "待应用",
    content: ev.unifiedDiff,
    patch: {
      path,
      unifiedDiff: ev.unifiedDiff,
      applied: Boolean(ev.applied),
    },
  });
  if (sid) saveRunPatchesForSession(sid);
}

function accumulateRuntimeFileStats(contributions, key, adds, dels) {
  const next = { ...(contributions || {}) };
  next[String(key || "runtime")] = { adds: Math.max(0, Number(adds) || 0), dels: Math.max(0, Number(dels) || 0) };
  const totals = Object.values(next).reduce((sum, item) => ({ adds: sum.adds + item.adds, dels: sum.dels + item.dels }), { adds: 0, dels: 0 });
  return { contributions: next, ...totals };
}

function recordRunModifiedFile(path, options = {}) {
  const relPath = normalizeWorkspaceRelPath(getActiveProject()?.cwd, path);
  if (!relPath) return null;
  const sid = state.eventRouteSessionId || state.liveRunSessionId;
  const existing = state.runPatches.get(relPath) || {};
  const patch = options.patch?.unifiedDiff
    ? {
        path: relPath,
        unifiedDiff: options.patch.unifiedDiff,
        applied: options.patch.applied !== false,
      }
    : existing.patch;
  const hasRuntimeStats = options.statKey && (options.adds != null || options.dels != null);
  const runtimeStats = hasRuntimeStats
    ? accumulateRuntimeFileStats(existing.statContributions, options.statKey, options.adds, options.dels)
    : null;
  const nextEntry = {
    ...existing,
    filePath: relPath,
    title: existing.title || `File · ${relPath}`,
    meta: options.meta || existing.meta || (isImageFilePath(relPath) ? "已生成图片" : "已编辑"),
    content: existing.content || "",
    ...(patch ? { patch } : {}),
    ...(runtimeStats
      ? {
          statContributions: runtimeStats.contributions,
          adds: runtimeStats.adds,
          dels: runtimeStats.dels,
        }
      : {}),
  };
  state.runPatches.set(relPath, nextEntry);
  if (sid) saveRunPatchesForSession(sid);
  syncFileEditLiveLabel(relPath, false);
  updateRunFilesChangedBar();
  updateRunActivitySummary();
  return nextEntry;
}

const WORKSPACE_FILE_EXT_RE =
  /\.(java|kt|scala|go|py|ts|tsx|js|jsx|mjs|cjs|rs|cpp|c|h|hpp|cs|rb|php|sql|xml|yml|yaml|toml|md|gradle|properties|json|html|htm|css|vue|svelte|svg|sh|bash|zsh|dockerfile|makefile)$/i;

/** Keep the collapsed activity bar in sync when we learn which file is being edited. */
function syncFileEditLiveLabel(relPath, done = false) {
  if (!relPath || !state.runActivityStats) return;
  const short = basename(relPath) || relPath;
  const label = `${done ? "已编辑" : "正在编辑"} ${short}`;
  const current = String(state.runActivityStats.lastStatus || "");
  if (
    !done &&
    current &&
    !/^(正在编辑|已编辑)(\s|$)/.test(current) &&
    !/^正在(读取|搜索|运行|查看)/.test(current)
  ) {
    return;
  }
  state.runActivityStats.lastStatus = label;
  const labelEl = state.runActivityEl?.querySelector(".run-activity-label");
  if (labelEl && !state.runActivityEl?.classList.contains("run-activity-finalized")) {
    labelEl.textContent = label;
  }
}

function enrichBareEditLiveLabel(label) {
  const text = String(label || "");
  if (!/^(正在编辑|已编辑)$/.test(text) || state.runPatches.size === 0) return text;
  const paths = [...state.runPatches.keys()];
  const path = paths[paths.length - 1];
  const short = basename(path) || path;
  return short ? `${text} ${short}` : text;
}

function clearWorkspaceTurnDiffPoll(pendingKey) {
  const timer = state.workspaceDiffPollTimers.get(pendingKey);
  if (timer) clearTimeout(timer);
  state.workspaceDiffPollTimers.delete(pendingKey);
}

function clearAllWorkspaceTurnDiffPolls() {
  for (const key of [...state.workspaceDiffPollTimers.keys()]) clearWorkspaceTurnDiffPoll(key);
  state.workspaceDiffPollTimers.clear();
}

function scheduleWorkspaceTurnDiffPoll(pendingKey) {
  if (state.workspaceDiffPollTimers.has(pendingKey)) return;
  const tick = async () => {
    if (!state.pendingToolLines.has(pendingKey)) {
      clearWorkspaceTurnDiffPoll(pendingKey);
      return;
    }
    const sid = state.eventRouteSessionId || state.liveRunSessionId || "";
    await reconcileRunPatchesFromWorkspace(sid);
    const paths = [...state.runPatches.keys()];
    const path = paths[paths.length - 1];
    if (path) {
      syncFileEditLiveLabel(path, false);
      const pending = state.pendingToolLines.get(pendingKey);
      if (pending?.line?.isConnected) {
        const mergedArgs = {
          ...normalizeToolArgsEnvelope(pending.args),
          path,
          file_path: path,
        };
        pending.args = mergedArgs;
        pending.line.textContent = toolLineText(
          pending.name,
          mergedArgs,
          false,
          pending.talentOverride,
        );
      }
    }
    if (state.pendingToolLines.has(pendingKey)) {
      state.workspaceDiffPollTimers.set(pendingKey, setTimeout(() => void tick(), 1200));
    } else {
      clearWorkspaceTurnDiffPoll(pendingKey);
    }
  };
  state.workspaceDiffPollTimers.set(pendingKey, setTimeout(() => void tick(), 700));
}

function scheduleCodexChipDiffPoll(callId) {
  const pollKey = `chip:${callId}`;
  if (state.workspaceDiffPollTimers.has(pollKey)) return;
  const tick = async () => {
    const body = state.runActivityBody;
    const chip = body?.querySelector(`[data-codex-activity-id="${cssEscape(callId)}"]`);
    if (!chip || chip.classList.contains("is-done")) {
      clearWorkspaceTurnDiffPoll(pollKey);
      return;
    }
    const sid = state.eventRouteSessionId || state.liveRunSessionId || "";
    await reconcileRunPatchesFromWorkspace(sid);
    const paths = [...state.runPatches.keys()];
    const lastPath = paths[paths.length - 1];
    if (lastPath) {
      const entry = state.runPatches.get(lastPath);
      const adds = Number(entry?.adds || 0);
      const dels = Number(entry?.dels || 0);
      renderCodexActivityChip({
        callId,
        icon: "file",
        label: `正在编辑 ${basename(lastPath)}`,
        status: "running",
        path: lastPath,
        adds,
        dels,
        runtime: "cursor",
      });
    }
    if (chip.classList.contains("is-running")) {
      state.workspaceDiffPollTimers.set(pollKey, setTimeout(() => void tick(), 800));
    } else {
      clearWorkspaceTurnDiffPoll(pollKey);
    }
  };
  state.workspaceDiffPollTimers.set(pollKey, setTimeout(() => void tick(), 400));
}

function refreshPendingToolLineFromArgs(name, args, callId, talentOverride) {
  const key = toolLineKey(name, callId);
  const pending = state.pendingToolLines.get(key);
  if (!pending) return false;
  pending.args = args;
  const path = extractToolCallPath(name, args);
  const lineText = toolLineText(name, args, false, talentOverride);
  if (pending.line?.isConnected) pending.line.textContent = lineText;
  const liveLabel = lineText.replace(/^⏺\s*/, "");
  if (state.runActivityStats) state.runActivityStats.lastStatus = liveLabel;
  if (path) {
    recordRunModifiedFile(path, {});
    clearWorkspaceTurnDiffPoll(key);
  }
  updateRunActivitySummary();
  return true;
}

/** Merge git diff (vs turn checkpoint or HEAD) into runPatches — covers Codex/Cursor/ACP edits. */
async function reconcileRunPatchesFromWorkspace(sessionId) {
  const active = getActiveProject();
  const bridge = getBridge();
  if (!active?.cwd || typeof bridge?.getWorkspaceTurnDiffs !== "function") return;
  const baseSha = state.runCheckpointShaBySession.get(sessionId) || "";
  try {
    const res = await bridge.getWorkspaceTurnDiffs({
      cwd: active.cwd,
      baseSha: baseSha || undefined,
    });
    if (!res?.ok || !Array.isArray(res.files)) return;
    for (const file of res.files) {
      if (!file?.path) continue;
      const relPath = normalizeWorkspaceRelPath(active.cwd, file.path);
      if (!relPath) continue;
      const existing = state.runPatches.get(relPath);
      if (existing?.patch?.unifiedDiff && !file.unifiedDiff) continue;
      recordRunModifiedFile(relPath, {
        patch: file.unifiedDiff
          ? { path: relPath, unifiedDiff: file.unifiedDiff, applied: true }
          : undefined,
      });
    }
  } catch {
    /* non-git workspace or git unavailable */
  }
}

/** Cursor-style strip: clickable modified files while the run is still in progress. */
function updateRunFilesChangedBar() {
  const details = state.runActivityEl;
  const body = state.runActivityBody;
  if (!details || !body) return;
  if (state.runConclusionRendered) {
    removeRunFilesChangedBars(getTimelineMount());
    return;
  }
  const files = [...state.runPatches.keys()];
  const mount = getTimelineMount();
  const activityKey = details.dataset.timelineEntryId || details.dataset.streamId || "active";
  const selector = `.run-files-changed-bar[data-run-activity-key="${cssEscape(activityKey)}"]`;
  const keyedBars = [...(mount?.querySelectorAll?.(selector) || [])];
  let bar = keyedBars.shift() || null;
  keyedBars.forEach((duplicate) => duplicate.remove());
  if (!bar) {
    const legacyBars = [
      ...details.querySelectorAll(".run-files-changed-bar:not([data-run-activity-key])"),
      ...(mount?.querySelectorAll?.(":scope > .run-files-changed-bar:not([data-run-activity-key])") || []),
    ];
    bar = legacyBars.shift() || null;
    legacyBars.forEach((duplicate) => duplicate.remove());
  }
  if (!files.length) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "run-files-changed-bar";
    body.insertAdjacentElement("afterend", bar);
  }
  bar.dataset.runActivityKey = activityKey;
  const filesHtml = buildRunConclusionFilesHtml(files, state.runPatches);
  bar.innerHTML = `
    <div class="run-files-changed-head">${files.length} 个文件已修改</div>
    <div class="modified-files-list">${filesHtml}</div>`;
}

function removeRunFilesChangedBars(root = getTimelineMount()) {
  root?.querySelectorAll?.(".run-files-changed-bar").forEach((bar) => bar.remove());
}

/** Claude Code-style merged view: the whole file with line numbers, changed hunks inlined red/green. */
function tokenizeForWordDiff(s) {
  return String(s).match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || [];
}

/** Token-level LCS diff of two strings → ordered ops {t: eq|del|add, s}. */
function wordDiffOps(oldStr, newStr) {
  const a = tokenizeForWordDiff(oldStr);
  const b = tokenizeForWordDiff(newStr);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ t: "eq", s: a[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "del", s: a[i++] });
    else ops.push({ t: "add", s: b[j++] });
  }
  while (i < n) ops.push({ t: "del", s: a[i++] });
  while (j < m) ops.push({ t: "add", s: b[j++] });
  return ops;
}

/** Word-highlighted bodies for a modified line pair, or null if too dissimilar to be useful. */
function wordDiffHtml(oldStr, newStr) {
  const ops = wordDiffOps(oldStr, newStr);
  let common = 0;
  let changed = 0;
  for (const op of ops) {
    if (op.t === "eq") common += op.s.length;
    else changed += op.s.length;
  }
  // Mostly-rewritten lines read better with whole-line coloring.
  if (common === 0 || common < changed * 0.25) return null;
  let oldHtml = "";
  let newHtml = "";
  for (const op of ops) {
    const esc = escapeHtml(op.s);
    if (op.t === "eq") {
      oldHtml += esc;
      newHtml += esc;
    } else if (op.t === "del") {
      oldHtml += `<span class="diff-word">${esc}</span>`;
    } else {
      newHtml += `<span class="diff-word">${esc}</span>`;
    }
  }
  return { oldHtml, newHtml };
}

/** Pair consecutive -runs with +runs and word-highlight each pair; key → body HTML. */
function buildWordDiffMap(lines) {
  const out = new Map();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].marker !== "-") {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].marker === "-") j++;
    let k = j;
    while (k < lines.length && lines[k].marker === "+") k++;
    const pairs = Math.min(j - i, k - j);
    for (let p = 0; p < pairs; p++) {
      const del = lines[i + p];
      const add = lines[j + p];
      const wd = wordDiffHtml(del.body, add.body);
      if (wd) {
        out.set(del.key, wd.oldHtml);
        out.set(add.key, wd.newHtml);
      }
    }
    i = k;
  }
  return out;
}

function renderFullFileDiffHtml(fullContent, unifiedDiff, applied) {
  if (fullContent == null) return "";
  const fileLines = String(fullContent).split("\n");
  const diffLines = String(unifiedDiff || "").split("\n");
  const hunks = [];
  let cur = null;
  diffLines.forEach((line, di) => {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      cur = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
      hunks.push(cur);
      return;
    }
    if (!cur || line.startsWith("---") || line.startsWith("+++")) return;
    cur.lines.push({ txt: line, di });
  });
  if (!hunks.length) return "";
  // Detect whether fullContent is the new or old file by matching hunk lines at
  // both anchors — the applied flag can lag behind what's actually on disk.
  const score = (useNew) => {
    let match = 0;
    let total = 0;
    for (const h of hunks) {
      let ln = useNew ? h.newStart : h.oldStart;
      for (const { txt } of h.lines) {
        const marker = txt[0] ?? " ";
        if (useNew ? marker === "-" : marker === "+") continue;
        total += 1;
        if (fileLines[ln - 1] === txt.slice(1)) match += 1;
        ln += 1;
      }
    }
    return total ? match / total : 0;
  };
  const newScore = score(true);
  const oldScore = score(false);
  if (newScore !== oldScore) applied = newScore > oldScore;
  hunks.sort((a, b) => (applied ? a.newStart - b.newStart : a.oldStart - b.oldStart));

  const rows = [];
  let lineNo = 1;
  const emitPlainUpTo = (target) => {
    while (lineNo < target && lineNo <= fileLines.length) {
      rows.push(
        `<div class="diff-line"><span class="diff-gutter">${lineNo}</span>${escapeHtml(fileLines[lineNo - 1])}</div>`,
      );
      lineNo += 1;
    }
  };
  for (const h of hunks) {
    const start = applied ? h.newStart : h.oldStart;
    if (start < lineNo) continue;
    emitPlainUpTo(start);
    const wordMap = buildWordDiffMap(
      h.lines.map(({ txt, di }) => ({
        marker: txt[0] ?? " ",
        body: txt.slice(1),
        key: di,
      })),
    );
    for (const { txt, di } of h.lines) {
      const marker = txt[0] ?? " ";
      const body = txt.slice(1);
      const inFile = applied ? marker !== "-" : marker !== "+";
      const cls = marker === "+" ? " diff-add" : marker === "-" ? " diff-del" : "";
      const bodyHtml = wordMap.get(di) ?? escapeHtml(body);
      rows.push(
        `<div class="diff-line${cls}" data-di="${di}"><span class="diff-gutter">${inFile ? lineNo : ""}</span>${bodyHtml}</div>`,
      );
      if (inFile) lineNo += 1;
    }
  }
  emitPlainUpTo(fileLines.length + 1);
  return rows.join("");
}

/** Flip every visible patch-status marker for the path after apply/undo, then persist. */
function markPatchAppliedInUi(relPath, applied = true) {
  const norm = normalizeWorkspaceRelPath(getActiveProject()?.cwd, relPath) || relPath;
  const from = applied ? "待应用" : "已应用";
  const to = applied ? "已应用" : "待应用";
  const tl = $("timeline");
  if (!tl) return;
  tl.querySelectorAll(".modified-file-btn").forEach((btn) => {
    if (btn.getAttribute("data-path") !== norm) return;
    const status = btn.querySelector(".modified-file-status");
    if (status) status.textContent = to;
  });
  tl.querySelectorAll(".event").forEach((el) => {
    const text = el.textContent || "";
    if (text.includes("补丁:") && text.includes(norm) && text.includes(from)) {
      el.textContent = text.replace(from, to);
    }
  });
  syncViewedTimelineCacheAfterToggle();
}

/** Swap a unified diff's direction so the existing apply path can undo it. */
function reverseUnifiedDiff(diff) {
  return String(diff || "")
    .split("\n")
    .map((line) => {
      if (line.startsWith("---")) return `+++${line.slice(3)}`;
      if (line.startsWith("+++")) return `---${line.slice(3)}`;
      const m = line.match(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/);
      if (m) return `@@ -${m[2]} +${m[1]} @@${m[3]}`;
      if (line.startsWith("+")) return `-${line.slice(1)}`;
      if (line.startsWith("-")) return `+${line.slice(1)}`;
      return line;
    })
    .join("\n");
}

function renderDiffLinesHtml(unifiedDiff) {
  const lines = String(unifiedDiff || "").split("\n");
  const wordMap = buildWordDiffMap(
    lines.map((line, key) => ({
      marker:
        line.startsWith("+++") || line.startsWith("---")
          ? "m"
          : line[0] === "+" || line[0] === "-"
            ? line[0]
            : " ",
      body: line.slice(1),
      key,
    })),
  );
  return lines
    .map((line, key) => {
      let cls = "diff-line";
      if (line.startsWith("+++") || line.startsWith("---")) cls += " diff-meta";
      else if (line.startsWith("@@")) cls += " diff-hunk";
      else if (line.startsWith("+")) cls += " diff-add";
      else if (line.startsWith("-")) cls += " diff-del";
      const wordHtml = wordMap.get(key);
      const body =
        wordHtml != null ? `${line[0]}${wordHtml}` : escapeHtml(line);
      return `<div class="${cls}">${body}</div>`;
    })
    .join("");
}

function renderFullFileHtml(content) {
  return String(content || "")
    .split("\n")
    .map((line, i) => {
      const num = i + 1;
      return `<div class="full-file-line"><span class="full-file-ln">${num}</span><span class="full-file-text">${escapeHtml(line)}</span></div>`;
    })
    .join("");
}

function filePathFromDetail(detail) {
  const raw = detail?.filePath || detail?.patch?.path || "";
  const cwd = getActiveProject()?.cwd;
  return normalizeWorkspaceRelPath(cwd, raw);
}

function patchStatusLabel(detail) {
  if (detail?.patch) {
    return detail.patch.applied ? "已应用" : "待应用";
  }
  const meta = detail?.meta;
  if (meta === "已应用" || meta === "待应用") return meta;
  return null;
}

function renderPatchStatusHtml(detail) {
  const label = patchStatusLabel(detail);
  if (!label) return "";
  const cls = label === "已应用" ? "applied" : "pending";
  return `<span class="code-patch-status ${cls}">${escapeHtml(label)}</span>`;
}

function normalizeWorkspaceRelPath(cwd, filePath) {
  if (!filePath) return "";
  let p = String(filePath).replace(/\\/g, "/");
  if (!cwd) return p.replace(/^\.\//, "");
  const root = String(cwd).replace(/\\/g, "/").replace(/\/$/, "");
  if (p === root) return "";
  if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  return p.replace(/^\.\//, "");
}

function getProjectRootName() {
  const cwd = getActiveProject()?.cwd || "";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "工程";
}

function renderPathBreadcrumbHTML(relPath) {
  const norm = normalizeWorkspaceRelPath(getActiveProject()?.cwd, relPath);
  if (!norm) {
    return `<button type="button" class="crumb crumb-root" data-path="">${escapeHtml(getProjectRootName())}</button>`;
  }
  const parts = norm.split("/").filter(Boolean);
  const chunks = [
    `<button type="button" class="crumb crumb-root" data-path="">${escapeHtml(getProjectRootName())}</button>`,
  ];
  let acc = "";
  parts.forEach((part, i) => {
    acc = i === 0 ? part : `${acc}/${part}`;
    const isLast = i === parts.length - 1;
    chunks.push(`<span class="crumb-sep" aria-hidden="true">›</span>`);
    chunks.push(
      `<button type="button" class="crumb${isLast ? " crumb-current" : ""}" data-path="${escapeHtml(acc)}">${escapeHtml(part)}</button>`,
    );
  });
  return chunks.join("");
}

function updatePathBreadcrumb(relPath) {
  const nav = $("codePathBreadcrumb");
  if (!nav) return;
  const norm = normalizeWorkspaceRelPath(getActiveProject()?.cwd, relPath);
  if (!norm && !state.rightOpen) {
    nav.classList.add("hidden");
    nav.innerHTML = "";
    return;
  }
  nav.classList.remove("hidden");
  nav.innerHTML = renderPathBreadcrumbHTML(norm);
  bindPathCrumbs(nav);
}

function bindPathCrumbs(container) {
  if (!container) return;
  container.querySelectorAll(".crumb").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const path = btn.getAttribute("data-path") ?? "";
      if (!path) {
        setWorkspaceExplorerOpen(true);
        void refreshWorkspaceExplorer();
        return;
      }
      const last = path.split("/").pop() || "";
      const isFile = last.includes(".");
      if (isFile) void openWorkspaceFile(path);
      else {
        state.workspaceExplorerExpanded.add(path);
        setWorkspaceExplorerOpen(true);
        void refreshWorkspaceExplorer().then(() =>
          highlightExplorerFile(state.workspaceActiveFile),
        );
      }
    });
  });
}

function setWorkspaceExplorerOpen(open) {
  state.workspaceExplorerOpen = open;
  const panel = $("workspaceExplorer");
  const btn = $("toggleWorkspaceExplorerBtn");
  panel?.classList.toggle("hidden", !open);
  btn?.setAttribute("aria-expanded", open ? "true" : "false");
  btn?.classList.toggle("active", open);
  if (open) void refreshSideExplorer();
}

function skillRootFromPath(skillPath) {
  const p = String(skillPath || "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

function skillRelPathFromAbs(absPath, root) {
  const norm = String(absPath || "").replace(/\\/g, "/");
  const base = String(root || "").replace(/\\/g, "/").replace(/\/$/, "");
  if (!base) return norm;
  if (norm === base) return "SKILL.md";
  if (norm.startsWith(`${base}/`)) return norm.slice(base.length + 1);
  return norm;
}

function skillAbsPath(relPath) {
  const root = state.skillExplorerRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const rel = String(relPath || ".").replace(/\\/g, "/");
  if (rel === "." || rel === "") return root;
  return `${root}/${rel}`;
}

async function listSkillDir(relPath = ".") {
  const skillPath = state.skillExplorerSkillPath;
  const bridge = getBridge();
  if (!skillPath || !bridge?.listSkillDir) {
    return { rootName: "Skill", path: ".", items: [] };
  }
  return bridge.listSkillDir({ skillPath, path: relPath });
}

async function refreshSideExplorer() {
  if (state.explorerMode === "skill") return refreshSkillExplorer();
  if (state.explorerMode === "plugin") return refreshPluginExplorer();
  return refreshWorkspaceExplorer();
}

async function refreshSkillExplorer() {
  const tree = $("workspaceExplorerTree");
  if (!tree) return;
  if (!state.skillExplorerSkillPath) {
    tree.innerHTML = `<p class="ws-tree-empty">未选择 Skill</p>`;
    return;
  }
  tree.innerHTML = `<p class="ws-tree-loading">加载 Skill 目录…</p>`;
  try {
    const html = await renderSkillTreeNode(".", 0);
    tree.innerHTML = html;
    bindSkillExplorerTree(tree);
    highlightSkillExplorerFile(state.skillActiveFile);
  } catch (e) {
    tree.innerHTML = `<p class="ws-tree-empty">${escapeHtml(String(e))}</p>`;
  }
}

/** Shared renderer for the workspace / skill / plugin explorer trees. */
async function renderExplorerTreeNode(dirPath, depth, opts) {
  const { expanded, listDir, rootLabel } = opts;
  const isRoot = dirPath === ".";
  if (!isRoot && !expanded.has(dirPath)) return "";

  const data = await listDir(dirPath);
  const label = isRoot
    ? escapeHtml(data.rootName || rootLabel)
    : escapeHtml(dirPath.split("/").pop() || dirPath);
  const indent = Math.min(depth, 8);
  const open = isRoot || expanded.has(dirPath);

  let childrenHtml = "";
  if (open) {
    const dirs = data.items.filter((i) => i.type === "dir");
    const files = data.items.filter((i) => i.type === "file");
    const subs = await Promise.all(
      dirs.map((d) =>
        expanded.has(d.path) ? renderExplorerTreeNode(d.path, depth + 1, opts) : "",
      ),
    );
    dirs.forEach((d, i) => {
      const dirOpen = expanded.has(d.path);
      childrenHtml += `
        <div class="ws-node ws-dir" data-path="${escapeHtml(d.path)}" style="--depth:${indent + 1}">
          <button type="button" class="ws-row ws-toggle" data-dir="${escapeHtml(d.path)}" aria-expanded="${dirOpen ? "true" : "false"}">
            ${treeChevron(dirOpen)}
            <span class="ws-icon">${treeFolderIcon(dirOpen)}</span>
            <span class="ws-name">${escapeHtml(d.name)}</span>
          </button>
          ${dirOpen ? `<div class="ws-children">${subs[i]}</div>` : ""}
        </div>`;
    });
    for (const f of files) {
      childrenHtml += `
        <button type="button" class="ws-row ws-file" data-file="${escapeHtml(f.path)}" style="--depth:${indent + 1}">
          <span class="ws-chevron ws-chevron-spacer"></span>
          <span class="ws-icon">${treeFileIcon()}</span>
          <span class="ws-name">${escapeHtml(f.name)}</span>
        </button>`;
    }
  }

  if (isRoot) {
    return `
      <div class="ws-node ws-root" data-path=".">
        <button type="button" class="ws-row ws-toggle ws-root-row" data-dir="." aria-expanded="${open ? "true" : "false"}">
          ${treeChevron(open)}
          <span class="ws-icon">${treeFolderIcon(open)}</span>
          <span class="ws-name">${label}</span>
        </button>
        <div class="ws-children">${childrenHtml}</div>
      </div>`;
  }
  return childrenHtml;
}

function bindExplorerTree(root, { expanded, refresh, openFile }) {
  root.querySelectorAll(".ws-toggle").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const dir = btn.getAttribute("data-dir") ?? ".";
      if (expanded.has(dir)) {
        expanded.delete(dir);
      } else {
        expanded.add(dir);
      }
      await refresh();
    });
  });
  root.querySelectorAll(".ws-file").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const path = btn.getAttribute("data-file");
      if (path) void openFile(path);
    });
  });
}

function highlightExplorerTreeRow(norm, expanded) {
  $("workspaceExplorerTree")?.querySelectorAll(".ws-row").forEach((el) => {
    el.classList.remove("active");
  });
  if (!norm) return;
  $("workspaceExplorerTree")?.querySelectorAll(".ws-file").forEach((btn) => {
    if (btn.getAttribute("data-file") === norm) btn.classList.add("active");
  });
  const parts = norm.split("/");
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = i === 0 ? parts[i] : `${acc}/${parts[i]}`;
    expanded.add(acc);
  }
  expanded.add(".");
}

function renderSkillTreeNode(dirPath, depth) {
  return renderExplorerTreeNode(dirPath, depth, {
    expanded: state.skillExplorerExpanded,
    listDir: listSkillDir,
    rootLabel: "Skill",
  });
}

function bindSkillExplorerTree(root) {
  bindExplorerTree(root, {
    expanded: state.skillExplorerExpanded,
    refresh: refreshSkillExplorer,
    openFile: openSkillBundledFile,
  });
}

function highlightSkillExplorerFile(relPath) {
  highlightExplorerTreeRow(
    String(relPath || "").replace(/\\/g, "/"),
    state.skillExplorerExpanded,
  );
}

async function openSkillBundledFile(relPath) {
  const skill = state.skillsById.get(state.activeSkillId);
  if (!skill?.path || !state.skillExplorerRoot) return;
  const absPath = skillAbsPath(relPath);
  state.skillActiveFile = relPath;
  const bridge = getBridge();
  if (!bridge?.readSkillFile) {
    updateSkillDetailContent(skill, "（无法读取：通信桥未就绪）", absPath);
    return;
  }
  try {
    const res = await bridge.readSkillFile({ path: absPath });
    updateSkillDetailContent(skill, res?.content ?? "", absPath);
    if (state.workspaceExplorerOpen) {
      await refreshSkillExplorer();
      highlightSkillExplorerFile(relPath);
    }
  } catch (e) {
    updateSkillDetailContent(skill, `（加载失败: ${String(e)}）`, absPath);
  }
}

function pluginRelPathFromAbs(absPath, root) {
  return skillRelPathFromAbs(absPath, root);
}

function pluginAbsPath(relPath) {
  const root = state.pluginExplorerRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const rel = String(relPath || ".").replace(/\\/g, "/");
  if (rel === "." || rel === "") return root;
  return `${root}/${rel}`;
}

async function listPluginDir(relPath = ".") {
  const root = state.pluginExplorerRoot;
  const bridge = getBridge();
  if (!root || !bridge?.listPluginDir) {
    return { rootName: "Plugin", path: ".", items: [] };
  }
  return bridge.listPluginDir({ pluginRoot: root, path: relPath });
}

async function refreshPluginExplorer() {
  const tree = $("workspaceExplorerTree");
  if (!tree) return;
  if (!state.pluginExplorerRoot) {
    tree.innerHTML = `<p class="ws-tree-empty">未选择插件</p>`;
    return;
  }
  tree.innerHTML = `<p class="ws-tree-loading">加载插件目录…</p>`;
  try {
    const html = await renderPluginTreeNode(".", 0);
    tree.innerHTML = html;
    bindPluginExplorerTree(tree);
    highlightPluginExplorerFile(state.pluginActiveFile);
  } catch (e) {
    tree.innerHTML = `<p class="ws-tree-empty">${escapeHtml(String(e))}</p>`;
  }
}

function renderPluginTreeNode(dirPath, depth) {
  return renderExplorerTreeNode(dirPath, depth, {
    expanded: state.pluginExplorerExpanded,
    listDir: listPluginDir,
    rootLabel: "Plugin",
  });
}

function bindPluginExplorerTree(root) {
  bindExplorerTree(root, {
    expanded: state.pluginExplorerExpanded,
    refresh: refreshPluginExplorer,
    openFile: openPluginBundledFile,
  });
}

function highlightPluginExplorerFile(relPath) {
  highlightExplorerTreeRow(
    String(relPath || "").replace(/\\/g, "/"),
    state.pluginExplorerExpanded,
  );
}

async function openPluginBundledFile(relPath) {
  const plugin = state.pluginsById.get(state.activePluginId);
  if (!plugin?.root || !state.pluginExplorerRoot) return;
  const absPath = pluginAbsPath(relPath);
  state.pluginActiveFile = relPath;
  const bridge = getBridge();
  if (!bridge?.readSkillFile) {
    updatePluginDetailContent(plugin, "（无法读取：通信桥未就绪）", absPath);
    return;
  }
  try {
    const res = await bridge.readSkillFile({ path: absPath });
    updatePluginDetailContent(plugin, res?.content ?? "", absPath);
    if (state.workspaceExplorerOpen) {
      await refreshPluginExplorer();
      highlightPluginExplorerFile(relPath);
    }
  } catch (e) {
    updatePluginDetailContent(plugin, `（加载失败: ${String(e)}）`, absPath);
  }
}

async function listWorkspaceDir(relPath = ".") {
  const active = getActiveProject();
  if (!active?.cwd || typeof requireBridge().listWorkspaceDir !== "function") {
    return { rootName: getProjectRootName(), path: ".", items: [] };
  }
  return requireBridge().listWorkspaceDir({ cwd: active.cwd, path: relPath });
}

async function refreshWorkspaceExplorer() {
  const tree = $("workspaceExplorerTree");
  const active = getActiveProject();
  if (!tree) return;
  if (!active?.cwd) {
    tree.innerHTML = `<p class="ws-tree-empty">请先配置项目工作目录</p>`;
    return;
  }
  tree.innerHTML = `<p class="ws-tree-loading">加载目录…</p>`;
  try {
    const html = await renderWsTreeNode(".", 0);
    tree.innerHTML = html;
    bindWorkspaceTree(tree);
    highlightExplorerFile(state.workspaceActiveFile);
  } catch (e) {
    tree.innerHTML = `<p class="ws-tree-empty">${escapeHtml(String(e))}</p>`;
  }
}

function renderWsTreeNode(dirPath, depth) {
  return renderExplorerTreeNode(dirPath, depth, {
    expanded: state.workspaceExplorerExpanded,
    listDir: listWorkspaceDir,
    rootLabel: getProjectRootName(),
  });
}

function bindWorkspaceTree(root) {
  bindExplorerTree(root, {
    expanded: state.workspaceExplorerExpanded,
    refresh: refreshWorkspaceExplorer,
    openFile: openWorkspaceFile,
  });
}

function highlightExplorerFile(relPath) {
  highlightExplorerTreeRow(
    normalizeWorkspaceRelPath(getActiveProject()?.cwd, relPath),
    state.workspaceExplorerExpanded,
  );
}

async function openWorkspaceFile(relPath) {
  const active = getActiveProject();
  const path = normalizeWorkspaceRelPath(active?.cwd, relPath);
  if (!path) return;
  state.workspaceActiveFile = path;
  let fullContent = null;
  if (isImageFilePath(path)) {
    fullContent = await readWorkspaceImageDataUrl(path);
  } else if (active?.cwd && typeof requireBridge().readWorkspaceFile === "function") {
    try {
      const res = await requireBridge().readWorkspaceFile({ cwd: active.cwd, path });
      fullContent = res?.content ?? null;
    } catch (e) {
      fullContent = `（无法读取完整文件: ${String(e)}）`;
    }
  }
  const patchDetail = state.runPatches.get(path);
  if (patchDetail) {
    showCodeDetail({ ...patchDetail, filePath: path, fullContent });
  } else {
    showCodeDetail({
      title: path.split("/").pop() || path,
      meta: path,
      filePath: path,
      fullContent,
      content: "",
    });
  }
  if (state.workspaceExplorerOpen) {
    await refreshWorkspaceExplorer();
    highlightExplorerFile(path);
  }
}

function maybeWorkspaceSourceLink(raw) {
  const val = String(raw || "").trim();
  if (!val) return "";
  if (/^(https?:|mailto:|tel:|data:|javascript:)/i.test(val)) return "";
  const noFrag = val.split("#")[0].replace(/^file:\/\//i, "").trim();
  if (!noFrag) return "";
  const normalized = noFrag.replace(/^\/+/, "");
  if (/\.(java|kt|scala|go|py|ts|tsx|js|jsx|rs|cpp|c|h|hpp|cs|rb|php|sql|xml|yml|yaml|toml|md)$/i.test(normalized)) {
    return normalized;
  }
  return "";
}

async function findWorkspaceFileByBasename(name, dir = ".", depth = 0) {
  if (!name || depth > 8) return "";
  const listing = await listWorkspaceDir(dir);
  const items = Array.isArray(listing?.items) ? listing.items : [];
  for (const item of items) {
    if (item?.kind !== "file") continue;
    const path = normalizeWorkspaceRelPath(getActiveProject()?.cwd, item.path || "");
    if (!path) continue;
    if (path.split("/").pop() === name) return path;
  }
  for (const item of items) {
    if (item?.kind !== "dir") continue;
    const sub = await findWorkspaceFileByBasename(name, item.path || "", depth + 1);
    if (sub) return sub;
  }
  return "";
}

async function workspaceFileExists(relPath) {
  const active = getActiveProject();
  const path = normalizeWorkspaceRelPath(active?.cwd, relPath);
  if (!path || !active?.cwd || typeof requireBridge().readWorkspaceFile !== "function") {
    return false;
  }
  try {
    await requireBridge().readWorkspaceFile({ cwd: active.cwd, path });
    return true;
  } catch {
    return false;
  }
}

async function openWorkspaceSourceLinkFromTimeline(anchor) {
  const href = anchor?.getAttribute?.("href") || "";
  const text = anchor?.textContent || "";
  const candidate = maybeWorkspaceSourceLink(href) || maybeWorkspaceSourceLink(text);
  if (!candidate) return false;

  const active = getActiveProject();
  if (!active?.cwd) return false;

  let rel = normalizeWorkspaceRelPath(active.cwd, candidate);
  if (rel && !(await workspaceFileExists(rel))) {
    rel = "";
  }
  if (!rel && !candidate.includes("/")) {
    rel = [...state.runPatches.keys()].find((p) => p.endsWith(`/${candidate}`) || p === candidate) || "";
  }
  if (rel && !(await workspaceFileExists(rel))) {
    rel = "";
  }
  if (!rel && !candidate.includes("/")) {
    rel = await findWorkspaceFileByBasename(candidate);
  }
  if (rel && !(await workspaceFileExists(rel))) {
    rel = "";
  }
  if (!rel) {
    notifyUser(`未在当前项目找到文件: ${candidate}`, "warn");
    return true;
  }
  await openWorkspaceFile(rel);
  return true;
}

function expandExplorerToFile(relPath) {
  const norm = normalizeWorkspaceRelPath(getActiveProject()?.cwd, relPath);
  if (!norm) return;
  state.workspaceExplorerExpanded.add(".");
  const parts = norm.split("/");
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = i === 0 ? parts[i] : `${acc}/${parts[i]}`;
    state.workspaceExplorerExpanded.add(acc);
  }
}

function getFilePreviewApi() {
  const raw = window.ForgeFilePreview;
  if (!raw) return null;
  if (typeof raw.mountPreview === "function") return raw;
  if (raw.default && typeof raw.default.mountPreview === "function") {
    return raw.default;
  }
  return null;
}

function mountFilePreviewPane(pane, content, filePath) {
  if (!pane || pane.dataset.mounted === "1") return;
  if (isImageFilePath(filePath) && String(content || "").startsWith("data:image/")) {
    pane.innerHTML = `<div class="image-file-preview"><img src="${escapeHtml(String(content))}" alt="${escapeHtml(basename(filePath))}" /></div>`;
    pane.dataset.mounted = "1";
    return;
  }
  const preview = getFilePreviewApi();
  if (preview?.mountPreview && filePath) {
    preview.mountPreview(pane, content, filePath);
  } else {
    pane.innerHTML = `<pre class="plain-file-pre">${escapeHtml(String(content ?? ""))}</pre>`;
    if (!preview) {
      pane.insertAdjacentHTML(
        "beforeend",
        `<p class="preview-fallback-hint">语法高亮未加载，请执行 <code>pnpm --filter @forge/desktop run build</code> 后重启。</p>`,
      );
    }
  }
  pane.dataset.mounted = "1";
}

function mountSourcePane(pane, content, filePath) {
  if (!pane || pane.dataset.mounted === "1") return;
  const preview = getFilePreviewApi();
  if (preview?.renderCode && filePath) {
    preview.renderCode(pane, content, filePath);
  } else {
    pane.innerHTML = `<pre class="plain-file-pre">${escapeHtml(String(content ?? ""))}</pre>`;
  }
  pane.dataset.mounted = "1";
}

function bindCodeDetailTabs(root, detail) {
  const filePath = filePathFromDetail(detail);
  const fullContent = detail.fullContent;
  const previewHost = () => root.querySelector('[data-pane="full"] .file-preview-host');
  const sourceHost = () => root.querySelector('[data-pane="source"] .file-source-host');

  root.querySelectorAll(".code-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.getAttribute("data-tab");
      root.querySelectorAll(".code-tab").forEach((t) => t.classList.remove("active"));
      root.querySelectorAll(".code-tab-pane").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      root.querySelector(`[data-pane="${name}"]`)?.classList.add("active");
      if (name === "full") mountFilePreviewPane(previewHost(), fullContent, filePath);
      if (name === "source") mountSourcePane(sourceHost(), fullContent, filePath);
    });
  });

  const defaultTab = root.querySelector(".code-tab.active")?.getAttribute("data-tab");
  if (defaultTab === "full") mountFilePreviewPane(previewHost(), fullContent, filePath);
  if (defaultTab === "source") mountSourcePane(sourceHost(), fullContent, filePath);
}

function findRunPatchDetail(relPath) {
  const cwd = getActiveProject()?.cwd;
  const norm = normalizeWorkspaceRelPath(cwd, relPath);
  if (state.runPatches.has(norm)) return state.runPatches.get(norm);
  if (state.runPatches.has(relPath)) return state.runPatches.get(relPath);
  for (const [k, v] of state.runPatches) {
    if (k === norm || k === relPath) return v;
    if (norm && (k.endsWith(`/${norm}`) || norm.endsWith(k))) return v;
  }
  return null;
}

async function openModifiedFile(relPath, fallbackPatch = null) {
  const active = getActiveProject();
  if (!active?.cwd) {
    pushEvent("请先选择有效项目目录", "warn");
    return;
  }
  const path = normalizeWorkspaceRelPath(active.cwd, relPath) || relPath;
  const detail =
    findRunPatchDetail(relPath) ||
    (fallbackPatch?.unifiedDiff
      ? {
          filePath: path,
          title: `Patch · ${path}`,
          meta: fallbackPatch.applied ? "已应用" : "待应用",
          content: fallbackPatch.unifiedDiff,
          patch: { ...fallbackPatch, path },
        }
      : null);
  openRight(true);
  state.workspaceActiveFile = path;
  expandExplorerToFile(path);
  updatePathBreadcrumb(path);

  let fullContent = null;
  if (typeof requireBridge().readWorkspaceFile === "function") {
    try {
      const res = await requireBridge().readWorkspaceFile({
        cwd: active.cwd,
        path,
      });
      fullContent = res?.content ?? null;
    } catch (e) {
      fullContent = `（无法读取完整文件: ${String(e)}）`;
    }
  }

  if (detail) {
    showCodeDetail({ ...detail, filePath: path, fullContent });
  } else {
    showCodeDetail({
      title: path.split("/").pop() || path,
      meta: path,
      filePath: path,
      fullContent,
      content: "",
    });
  }
  if (state.workspaceExplorerOpen) await refreshWorkspaceExplorer();
}

function decoratePromptWithCheckpoint(promptEl, sha, turnIndex) {
  if (!promptEl || !sha || promptEl.querySelector(".checkpoint-btn")) return;
  const turnAttr = Number.isInteger(turnIndex) ? ` data-checkpoint-turn="${turnIndex}"` : "";
  promptEl.insertAdjacentHTML(
    "beforeend",
    `<button type="button" class="checkpoint-btn" data-checkpoint-sha="${escapeHtml(sha)}"${turnAttr} title="把工作区回滚到本条消息发出之前的状态（可选同时撤回此后的对话）">⟲ 回到此处</button>`,
  );
  const entryId = promptEl.dataset.timelineNodeId;
  if (entryId) {
    recordPromptCheckpoint(
      promptEl.dataset.eventDetailSession || getActiveEventSessionId(),
      entryId,
      sha,
      turnIndex,
    );
  }
}

/** Attach a rewind button (pre-run worktree snapshot) to the turn's user prompt. */
function attachCheckpointToPrompt(sha, turnIndex) {
  const mount = getTimelineMount();
  if (!mount || !sha) return;
  const prompts = mount.querySelectorAll(":scope > .event.user-prompt");
  decoratePromptWithCheckpoint(prompts[prompts.length - 1], sha, turnIndex);
}

/** Modal rewind picker → resolves "code" | "code+chat" | null. */
function showRewindDialog(canTruncate) {
  return new Promise((resolve) => {
    document.querySelector(".rewind-modal")?.remove();
    const modal = document.createElement("div");
    modal.className = "rewind-modal";
    modal.innerHTML = `
      <div class="rewind-mask"></div>
      <div class="rewind-card" role="dialog" aria-modal="true">
        <div class="rewind-title">回到此处</div>
        <p class="rewind-desc">把工作区文件回滚到这条消息发出之前的状态。此后的文件改动会被覆盖，新增的文件会被删除。</p>
        <div class="rewind-actions">
          <button type="button" class="btn secondary" data-rewind="cancel">取消</button>
          ${
            canTruncate
              ? `<button type="button" class="btn secondary" data-rewind="code">仅回滚文件</button>
                 <button type="button" class="btn primary" data-rewind="code+chat">文件 + 撤回对话</button>`
              : `<button type="button" class="btn primary" data-rewind="code">回滚文件</button>`
          }
        </div>
      </div>`;
    const done = (val) => {
      modal.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      }
    };
    modal.querySelector(".rewind-mask").addEventListener("click", () => done(null));
    modal.querySelectorAll("[data-rewind]").forEach((b) => {
      b.addEventListener("click", () => {
        const v = b.getAttribute("data-rewind");
        done(v === "cancel" ? null : v);
      });
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(modal);
  });
}

async function handleCheckpointRestore(sha, turnIndex) {
  const active = getActiveProject();
  if (!sha || !active?.cwd) return;
  const viewingSid = sessionRuns?.getViewingSessionId?.() || "";
  if (viewingSid && state.runningSessions.has(viewingSid)) {
    notifyUser("当前会话执行中，请先停止再回滚", "warn");
    return;
  }
  const canTruncate = Boolean(viewingSid) && Number.isInteger(turnIndex);
  const choice = await showRewindDialog(canTruncate);
  if (!choice) return;
  const truncate = choice === "code+chat";
  try {
    const res = await requireBridge().restoreCheckpoint({
      cwd: active.cwd,
      sha,
      sessionId: truncate ? viewingSid : undefined,
      turnIndex: truncate ? turnIndex : undefined,
      truncateConversation: truncate,
    });
    if (res?.ok === false) {
      notifyUser(`回滚失败: ${res?.message ?? "未知错误"}`, "err");
      return;
    }
    const fileNote = res?.removedCount
      ? `（移除 ${res.removedCount} 个此后新增的文件）`
      : "";
    notifyUser(`已回滚工作区到检查点${fileNote}`, "status");
    if (truncate && res?.truncatedMessages) {
      // Conversation truncated server-side — drop stale caches (or the old
      // conclusion/patches get re-rendered onto the rebuilt timeline) and
      // rebuild from the daemon, which is now the source of truth.
      state.externalSessionVersionSeen.delete(viewingSid);
      forgetSessionRunCaches(viewingSid);
      await restoreSessionTimeline(viewingSid, state.viewSwitchGeneration, {
        scrollToBottom: true,
      });
    }
    if (state.workspaceExplorerOpen) void refreshWorkspaceExplorer();
    renderComposerGitBranchSelect?.();
  } catch (e) {
    notifyUser(`回滚失败: ${String(e)}`, "err");
  }
}

/** Pinned task-plan card driven by update_plan or dispatch_plan; latest call wins. */
function renderPlanCard(items, title = "任务清单") {
  const mount = getTimelineMount();
  if (!mount) return;
  let card = mount.querySelector(":scope > .plan-card:not(.dispatch-timeline-card)");
  if (!items.length) {
    card?.remove();
    return;
  }
  if (!card) {
    card = document.createElement("div");
    card.className = "plan-card";
    mount.appendChild(card);
  }
  placePlanCardOnMount(card, mount);
  const doneCount = items.filter((i) => i.status === "done").length;
  const rows = items
    .map((i) => {
      const cls =
        i.status === "done"
          ? " is-done"
          : i.status === "in_progress"
            ? " is-active"
            : "";
      const mark = i.status === "done" ? "✓" : i.status === "in_progress" ? "▸" : "○";
      return `<li class="plan-item${cls}"><span class="plan-mark" aria-hidden="true">${mark}</span><span class="plan-text">${escapeHtml(i.text)}</span></li>`;
    })
    .join("");
  card.innerHTML = `
    <div class="plan-card-head">${escapeHtml(title)}<span class="plan-card-progress">${doneCount}/${items.length}</span></div>
    <ul class="plan-list">${rows}</ul>`;
  const sid = getActiveEventSessionId();
  if (sid) recordPlanCardEntry(sid, title, items);
}

function renderIntentPlanCard(ev) {
  const constraints = Array.isArray(ev.constraints) ? ev.constraints : [];
  const uncertainties = Array.isArray(ev.uncertainties) ? ev.uncertainties : [];
  const lines = [
    `目标：${ev.summary || "执行用户请求"}`,
    `流程：${formatIntentRunKind(ev.runKind)} · ${ev.source === "model" ? "模型判断" : "规则兜底"}`,
    ev.executionReason ? `原因：${ev.executionReason}` : "",
    ...constraints.map((item) => `约束：${item}`),
    ...uncertainties.map((item) => `不确定：${item}`),
  ].filter(Boolean);
  pushEvent("模型理解", "skill-hit", {
    title: "模型理解",
    meta: formatIntentRunKind(ev.runKind),
    content: lines.join("\n"),
  });
}

function formatIntentRunKind(kind) {
  if (kind === "talent_dispatch") return "多人才派活";
  if (kind === "talent_foreground") return "单人才接管";
  return "Coordinator 直接执行";
}

function dispatchPlanToPlanItems(ev) {
  const items = [];
  for (const wave of ev.waves || []) {
    for (const step of wave.steps || []) {
      if (step.kind === "coordinator") continue;
      const prefix = step.displayName ? `${step.displayName}` : step.mention || step.kind;
      items.push({
        text: `${prefix} · ${step.task}`,
        status: step.status || "pending",
      });
    }
  }
  return items;
}

function getDispatchTimelineState(sessionId, create = false) {
  const sid = sessionId || getActiveEventSessionId() || "_anonymous";
  if (!state.dispatchTimelineBySession.has(sid) && create) {
    state.dispatchTimelineBySession.set(sid, {
      sessionId: sid,
      intent: "",
      executionMode: "parallel",
      waves: [],
      talents: new Map(),
      coordinatorStatus: "",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return state.dispatchTimelineBySession.get(sid) || null;
}

function getDispatchTalentRecord(dispatchState, talent) {
  if (!dispatchState || !talent?.mention) return null;
  const key = normalizeTalentMention(talent.mention);
  if (!key) return null;
  if (!dispatchState.talents.has(key)) {
    dispatchState.talents.set(key, {
      mention: key,
      displayName: talent.displayName || talent.mention || key,
      role: talent.role || "",
      emoji: talent.emoji || "",
      avatar: talent.avatar || "",
      task: "",
      status: "pending",
      waveIndex: null,
      waveTotal: null,
      summary: "",
      startedAt: null,
      endedAt: null,
    });
  }
  const record = dispatchState.talents.get(key);
  record.displayName = talent.displayName || record.displayName;
  record.role = talent.role || record.role;
  record.emoji = talent.emoji || record.emoji;
  record.avatar = talent.avatar || record.avatar;
  return record;
}

function isSubagentFailureSummary(summary) {
  const text = String(summary || "").trim();
  if (!text) return false;
  if (/^子代理失败[:：]/u.test(text)) return true;
  const body = text.includes(": ")
    ? text.slice(text.indexOf(": ") + 2).trim()
    : text;
  return /^失败\s*[—\-–]/u.test(body);
}

function reduceDispatchTimelineEvent(ev) {
  const sid = ev.sessionId || getActiveEventSessionId();
  const isDispatchEvent =
    ev.type === "dispatch_plan" ||
    ev.type === "dispatch_wave_start" ||
    (ev.type === "status" && ev.message?.includes("团队负责人正在汇总")) ||
    Boolean(ev.talent?.mention);
  if (!isDispatchEvent) return null;
  const dispatchState = getDispatchTimelineState(
    sid,
    ev.type === "dispatch_plan",
  );
  if (!dispatchState) return null;
  dispatchState.updatedAt = Date.now();

  if (ev.type === "dispatch_plan") {
    dispatchState.intent = ev.intent || "";
    dispatchState.executionMode = ev.executionMode || "parallel";
    dispatchState.waves = Array.isArray(ev.waves) ? ev.waves : [];
    dispatchState.talents = new Map();
    dispatchState.coordinatorStatus = "";
    dispatchState.currentWave = null;
    dispatchState.startedAt = Date.now();
    for (const wave of dispatchState.waves) {
      for (const step of wave.steps || []) {
        if (step.kind === "coordinator") continue;
        const mention = normalizeTalentMention(step.mention || step.id || "");
        if (!mention) continue;
        const talent = {
          mention,
          displayName: step.displayName || step.mention || mention,
          role: step.role || "",
          emoji: step.emoji || "",
          avatar: step.avatar || "",
        };
        const record = getDispatchTalentRecord(dispatchState, talent);
        if (!record) continue;
        record.task = step.task || record.task || "";
        record.status = step.status || record.status || "pending";
        record.waveIndex = wave.waveIndex ?? record.waveIndex;
        record.waveTotal = wave.waveTotal ?? record.waveTotal;
      }
    }
    return dispatchState;
  }

  if (ev.type === "dispatch_wave_start") {
    dispatchState.coordinatorStatus = `第 ${ev.waveIndex}/${ev.waveTotal} 波次已开始`;
    dispatchState.currentWave = {
      waveIndex: ev.waveIndex,
      waveTotal: ev.waveTotal,
      executionMode: ev.executionMode,
      talentLabels: ev.talentLabels || [],
    };
    return dispatchState;
  }

  if (ev.type === "talent_active") {
    const record = getDispatchTalentRecord(dispatchState, ev.talent);
    if (record) record.status = ev.mode === "foreground" ? "foreground" : "active";
    return dispatchState;
  }

  if (ev.type === "subagent_start") {
    const record = getDispatchTalentRecord(dispatchState, ev.talent);
    if (record) {
      const taskText = String(ev.task || "");
      record.task = taskText.includes(": ")
        ? taskText.slice(taskText.indexOf(": ") + 2)
        : taskText || record.task;
      record.status = "active";
      record.startedAt = record.startedAt || Date.now();
      if (ev.dispatchWave) {
        record.waveIndex = ev.dispatchWave.index;
        record.waveTotal = ev.dispatchWave.total;
      }
    }
    return dispatchState;
  }

  if (ev.type === "subagent_end") {
    const record = getDispatchTalentRecord(dispatchState, ev.talent);
    if (record) {
      const summary = String(ev.summary || "");
      record.summary =
        ev.talent && summary.includes(": ")
          ? summary.slice(summary.indexOf(": ") + 2)
          : summary;
      record.status = isSubagentFailureSummary(summary) ? "error" : "done";
      record.endedAt = Date.now();
    }
    return dispatchState;
  }

  if (ev.type === "status" && ev.message?.includes("团队负责人正在汇总")) {
    dispatchState.coordinatorStatus = "团队负责人正在汇总";
    return dispatchState;
  }

  return null;
}

function renderDispatchTimelineCard(dispatchState) {
  if (!dispatchState) return;
  const mount = getTimelineMount();
  if (!mount) return;
  let card = mount.querySelector(
    `:scope > .dispatch-timeline-card[data-dispatch-session="${cssEscape(dispatchState.sessionId)}"]`,
  );
  if (!card) {
    card = document.createElement("section");
    card.className = "plan-card dispatch-timeline-card";
    card.dataset.dispatchSession = dispatchState.sessionId;
    mount.appendChild(card);
  }
  const prompt = mount.querySelector(":scope > .event.user-prompt:last-of-type");
  if (prompt && card.parentElement === mount) {
    prompt.insertAdjacentElement("afterend", card);
  } else if (state.runActivityEl && state.runActivityEl.parentElement === mount) {
    mount.insertBefore(card, state.runActivityEl);
  }

  const talents = [...dispatchState.talents.values()];
  const doneCount = talents.filter((talent) => talent.status === "done").length;
  const modeLabel = dispatchState.executionMode === "serial" ? "串行" : "并行";
  const waveCount = dispatchState.waves.length || dispatchState.currentWave?.waveTotal || 1;
  const rows = talents
    .map((talent) => renderDispatchTalentRow(talent))
    .join("");
  const coordinator = dispatchState.coordinatorStatus
    ? `<div class="dispatch-coordinator">${escapeHtml(dispatchState.coordinatorStatus)}</div>`
    : "";
  card.innerHTML = `
    <div class="plan-card-head">
      团队派活
      <span class="plan-card-progress">${doneCount}/${talents.length}</span>
    </div>
    <div class="dispatch-meta">${escapeHtml(
      [dispatchState.intent || "多人派活", `${modeLabel} · ${waveCount} 个波次`]
        .filter(Boolean)
        .join(" · "),
    )}</div>
    <ul class="plan-list dispatch-talent-list">${rows}</ul>
    ${coordinator}`;
  const sid = dispatchState.sessionId;
  if (sid) {
    recordDispatchCardEntry(sid);
    syncTimelineCacheForSession(sid);
  }
}

function renderDispatchTalentRow(talent) {
  const status = talent.status || "pending";
  const cls =
    status === "done"
      ? " is-done"
      : status === "active" || status === "foreground"
        ? " is-active"
        : status === "error"
          ? " is-error"
          : "";
  const mark =
    status === "done"
      ? "✓"
      : status === "active" || status === "foreground"
        ? "▸"
        : status === "error"
          ? "!"
          : "○";
  const emoji = talent.emoji || "🧑";
  const wave =
    talent.waveIndex && talent.waveTotal && talent.waveTotal > 1
      ? `波次 ${talent.waveIndex}/${talent.waveTotal} · `
      : "";
  const task = talent.task ? ` · ${truncateToolSummary(talent.task, 96)}` : "";
  const summary = talent.summary
    ? `<div class="dispatch-talent-summary">${escapeHtml(truncateToolSummary(talent.summary, 140))}</div>`
    : "";
  return `
    <li class="plan-item dispatch-talent-item${cls}">
      <span class="plan-mark" aria-hidden="true">${mark}</span>
      <span class="plan-text">
        <span class="dispatch-talent-title">${escapeHtml(`${emoji} ${talent.displayName}`)}</span>
        <span class="dispatch-talent-meta">${escapeHtml(`${wave}${talent.role || "人才"}${task}`)}</span>
        ${summary}
      </span>
    </li>`;
}

// ── Reflection gate timeline card ───────────────────────────────────────────
const REFLECTION_DIMENSION_LABELS = {
  completeness: "完整性",
  grounding: "接地性",
  consistency: "一致性",
  instruction: "指令遵从",
};

function getReflectionState(sessionId, create = false) {
  const sid = sessionId || getActiveEventSessionId() || "_anonymous";
  if (!state.reflectionBySession.has(sid) && create) {
    state.reflectionBySession.set(sid, {
      sessionId: sid,
      round: 0,
      status: "reviewing",
      issues: [],
      updatedAt: Date.now(),
    });
  }
  return state.reflectionBySession.get(sid) || null;
}

function reduceReflectionEvent(ev) {
  const sid = ev.sessionId || getActiveEventSessionId();
  if (ev.type === "reflection_start") {
    const s = getReflectionState(sid, true);
    if (!s) return null;
    s.round = ev.round || s.round + 1;
    s.status = "reviewing";
    s.issues = [];
    s.updatedAt = Date.now();
    return s;
  }
  if (ev.type === "reflection_verdict") {
    const s = getReflectionState(sid, true);
    if (!s) return null;
    s.round = ev.round || s.round;
    s.verdict = ev.verdict;
    s.reworking = Boolean(ev.reworking);
    // Status reflects what actually happened: only a real rework shows 需返工;
    // a revise with sub-gate (minor-only) issues is released with advisories.
    s.status = ev.reworking ? "revise" : "pass";
    s.issues = Array.isArray(ev.issues) ? ev.issues : [];
    s.updatedAt = Date.now();
    return s;
  }
  return null;
}

function applyReflectionEvent(ev) {
  const s = reduceReflectionEvent(ev);
  if (s) renderReflectionCard(s);
  return s;
}

/** Run concluded — if a rework round was in flight, close the loop on the card. */
function markReflectionDelivered(sessionId) {
  const s = getReflectionState(sessionId, false);
  if (!s || s.status !== "revise" || s.delivered) return;
  s.delivered = true;
  s.updatedAt = Date.now();
  renderReflectionCard(s);
}

function renderReflectionCard(reflectionState) {
  if (!reflectionState) return;
  const mount = getTimelineMount();
  if (!mount) return;
  let card = mount.querySelector(
    `:scope > .reflection-card[data-reflection-session="${cssEscape(reflectionState.sessionId)}"]`,
  );
  if (!card) {
    card = document.createElement("section");
    card.className = "plan-card reflection-card";
    card.dataset.reflectionSession = reflectionState.sessionId;
    mount.appendChild(card);
  }
  // Reflection happens at finalization — keep it just above the conclusion.
  const conclusion = mount.querySelector(":scope > .run-conclusion");
  if (conclusion && card.parentElement === mount) {
    conclusion.insertAdjacentElement("beforebegin", card);
  }
  const status = reflectionState.status;
  const issues = reflectionState.issues || [];
  let statusLabel;
  let statusCls;
  let hint = "";
  if (status === "revise") {
    if (reflectionState.delivered) {
      // Rework round finished and the corrected conclusion was delivered below.
      statusLabel = "↻ 已返工并交付修正结论";
      statusCls = " is-done";
      hint = "返工补做的核对/验证步骤在上方「已处理」活动折叠内，修正后的结论见下方。";
    } else {
      statusLabel = "▸ 已退回返工，重新作答中…";
      statusCls = " is-active";
      hint = "针对下列阻断问题重新执行中，补做的步骤会进入上方「已处理」活动。";
    }
  } else if (status === "pass") {
    statusLabel = issues.length ? `✓ 通过 · ${issues.length} 条次要建议` : "✓ 通过";
    statusCls = " is-done";
  } else {
    statusLabel = "审校中…";
    statusCls = "";
  }
  const rows = issues.map((issue) => renderReflectionIssueRow(issue)).join("");
  card.innerHTML = `
    <div class="plan-card-head">
      反思校验
      <span class="plan-card-progress">第 ${reflectionState.round || 1} 轮</span>
    </div>
    <div class="reflection-status${statusCls}">${escapeHtml(statusLabel)}</div>
    ${hint ? `<div class="reflection-hint">${escapeHtml(hint)}</div>` : ""}
    ${issues.length ? `<ul class="plan-list reflection-issue-list">${rows}</ul>` : ""}`;
  const sid = reflectionState.sessionId;
  if (sid) {
    recordReflectionCardEntry(sid);
    syncTimelineCacheForSession(sid);
  }
}

function renderReflectionIssueRow(issue) {
  const dim = REFLECTION_DIMENSION_LABELS[issue.dimension] || issue.dimension || "";
  const blocker = issue.severity === "blocker";
  const sev = blocker ? "阻断" : "次要";
  const detail = issue.detail
    ? `<span class="reflection-issue-detail">${escapeHtml(truncateToolSummary(issue.detail, 160))}</span>`
    : "";
  const action = issue.suggestedAction
    ? `<div class="reflection-issue-action">→ ${escapeHtml(truncateToolSummary(issue.suggestedAction, 160))}</div>`
    : "";
  return `
    <li class="plan-item reflection-issue-item${blocker ? " is-error" : ""}">
      <span class="plan-mark" aria-hidden="true">${blocker ? "!" : "·"}</span>
      <span class="plan-text">
        <span class="reflection-issue-title">${escapeHtml(`${dim} · ${sev}`)}</span>
        ${detail}
        ${action}
      </span>
    </li>`;
}

/** Live-streamed narrative lives in 结论; remove the buffer copy from the activity fold/stream.
 *  Step narratives (.step-narrative) and restored assistant blocks must survive. */
function stripNarrativeFromActivity() {
  const mount = getTimelineMount();
  if (!mount) return;
  mount
    .querySelectorAll(
      ".run-activity-body .assistant-block.narrative-buffer, .run-activity-body .run-conclusion-live, .run-activity-body .run-conclusion, .run-activity-stream .assistant-block.narrative-buffer, .run-activity-stream .run-conclusion-live, .run-activity-stream .run-conclusion",
    )
    .forEach((el) => {
      const holder = el.closest(".event");
      if (
        holder &&
        !holder.classList.contains("run-conclusion-live") &&
        !holder.classList.contains("run-conclusion")
      ) {
        holder.remove();
      } else {
        (holder?.classList?.contains("run-conclusion-live") ||
        holder?.classList?.contains("run-conclusion")
          ? holder
          : el
        ).remove();
      }
    });
  state.streamTextNode = null;
  state.streamTextBuffer = "";
  state.streamTextRaw = "";
}

function normalizeConclusionCopyText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicateConclusionCopy(candidate, finalText) {
  const a = normalizeConclusionCopyText(candidate);
  const b = normalizeConclusionCopyText(finalText);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function pruneRunActivityConclusionCopies(finalText, root = getTimelineMount()) {
  if (!root || !finalText) return;
  root
    .querySelectorAll(
      ":scope > details.run-activity .run-conclusion-live, :scope > details.run-activity .run-conclusion, :scope > details.run-activity .assistant-block.narrative-buffer, :scope > .run-activity-stream .run-conclusion-live, :scope > .run-activity-stream .run-conclusion, :scope > .run-activity-stream .assistant-block.narrative-buffer",
    )
    .forEach((el) => {
      const holder = el.closest(".event") || el;
      holder.remove();
    });
  root
    .querySelectorAll(
      ":scope > details.run-activity .step-narrative, :scope > details.run-activity .codex-commentary, :scope > .run-activity-stream .step-narrative, :scope > .run-activity-stream .codex-commentary",
    )
    .forEach((el) => {
      const text = domLineTextContent(el);
      if (isDuplicateConclusionCopy(text, finalText)) el.remove();
    });
}

function pruneStructuredRunActivityConclusionCopies(sessionId, finalText) {
  if (!sessionId || !finalText) return;
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return;
  let changed = false;
  for (const entry of ensureTimelineEntries(timelineState)) {
    if (entry.type !== "run_activity" || !Array.isArray(entry.children)) continue;
    const before = entry.children.length;
    entry.children = entry.children.filter((child) => {
      const cls = String(child.className || "");
      if (
        child.type === "event" &&
        (/\brun-conclusion-live\b/.test(cls) || /\brun-conclusion\b/.test(cls))
      ) {
        return false;
      }
      if (
        (child.type === "step_narrative" || child.type === "codex_commentary") &&
        isDuplicateConclusionCopy(child.text, finalText)
      ) {
        return false;
      }
      return true;
    });
    if (entry.children.length !== before) changed = true;
  }
  if (changed) touchTimelineState(sessionId);
}

function renderConclusionMarkdown(host, text) {
  const preview = getFilePreviewApi();
  if (preview?.renderMarkdown) {
    preview.renderMarkdown(host, text);
  } else {
    host.innerHTML = `<div class="md-preview"><p>${escapeHtml(text)}</p></div>`;
  }
  hydrateMarkdownLocalImages(host);
  decorateMarkdownCodeBlocks(host);
}

async function readWorkspaceImageDataUrl(path) {
  const active = getActiveProject();
  const bridge = getBridge();
  if (!active?.cwd || typeof bridge?.readWorkspaceImage !== "function") return null;
  const relPath = normalizeWorkspaceRelPath(active.cwd, path) || path;
  try {
    const res = await bridge.readWorkspaceImage({ cwd: active.cwd, path: relPath });
    return res?.dataUrl || null;
  } catch {
    return null;
  }
}

function hydrateGeneratedImages(root) {
  root?.querySelectorAll?.("[data-image-path]").forEach((slot) => {
    const path = slot.getAttribute("data-image-path") || "";
    if (!isImageFilePath(path) || slot.dataset.loaded === "1") return;
    slot.dataset.loaded = "1";
    void readWorkspaceImageDataUrl(path).then((dataUrl) => {
      if (!dataUrl) {
        slot.textContent = "无法预览";
        slot.classList.add("is-missing");
        return;
      }
      slot.innerHTML = `<img src="${escapeHtml(dataUrl)}" alt="${escapeHtml(basename(path))}" />`;
    });
  });
  root?.querySelectorAll?.("[data-generated-image-path]").forEach((card) => {
    if (card.dataset.bound === "1") return;
    card.dataset.bound = "1";
    card.addEventListener("click", () => {
      const path = card.getAttribute("data-generated-image-path") || "";
      if (path) void openWorkspaceFile(path);
    });
  });
}

function hydrateMarkdownLocalImages(host) {
  host.querySelectorAll?.(".md-preview img").forEach((img) => {
    const raw = img.getAttribute("src") || "";
    if (!raw || /^(https?:|data:|blob:)/i.test(raw) || !isImageFilePath(raw)) return;
    void readWorkspaceImageDataUrl(raw).then((dataUrl) => {
      if (dataUrl) img.setAttribute("src", dataUrl);
    });
  });
}

/** Wrap each rendered <pre> with a copy button. Markup survives innerHTML repaints; clicks are delegated. */
function decorateMarkdownCodeBlocks(host) {
  host.querySelectorAll("pre").forEach((pre) => {
    if (pre.closest(".md-code-block")) return;
    const wrap = document.createElement("div");
    wrap.className = "md-code-block";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    wrap.insertAdjacentHTML(
      "afterbegin",
      `<button type="button" class="md-code-copy" data-copy-action="code" title="复制代码">复制</button>`,
    );
  });
}

async function handleTimelineCopyClick(btn) {
  const action = btn.getAttribute("data-copy-action");
  let text = "";
  if (action === "code") {
    text = btn.closest(".md-code-block")?.querySelector("pre")?.textContent ?? "";
  } else if (action === "conclusion") {
    text =
      btn
        .closest(".run-conclusion-inner")
        ?.querySelector(".run-conclusion-md")?.textContent ?? "";
  }
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => {
      btn.textContent = prev;
    }, 1200);
  } catch (e) {
    notifyUser(`复制失败: ${String(e)}`, "warn");
  }
}

function hoistRunActivityOutOfConclusion(root = getTimelineMount()) {
  if (!root) return;
  root.querySelectorAll(":scope > .run-conclusion").forEach((conclusion) => {
    conclusion.querySelectorAll("details.run-activity").forEach((activity) => {
      conclusion.insertAdjacentElement("afterend", activity);
    });
  });
}

function renderRunConclusion(finalText, explicitSessionId) {
  const sid =
    explicitSessionId ||
    state.eventRouteSessionId ||
    sessionRuns?.getViewingSessionId() ||
    state.liveRunSessionId ||
    "";
  if (sid && state.conclusionDomRenderedThisTurn.has(sid)) {
    forgeSessionLog("conclusion:skip-duplicate", {
      sid,
      explicitSessionId,
      liveRunSessionId: state.liveRunSessionId,
      eventRouteSessionId: state.eventRouteSessionId,
    });
    return;
  }
  state.runConclusionRendered = true;
  flushStreamText();
  const streamedText = String(state.streamTextRaw || "").trim();
  const finalCandidate = String(finalText || state.runFinalText || "").trim();
  finishStreamTextSegment({
    skipPersist: Boolean(finalCandidate && isDuplicateConclusionCopy(streamedText, finalCandidate)),
  });
  const hadToolSteps = (state.runActivityStats?.tools ?? 0) > 0;
  const concludingActivity = resolveTurnRunActivityForConclusion(getTimelineMount());
  stripNarrativeFromActivity();
  hoistOrphanNodesIntoRunActivity();
  repairTimelineDomStructure(getTimelineMount());
  if (sid) syncStructuredTimelineFromDom(sid);
  finalizeRunActivity();

  let text = finalCandidate;
  // Intermediate step narration is persisted inside 已处理 at each segment boundary.
  // Conclusion is only the final user-facing answer from the done event.
  if (!text && streamedText && !hadToolSteps) text = streamedText;
  text = dedupeConclusionAgainstStepNarratives(text, sid, getTimelineMount(), concludingActivity);
  if (text) {
    state.runFinalText = text;
    if (sid) state.runFinalTextBySession.set(sid, text);
  }
  recordGeneratedImagePathsFromText(text);
  pruneRunActivityConclusionCopies(text, getTimelineMount());
  if (sid) pruneStructuredRunActivityConclusionCopies(sid, text);

  if (sid) {
    const patches = state.runPatchesBySession.get(sid);
    if (patches?.size) state.runPatches = new Map(patches);
  }

  if (!state.runPatches.size && hadToolSteps) {
    void reconcileRunPatchesFromWorkspace(sid).then(() => {
      if (!state.runPatches.size) return;
      const updatedFiles = [...state.runPatches.keys()];
      const wrap = container?.querySelector(".run-conclusion");
      if (!wrap) return;
      const existingFilesSection = wrap.querySelector(".modified-files-list");
      if (existingFilesSection) return;
      const inner = wrap.querySelector(".run-conclusion-inner");
      if (!inner) return;
      const filesHtml = buildRunConclusionFilesHtml(updatedFiles, state.runPatches);
      if (!filesHtml) return;
      inner.insertAdjacentHTML("beforeend",
        `<div class="run-conclusion-heading">${updatedFiles.length} 个文件已修改</div>
         <div class="modified-files-list">${filesHtml}</div>`);
      if (sid) saveRunPatchesForSession(sid);
    });
  }

  const files = [...state.runPatches.keys()];
  const container = getTimelineMount();
  if (!container) {
    forgeSessionLog("conclusion:skip-no-mount", { sid, explicitSessionId });
    return;
  }
  if (sid) {
    state.conclusionDomRenderedThisTurn.add(sid);
    state.runConclusionBySession.set(sid, true);
  }

  const turnActivity = resolveTurnRunActivityForConclusion(container);
  if (turnHasConclusionAfter(turnActivity)) {
    forgeSessionLog("conclusion:skip-turn-existing", { sid, explicitSessionId });
    return;
  }

  const wrap = document.createElement("div");
  removeRunFilesChangedBars(container);
  populateRunConclusionElement(wrap, state.runFinalText, files, state.runPatches);
  placeRunConclusionOnMount(wrap, container);
  hoistRunActivityOutOfConclusion(container);
  pruneRunActivityConclusionCopies(state.runFinalText, container);
  scheduleRunViewScroll();
  if (sid) {
    pruneStructuredRunActivityConclusionCopies(sid, state.runFinalText);
    recordConclusionEntry(sid, state.runFinalText);
    syncTimelineCacheForSession(sid);
    syncStructuredTimelineFromDom(sid);
  }
  forgeSessionLog("conclusion:rendered", {
    sid,
    explicitSessionId,
    hasText: Boolean(state.runFinalText),
    patchCount: files.length,
    offscreen: Boolean(state.offscreenTimelineEl),
  });
  void reconcileRunPatchesFromWorkspace(
    sid || state.eventRouteSessionId || state.liveRunSessionId || "",
  ).then(() => {
    if (sid) {
      saveRunPatchesForSession(sid);
      syncTimelineCacheForSession(sid);
      syncStructuredTimelineFromDom(sid);
    }
  });
}

function prepareViewingSessionRun(sessionId) {
  ensureLiveRunSession(sessionId);
  state.activityFollowBottom = true;
  state.timelineFollowBottom = true;
  resetRunArtifacts();
  slashPaletteApi?.close?.();
  fileMentionApi?.close?.();
}

function setRunState(running) {
  if (running) {
    const sid = sessionRuns?.getViewingSessionId();
    if (sid) prepareViewingSessionRun(sid);
  }
  sessionRuns?.syncComposerRunChrome();
}

function clampPanelWidth(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadPanelWidths() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PANEL_WIDTHS_KEY) || "{}");
    if (typeof raw.left === "number") {
      state.panelLeftWidth = clampPanelWidth(raw.left, PANEL_MIN_LEFT, PANEL_MAX_LEFT);
    }
    if (typeof raw.right === "number") {
      state.panelRightWidth = clampPanelWidth(raw.right, PANEL_MIN_RIGHT, PANEL_MAX_RIGHT);
    }
  } catch {
    /* ignore */
  }
}

function savePanelWidths() {
  localStorage.setItem(
    LS_PANEL_WIDTHS_KEY,
    JSON.stringify({
      left: state.panelLeftWidth,
      right: state.panelRightWidth,
    }),
  );
}

function applyPanelWidths() {
  const shell = $("appShell");
  if (!shell) return;
  shell.style.setProperty("--panel-left-width", `${state.panelLeftWidth}px`);
  const rightPx = state.rightOpen ? state.panelRightWidth : 0;
  shell.style.setProperty("--panel-right-width", `${rightPx}px`);
  $("resizeHandleRight")?.classList.toggle("hidden", !state.rightOpen);
}

function bindPanelResize() {
  const bindHandle = (handle, side) => {
    if (!handle) return;
    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.classList.add("is-active");
      document.body.classList.add("is-resizing");
      const startX = e.clientX;
      const startLeft = state.panelLeftWidth;
      const startRight = state.panelRightWidth;

      const onPointerMove = (ev) => {
        const dx = ev.clientX - startX;
        if (side === "left") {
          state.panelLeftWidth = clampPanelWidth(
            startLeft + dx,
            PANEL_MIN_LEFT,
            PANEL_MAX_LEFT,
          );
        } else if (state.rightOpen) {
          state.panelRightWidth = clampPanelWidth(
            startRight - dx,
            PANEL_MIN_RIGHT,
            PANEL_MAX_RIGHT,
          );
        }
        applyPanelWidths();
      };

      const onPointerUp = () => {
        handle.classList.remove("is-active");
        document.body.classList.remove("is-resizing");
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        savePanelWidths();
      };

      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const delta = e.key === "ArrowLeft" ? -12 : 12;
      if (side === "left") {
        state.panelLeftWidth = clampPanelWidth(
          state.panelLeftWidth + delta,
          PANEL_MIN_LEFT,
          PANEL_MAX_LEFT,
        );
      } else if (state.rightOpen) {
        state.panelRightWidth = clampPanelWidth(
          state.panelRightWidth - delta,
          PANEL_MIN_RIGHT,
          PANEL_MAX_RIGHT,
        );
      }
      applyPanelWidths();
      savePanelWidths();
    });
  };

  bindHandle($("resizeHandleLeft"), "left");
  bindHandle($("resizeHandleRight"), "right");
}

/** Show exactly one of the right-region panels (code vs terminal), or neither. */
function applyRightMode() {
  const showTerminal = state.rightOpen && state.rightMode === "terminal";
  const showCode = state.rightOpen && state.rightMode === "code";
  $("rightPanel")?.classList.toggle("collapsed", !showCode);
  $("terminalPanel")?.classList.toggle("collapsed", !showTerminal);
  $("terminalPanel")?.setAttribute("aria-hidden", showTerminal ? "false" : "true");
  $("terminalToggleBtn")?.classList.toggle("active", showTerminal);
  $("toggleRightBtn")?.classList.toggle("active", showCode);
}

function openRight(open, mode = "code") {
  state.rightOpen = open;
  if (open) state.rightMode = mode;
  if (open && state.panelRightWidth < PANEL_MIN_RIGHT) {
    state.panelRightWidth = PANEL_DEFAULT_RIGHT;
  }
  applyRightMode();
  applyPanelWidths();
  if (open && state.rightMode === "terminal") {
    window.forgeTerminalPanel?.ensureStarted?.();
    requestAnimationFrame(() => window.forgeTerminalPanel?.refit?.());
  }
}

/** True when the event target is inside the right code panel or its chrome. */
function isRightCodePanelChrome(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "#rightPanel, #resizeHandleRight, #toggleRightBtn, #toggleWorkspaceExplorerBtn",
    ),
  );
}

/**
 * Clicks that intentionally open/replace the code detail panel.
 * Excluded from outside-close so we don't collapse then re-open in one gesture.
 */
function isRightCodePanelOpenTrigger(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      [
        ".plugin-card[data-plugin-id]",
        ".skill-card[data-skill-id]",
        ".talent-market-card[data-template-id]",
        ".talent-roster-card[data-talent-card]",
        "[data-talent-sidebar]",
        ".modified-file-btn",
        ".event.clickable",
        ".store-card",
      ].join(", "),
    ),
  );
}

/** Close the code detail side panel when the user clicks elsewhere. */
function bindRightPanelOutsideClose() {
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!state.rightOpen || state.rightMode !== "code") return;
      if (e.button != null && e.button !== 0) return;
      const t = e.target;
      if (isRightCodePanelChrome(t) || isRightCodePanelOpenTrigger(t)) return;
      openRight(false);
    },
    true,
  );
}

function setRightPanelMode(mode) {
  const head = $("rightPanel")?.querySelector(".right-panel-head h3");
  const hint = $("rightPanel")?.querySelector(".right-panel-head p");
  if (!head || !hint) return;
  if (mode === "skill") {
    head.textContent = "Skill 详情";
    hint.textContent = "左侧目录可浏览 Skill 包内脚本与引用文件；点击文件查看内容。";
  } else if (mode === "plugin") {
    head.textContent = "插件详情";
    hint.textContent = "左侧目录可浏览插件包内文件；点击文件查看内容。";
  } else if (mode === "talent") {
    head.textContent = "人才模版";
    hint.textContent = "预览 agency-agents 人设 Markdown；可切换「预览 / 源代码」查看完整技能模版。";
  } else {
    head.textContent = "代码详情";
    hint.textContent = "点击「修改的文件」或目录树中的文件，查看相对路径、diff 与完整内容。";
  }
}

function bindSkillDetailTabs(root, skill, content, filePath = skill.path) {
  const path = filePath || skill.path || `${skill.id}.md`;
  const previewHost = () => root.querySelector('[data-pane="preview"] .skill-preview-host');
  const sourceHost = () => root.querySelector('[data-pane="source"] .skill-source-host');

  const activateTab = (name) => {
    root.querySelectorAll(".code-tab").forEach((t) => {
      t.classList.toggle("active", t.getAttribute("data-tab") === name);
    });
    root.querySelectorAll(".code-tab-pane").forEach((p) => {
      p.classList.toggle("active", p.getAttribute("data-pane") === name);
    });
    if (name === "preview") {
      const pane = previewHost();
      if (pane) pane.dataset.mounted = "";
      mountFilePreviewPane(previewHost(), content, path);
    }
    if (name === "source") {
      const pane = sourceHost();
      if (pane) pane.dataset.mounted = "";
      const host = sourceHost();
      const preview = getFilePreviewApi();
      if (preview?.renderPlain && host) {
        preview.renderPlain(host, content);
        host.dataset.mounted = "1";
      } else {
        mountSourcePane(host, content, path);
      }
    }
  };

  root.querySelectorAll(".code-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activateTab(tab.getAttribute("data-tab"));
    });
  });

  activateTab("preview");
}

function updateSkillDetailContent(skill, content, filePath) {
  const root = $("codeDetail");
  if (!root?.querySelector(".skill-detail-card")) {
    showSkillDetail(skill, content, filePath);
    return;
  }
  const pathEl = root.querySelector(".skill-detail-open-file");
  if (pathEl) {
    pathEl.textContent = skillRelPathFromAbs(filePath, state.skillExplorerRoot);
    pathEl.title = filePath;
  }
  bindSkillDetailTabs(root, skill, content, filePath);
}

function pluginCapsLine(caps) {
  const c = caps ?? {};
  const parts = [];
  if ((c.skills ?? 0) > 0) parts.push(`${c.skills} skill`);
  if ((c.mcpServers ?? 0) > 0) parts.push(`${c.mcpServers} MCP`);
  if ((c.commands ?? 0) > 0) parts.push(`${c.commands} cmd`);
  if ((c.workflows ?? 0) > 0) parts.push(`${c.workflows} flow`);
  return parts.length ? parts.join(" · ") : "";
}

function updatePluginDetailContent(plugin, content, filePath) {
  const root = $("codeDetail");
  if (!root?.querySelector(".skill-detail-card")) {
    showPluginDetail(plugin, content, filePath);
    return;
  }
  const pathEl = root.querySelector(".skill-detail-open-file");
  if (pathEl) {
    pathEl.textContent = pluginRelPathFromAbs(filePath, state.pluginExplorerRoot);
    pathEl.title = filePath;
  }
  bindSkillDetailTabs(root, { id: plugin.id, path: filePath }, content, filePath);
}

function showPluginDetail(plugin, content, openFilePath) {
  openRight(true);
  setRightPanelMode("plugin");
  state.activePluginId = plugin.id;
  state.activeSkillId = "";
  state.activeTalentTemplateId = "";
  state.explorerMode = "plugin";
  state.pluginExplorerRoot = plugin.root || "";
  state.pluginExplorerExpanded = new Set(["."]);
  state.pluginActiveFile = openFilePath
    ? pluginRelPathFromAbs(openFilePath, state.pluginExplorerRoot)
    : "";
  $("codePathBreadcrumb")?.classList.add("hidden");
  $("workspaceExplorer")?.setAttribute("aria-label", "插件包目录");
  const actions = $("codeDetailActions");
  actions?.classList.add("hidden");
  actions.innerHTML = "";

  const root = $("codeDetail");
  root.className = "";
  const caps = plugin.capabilities ?? {};
  const capsLine = pluginCapsLine(caps);
  const openRel = openFilePath
    ? pluginRelPathFromAbs(openFilePath, state.pluginExplorerRoot)
    : "";

  root.innerHTML = `
    <div class="code-card skill-detail-card">
      <div class="skill-detail-head">
        <h4 class="skill-detail-name">${escapeHtml(plugin.name || plugin.id)}</h4>
        <span class="skill-detail-id">${escapeHtml(plugin.id)} · v${escapeHtml(plugin.version || "?")}</span>
      </div>
      ${plugin.description ? `<p class="skill-detail-desc">${escapeHtml(plugin.description)}</p>` : ""}
      ${capsLine ? `<div class="skill-detail-group">${escapeHtml(capsLine)}</div>` : ""}
      ${plugin.root ? `<div class="skill-detail-path" title="${escapeHtml(plugin.root)}">${escapeHtml(plugin.root)}</div>` : ""}
      ${openRel ? `<div class="skill-detail-open-file" title="${escapeHtml(openFilePath || "")}">当前文件：${escapeHtml(openRel)}</div>` : ""}
      <div class="code-detail-tabs skill-detail-tabs">
        <div class="code-detail-tab-list">
          <button type="button" class="code-tab active" data-tab="preview">预览</button>
          <button type="button" class="code-tab" data-tab="source">源代码</button>
        </div>
      </div>
      <div class="code-tab-pane active" data-pane="preview">
        <div class="file-preview-host skill-preview-host"></div>
      </div>
      <div class="code-tab-pane" data-pane="source">
        <div class="file-source-host skill-source-host"></div>
      </div>
    </div>
  `;

  bindSkillDetailTabs(root, { id: plugin.id, path: openFilePath }, content, openFilePath);

  document.querySelectorAll(".plugin-card").forEach((el) => {
    el.classList.toggle("active", el.dataset.pluginId === plugin.id);
  });
  document.querySelectorAll(".skill-card.active").forEach((el) => {
    el.classList.remove("active");
  });

  if (plugin.root) {
    setWorkspaceExplorerOpen(true);
    void refreshPluginExplorer();
  }
}

async function openPluginDetail(pluginId) {
  const plugin = state.pluginsById.get(pluginId);
  if (!plugin) return;
  if (!plugin.root) {
    showPluginDetail(plugin, "（该插件无本地路径，无法浏览文件）");
    return;
  }
  const bridge = getBridge();
  if (!bridge?.readSkillFile) {
    showPluginDetail(plugin, "（无法读取插件文件：通信桥未就绪）");
    return;
  }
  const candidates = ["plugin.json", "README.md"];
  for (const name of candidates) {
    const abs = `${plugin.root.replace(/\/$/, "")}/${name}`;
    try {
      const res = await bridge.readSkillFile({ path: abs });
      showPluginDetail(plugin, res?.content ?? "", abs);
      return;
    } catch {
      /* try next */
    }
  }
  showPluginDetail(plugin, "（未找到 plugin.json 或 README.md）", plugin.root);
}

function indexPluginsFromList(plugins) {
  state.pluginsById.clear();
  for (const p of plugins ?? []) {
    if (p?.id) state.pluginsById.set(p.id, p);
  }
}

function bindPluginCardClicks(root) {
  bindPluginCardActions(root);
  if (!root) return;
  root.querySelectorAll(".plugin-card[data-plugin-id]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-plugin-toggle], [data-hub-chip], [data-hub-sync-one], [data-hub-remove], [data-hub-import], .manage-card-actions")) return;
      const id = card.dataset.pluginId;
      if (id) void openPluginDetail(id);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const id = card.dataset.pluginId;
      if (id) void openPluginDetail(id);
    });
  });
}

function githubUrlFromRepo(repo, subdir) {
  const raw = String(repo || "").trim();
  if (!raw) return "";
  const slug = raw
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!slug.includes("/")) return "";
  const base = `https://github.com/${slug}`;
  const sub = String(subdir || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return sub ? `${base}/tree/HEAD/${sub}` : base;
}

async function openGithubRepo(repo, subdir) {
  const url = githubUrlFromRepo(repo, subdir);
  if (!url) {
    notifyUser("无效的 GitHub 仓库地址", "warn");
    return;
  }
  const bridge = getBridge();
  if (!bridge?.openExternal) {
    notifyUser("无法打开浏览器", "err");
    return;
  }
  try {
    await bridge.openExternal(url);
  } catch (e) {
    notifyUser(`打开链接失败: ${String(e)}`, "err");
  }
}

function bindDiscoverInstalledOpen(root, items, onOpenInstalled) {
  if (!onOpenInstalled) return;
  root.querySelectorAll(".store-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".store-card-install") || e.target.closest(".store-card-repo-link")) {
        return;
      }
      const id = card.getAttribute("data-store-id") || card.getAttribute("data-plugin-store-id");
      const item = (items ?? []).find((x) => x.id === id);
      if (item?.installed) onOpenInstalled(item);
    });
  });
}

function showSkillDetail(skill, content, openFilePath = skill.path) {
  openRight(true);
  setRightPanelMode("skill");
  state.activeSkillId = skill.id;
  state.activePluginId = "";
  state.activeTalentTemplateId = "";
  state.explorerMode = "skill";
  state.skillExplorerSkillPath = skill.path || "";
  state.skillExplorerRoot = skill.path ? skillRootFromPath(skill.path) : "";
  state.skillExplorerExpanded = new Set(["."]);
  state.skillActiveFile = skill.path
    ? skillRelPathFromAbs(openFilePath || skill.path, state.skillExplorerRoot)
    : "";
  $("codePathBreadcrumb")?.classList.add("hidden");
  $("workspaceExplorer")?.setAttribute("aria-label", "Skill 包目录");
  const actions = $("codeDetailActions");
  actions?.classList.add("hidden");
  actions.innerHTML = "";

  const root = $("codeDetail");
  root.className = "";
  const triggers = (skill.triggers ?? []).filter(Boolean);
  const triggersHtml = triggers.length
    ? `<div class="skill-detail-triggers">${triggers
        .map((t) => `<span class="skill-trigger-chip">${escapeHtml(t)}</span>`)
        .join("")}</div>`
    : "";
  const openRel = openFilePath
    ? skillRelPathFromAbs(openFilePath, state.skillExplorerRoot)
    : "";

  root.innerHTML = `
    <div class="code-card skill-detail-card">
      <div class="skill-detail-head">
        <h4 class="skill-detail-name">${escapeHtml(skill.name || skill.id)}</h4>
        <span class="skill-detail-id">${escapeHtml(skill.id)}</span>
      </div>
      ${skill.groupTitle ? `<div class="skill-detail-group">${escapeHtml(skill.groupTitle)}</div>` : ""}
      ${skill.description ? `<p class="skill-detail-desc">${escapeHtml(skill.description)}</p>` : ""}
      ${triggersHtml}
      ${skill.path ? `<div class="skill-detail-path" title="${escapeHtml(skill.path)}">${escapeHtml(skill.path)}</div>` : ""}
      ${openRel ? `<div class="skill-detail-open-file" title="${escapeHtml(openFilePath || "")}">当前文件：${escapeHtml(openRel)}</div>` : ""}
      <div class="code-detail-tabs skill-detail-tabs">
        <div class="code-detail-tab-list">
          <button type="button" class="code-tab active" data-tab="preview">Markdown 预览</button>
          <button type="button" class="code-tab" data-tab="source">源代码</button>
        </div>
      </div>
      <div class="code-tab-pane active" data-pane="preview">
        <div class="file-preview-host skill-preview-host"></div>
      </div>
      <div class="code-tab-pane" data-pane="source">
        <div class="file-source-host skill-source-host"></div>
      </div>
    </div>
  `;

  bindSkillDetailTabs(root, skill, content, openFilePath || skill.path);

  document.querySelectorAll(".skill-card").forEach((el) => {
    el.classList.toggle("active", el.dataset.skillId === skill.id);
  });
  document.querySelectorAll(".plugin-card.active").forEach((el) => {
    el.classList.remove("active");
  });

  if (skill.path) {
    setWorkspaceExplorerOpen(true);
    void refreshSkillExplorer();
  }
}

function bindTalentTemplateActions(meta) {
  const actions = $("codeDetailActions");
  if (!actions) return;
  actions.querySelector("#talentRightHireBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openTalentHireModal(meta.templateId);
  });
  actions.querySelector("#talentRightManageBtn")?.addEventListener("click", () => {
    if (meta.rosterMention) void openTalentDetail(meta.rosterMention);
  });
  actions.querySelector("[data-talent-right-mention]")?.addEventListener("click", () => {
    const mention = actions
      .querySelector("[data-talent-right-mention]")
      ?.getAttribute("data-talent-right-mention");
    if (mention) insertTalentMention(mention);
  });
}

function showTalentTemplateDetail(meta, content) {
  openRight(true);
  if (state.panelRightWidth < 420) {
    state.panelRightWidth = clampPanelWidth(480, PANEL_MIN_RIGHT, PANEL_MAX_RIGHT);
    applyPanelWidths();
    savePanelWidths();
  }
  setRightPanelMode("talent");
  state.activeTalentTemplateId = meta.templateId;
  state.activeSkillId = "";
  state.activePluginId = "";
  state.explorerMode = "workspace";
  state.talentPreviewTemplateId = meta.templateId;
  state.talentPreviewSource = meta.source || "market";
  setWorkspaceExplorerOpen(false);
  $("workspaceExplorer")?.classList.add("hidden");
  $("codePathBreadcrumb")?.classList.add("hidden");
  highlightTalentPreviewCards();

  const actions = $("codeDetailActions");
  if (actions) {
    actions.classList.remove("hidden");
    if (meta.hired && meta.rosterMention) {
      actions.innerHTML = `<button type="button" class="btn secondary btn-sm" id="talentRightManageBtn">管理设置</button>
        <button type="button" class="btn secondary btn-sm" data-talent-right-mention="${escapeHtml(meta.rosterMention)}">插入 @</button>`;
    } else if (meta.hired) {
      actions.innerHTML = `<span class="store-card-badge installed">已租用</span>`;
    } else {
      actions.innerHTML = `<button type="button" class="btn primary btn-sm" id="talentRightHireBtn">租用</button>`;
    }
    bindTalentTemplateActions(meta);
  }

  const root = $("codeDetail");
  root.className = "";
  const chips = [];
  for (const skill of meta.suggestedSkills || []) {
    chips.push(`<span class="talent-detail-chip">${escapeHtml(skill)}</span>`);
  }
  for (const tool of meta.suggestedTools || []) {
    chips.push(`<span class="talent-detail-chip is-tool">${escapeHtml(tool)}</span>`);
  }
  const chipsHtml = chips.length
    ? `<div class="talents-detail-chips">${chips.join("")}</div>`
    : "";

  root.innerHTML = `
    <div class="code-card skill-detail-card talent-template-detail-card">
      <div class="skill-detail-head">
        <div class="talent-template-title">
          ${talentAvatarHtml(meta, "talent-avatar talent-avatar-lg")}
          <h4 class="skill-detail-name">${escapeHtml(meta.role || meta.templateId)}</h4>
        </div>
        <span class="skill-detail-id">${escapeHtml(talentCategoryLabel(meta.category || ""))} · ${escapeHtml(meta.templateId)}</span>
      </div>
      ${meta.description ? `<p class="skill-detail-desc">${escapeHtml(meta.description)}</p>` : ""}
      ${chipsHtml}
      <div class="code-detail-tabs skill-detail-tabs">
        <div class="code-detail-tab-list">
          <button type="button" class="code-tab active" data-tab="preview">Markdown 预览</button>
          <button type="button" class="code-tab" data-tab="source">源代码</button>
        </div>
      </div>
      <div class="code-tab-pane active" data-pane="preview">
        <div class="file-preview-host skill-preview-host"></div>
      </div>
      <div class="code-tab-pane" data-pane="source">
        <div class="file-source-host skill-source-host"></div>
      </div>
    </div>
  `;

  const virtualSkill = { id: meta.templateId, path: `${meta.templateId}.md` };
  bindSkillDetailTabs(root, virtualSkill, content, virtualSkill.path);

  document.querySelectorAll(".skill-card.active").forEach((el) => {
    el.classList.remove("active");
  });
  document.querySelectorAll(".plugin-card.active").forEach((el) => {
    el.classList.remove("active");
  });
}

async function openSkillDetail(skillId) {
  const skill = state.skillsById.get(skillId);
  if (!skill) return;
  if (!skill.path) {
    showSkillDetail(skill, "（该 Skill 无文件路径，无法加载正文）");
    return;
  }
  const bridge = getBridge();
  if (!bridge?.readSkillFile) {
    showSkillDetail(skill, "（无法读取 Skill 文件：通信桥未就绪）");
    return;
  }
  try {
    const res = await bridge.readSkillFile({ path: skill.path });
    showSkillDetail(skill, res?.content ?? "");
  } catch (e) {
    showSkillDetail(skill, `（加载失败: ${String(e)}）`);
  }
}

function indexSkillsFromGroups(groups) {
  state.skillsById.clear();
  for (const group of groups ?? []) {
    for (const skill of group.skills ?? []) {
      if (!skill?.id) continue;
      state.skillsById.set(skill.id, {
        ...skill,
        groupTitle: group.title,
      });
    }
  }
}

function bindSkillCardClicks(root) {
  bindSkillCardActions(root);
  if (!root) return;
  root.querySelectorAll(".skill-card[data-skill-id]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-skill-toggle], [data-hub-chip], [data-hub-sync-one], [data-hub-remove], [data-hub-import], .manage-card-actions")) return;
      const id = card.dataset.skillId;
      if (id) void openSkillDetail(id);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const id = card.dataset.skillId;
      if (id) void openSkillDetail(id);
    });
  });
}

/** Set by a click on an inline diff line; consumed by the next showCodeDetail render. */
let pendingCodeDetailScroll = null;

function applyPendingCodeDetailScroll(root) {
  const target = pendingCodeDetailScroll;
  pendingCodeDetailScroll = null;
  if (!target) return;
  const view = root.querySelector(".code-diff-view");
  if (!view) return;
  // Merged view rows carry the unified-diff line index; plain diff view maps 1:1 by order.
  const withDi = [...view.querySelectorAll(".diff-line[data-di]")];
  const el = withDi.length
    ? withDi.find((c) => Number(c.dataset.di) >= target.index) ||
      withDi[withDi.length - 1]
    : view.querySelectorAll(".diff-line")[target.index];
  if (!el) return;
  const diffTab = root.querySelector('.code-tab[data-tab="diff"]');
  if (diffTab && !diffTab.classList.contains("active")) diffTab.click();
  el.scrollIntoView({ block: "center" });
  el.classList.add("diff-line-flash");
  setTimeout(() => el.classList.remove("diff-line-flash"), 1600);
}

function showCodeDetail(detail) {
  openRight(true);
  setRightPanelMode("code");
  state.activeSkillId = "";
  state.activePluginId = "";
  state.activeTalentTemplateId = "";
  state.explorerMode = "workspace";
  $("workspaceExplorer")?.setAttribute("aria-label", "工程目录");
  document.querySelectorAll(".skill-card.active").forEach((el) => {
    el.classList.remove("active");
  });
  document.querySelectorAll(".plugin-card.active").forEach((el) => {
    el.classList.remove("active");
  });
  const root = $("codeDetail");
  const actions = $("codeDetailActions");
  root.className = "";
  const filePath = filePathFromDetail(detail);
  state.workspaceActiveFile = filePath;
  updatePathBreadcrumb(filePath);
  expandExplorerToFile(filePath);
  if (state.workspaceExplorerOpen) void refreshWorkspaceExplorer();
  const preview = getFilePreviewApi();
  const kind = preview?.getFileKind?.(filePath) ?? "code";
  const isImage = isImageFilePath(filePath);
  const isMarkdown = kind === "markdown";
  const hasFull =
    detail.fullContent != null && String(detail.fullContent).length > 0;
  const mergedDiffHtml =
    hasFull && !isMarkdown && !isImage && detail.patch?.unifiedDiff
      ? renderFullFileDiffHtml(
          detail.fullContent,
          detail.patch.unifiedDiff,
          detail.patch.applied,
        )
      : "";
  const diffHtml = mergedDiffHtml || renderDiffLinesHtml(detail.content);
  const diffTabLabel = mergedDiffHtml ? "代码 + 变动" : "变动 (diff)";
  const defaultTab = isImage && hasFull ? "full" : mergedDiffHtml || !hasFull ? "diff" : "full";
  const previewTabLabel = isImage ? "图片预览" : isMarkdown ? "Markdown 预览" : "代码阅读";

  const patchStatusHtml = renderPatchStatusHtml(detail);

  root.innerHTML = `
    <div class="code-card">
      <div class="code-detail-tabs">
        <div class="code-detail-tab-list">
          <button type="button" class="code-tab ${defaultTab === "diff" ? "active" : ""}" data-tab="diff">${diffTabLabel}</button>
          ${
            hasFull
              ? `<button type="button" class="code-tab ${defaultTab === "full" ? "active" : ""}" data-tab="full">${previewTabLabel}</button>`
              : ""
          }
          ${
            hasFull && isMarkdown && !isImage
              ? `<button type="button" class="code-tab" data-tab="source">源代码</button>`
              : ""
          }
        </div>
        ${patchStatusHtml}
      </div>
      <div class="code-tab-pane ${defaultTab === "diff" ? "active" : ""}" data-pane="diff">
        <div class="code-diff-view">${diffHtml}</div>
      </div>
      ${
        hasFull
          ? `<div class="code-tab-pane ${defaultTab === "full" ? "active" : ""}" data-pane="full"><div class="file-preview-host"></div></div>`
          : ""
      }
      ${
        hasFull && isMarkdown && !isImage
          ? `<div class="code-tab-pane" data-pane="source"><div class="file-source-host"></div></div>`
          : ""
      }
    </div>
  `;

  if (hasFull) {
    bindCodeDetailTabs(root, detail);
  } else {
    root.querySelectorAll(".code-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const name = tab.getAttribute("data-tab");
        root.querySelectorAll(".code-tab").forEach((t) => t.classList.remove("active"));
        root.querySelectorAll(".code-tab-pane").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        root.querySelector(`[data-pane="${name}"]`)?.classList.add("active");
      });
    });
  }

  if (actions) {
    actions.classList.add("hidden");
    actions.innerHTML = "";
    if (detail.patch?.applied && detail.patch.unifiedDiff) {
      actions.classList.remove("hidden");
      actions.innerHTML = `<button type="button" class="btn secondary" id="undoPatchBtn">撤销此补丁</button>`;
      $("undoPatchBtn")?.addEventListener("click", async () => {
        const active = getActiveProject();
        if (!active?.cwd) {
          notifyUser("请先选择有效项目目录", "warn");
          return;
        }
        if (!window.confirm("将反向应用该补丁，把这次改动从文件中撤销。继续？")) return;
        const btn = $("undoPatchBtn");
        if (btn) {
          btn.disabled = true;
          btn.textContent = "撤销中…";
        }
        try {
          const res = await requireBridge().applyPatch({
            cwd: active.cwd,
            path: detail.patch.path,
            unifiedDiff: reverseUnifiedDiff(detail.patch.unifiedDiff),
          });
          if (res?.ok !== false) {
            notifyUser(`已撤销补丁: ${detail.patch.path}`, "status");
            detail.patch.applied = false;
            recordRunPatch({
              path: detail.patch.path,
              unifiedDiff: detail.patch.unifiedDiff,
              applied: false,
            });
            markPatchAppliedInUi(detail.patch.path, false);
            void openModifiedFile(detail.patch.path, detail.patch);
          } else {
            notifyUser(`撤销失败: ${res?.message ?? "未知错误"}`, "err");
            if (btn) {
              btn.disabled = false;
              btn.textContent = "撤销此补丁";
            }
          }
        } catch (e) {
          notifyUser(`撤销补丁失败: ${String(e)}`, "err");
          if (btn) {
            btn.disabled = false;
            btn.textContent = "撤销此补丁";
          }
        }
      });
    }
    if (detail.patch && !detail.patch.applied) {
      actions.classList.remove("hidden");
      actions.innerHTML = `<button type="button" class="btn primary" id="applyPatchBtn">应用补丁</button>`;
      $("applyPatchBtn")?.addEventListener("click", async () => {
        const active = getActiveProject();
        if (!active?.cwd) {
          notifyUser("请先选择有效项目目录", "warn");
          return;
        }
        const btn = $("applyPatchBtn");
        if (btn) {
          btn.disabled = true;
          btn.textContent = "应用中…";
        }
        try {
          const res = await requireBridge().applyPatch({
            cwd: active.cwd,
            path: detail.patch.path,
            unifiedDiff: detail.patch.unifiedDiff,
          });
          if (res?.ok !== false) {
            notifyUser(
              res?.alreadyApplied
                ? `变更已在文件中: ${detail.patch.path}`
                : `补丁已应用: ${detail.patch.path}`,
              "status",
            );
            detail.patch.applied = true;
            recordRunPatch({
              path: detail.patch.path,
              unifiedDiff: detail.patch.unifiedDiff,
              applied: true,
            });
            markPatchAppliedInUi(detail.patch.path);
            void openModifiedFile(detail.patch.path);
          } else {
            notifyUser(`应用失败: ${res?.message ?? "未知错误"}`, "err");
            if (btn) {
              btn.disabled = false;
              btn.textContent = "应用补丁";
            }
          }
        } catch (e) {
          notifyUser(`应用补丁失败: ${String(e)}`, "err");
          if (btn) {
            btn.disabled = false;
            btn.textContent = "应用补丁";
          }
        }
      });
    }
  }

  applyPendingCodeDetailScroll(root);
}

function clearTimeline() {
  $("timeline").innerHTML = "";
  setTimelineRuntime("forge");
  resetRunArtifacts();
  clearLiveStatusLine();
  state.currentStepEl = null;
  state.currentStepBody = null;
  state.statusNode = null;
  state.streamTextNode = null;
  state.streamTextBuffer = "";
  state.streamTextRaw = "";
  state.thinkingPre = null;
  resetRunActivityState();
}

function updateChatEmptyTitle() {
  const p = getActiveProject();
  $("chatEmptyTitle").textContent = p
    ? `我们应该在 ${p.name} 中构建什么？`
    : "我们应该构建什么？";
}

function showChatEmpty(show) {
  state.chatEmpty = show;
  const panel = $("centerPanel");
  if (panel) panel.classList.toggle("chat-empty-mode", show && state.activeNav === "chat");
  if (state.activeNav !== "chat") return;
  $("chatEmpty").classList.toggle("hidden", !show);
  $("timeline").classList.toggle("hidden", show);
}

function renderComposerProjectSelect() {
  const sel = $("composerProjectSelect");
  if (!sel) return;
  sel.innerHTML = "";
  state.projects.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (state.projects.some((p) => p.id === state.activeProjectId)) {
    sel.value = state.activeProjectId;
  } else if (state.projects[0]) {
    sel.value = state.projects[0].id;
    state.activeProjectId = state.projects[0].id;
  }
  const label = $("composerProjectLabel");
  const active = getActiveProject();
  if (label) label.textContent = active?.name || "项目";
  updateChatEmptyTitle();
  renderComposerGitBranchSelect();
}

function renderComposerGitBranchSelect() {
  const tag = $("composerGitBranchTag");
  const label = $("composerGitBranchLabel");
  if (!tag || !label) return;

  const active = getActiveProject();
  const info = active ? state.gitBranchByProject.get(active.id) : null;
  if (!active?.cwd || !info?.isRepo || !info.current) {
    tag.classList.add("hidden");
    closeGitBranchMenu();
    return;
  }

  const branches = Array.isArray(info.branches) ? info.branches : [];
  const disabled = Boolean(info.detached || state.runningSessions.size > 0 || !branches.length);
  tag.classList.remove("hidden");
  tag.classList.toggle("is-detached", Boolean(info.detached));
  tag.title = info.detached
    ? `当前 Git 状态: ${info.current}`
    : `当前 Git 分支: ${info.current}`;
  tag.disabled = disabled;
  tag.setAttribute("aria-expanded", state.gitBranchMenuOpen ? "true" : "false");
  label.textContent = info.current;
  if (disabled && state.gitBranchMenuOpen) closeGitBranchMenu();
  else if (state.gitBranchMenuOpen) renderGitBranchMenu();
}

function closeGitBranchMenu() {
  state.gitBranchMenuOpen = false;
  state.gitBranchSearchQuery = "";
  $("composerGitBranchMenu")?.classList.add("hidden");
  $("composerGitBranchTag")?.setAttribute("aria-expanded", "false");
}

function positionGitBranchMenu() {
  const tag = $("composerGitBranchTag");
  const menu = $("composerGitBranchMenu");
  if (!tag || !menu || menu.classList.contains("hidden")) return;
  const rect = tag.getBoundingClientRect();
  const width = Math.min(320, Math.max(220, window.innerWidth - 24));
  menu.style.width = `${width}px`;
  const menuHeight = menu.offsetHeight || 220;
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
  const topAbove = rect.top - menuHeight - 8;
  const topBelow = rect.bottom + 8;
  const top = topAbove >= 8 ? topAbove : Math.min(topBelow, window.innerHeight - menuHeight - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function renderGitBranchMenu() {
  const menu = $("composerGitBranchMenu");
  const input = $("composerGitBranchSearch");
  const list = $("composerGitBranchList");
  const active = getActiveProject();
  const info = active ? state.gitBranchByProject.get(active.id) : null;
  if (!menu || !input || !list || !info?.isRepo) return;

  input.value = state.gitBranchSearchQuery;
  list.innerHTML = "";
  const query = state.gitBranchSearchQuery.trim().toLowerCase();
  const branches = (Array.isArray(info.branches) ? info.branches : []).filter((branch) =>
    branch.toLowerCase().includes(query),
  );

  if (!branches.length) {
    const empty = document.createElement("div");
    empty.className = "branch-menu-empty";
    empty.textContent = query ? "没有匹配的分支" : "暂无本地分支";
    list.appendChild(empty);
  } else {
    branches.forEach((branch) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `branch-menu-item${branch === info.current ? " is-current" : ""}`;
      item.dataset.branch = branch;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", branch === info.current ? "true" : "false");
      item.innerHTML = `
        <span class="branch-menu-check" aria-hidden="true">${branch === info.current ? "✓" : ""}</span>
        <span class="branch-menu-name"></span>
      `;
      item.querySelector(".branch-menu-name").textContent = branch;
      list.appendChild(item);
    });
  }
  positionGitBranchMenu();
}

function openGitBranchMenu() {
  const active = getActiveProject();
  const info = active ? state.gitBranchByProject.get(active.id) : null;
  const branches = Array.isArray(info?.branches) ? info.branches : [];
  if (!info?.isRepo || info.detached || state.runningSessions.size > 0 || !branches.length) return;
  state.gitBranchRefreshController?.refreshNow?.();
  state.gitBranchMenuOpen = true;
  state.gitBranchSearchQuery = "";
  $("composerGitBranchMenu")?.classList.remove("hidden");
  $("composerGitBranchTag")?.setAttribute("aria-expanded", "true");
  renderGitBranchMenu();
  requestAnimationFrame(() => {
    positionGitBranchMenu();
    $("composerGitBranchSearch")?.focus();
  });
}

async function switchGitBranchFromMenu(branch) {
  const active = getActiveProject();
  const current = state.gitBranchByProject.get(active?.id)?.current;
  if (!active?.cwd || !branch || branch === current) {
    closeGitBranchMenu();
    return;
  }
  if (state.runningSessions.size > 0) {
    notifyUser("执行中暂不能切换分支", "warn");
    closeGitBranchMenu();
    renderComposerGitBranchSelect();
    return;
  }
  closeGitBranchMenu();
  const tag = $("composerGitBranchTag");
  if (tag) tag.disabled = true;
  try {
    const res = await requireBridge().switchGitBranch({ cwd: active.cwd, branch });
    if (!res?.ok) {
      notifyUser(res?.message || "切换 Git 分支失败", "err");
    } else {
      notifyUser(`已切换到分支: ${res.current || branch}`, "done");
    }
  } catch (e) {
    notifyUser(`切换 Git 分支失败: ${String(e)}`, "err");
  } finally {
    await refreshGitBranchForProject(active);
  }
}

async function refreshGitBranchForProject(project = getActiveProject()) {
  const bridge = getBridge();
  if (!bridge?.getGitBranches || !project?.id || !project.cwd) {
    renderComposerGitBranchSelect();
    return;
  }
  const requestSeq = ++state.gitBranchRequestSeq;
  const projectId = project.id;
  const cwd = project.cwd;
  try {
    const info = await bridge.getGitBranches({ cwd });
    const latest = state.projects.find((p) => p.id === projectId);
    if (!latest || latest.cwd !== cwd || requestSeq !== state.gitBranchRequestSeq) return;
    state.gitBranchByProject.set(projectId, info);
  } catch {
    state.gitBranchByProject.set(projectId, {
      isRepo: false,
      current: null,
      detached: false,
      branches: [],
    });
  }
  if (projectId === state.activeProjectId) renderComposerGitBranchSelect();
}

function startGitBranchAutoRefresh() {
  if (state.gitBranchRefreshController) return;
  const factory = globalThis.ForgeGitBranchRefresh?.createGitBranchRefreshController;
  if (typeof factory !== "function") return;
  state.gitBranchRefreshController = factory({
    refresh: () => refreshGitBranchForProject(),
    getActiveKey: () => getActiveProject()?.cwd || "",
    intervalMs: 4000,
  });
  state.gitBranchRefreshController.start();
}

function bindComposerGitBranchSelect() {
  const tag = $("composerGitBranchTag");
  const menu = $("composerGitBranchMenu");
  const input = $("composerGitBranchSearch");
  const list = $("composerGitBranchList");
  if (!tag || !menu || !input || !list || tag.dataset.bound === "1") return;
  tag.dataset.bound = "1";
  tag.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.gitBranchMenuOpen) closeGitBranchMenu();
    else openGitBranchMenu();
  });
  input.addEventListener("input", () => {
    state.gitBranchSearchQuery = input.value;
    renderGitBranchMenu();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeGitBranchMenu();
      tag.focus();
      return;
    }
    if (e.key === "Enter") {
      const first = list.querySelector(".branch-menu-item");
      const branch = first?.dataset.branch;
      if (branch) {
        e.preventDefault();
        void switchGitBranchFromMenu(branch);
      }
    }
  });
  list.addEventListener("click", (e) => {
    const item = e.target.closest?.(".branch-menu-item");
    const branch = item?.dataset.branch;
    if (branch) void switchGitBranchFromMenu(branch);
  });
  document.addEventListener("click", (e) => {
    if (!state.gitBranchMenuOpen) return;
    if (menu.contains(e.target) || tag.contains(e.target)) return;
    closeGitBranchMenu();
  });
  window.addEventListener("resize", () => {
    if (state.gitBranchMenuOpen) positionGitBranchMenu();
  });
  window.addEventListener("scroll", () => {
    if (state.gitBranchMenuOpen) positionGitBranchMenu();
  });
}

function setActiveProject(id, { newChat = false } = {}) {
  if (!id || !state.projects.some((p) => p.id === id)) return;
  const prevProject = getActiveProject();
  if (id === state.activeProjectId && !newChat) {
    renderComposerProjectSelect();
    renderProjects();
    updateChatEmptyTitle();
    return;
  }
  const outgoingSid =
    state.viewingTimelineSessionId || prevProject?.sessionId || "";
  const prevSid =
    prevProject && prevProject.id !== id ? prevProject.sessionId || "" : "";
  state.activeProjectId = id;
  state.expandedProjectIds.add(id);
  state.acpPrewarmKey = "";
  scheduleAcpPrewarm();
  saveProjects();
  renderProjects();
  renderComposerProjectSelect();
  void refreshGitBranchForProject();
  if (state.workspaceExplorerOpen) void refreshWorkspaceExplorer();
  void renderResourceView();
  const bridge = getBridge();
  if (bridge) void reloadConfigAndSessions().catch(() => {});
  if (state.chatEmpty) {
    const active = getActiveProject();
    if (active) active.sessionId = "";
    updateChatEmptyTitle();
    saveProjects();
  } else if (newChat) {
    startNewChat();
  } else {
    const active = getActiveProject();
    if (active?.sessionId && sessionRuns) {
      setNav("chat");
      void sessionRuns.switchSessionView(active, active.sessionId, prevSid, {
        outgoingSessionId: outgoingSid,
      });
    } else if (sessionRuns && outgoingSid) {
      sessionRuns.captureOutgoingTimeline(outgoingSid);
      state.viewingTimelineSessionId = null;
      clearTimeline();
      showChatEmpty(true);
    }
  }
}

function bindComposerProjectSelect() {
  const sel = $("composerProjectSelect");
  if (!sel || sel.dataset.bound === "1") return;
  sel.dataset.bound = "1";
  sel.addEventListener("change", () => {
    const id = sel.value;
    if (!id) return;
    setActiveProject(id, { newChat: !state.chatEmpty });
  });
}

function startNewChat(opts = {}) {
  const active = getActiveProject();
  const outgoingSid =
    state.viewingTimelineSessionId || active?.sessionId || "";
  if (outgoingSid) {
    saveSessionRunArtifacts(outgoingSid);
    captureOutgoingTimeline(outgoingSid);
    void releaseAcpForForgeSession(outgoingSid);
  }
  if (active) active.sessionId = "";
  state.pendingHookSource = "clear";
  state.viewingTimelineSessionId = null;
  clearTimeline();
  showChatEmpty(true);
  saveProjects();
  renderProjects();
  renderComposerProjectSelect();
  $("messageInput").value = opts.prefill ? String(opts.prefill) : "";
  slashPaletteApi?.close?.();
  fileMentionApi?.close?.();
  sessionRuns?.syncComposerRunChrome();
  setNav("chat");
  scheduleAcpPrewarm();
}

/** Desktop slash commands — must hit daemon directly (not via agent run). */
async function tryHandleSlashCommand(message) {
  const raw = String(message || "").trim();
  if (!raw.startsWith("/")) return false;

  const body = raw.slice(1).trim();
  const space = body.search(/\s/);
  const cmd = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const args = space === -1 ? "" : body.slice(space + 1).trim();

  if (cmd === "clear" || cmd === "new") {
    startNewChat();
    pushEvent("已开始新对话（/clear）", "done");
    return true;
  }

  if (cmd === "compact" || cmd === "压缩") {
    const active = getActiveProject();
    if (!active?.sessionId) {
      notifyUser("当前项目没有可压缩的会话，请先发送一条消息", "warn");
      return true;
    }
    const keepLast = args ? parseInt(args, 10) : 12;
    if (args && Number.isNaN(keepLast)) {
      notifyUser("用法: /compact [保留条数]，例如 /compact 8", "warn");
      return true;
    }
    pushEvent(`正在压缩会话（保留最近 ${keepLast || 12} 条）…`, "status");
    try {
      const result = await requireBridge().compactSession({
        sessionId: active.sessionId,
        keepLast: keepLast || 12,
      });
      const mode = result?.mode ?? "local";
      if (!result?.blocked) {
        state.pendingHookSource = "compact";
      }
      pushEvent(
        result?.blocked
          ? "压缩被 Hook 阻止"
          : `已压缩会话 (${mode})：摘要 ${result?.summarizedMessages ?? 0} 条，保留 ${result?.keptMessages ?? 0} 条`,
        result?.blocked ? "warn" : "done",
      );
      if (result?.summaryPreview) {
        pushEvent(`摘要预览: ${result.summaryPreview.slice(0, 280)}`, "status");
      }
    } catch (e) {
      pushEvent(`压缩失败: ${String(e)}`, "err");
    }
    $("messageInput").value = "";
    slashPaletteApi?.close?.();
    fileMentionApi?.close?.();
    return true;
  }

  if (cmd === "help" || cmd === "h" || cmd === "?") {
    pushEvent(
      "斜杠命令: /compact [N] 压缩历史 | /clear 新对话 | /talents /roster /hire 人才中心 | /plan /review 等仍会发给 Agent。",
      "status",
    );
    $("messageInput").value = "";
    slashPaletteApi?.close?.();
    fileMentionApi?.close?.();
    return true;
  }

  if (cmd === "talents" || cmd === "talent") {
    setNav("talents");
    state.talentMarketCategory = args.trim() || "";
    void renderTalentsView();
    pushEvent(
      args.trim()
        ? `已打开人才市场（分类: ${args.trim()}）`
        : "已打开人才中心 · 人才市场",
      "status",
    );
    $("messageInput").value = "";
    slashPaletteApi?.close?.();
    fileMentionApi?.close?.();
    return true;
  }

  if (cmd === "roster") {
    setNav("talents");
    setTalentsTab("roster");
    void renderTalentsView();
    pushEvent("已打开人才中心 · 已租用", "status");
    $("messageInput").value = "";
    slashPaletteApi?.close?.();
    fileMentionApi?.close?.();
    return true;
  }

  if (cmd === "hire") {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
      pushEvent("用法: /hire <template-id>，例如 /hire product-manager", "warn");
      return true;
    }
    setNav("talents");
    void loadTalentTemplates().then(() => {
      openTalentHireModal(parts[0]);
    });
    $("messageInput").value = "";
    slashPaletteApi?.close?.();
    fileMentionApi?.close?.();
    return true;
  }

  return false;
}

function formatUserPromptForDisplay(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const stripped = t
    .replace(/^开始执行:\s*/, "")
    .replace(/^\[微信渠道\]\s*/, "")
    .replace(/^\[微信[^\]]*\]\s*/, "")
    .trim();
  return stripped || t;
}


function plainUserContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p.type === "text") return p.text ?? "";
        if (p.type === "image_url") return "🖼️ [图片]";
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return String(content);
}

function composerAttachmentId() {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTokensShort(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

/** Composer badge showing this session's context budget usage. */
function renderContextMeter() {
  const el = $("contextMeter");
  if (!el) return;
  const sid = sessionRuns?.getViewingSessionId?.() || "";
  const usage = sid ? state.contextUsageBySession.get(sid) : null;
  if (!usage?.max) {
    el.classList.add("hidden");
    return;
  }
  const pct = Math.min(100, Math.round((usage.used / usage.max) * 100));
  el.classList.remove("hidden");
  el.classList.toggle("is-warn", pct >= 80 || Boolean(usage.truncated));
  el.textContent = `上下文 ${pct}%`;
  el.title =
    `本轮发送约 ${formatTokensShort(usage.used)} / ${formatTokensShort(usage.max)} tokens` +
    `${usage.truncated ? "（较早历史已截断）" : ""}。点击立即压缩历史（/compact）。`;
}

function bindContextMeterCompact() {
  $("contextMeter")?.addEventListener("click", () => {
    const viewingSid = sessionRuns?.getViewingSessionId?.() || "";
    if (viewingSid && state.runningSessions.has(viewingSid)) {
      notifyUser("执行中无法压缩，请等本轮完成", "warn");
      return;
    }
    void tryHandleSlashCommand("/compact");
  });
}

/** ↑/↓ recall of previously sent prompts (terminal-style; only from an empty box). */
const PROMPT_HISTORY_LS_KEY = "forge.promptHistory";

function loadPromptHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(PROMPT_HISTORY_LS_KEY) || "[]");
    return Array.isArray(arr) ? arr.slice(-50).map(String) : [];
  } catch {
    return [];
  }
}

const promptHistory = { items: loadPromptHistory(), index: null, draft: "" };

function pushPromptHistory(message) {
  const t = String(message || "").trim();
  if (!t) return;
  if (promptHistory.items[promptHistory.items.length - 1] !== t) {
    promptHistory.items.push(t);
  }
  if (promptHistory.items.length > 50) promptHistory.items.shift();
  promptHistory.index = null;
  try {
    localStorage.setItem(PROMPT_HISTORY_LS_KEY, JSON.stringify(promptHistory.items));
  } catch {
    /* storage may be full or unavailable */
  }
}

function handlePromptHistoryKey(e) {
  const input = $("messageInput");
  const items = promptHistory.items;
  if (!input || !items.length) return;
  const navigating = promptHistory.index !== null;
  if (e.key === "ArrowUp") {
    if (!navigating && input.value.trim() !== "") return;
    e.preventDefault();
    if (!navigating) {
      promptHistory.draft = input.value;
      promptHistory.index = items.length - 1;
    } else if (promptHistory.index > 0) {
      promptHistory.index -= 1;
    }
    input.value = items[promptHistory.index];
  } else {
    if (!navigating) return;
    e.preventDefault();
    if (promptHistory.index < items.length - 1) {
      promptHistory.index += 1;
      input.value = items[promptHistory.index];
    } else {
      promptHistory.index = null;
      input.value = promptHistory.draft;
    }
  }
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Refill the composer from a failed run; auto-send unless a run is active. */
function retryComposerMessage(message) {
  const input = $("messageInput");
  if (!input || !message) return;
  input.value = message;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  if (sessionRuns?.isComposerStopMode?.()) {
    notifyUser("当前会话执行中，消息已填入输入框，回车即可排队", "status");
    return;
  }
  $("runBtn")?.click();
}

function loadRuntimePrefs() {
  state.runtimePrefs = window.ForgeRuntimeUI?.loadPrefs?.() ?? {
    defaultProvider: "forge",
    cursor: { model: "", mode: "default" },
    codex: { model: "" },
    claude: { model: "sonnet" },
  };
  return state.runtimePrefs;
}

async function releaseAcpForForgeSession(sessionId) {
  if (!sessionId) return;
  try {
    await requireBridge().releaseAcpForgeSession({ sessionId });
  } catch {
    /* daemon may be offline */
  }
}

function scheduleAcpPrewarm() {
  if (state.acpPrewarmTimer) clearTimeout(state.acpPrewarmTimer);
  state.acpPrewarmTimer = setTimeout(() => {
    state.acpPrewarmTimer = null;
    void runAcpPrewarm();
  }, 400);
}

async function runAcpPrewarm() {
  const prefs = loadRuntimePrefs();
  const provider =
    $("runtimeSelect")?.value || prefs.defaultProvider || "forge";
  if (provider !== "cursor") return;
  const cwd = getActiveProject()?.cwd;
  if (!cwd) return;
  const model = prefs.cursor?.model || state.selectedCursorModel || "";
  const mode = prefs.cursor?.mode || state.selectedCursorMode || "default";
  const key = `${provider}:${cwd}:${model}:${mode}`;
  if (state.acpPrewarmInFlight && state.acpPrewarmKey === key) return;
  if (state.acpPrewarmKey === key) return;
  const bridge = getBridge();
  if (!bridge?.prewarmAcpSession) return;
  state.acpPrewarmInFlight = true;
  state.acpPrewarmKey = key;
  try {
    await bridge.prewarmAcpSession({
      provider: "cursor",
      cwd,
      model: model || undefined,
      mode: mode || undefined,
    });
  } catch {
    state.acpPrewarmKey = "";
  } finally {
    state.acpPrewarmInFlight = false;
  }
}

function saveRuntimePrefs(patch = {}) {
  const next = {
    ...loadRuntimePrefs(),
    ...patch,
    cursor: { ...loadRuntimePrefs().cursor, ...(patch.cursor || {}) },
    codex: { ...loadRuntimePrefs().codex, ...(patch.codex || {}) },
    claude: { ...loadRuntimePrefs().claude, ...(patch.claude || {}) },
  };
  state.runtimePrefs = next;
  window.ForgeRuntimeUI?.savePrefs?.(next);
  return next;
}

function applyRuntimePrefsToComposer() {
  const prefs = loadRuntimePrefs();
  const runtimeSel = $("runtimeSelect");
  if (runtimeSel && prefs.defaultProvider) {
    runtimeSel.value = prefs.defaultProvider;
  }
  state.selectedCursorModel = prefs.cursor?.model || state.selectedCursorModel || "";
  state.selectedCursorMode = prefs.cursor?.mode || state.selectedCursorMode || "default";
  state.selectedCodexModel = prefs.codex?.model || state.selectedCodexModel || "";
  state.selectedClaudeModel = prefs.claude?.model || state.selectedClaudeModel || "sonnet";
  renderRuntimeModelSelect();
  if (prefs.defaultProvider === "cursor") {
    void loadCursorModelsForActiveProject();
    scheduleAcpPrewarm();
  }
  if (prefs.defaultProvider === "codex") void loadCodexModelsForActiveProject();
}

function setDefaultRuntimeProvider(providerId) {
  saveRuntimePrefs({ defaultProvider: providerId });
  applyRuntimePrefsToComposer();
  notifyUser(`默认 Runtime: ${runtimeDisplayName({ provider: providerId })}`, "done");
}

function getSelectedRuntimeRequest() {
  const value = $("runtimeSelect")?.value || "forge";
  if (value === "codex") {
    const model =
      $("profileSelect")?.dataset.runtime === "codex"
        ? $("profileSelect")?.value
        : state.selectedCodexModel;
    return { provider: "codex", ...(model ? { model } : {}) };
  }
  if (value === "claude-code") {
    const model =
      $("profileSelect")?.dataset.runtime === "claude-code"
        ? $("profileSelect")?.value
        : state.selectedClaudeModel;
    return { provider: "claude-code", ...(model ? { model } : {}) };
  }
  if (value === "cursor") {
    const model =
      $("profileSelect")?.dataset.runtime === "cursor"
        ? $("profileSelect")?.value
        : state.selectedCursorModel;
    const mode =
      $("runtimeModeSelect")?.dataset.runtime === "cursor"
        ? $("runtimeModeSelect")?.value
        : state.selectedCursorMode;
    return {
      provider: "cursor",
      ...(model ? { model } : {}),
      ...(mode ? { permissionMode: mode } : {}),
    };
  }
  return undefined;
}

function runtimeDisplayName(runtime) {
  if (runtime?.provider === "codex") return "Codex";
  if (runtime?.provider === "claude-code") return "Claude Code";
  if (runtime?.provider === "cursor") return "Cursor Agent";
  if (runtime?.provider) return runtime.provider;
  return "Forge Agent";
}

function enqueueComposerRun(sessionId, projectId, message, attachments, runtime) {
  const arr = state.queuedRunsBySession.get(sessionId) || [];
  arr.push({ projectId, message, attachments, runtime });
  state.queuedRunsBySession.set(sessionId, arr);
  renderComposerQueue();
}

function renderComposerQueue() {
  const bar = $("composerQueue");
  if (!bar) return;
  const sid = sessionRuns?.getViewingSessionId?.() || "";
  const list = (sid && state.queuedRunsBySession.get(sid)) || [];
  if (!list.length) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = list
    .map(({ message, attachments }, i) => {
      const text = message || `[${attachments.length} 个附件]`;
      return `<span class="composer-queue-chip">
        <span class="queue-chip-label">排队中</span>
        <span class="queue-chip-text" title="${escapeHtml(text)}">${escapeHtml(text)}</span>
        <button type="button" class="chip-remove" data-queue-index="${i}" aria-label="取消排队">×</button>
      </span>`;
    })
    .join("");
  bar.querySelectorAll("[data-queue-index]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.getAttribute("data-queue-index"));
      const arr = state.queuedRunsBySession.get(sid) || [];
      arr.splice(idx, 1);
      if (!arr.length) state.queuedRunsBySession.delete(sid);
      renderComposerQueue();
    });
  });
}

function renderComposerAttachments() {
  const bar = $("composerAttachments");
  if (!bar) return;
  const list = state.composerAttachments;
  if (!list.length) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = list
    .map(({ id, attachment: a }) => {
      const thumb =
        a.kind === "image" && a.dataUrl
          ? `<img src="${a.dataUrl}" alt="" />`
          : `<span class="chip-file-icon" aria-hidden="true">${treeFileIcon()}</span>`;
      return `<span class="composer-attachment-chip" data-att-id="${escapeHtml(id)}">
        ${thumb}
        <span class="chip-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
        <button type="button" class="chip-remove" data-remove-att="${escapeHtml(id)}" aria-label="移除">×</button>
      </span>`;
    })
    .join("");
  bar.querySelectorAll("[data-remove-att]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const rid = btn.getAttribute("data-remove-att");
      state.composerAttachments = state.composerAttachments.filter((x) => x.id !== rid);
      renderComposerAttachments();
    });
  });
}

function addComposerAttachments(items) {
  const max = 8;
  for (const attachment of items) {
    if (state.composerAttachments.length >= max) {
      notifyUser(`最多附加 ${max} 个文件`, "warn");
      break;
    }
    if (state.composerAttachments.some((x) => x.attachment.name === attachment.name)) {
      continue;
    }
    if (
      attachment.kind === "file" &&
      attachment.text?.includes("未能解析为文本")
    ) {
      notifyUser(`${attachment.name}: 未能提取正文`, "warn");
    }
    state.composerAttachments.push({ id: composerAttachmentId(), attachment });
  }
  renderComposerAttachments();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function readBrowserFileAsAttachment(file) {
  const name = file.name || "file";
  if (file.type.startsWith("image/")) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return {
      kind: "image",
      name,
      mimeType: file.type || "image/png",
      dataUrl,
    };
  }
  const bridge = getBridge();
  if (bridge?.extractAttachmentBytes) {
    const buf = await file.arrayBuffer();
    const res = await bridge.extractAttachmentBytes({
      name,
      base64: arrayBufferToBase64(buf),
    });
    if (res?.attachment) return res.attachment;
  }
  const text = await file.text();
  return {
    kind: "file",
    name,
    mimeType: file.type || "text/plain",
    text: text.slice(0, 50_000),
  };
}

async function ingestDataTransfer(dt) {
  if (!dt) return;
  const paths = [];
  const browserFiles = [];
  for (const file of dt.files ?? []) {
    if (file.path) paths.push(file.path);
    else browserFiles.push(file);
  }
  const items = [];
  if (paths.length && getBridge()?.readAttachmentPaths) {
    const res = await getBridge().readAttachmentPaths(paths);
    items.push(...(res?.items ?? []));
  }
  for (const file of browserFiles) {
    try {
      items.push(await readBrowserFileAsAttachment(file));
    } catch {
      notifyUser(`无法读取: ${file.name}`, "warn");
    }
  }
  if (items.length) addComposerAttachments(items);
}

function closeComposerAttachMenu() {
  const menu = $("composerAttachMenu");
  menu?.classList.add("hidden");
  $("composerAddBtn")?.setAttribute("aria-expanded", "false");
  if (menu) {
    menu.style.position = "";
    menu.style.left = "";
    menu.style.top = "";
    menu.style.zIndex = "";
  }
}

function openComposerAttachMenu() {
  const menu = $("composerAttachMenu");
  const btn = $("composerAddBtn");
  if (!menu || !btn) return;
  menu.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");
  menu.style.position = "fixed";
  menu.style.zIndex = "10000";
  const rect = btn.getBoundingClientRect();
  const gap = 6;
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.top = `${rect.bottom + gap}px`;
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.bottom > window.innerHeight - 8) {
    menu.style.top = `${Math.max(8, rect.top - menuRect.height - gap)}px`;
  }
  if (menuRect.right > window.innerWidth - 8) {
    menu.style.left = `${Math.max(8, window.innerWidth - menuRect.width - 8)}px`;
  }
}

function toggleComposerAttachMenu() {
  const menu = $("composerAttachMenu");
  if (!menu) return;
  if (menu.classList.contains("hidden")) openComposerAttachMenu();
  else closeComposerAttachMenu();
}

function bindComposerAttachments() {
  const card = $("composerCard");
  const input = $("messageInput");

  const addBtn = $("composerAddBtn");
  const attachMenu = $("composerAttachMenu");
  if (!addBtn || !attachMenu) return;

  addBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleComposerAttachMenu();
  });

  attachMenu.querySelector('[data-attach-action="files"]')?.addEventListener("click", async (e) => {
    e.stopPropagation();
    closeComposerAttachMenu();
    try {
      const bridge = requireBridge();
      if (typeof bridge.pickAttachments !== "function") {
        notifyUser("请完全退出并重新启动桌面端以加载附件功能", "warn");
        return;
      }
      const res = await bridge.pickAttachments();
      addComposerAttachments(res?.items ?? []);
    } catch (err) {
      notifyUser(`选择文件失败: ${String(err)}`, "err");
    }
  });

  document.addEventListener(
    "click",
    (e) => {
      if (
        e.target.closest(".composer-attach-wrap") ||
        e.target.closest("#composerAttachMenu")
      ) {
        return;
      }
      closeComposerAttachMenu();
    },
    true,
  );

  window.addEventListener("resize", () => {
    if (!$("composerAttachMenu")?.classList.contains("hidden")) {
      openComposerAttachMenu();
    }
  });

  const onDrag = (over) => {
    card?.classList.toggle("composer-dragover", over);
  };

  card?.addEventListener("dragover", (e) => {
    e.preventDefault();
    onDrag(true);
  });
  card?.addEventListener("dragleave", (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    onDrag(false);
  });
  card?.addEventListener("drop", async (e) => {
    e.preventDefault();
    onDrag(false);
    await ingestDataTransfer(e.dataTransfer);
  });

  input?.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let hasImage = false;
    for (const item of items) {
      if (item.type.startsWith("image/")) hasImage = true;
    }
    if (!hasImage) return;
    e.preventDefault();
    const files = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    const attachments = [];
    for (const f of files) {
      attachments.push(await readBrowserFileAsAttachment(f));
    }
    addComposerAttachments(attachments);
  });
}

function clearComposerAttachments() {
  state.composerAttachments = [];
  renderComposerAttachments();
}

function pushEvent(text, cls = "", detail) {
  const sid = state.eventRouteSessionId || state.liveRunSessionId;
  if (state.pushEventMountOverride) {
    const line = pushEventIn(state.pushEventMountOverride, text, cls, detail);
    if (sid) syncTimelineCacheForSession(sid);
    return line;
  }
  if (shouldFoldIntoRunActivity(text, cls)) {
    ensureRunActivity();
    trackRunActivityStats(text, cls);
    const line = pushEventIn(state.runActivityBody, text, cls, detail);
    if (sid) syncTimelineCacheForSession(sid);
    return line;
  }
  const line = pushEventIn(getTimelineMount(), text, cls, detail);
  if (isTimelineRootMessage(text)) {
    line.classList.add("user-prompt");
    markTimelineEventUserPrompt(line);
    normalizeTimelineTurnOrder();
  }
  if (sid) syncTimelineCacheForSession(sid);
  return line;
}

function groupRestoredTurns(messages) {
  const turns = [];
  let current = null;
  for (const msg of messages) {
    if (msg.role === "user") {
      if (current) turns.push(current);
      current = { user: msg, msgs: [] };
    } else if (msg.role === "assistant" || msg.role === "tool") {
      if (!current) current = { user: null, msgs: [] };
      current.msgs.push(msg);
    }
  }
  if (current) turns.push(current);
  return turns;
}

function turnsWithDedupedPrompts(messages) {
  const turns = groupRestoredTurns(messages);
  if (turns.length < 2) return turns;
  const out = [];
  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(turn);
      continue;
    }
    const prevPrompt = formatUserPromptForDisplay(plainUserContent(prev.user?.content).trim());
    const currPrompt = formatUserPromptForDisplay(plainUserContent(turn.user?.content).trim());
    const prevHasContent = prev.msgs.length > 0;
    const prevHasAssistant = prev.msgs.some((msg) => msg.role === "assistant");
    const currHasAssistant = turn.msgs.some((msg) => msg.role === "assistant");
    // Some runtimes can persist an empty "preview turn" plus the real turn.
    // Collapse adjacent duplicates so restore keeps one prompt and one activity block.
    if (prevPrompt && currPrompt && prevPrompt === currPrompt && !prevHasContent && currHasAssistant) {
      out[out.length - 1] = turn;
      continue;
    }
    // Empty echo turn sandwiched between real turns (common with external runtimes).
    if (
      prevPrompt &&
      currPrompt &&
      prevPrompt === currPrompt &&
      !prevHasAssistant &&
      !currHasContent &&
      currHasAssistant
    ) {
      continue;
    }
    out.push(turn);
  }
  return out;
}

function normalizeUserPromptLabel(text) {
  return formatUserPromptForDisplay(
    String(text || "")
      .replace(/^开始执行[:：]\s*/, "")
      .trim(),
  );
}

function collectExpectedRestorePrompts(messages, sessionId) {
  const turns = turnsWithDedupedPrompts(messages);
  const labels = turns
    .map((turn) => {
      const rawUser = plainUserContent(turn.user?.content).trim();
      if (!rawUser || isTeamDispatchFollowupMessage(rawUser)) return "";
      if (rawUser.startsWith("Conversation summary")) return "";
      return normalizeUserPromptLabel(rawUser);
    })
    .filter(Boolean);
  if (!labels.length) {
    const preview = normalizeUserPromptLabel(sessionPreviewForRestore(sessionId));
    if (preview) labels.push(preview);
  }
  return labels;
}

/** Consecutive duplicate user prompts break turn-order validation and duplicate 开始执行 rows. */
function dedupeConsecutiveStructuredPrompts(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    const prev = out[out.length - 1];
    if (
      entry?.type === "event" &&
      entry.isUserPrompt &&
      prev?.type === "event" &&
      prev.isUserPrompt &&
      normalizeUserPromptLabel(prev.text) === normalizeUserPromptLabel(entry.text)
    ) {
      continue;
    }
    out.push(entry);
  }
  return out;
}

function sanitizeStructuredTimelineCache(sessionId) {
  if (!sessionId) return;
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return;
  const entries = ensureTimelineEntries(timelineState);
  const deduped = dedupeConsecutiveStructuredPrompts(entries);
  if (deduped.length !== entries.length) {
    timelineState.entries = deduped;
    touchTimelineState(sessionId);
  }
}

function sessionUsesExternalRuntime(sessionId, messages = []) {
  const mapped = state.runtimeBySession.get(sessionId);
  if (mapped && mapped !== "forge") return true;
  return !groupRestoredTurns(messages).some((turn) =>
    turn.msgs.some(
      (msg) => msg.role === "assistant" && (msg.tool_calls?.length ?? 0) > 0,
    ),
  );
}

function findRunActivityCacheInsertIndex(entries, turnIndex) {
  if (!Array.isArray(entries)) return 0;
  let promptCount = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.type !== "event" || !entry.isUserPrompt) continue;
    if (promptCount === turnIndex) {
      let j = i + 1;
      while (j < entries.length) {
        const type = entries[j].type;
        if (type === "run_activity" || type === "conclusion") return j;
        if (type === "event" && entries[j].isUserPrompt) break;
        j += 1;
      }
      return j;
    }
    promptCount += 1;
  }
  return entries.length;
}

function createRestoredRunActivityShellElement(saved = {}) {
  const details = document.createElement("details");
  details.className = "run-activity";
  details.dataset.timelineEntryId = timelineEntryId();
  // Restored process folds stay collapsed unless the snapshot explicitly kept them open.
  details.open = saved.open === true;
  details.innerHTML = `
    <summary class="run-activity-summary">
      <span class="run-activity-chevron" aria-hidden="true">›</span>
      <span class="run-activity-label">${escapeHtml(saved.label || "已处理")}</span>
      <span class="run-activity-meta">${escapeHtml(saved.meta || "")}</span>
    </summary>
    <div class="run-activity-body"></div>`;
  bindRunActivityPin(details);
  bindRunActivityScroll(details.querySelector(".run-activity-body"), details);
  return details;
}

function insertRestoredRunActivityShell(mount, turnIndex, saved = {}) {
  if (!mount) return null;
  const shell = createRestoredRunActivityShellElement(saved);
  shell.dataset.turnIndex = String(turnIndex);
  const prompts = mount.querySelectorAll(":scope > .event.user-prompt");
  const prompt = prompts[turnIndex];
  if (prompt) {
    let insertBefore = prompt.nextElementSibling;
    while (
      insertBefore &&
      !insertBefore.matches("details.run-activity, .run-conclusion, .event.user-prompt")
    ) {
      insertBefore = insertBefore.nextElementSibling;
    }
    if (insertBefore) mount.insertBefore(shell, insertBefore);
    else prompt.insertAdjacentElement("afterend", shell);
  } else {
    const anchor = findTurnPromptDomAnchor(mount, turnIndex);
    if (anchor) mount.insertBefore(shell, anchor);
    else mount.appendChild(shell);
  }
  return shell;
}

/** Normalize runtime tool args where ACP may nest payloads under item/input/arguments. */
function normalizeToolArgsEnvelope(args) {
  const a = args && typeof args === "object" ? args : {};
  const roots = [a];
  if (a.item && typeof a.item === "object") roots.push(a.item);
  if (a.input && typeof a.input === "object") roots.push(a.input);
  if (a.arguments && typeof a.arguments === "object") roots.push(a.arguments);
  if (typeof a.arguments === "string") {
    try {
      const parsed = JSON.parse(a.arguments);
      if (parsed && typeof parsed === "object") roots.push(parsed);
    } catch {
      /* ignore non-JSON arguments */
    }
  }
  if (a.item?.input && typeof a.item.input === "object") roots.push(a.item.input);
  if (a.item?.arguments && typeof a.item.arguments === "object") roots.push(a.item.arguments);
  if (typeof a.item?.arguments === "string") {
    try {
      const parsed = JSON.parse(a.item.arguments);
      if (parsed && typeof parsed === "object") roots.push(parsed);
    } catch {
      /* ignore non-JSON arguments */
    }
  }
  const merged = {};
  for (const root of roots) Object.assign(merged, root);
  return merged;
}

/** Read the first non-empty string arg from common key aliases. */
function readToolArgString(args, keys) {
  const a = normalizeToolArgsEnvelope(args);
  for (const key of keys) {
    const value = a[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/** Map ACP / external-runtime tool titles to forge tool keys. */
function normalizeRuntimeToolKey(name) {
  const compact = String(name || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (
    compact === "editfile" ||
    compact === "strreplace" ||
    compact === "searchreplace" ||
    compact === "applypatch" ||
    compact === "edit"
  ) {
    return "write_patch";
  }
  if (
    compact === "write" ||
    compact === "writefile" ||
    compact === "createfile"
  ) {
    return "write_file";
  }
  if (compact === "read" || compact === "readfile") return "read_file";
  return String(name || "");
}

function isFileEditRuntimeTool(name) {
  const key = normalizeRuntimeToolKey(name);
  return key === "write_patch" || key === "write_file";
}

function extractToolCallPath(_name, args) {
  const normalized = normalizeToolArgsEnvelope(args);
  const direct = readToolArgString(normalized, [
    "path",
    "file_path",
    "filePath",
    "target_file",
    "targetFile",
    "relative_path",
    "relativePath",
    "filename",
    "fileName",
    "targetPath",
    "uri",
    "file",
  ]);
  if (direct) return direct;
  return deepFindPathInObject(normalized);
}

function deepFindPathInObject(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindPathInObject(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const text = raw.trim();
    if (/^(path|file|target|relative)/i.test(key) && text.includes(".")) return text;
    if (
      WORKSPACE_FILE_EXT_RE.test(text) &&
      text.length < 280 &&
      !text.includes("\n")
    ) {
      return text;
    }
  }
  for (const raw of Object.values(value)) {
    if (raw && typeof raw === "object") {
      const found = deepFindPathInObject(raw, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function recordGeneratedImagePathsFromText(text) {
  for (const path of extractImagePathsFromText(text)) {
    recordRunModifiedFile(path, { meta: "已生成图片" });
  }
}

function buildReplaceStringsDiffPreview(path, oldStr, newStr) {
  const oldLines = String(oldStr ?? "").split("\n");
  const newLines = String(newStr ?? "").split("\n");
  const oldCount = Math.max(oldLines.length, 1);
  const newCount = Math.max(newLines.length, 1);
  const header = `--- a/${path}\n+++ b/${path}\n@@ -1,${oldCount} +1,${newCount} @@\n`;
  const body = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
  return header + (body ? `${body}\n` : "");
}

function extractPatchFromRuntimeToolArgs(name, args) {
  const path = extractToolCallPath(name, args);
  if (!path) return null;
  const a = normalizeToolArgsEnvelope(args);
  const key = normalizeRuntimeToolKey(name);

  if (key === "write_patch") {
    const unifiedDiff = readToolArgString(a, ["unified_diff", "unifiedDiff", "diff"]);
    if (unifiedDiff) return { path, unifiedDiff };
    const oldStr = readToolArgString(a, [
      "old_string",
      "oldString",
      "old_text",
      "oldText",
    ]);
    const newStr = readToolArgString(a, [
      "new_string",
      "newString",
      "new_text",
      "newText",
    ]);
    if (oldStr || newStr) {
      return { path, unifiedDiff: buildReplaceStringsDiffPreview(path, oldStr, newStr) };
    }
    const edit = readToolArgString(a, ["code_edit", "codeEdit", "edit", "patch"]);
    if (edit) return { path, unifiedDiff: buildCreateFileDiffPreview(path, edit) };
  }

  if (key === "write_file") {
    const content = a.contents ?? a.content ?? a.text ?? a.body ?? null;
    if (content != null) {
      return { path, unifiedDiff: buildCreateFileDiffPreview(path, String(content)) };
    }
  }

  const oldStr = readToolArgString(a, ["old_string", "oldString"]);
  const newStr = readToolArgString(a, ["new_string", "newString"]);
  if (oldStr || newStr) {
    return { path, unifiedDiff: buildReplaceStringsDiffPreview(path, oldStr, newStr) };
  }
  const content = a.contents ?? a.content ?? a.text ?? null;
  if (content != null) {
    return { path, unifiedDiff: buildCreateFileDiffPreview(path, String(content)) };
  }
  return null;
}

function extractPatchFromToolResult(resultStr) {
  const raw = String(resultStr || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const path = readToolArgString(parsed, ["path", "file_path", "filePath"]);
    const unifiedDiff = readToolArgString(parsed, ["unifiedDiff", "unified_diff", "diff"]);
    if (path && unifiedDiff) return { path, unifiedDiff };
  } catch {
    /* not JSON */
  }
  if (raw.includes("@@") && (raw.includes("\n+") || raw.includes("\n-"))) {
    const pathMatch = raw.match(/^\+\+\+ b\/(.+)$/m);
    return { path: pathMatch?.[1] || "", unifiedDiff: raw };
  }
  const pathHint =
    raw.match(/(?:^|\n)(?:Updated|Edited|Wrote|Created|Modified)\s+[`"']?([^\s`"']+)/i)?.[1] ||
    raw.match(/([^\s`"']+\.[A-Za-z0-9]{1,8})(?:\s|$)/)?.[1] ||
    "";
  if (pathHint && pathHint.includes(".")) {
    return { path: pathHint, unifiedDiff: "" };
  }
  return null;
}

/** Short human summary for a tool call line: file path / pattern / command. */
function toolCallSummary(name, args) {
  const a = normalizeToolArgsEnvelope(args);
  const item = a.item && typeof a.item === "object" ? a.item : {};
  if (name === "grep") {
    return [a.pattern, a.glob].filter(Boolean).map(String).join(" · ");
  }
  if (name === "run_command" || a.type === "commandExecution" || item.type === "commandExecution") {
    return String(a.command ?? item.command ?? a.cmd ?? "").trim();
  }
  if (name === "localShellCall" || a.type === "localShellCall") {
    return String(a.command ?? item.command ?? a.cmd ?? "").trim();
  }
  if (name === "mcpToolCall" || a.type === "mcpToolCall") {
    const server = a.serverName || a.server || item.serverName || item.server;
    const tool = a.toolName || a.name || item.toolName || item.name;
    return [server, tool].filter(Boolean).map(String).join(" · ");
  }
  if (name === "move_file" || name === "rename_file") {
    if (a.from || a.to) return `${a.from ?? "?"} → ${a.to ?? "?"}`;
  }
  const path = extractToolCallPath(name, args);
  if (path) return path;
  return "";
}

function displayToolName(name, args) {
  const a = normalizeToolArgsEnvelope(args);
  const type = String(a.type || name || "");
  const raw = String(name || type || "tool");
  const runtimeKey = normalizeRuntimeToolKey(raw);
  if (raw === "mcpToolCall" || type === "mcpToolCall") return "调用 MCP 工具";
  if (raw === "localShellCall" || type === "localShellCall") return "执行命令";
  if (raw === "commandExecution" || type === "commandExecution") return "执行命令";
  if (raw === "read_file" || raw === "readFile" || runtimeKey === "read_file") return "读取文件";
  if (raw === "list_dir" || raw === "listFiles") return "查看目录";
  if (raw === "grep" || raw === "search") return "搜索";
  if (raw === "run_command") return "执行命令";
  if (raw === "write_patch" || runtimeKey === "write_patch") return "编辑文件";
  if (raw === "write_file" || runtimeKey === "write_file") return "写入文件";
  return raw;
}

function actionToolName(name, args, done) {
  const a = normalizeToolArgsEnvelope(args);
  const type = String(a.type || name || "");
  const raw = String(name || type || "tool");
  const runtimeKey = normalizeRuntimeToolKey(raw);
  const prefix = done ? "已" : "正在";
  if (raw === "mcpToolCall" || type === "mcpToolCall") return `${prefix}调用 MCP 工具`;
  if (raw === "localShellCall" || type === "localShellCall") return done ? "已运行" : "正在运行";
  if (raw === "commandExecution" || type === "commandExecution") return done ? "已运行" : "正在运行";
  if (raw === "read_file" || raw === "readFile" || runtimeKey === "read_file") {
    return done ? "已读取" : "正在读取";
  }
  if (raw === "list_dir" || raw === "listFiles") return done ? "已查看目录" : "正在查看目录";
  if (raw === "grep" || raw === "search") return done ? "已搜索" : "正在搜索";
  if (raw === "run_command") return done ? "已运行" : "正在运行";
  if (raw === "write_patch" || raw === "write_file" || isFileEditRuntimeTool(raw)) {
    return done ? "已编辑" : "正在编辑";
  }
  return `${prefix}${displayToolName(name, args)}`;
}

function diffStatsFromUnifiedDiff(unifiedDiff) {
  let adds = 0;
  let dels = 0;
  for (const line of String(unifiedDiff || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) dels += 1;
  }
  return { adds, dels };
}

function patchStatsHtml(unifiedDiff) {
  const { adds, dels } = diffStatsFromUnifiedDiff(unifiedDiff);
  return `<span class="inline-diff-stat inline-diff-add">+${adds}</span><span class="inline-diff-stat inline-diff-del">-${dels}</span>`;
}

function diffStatsHtml(adds, dels) {
  return `<span class="inline-diff-stat inline-diff-add">+${Number(adds || 0)}</span><span class="inline-diff-stat inline-diff-del">-${Number(dels || 0)}</span>`;
}

/** Workspace file the tool touched (used to open the real file on click). */
function toolCallFilePath(name, args) {
  const a = normalizeToolArgsEnvelope(args);
  if (name === "grep" || name === "run_command" || name === "list_dir" || name === "echo") {
    return "";
  }
  const raw =
    name === "move_file" || name === "rename_file"
      ? a.to ?? a.from
      : extractToolCallPath(name, args) || a.path;
  if (typeof raw !== "string" || !raw) return "";
  return normalizeWorkspaceRelPath(getActiveProject()?.cwd, raw);
}

function truncateToolSummary(summary, max = 64) {
  const str = String(summary || "");
  if (str.length <= max) return str;
  // Paths: keep the tail (file name); patterns/commands: keep the head.
  return str.includes("/") ? `…${str.slice(-max)}` : `${str.slice(0, max)}…`;
}

function toolLineText(name, args, done, talentOverride) {
  const patch = extractPatchFromToolCall(name, args, "");
  const patchPath = patch?.path ? normalizeWorkspaceRelPath(getActiveProject()?.cwd, patch.path) : "";
  const summary = truncateToolSummary(patchPath || toolCallSummary(name, args), patchPath ? 72 : 64);
  const patchStats = patch?.unifiedDiff ? diffStatsFromUnifiedDiff(patch.unifiedDiff) : null;
  const stats = patchStats && done ? ` +${patchStats.adds} -${patchStats.dels}` : "";
  const core = `${actionToolName(name, args, done)}${summary ? ` ${summary}` : ""}${stats}`;
  const labeled = formatTalentStepLabel(core, undefined, talentOverride);
  return `${done ? "✓" : "⏺"} ${labeled}`;
}

/** Render tool result for the detail pane: unwrap known JSON envelopes into readable text. */
function formatToolResultForDetail(name, result) {
  const raw = String(result ?? "");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.content === "string" && name === "read_file") {
        const head = `path: ${parsed.path ?? ""} · 共 ${parsed.totalLines ?? "?"} 行 · 预览自第 ${parsed.previewFromLine ?? 1} 行起 ${parsed.previewLineCount ?? "?"} 行`;
        return `${head}\n\n${parsed.content}`;
      }
      if (name === "grep" && parsed.matches != null) {
        const matches =
          typeof parsed.matches === "string"
            ? parsed.matches
            : JSON.stringify(parsed.matches, null, 2);
        return `匹配 ${parsed.matchCount ?? "?"} 处\n\n${matches}`;
      }
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    /* not JSON — show raw */
  }
  return raw;
}

function buildToolDetailContent(name, args, result) {
  const sections = [`【参数】\n${JSON.stringify(args ?? {}, null, 2)}`];
  const formatted = formatToolResultForDetail(name, result);
  if (formatted) sections.push(`【结果】\n${formatted}`);
  return sections.join("\n\n");
}

function buildToolEventDetail(name, args, result, talentOverride) {
  const summary = toolCallSummary(name, args);
  const patch = extractPatchFromToolCall(name, args, String(result ?? ""));
  const t = talentOverride || getForegroundTalent();
  const displayName = displayToolName(name, args);
  const title = t
    ? `${t.displayName} · ${displayName}${summary ? ` · ${summary}` : ""}`
    : `Tool · ${displayName}${summary ? ` · ${summary}` : ""}`;
  return {
    title,
    meta: summary || (t ? t.role || "工具调用" : "工具调用"),
    content: buildToolDetailContent(name, args, result),
    toolFile: toolCallFilePath(name, args),
    ...(patch ? { patch } : {}),
  };
}

/** Stable per-call key — callId when present (parallel tools), else session+name. */
function toolLineKey(name, callId) {
  if (callId) return `id:${callId}`;
  return `nm:${getActiveEventSessionId() || "_anonymous"}:${name}`;
}

/** One line per tool call: created at tool_start, completed in place at tool_end. */
function beginToolLine(name, args, callId, talentOverride) {
  const detail = buildToolEventDetail(name, args, null, talentOverride);
  if (!state.stepToolGroupBody?.isConnected) beginStepToolGroup();
  const mount = getToolEventMount();
  trackRunActivityStats(toolLineText(name, args, false, talentOverride), "tool-event is-running");
  const line = pushEventIn(mount, toolLineText(name, args, false, talentOverride), "tool-event is-running", detail);
  bumpStepToolGroupCount();
  const liveLabel = toolLineText(name, args, false, talentOverride).replace(/^⏺\s*/, "");
  const key = toolLineKey(name, callId);
  if (isFileEditRuntimeTool(name)) {
    const editPath = extractToolCallPath(name, args);
    if (editPath) recordRunModifiedFile(editPath, {});
    else {
      scheduleWorkspaceTurnDiffPoll(key);
      if (state.runActivityStats) {
        state.runActivityStats.lastStatus = liveLabel;
        updateRunActivitySummary();
      }
    }
  } else if (state.runActivityStats) {
    state.runActivityStats.lastStatus = liveLabel;
    updateRunActivitySummary();
  }
  if (line) {
    // Marker must land in the timeline cache too, so it survives innerHTML repaints.
    line.dataset.pendingTool = key;
    line.dataset.toolName = displayToolName(name, args);
    const cacheSid = state.eventRouteSessionId || state.liveRunSessionId;
    if (cacheSid) syncTimelineCacheForSession(cacheSid);
  }
  state.pendingToolLines.set(key, { name, args, line, detail, talentOverride });
}

/** Recover the in-flight tool line after an innerHTML repaint replaced the node. */
function findPendingToolLineInDom(key) {
  const body = state.runActivityBody;
  if (!body?.querySelectorAll) return null;
  const events = body.querySelectorAll(".event.clickable[data-pending-tool]");
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].getAttribute("data-pending-tool") === key) {
      return events[i];
    }
  }
  return null;
}

function completeToolLine(name, result, callId) {
  const key = toolLineKey(name, callId);
  clearWorkspaceTurnDiffPoll(key);
  const pending = state.pendingToolLines.get(key);
  state.pendingToolLines.delete(key);
  if (pending && (pending.name === name || callId)) {
    const line = pending.line?.isConnected
      ? pending.line
      : findPendingToolLineInDom(key);
    if (line) {
      // detail object is shared by reference with the event-detail stores.
      pending.detail.content = buildToolDetailContent(name, pending.args, result);
      line.textContent = toolLineText(pending.name, pending.args, true, pending.talentOverride);
      line.classList.remove("is-running");
      line.classList.add("is-done");
      line.removeAttribute("data-pending-tool");
      const patchInfo = extractPatchFromToolCall(
        name,
        pending.args,
        String(result ?? ""),
      );
      recordGeneratedImagePathsFromText(result);
      if (patchInfo) {
        pending.detail.patch = patchInfo;
        const relPath = normalizeWorkspaceRelPath(getActiveProject()?.cwd, patchInfo.path);
        if (relPath) recordRunModifiedFile(relPath, { patch: patchInfo });
      } else if (isFileEditRuntimeTool(pending.name)) {
        const relPath = normalizeWorkspaceRelPath(
          getActiveProject()?.cwd,
          extractToolCallPath(pending.name, pending.args),
        );
        if (relPath) recordRunModifiedFile(relPath, {});
      }
      const inlineDiff = buildInlineDiffHtml(patchInfo);
      if (inlineDiff) line.insertAdjacentHTML("beforeend", inlineDiff);
      const serialized = serializeEventDetail(pending.detail);
      if (serialized) line.dataset.forgeDetail = serialized;
      const cacheSid = state.eventRouteSessionId || state.liveRunSessionId;
      if (cacheSid && line.dataset.timelineNodeId) {
        const serialized = serializeEventDetail(pending.detail);
        updateTimelineEventEntry(cacheSid, line.dataset.timelineNodeId, {
          text: toolLineText(pending.name, pending.args, true, pending.talentOverride),
          className: "tool-event is-done",
          hasDetail: true,
          forgeDetail: serialized || "",
        });
      }
      trackRunActivityStats(`✓ ${name}`);
      if (state.runActivityStats) {
        const doneLabel = toolLineText(pending.name, pending.args, true, pending.talentOverride).replace(
          /^✓\s*/,
          "",
        );
        state.runActivityStats.lastStatus = enrichBareEditLiveLabel(doneLabel);
        if (patchInfo?.path) syncFileEditLiveLabel(patchInfo.path, true);
      }
      updateRunActivitySummary();
      if (cacheSid) syncTimelineCacheForSession(cacheSid);
      if (runActivityBodyShouldAutoScroll()) scheduleRunViewScroll();
      maybeCollapseStepToolGroup();
      return;
    }
  }
  // Start line lost (view switch mid-tool) — emit a single completed line.
  if (!state.stepToolGroupBody?.isConnected) beginStepToolGroup();
  pushEventIn(
    getToolEventMount(),
    toolLineText(name, {}, true),
    "tool-event is-done",
    buildToolEventDetail(name, {}, result),
  );
  bumpStepToolGroupCount();
  maybeCollapseStepToolGroup();
}

/** Collapsible inline diff under a patch tool line — first lines only; full diff stays in the right panel. */
function buildInlineDiffHtml(patch, maxLines = 10) {
  if (!patch?.unifiedDiff) return "";
  const lines = String(patch.unifiedDiff).split("\n");
  const shown = lines.slice(0, maxLines);
  const rest = lines.length - shown.length;
  const more = rest > 0
    ? `<div class="diff-line diff-more">… 还有 ${rest} 行，点击查看完整 diff</div>`
    : "";
  const base = String(patch.path || "").split("/").pop() || "";
  return `<details class="tool-inline-diff">
    <summary class="tool-inline-diff-head">
      <span class="inline-diff-chevron" aria-hidden="true">${sidebarIcon("chevron-right", "inline-diff-chevron-svg")}</span>
      <span class="inline-diff-file">${escapeHtml(base)}</span>
      ${patchStatsHtml(patch.unifiedDiff)}
    </summary>
    <div class="tool-inline-diff-body">${renderDiffLinesHtml(shown.join("\n"))}${more}</div>
  </details>`;
}

function buildCreateFileDiffPreview(path, content) {
  const lines = String(content ?? "").split("\n");
  const header = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`;
  return header + lines.map((line) => `+${line}`).join("\n");
}

function extractPatchFromToolCall(name, args, resultStr) {
  const a = normalizeToolArgsEnvelope(args);
  let applied = false;
  try {
    const r = JSON.parse(String(resultStr || "{}"));
    applied = r.ok === true && r.status !== "pending_confirmation";
  } catch {
    /* ignore */
  }
  if (isFileEditRuntimeTool(name) && String(resultStr || "").trim()) {
    applied = true;
  }

  const fromArgs = extractPatchFromRuntimeToolArgs(name, args);
  if (fromArgs) {
    return {
      ...fromArgs,
      applied: applied || isFileEditRuntimeTool(name),
    };
  }

  const fromResult = extractPatchFromToolResult(resultStr);
  if (fromResult?.unifiedDiff) {
    const path =
      fromResult.path ||
      extractToolCallPath(name, args) ||
      readToolArgString(a, ["path", "file_path"]);
    if (path) {
      return { path, unifiedDiff: fromResult.unifiedDiff, applied: applied || true };
    }
  }

  const effectiveName = normalizeRuntimeToolKey(name);
  if (name === "write_patch" || effectiveName === "write_patch") {
    const path = a.path || extractToolCallPath(name, args);
    const unifiedDiff = a.unified_diff;
    if (!path || !unifiedDiff) return null;
    return { path, unifiedDiff, applied };
  }
  if (name === "write_file" || effectiveName === "write_file") {
    const path = a.path || extractToolCallPath(name, args);
    if (!path || a.content == null) return null;
    return {
      path,
      unifiedDiff: buildCreateFileDiffPreview(path, a.content),
      applied,
    };
  }
  return null;
}

function isTeamDispatchFollowupMessage(raw) {
  return String(raw || "").trim().startsWith("[团队派活结果]");
}

function parseTeamDispatchSections(raw) {
  const text = String(raw || "");
  const sections = [];
  const re =
    /###\s*\d+\.\s*([^\n(@]+?)\s*\(@([\p{L}\p{N}_-]+)\s*,\s*([^)]+)\)\s*\nAssigned task:\s*([\s\S]*?)\nResult:\s*([\s\S]*?)(?=\n###\s*\d+\.|$)/gu;
  let match = re.exec(text);
  while (match) {
    sections.push({
      displayName: match[1].trim(),
      mention: match[2].trim(),
      role: match[3].trim(),
      task: match[4].trim(),
      result: match[5].trim(),
    });
    match = re.exec(text);
  }
  return sections;
}

function talentInfoFromRoster(mention) {
  const key = String(mention || "").toLowerCase();
  const row = (state.talentsRoster ?? []).find(
    (t) => String(t.mention || "").toLowerCase() === key,
  );
  if (!row) return null;
  return {
    mention: row.mention,
    displayName: row.displayName,
    role: row.role,
    emoji: row.emoji,
    avatar: row.avatar,
  };
}

function structuredTimelineShouldReload(sessionId) {
  const timelineState = getNormalTimelineState(sessionId, false);
  if (!timelineState) return false;
  return ensureTimelineEntries(timelineState).some(
    (entry) =>
      entry.type === "event" &&
      entry.isUserPrompt &&
      String(entry.text || "").includes("[团队派活结果]"),
  );
}

function appendRestoredSubagentCard(talent, taskLabel, resultText) {
  ensureRunActivity();
  if (!state.runActivityBody || !talent?.mention) return;
  const details = document.createElement("details");
  details.className = "run-activity subagent-talent-activity";
  details.open = false;
  details.dataset.talentMention = normalizeTalentMention(talent.mention);
  const emoji = talent.emoji || "🧑";
  const taskShort = truncateToolSummary(taskLabel, 48);
  details.innerHTML = `
    <summary class="run-activity-summary">
      <span class="run-activity-chevron" aria-hidden="true">›</span>
      <span class="run-activity-label">${escapeHtml(`${emoji} ${talent.displayName} · 完成`)}</span>
      <span class="run-activity-meta">${escapeHtml(taskShort)}</span>
    </summary>
    <div class="run-activity-body subagent-talent-body"></div>
  `;
  bindRunActivityPin(details);
  const body = details.querySelector(".subagent-talent-body");
  bindRunActivityScroll(body, details);
  state.runActivityBody.appendChild(details);
  const sid = getActiveEventSessionId();
  if (sid) {
    recordSubagentShellEntry(sid, talent, taskLabel, null);
    syncSubagentShellEntry(sid, talent, {
      finalized: true,
      label: `${emoji} ${talent.displayName} · 完成`,
      meta: taskShort,
      open: false,
    });
  }
  if (taskLabel) {
    pushEventIn(body, `▶ ${talent.displayName} · ${truncateToolSummary(taskLabel, 80)}`, "status");
  }
  pushEventIn(body, `✓ ${talent.displayName} 完成`, "done", {
    title: `${talent.displayName} (@${talent.mention})`,
    meta: talent.role || "人才",
    content: resultText,
  });
}

function renderRestoredTeamDispatchTurn(turn, turnState) {
  const sid = state.viewingTimelineSessionId || sessionRuns?.getViewingSessionId();
  const rawUser = plainUserContent(turn.user?.content).trim();
  const sections = parseTeamDispatchSections(rawUser);

  pushEvent("◇ 团队任务已完成，负责人继续汇总…", "status");

  beginRestoredRunActivity();

  for (const section of sections) {
    const rosterTalent = talentInfoFromRoster(section.mention);
    const talent = {
      mention: section.mention,
      displayName: rosterTalent?.displayName || section.displayName,
      role: rosterTalent?.role || section.role,
      emoji: rosterTalent?.emoji,
      avatar: rosterTalent?.avatar,
    };
    appendRestoredSubagentCard(talent, section.task, section.result);
  }

  pushEventIn(state.runActivityBody, "◇ 团队负责人汇总中…", "status");

  let finalText = "";
  let hadActivity = sections.length > 0;

  for (const msg of turn.msgs) {
    if (msg.role === "tool") continue;
    if (msg.role !== "assistant") continue;

    if (msg.reasoning_content || msg.tool_calls?.length) {
      hadActivity = true;
    }

    if (msg.reasoning_content) {
      renderRestoredThinking(msg.reasoning_content);
      if (state.runActivityStats) {
        state.runActivityStats.thinkingChars += String(msg.reasoning_content).length;
      }
    }

    if (msg.tool_calls?.length) {
      if (state.runActivityStats) {
        state.runActivityStats.step += 1;
      }
      const stepText = plainUserContent(msg.content).trim();
      if (stepText) {
        appendRestoredAssistantText(stepText);
      }

      for (const tc of msg.tool_calls) {
        const name = tc.function?.name ?? "tool";
        if (name === "update_plan") {
          let args = {};
          try {
            args = JSON.parse(tc.function?.arguments ?? "{}");
          } catch {
            args = {};
          }
          if (Array.isArray(args.items)) {
            turnState.restoredPlan = args.items;
            renderPlanCard(args.items, turnState.planCardTitle || "任务清单");
          }
          continue;
        }
        if (name === "spawn_agent") continue;

        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          args = {};
        }

        const toolMsg = turn.msgs.find(
          (m) => m.role === "tool" && m.tool_call_id === tc.id,
        );
        const result = toolMsg?.content ?? "";

        if (!state.stepToolGroupBody?.isConnected) beginStepToolGroup();
        const restoredLine = pushEventIn(
          getToolEventMount(),
          toolLineText(name, args, true),
          "tool-event is-done",
          buildToolEventDetail(name, args, result),
        );
        bumpStepToolGroupCount();
        trackRunActivityStats(`✓ ${name}`);

        const patchInfo = extractPatchFromToolCall(name, args, result);
        if (patchInfo) {
          pushRestoredPatchEvent(patchInfo);
          const inlineDiff = buildInlineDiffHtml(patchInfo);
          if (inlineDiff) restoredLine?.insertAdjacentHTML("beforeend", inlineDiff);
        }
      }
    } else {
      const answer = plainUserContent(msg.content).trim();
      if (answer) finalText = answer;
    }
  }

  if (hadActivity) {
    pushEventIn(state.runActivityBody, "执行完成", "done");
    finalizeRunActivity();
  }
  if (finalText || state.runPatches.size || hadActivity) {
    renderRunConclusion(finalText, sid);
  }
}

function endStepToolGroup() {
  const details = state.stepToolGroupEl;
  if (!details?.isConnected) {
    state.stepToolGroupEl = null;
    state.stepToolGroupBody = null;
    state.stepToolGroupCount = 0;
    return;
  }
  const n =
    state.stepToolGroupCount ||
    details.querySelectorAll(".step-tool-group-body .tool-event").length;
  updateStepToolGroupSummary(details, n);
  details.open = false;
  state.stepToolGroupEl = null;
  state.stepToolGroupBody = null;
  state.stepToolGroupCount = 0;
}

function createStepToolGroupElement(open = false) {
  const details = document.createElement("details");
  details.className = "step-tool-group";
  details.open = open;
  details.innerHTML = `
    <summary class="step-tool-group-summary">工具操作</summary>
    <div class="step-tool-group-body"></div>`;
  return details;
}

function isStructuredToolGroupChild(entry) {
  if (!entry) return false;
  if (entry.type === "codex_activity") return true;
  return entry.type === "event" && /\btool-event\b/.test(String(entry.className || ""));
}

function stepToolGroupHasCodexActivity(details) {
  return Boolean(details?.querySelector?.(".step-tool-group-body .codex-activity-chip"));
}

function updateStepToolGroupSummary(details = state.stepToolGroupEl, count = state.stepToolGroupCount) {
  const summary = details?.querySelector?.(".step-tool-group-summary");
  if (!summary) return;
  const n =
    count ||
    details.querySelectorAll(".step-tool-group-body .tool-event, .step-tool-group-body .codex-activity-chip").length;
  summary.textContent = n > 0 ? `工具操作 · ${n}` : "工具操作";
}

function beginStepToolGroup() {
  if (state.stepToolGroupBody?.isConnected) return;
  ensureRunActivity();
  const body = state.runActivityBody;
  if (!body) return;
  const details = createStepToolGroupElement(false);
  body.appendChild(details);
  state.stepToolGroupEl = details;
  state.stepToolGroupBody = details.querySelector(".step-tool-group-body");
  state.stepToolGroupCount = 0;
}

function bumpStepToolGroupCount() {
  state.stepToolGroupCount = (state.stepToolGroupCount || 0) + 1;
  updateStepToolGroupSummary();
}

function maybeCollapseStepToolGroup() {
  const body = state.stepToolGroupBody;
  if (
    !body?.isConnected ||
    body.querySelector(".tool-event.is-running, .codex-activity-chip.is-running")
  ) return;
  if (state.stepToolGroupEl) state.stepToolGroupEl.open = false;
}

function getToolEventMount() {
  if (state.pushEventMountOverride) return state.pushEventMountOverride;
  if (state.stepToolGroupBody?.isConnected) return state.stepToolGroupBody;
  ensureRunActivity();
  if (state.runActivityBody) {
    beginStepToolGroup();
    return state.stepToolGroupBody || state.runActivityBody;
  }
  return getTimelineMount();
}

function appendRestoredAssistantText(text) {
  const trimmed = collapseRepeatedCodexText(text);
  if (!trimmed) return;
  const sid = getActiveEventSessionId();
  if (shouldSkipCodexCommentary(sid, trimmed)) return;
  if (sid) {
    const list = state.stepNarrativesBySession.get(sid) || [];
    list.push(trimmed);
    state.stepNarrativesBySession.set(sid, list);
  }
  endStepToolGroup();
  ensureRunActivity({ force: true });
  const mount = state.runActivityBody || state.currentStepBody || $("timeline");
  const wrap = document.createElement("div");
  wrap.className = "event step-narrative done";
  wrap.innerHTML = `<div class="step-narrative-text" role="note"></div>`;
  const host = wrap.querySelector(".step-narrative-text");
  if (host) {
    if (trimmed.includes("\n") || /^#+\s|^\s*[-*]/m.test(trimmed)) {
      renderConclusionMarkdown(host, trimmed);
    } else {
      host.textContent = trimmed;
    }
  }
  mount.appendChild(wrap);
  if (sid) {
    recordStepNarrativeEntry(
      sid,
      trimmed,
      Boolean(host?.querySelector(".md-preview")),
    );
  }
  beginStepToolGroup();
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDedupeSentence(text) {
  return String(text || "")
    .replace(/[“”"'`‘’（）()【】\[\]《》<>]/g, "")
    .replace(/[。！？!?,，；;:\s]/g, "")
    .trim();
}

function levenshteinDistance(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (!s) return t.length;
  if (!t) return s.length;
  const prev = new Array(t.length + 1);
  const curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j += 1) prev[j] = curr[j];
  }
  return prev[t.length];
}

function firstSentenceText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const m = raw.match(/^[\s\S]*?[。！？!?](?:\s|$)/);
  return (m ? m[0] : raw).trim();
}

function isLikelyProcessNarrativeSentence(text) {
  const sentence = String(text || "").trim();
  if (!sentence) return false;
  const normalized = normalizeDedupeSentence(sentence);
  if (!normalized) return false;
  return /^(我会|我先|我将|接下来我|下面我|然后我|先|接下来|下面)/.test(sentence) &&
    /(查看|检查|定位|梳理|整理|补上|补充|创建|新建|修改|修复|实现|完善|输出|给你|发你|同步|说明)/.test(sentence);
}

function isNearDuplicateLeadSentence(conclusionText, narrativeText) {
  const a = normalizeDedupeSentence(firstSentenceText(conclusionText));
  const b = normalizeDedupeSentence(firstSentenceText(narrativeText));
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const dist = levenshteinDistance(a, b);
  const limit = a.length > 18 && b.length > 18 ? 2 : 1;
  return dist <= limit;
}

function collectStepNarrativeTexts(sessionId, root = getTimelineMount(), activityEl = null) {
  const texts = [];
  const seen = new Set();
  const push = (value) => {
    const t = String(value || "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    texts.push(t);
  };
  const activity =
    activityEl ||
    state.runActivityEl ||
    root?.querySelector?.(":scope > details.run-activity:last-of-type");
  const collectFrom = (container) => {
    if (!container?.querySelectorAll) return;
    container.querySelectorAll(".step-narrative-text, .codex-commentary-text").forEach((el) => {
      push(el.textContent);
    });
  };
  if (activity) {
    collectFrom(activity);
  } else {
    root
      ?.querySelectorAll?.(":scope > details.run-activity")
      ?.forEach((entry) => collectFrom(entry));
  }
  return texts;
}

function stripLeadingStepNarratives(conclusionText, narratives) {
  let text = String(conclusionText || "").trim();
  if (!text || !narratives?.length) return text;
  const original = text;
  let guard = 0;
  while (guard++ < narratives.length * 4 + 8) {
    let changed = false;
    for (const narrative of narratives) {
      const plain = String(narrative || "").trim();
      if (!plain) continue;
      if (text.startsWith(plain)) {
        text = text.slice(plain.length).replace(/^[\s。；;，,\n]+/, "").trim();
        changed = true;
        break;
      }
      const pattern = escapeRegex(plain).replace(/\s+/g, "\\s*");
      const match = text.match(new RegExp(`^${pattern}`));
      if (match) {
        text = text.slice(match[0].length).replace(/^[\s。；;，,\n]+/, "").trim();
        changed = true;
        break;
      }
      const lead = firstSentenceText(text);
      if (lead && isNearDuplicateLeadSentence(text, plain)) {
        text = text.slice(lead.length).replace(/^[\s。；;，,\n]+/, "").trim();
        changed = true;
        break;
      }
    }
    if (!changed) {
      const lead = firstSentenceText(text);
      if (lead && isLikelyProcessNarrativeSentence(lead) && narratives.length > 0) {
        text = text.slice(lead.length).replace(/^[\s。；;，,\n]+/, "").trim();
        changed = true;
      }
    }
    if (!changed) break;
  }
  return text || original;
}

function stripLeadingProcessNarrativeSentences(conclusionText, maxDrop = 3) {
  let text = String(conclusionText || "").trim();
  if (!text) return text;
  let dropped = 0;
  while (dropped < maxDrop) {
    const lead = firstSentenceText(text);
    if (!lead || !isLikelyProcessNarrativeSentence(lead)) break;
    const next = text.slice(lead.length).replace(/^[\s。；;，,\n]+/, "").trim();
    if (!next || next === text) break;
    text = next;
    dropped += 1;
  }
  return text;
}

function dedupeConclusionAgainstStepNarratives(text, sessionId, root = getTimelineMount(), activityEl = null) {
  const narratives = collectStepNarrativeTexts(sessionId, root, activityEl);
  const deduped = stripLeadingStepNarratives(text, narratives);
  const trimmed = stripLeadingProcessNarrativeSentences(deduped);
  return trimmed || deduped;
}

function renderRestoredThinking(text) {
  const wrap = document.createElement("details");
  wrap.className = "event thinking";
  wrap.dataset.thinkingId = String(++state.thinkingBlockSeq);
  wrap.open = false;
  const chars = String(text || "").length;
  wrap.innerHTML = `
    <summary>思考完成 · ${chars} 字</summary>
    <pre class="event-pre"></pre>
  `;
  const pre = wrap.querySelector(".event-pre");
  if (pre) pre.textContent = text;
  (state.runActivityBody || state.currentStepBody || $("timeline")).appendChild(wrap);
  const sid = getActiveEventSessionId();
  if (sid) {
    recordThinkingEntry(
      sid,
      wrap.dataset.thinkingId,
      null,
      `思考完成 · ${chars} 字`,
      text,
    );
  }
}

function pushRestoredPatchEvent(patchInfo) {
  const patchPath = normalizeWorkspaceRelPath(getActiveProject()?.cwd, patchInfo.path);
  recordRunPatch({
    path: patchPath,
    unifiedDiff: patchInfo.unifiedDiff,
    applied: patchInfo.applied,
  });
  trackRunActivityStats(`补丁: ${patchPath}`, patchInfo.applied ? "done" : "warn");
  pushEventIn(
    getToolEventMount(),
    `补丁: ${patchPath}（${patchInfo.applied ? "已应用" : "待应用"}）`,
    patchInfo.applied ? "done" : "warn",
    {
      title: `Patch · ${patchPath}`,
      meta: patchInfo.applied ? "已应用" : "待应用",
      content: patchInfo.unifiedDiff,
      patch: {
        path: patchPath,
        unifiedDiff: patchInfo.unifiedDiff,
        applied: Boolean(patchInfo.applied),
      },
    },
  );
}

function beginRestoredRunActivity() {
  resetRunActivityState();
  const sid = getActiveEventSessionId();
  const timelineState = sid ? getNormalTimelineState(sid, true) : null;
  if (timelineState) timelineState.activeRunEntry = null;
  ensureRunActivity({ force: true });
  state.runActivityStats.startedAt = Date.now() - 1000;
}

function dispatchPlansByTurnIndex(dispatchPlans) {
  const map = new Map();
  for (const row of dispatchPlans || []) {
    if (Number.isInteger(row?.turnIndex)) map.set(row.turnIndex, row);
  }
  return map;
}

function applyRestoredDispatchPlan(turnState, turnIndex, dispatchByTurn) {
  const ev = dispatchByTurn.get(turnIndex);
  if (!ev) return;
  turnState.restoredPlan = dispatchPlanToPlanItems(ev);
  turnState.planCardTitle = "团队负责人计划";
}

function sessionPreviewForRestore(sessionId) {
  const row = state.sessionsAll.find((s) => s.id === sessionId);
  return String(row?.lastPreview || "").trim();
}

function dedupeDomUserPrompts(mount, expectedLabels = []) {
  if (!mount) return;
  const prompts = [...mount.querySelectorAll(":scope > .event.user-prompt")];
  if (!prompts.length) return;

  const normalizedExpected = expectedLabels.map((label) => normalizeUserPromptLabel(label));
  if (normalizedExpected.length && prompts.length > normalizedExpected.length) {
    for (let i = prompts.length - 1; i >= normalizedExpected.length; i -= 1) {
      prompts[i]?.remove();
    }
  }

  let prev = "";
  for (const line of [...mount.querySelectorAll(":scope > .event.user-prompt")]) {
    const label = normalizeUserPromptLabel(line.textContent);
    if (label && label === prev) {
      line.remove();
      continue;
    }
    prev = label;
  }
}

function ensureRestoredPromptFromPreview(sessionId, messages = []) {
  const mount = $("timeline");
  if (!mount) return;
  const expectedTurns = collectExpectedRestorePrompts(messages, sessionId);
  if (!expectedTurns.length) return;

  const existingPrompts = [
    ...mount.querySelectorAll(":scope > .event.user-prompt"),
  ].map((line) => normalizeUserPromptLabel(line.textContent));

  dedupeDomUserPrompts(mount, expectedTurns);
  const afterDedupe = [
    ...mount.querySelectorAll(":scope > .event.user-prompt"),
  ].map((line) => normalizeUserPromptLabel(line.textContent));
  if (afterDedupe.length >= expectedTurns.length) return;

  const prevRoute = state.eventRouteSessionId;
  state.eventRouteSessionId = sessionId || prevRoute;
  try {
    const timelineState = getNormalTimelineState(sessionId, true);
    const entries = ensureTimelineEntries(timelineState);
    for (let i = afterDedupe.length; i < expectedTurns.length; i += 1) {
      const userText = expectedTurns[i];
      const text = `开始执行: ${userText}`;
      const line = document.createElement("div");
      line.className = "event user-prompt";
      line.textContent = text;
      if (sessionId) line.dataset.eventDetailSession = sessionId;
      const anchor = findTurnPromptDomAnchor(mount, i);
      if (anchor) mount.insertBefore(line, anchor);
      else mount.appendChild(line);
      recordTimelineEvent(mount, line, text, "", undefined, {
        insertIndex: findTurnPromptCacheInsertIndex(entries, i),
      });
      markTimelineEventUserPrompt(line);
    }
    normalizeTimelineTurnOrder(mount);
  } finally {
    state.eventRouteSessionId = prevRoute;
  }
}

function renderRestoredTurnConclusion(finalText, sessionId, hadActivity = false) {
  const container = getTimelineMount();
  if (!container) return;
  const turnActivity = hadActivity ? resolveTurnRunActivityForConclusion(container) : null;
  if (turnActivity && turnHasConclusionAfter(turnActivity)) return;
  const text = dedupeConclusionAgainstStepNarratives(
    String(finalText || "").trim(),
    sessionId,
    container,
    turnActivity,
  );
  const files = [...state.runPatches.keys()];
  const wrap = document.createElement("div");
  populateRunConclusionElement(wrap, text, files, state.runPatches);
  if (turnActivity?.parentElement === container) {
    turnActivity.insertAdjacentElement("afterend", wrap);
  } else {
    const lastPrompt = container.querySelector(":scope > .event.user-prompt:last-of-type");
    if (lastPrompt) lastPrompt.insertAdjacentElement("afterend", wrap);
    else container.appendChild(wrap);
  }
  if (sessionId) recordConclusionEntry(sessionId, text);
}

function renderRestoredSession(sessionId, messages, checkpoints = [], dispatchPlans = []) {
  const sid = sessionId || state.viewingTimelineSessionId || sessionRuns?.getViewingSessionId();
  const prevRoute = state.eventRouteSessionId;
  state.eventRouteSessionId = sid || prevRoute;
  const turns = turnsWithDedupedPrompts(messages);
  const turnState = { restoredPlan: null, planCardTitle: "任务清单" };
  const dispatchByTurn = dispatchPlansByTurnIndex(dispatchPlans);
  // turnIndex = count of user messages before the turn (daemon snapshot time).
  const checkpointByTurn = new Map(
    (checkpoints || []).map((c) => [Number(c.turnIndex), String(c.sha || "")]),
  );
  let userTurnOrdinal = 0;

  turns.forEach((turn) => {
    turnState.restoredPlan = null;
    turnState.planCardTitle = "任务清单";
    state.runPatches.clear();
    state.runFinalText = "";
    state.runConclusionRendered = false;
    resetRunActivityState();
    state.currentStepEl = null;
    state.currentStepBody = null;
    if (sid) {
      state.runConclusionBySession.delete(sid);
      state.conclusionDomRenderedThisTurn.delete(sid);
      const timelineState = getNormalTimelineState(sid, false);
      if (timelineState) timelineState.activeRunEntry = null;
    }

    const rawUser =
      plainUserContent(turn.user?.content).trim() ||
      (!turn.user && turns.length === 1
        ? formatUserPromptForDisplay(sessionPreviewForRestore(sid))
        : "");
    if (isTeamDispatchFollowupMessage(rawUser)) {
      renderRestoredTeamDispatchTurn(turn, turnState);
      return;
    }

    const userText = formatUserPromptForDisplay(rawUser);
    if (userText) {
      const isSummary = rawUser.startsWith("Conversation summary");
      const promptLine = pushEvent(
        isSummary ? "会话摘要（已压缩历史）" : `开始执行: ${userText}`,
      );
      if (!isSummary) {
        const sha = checkpointByTurn.get(userTurnOrdinal);
        if (sha) decoratePromptWithCheckpoint(promptLine, sha, userTurnOrdinal);
        applyRestoredDispatchPlan(turnState, userTurnOrdinal, dispatchByTurn);
      }
    }
    if (turnState.restoredPlan?.length) {
      renderPlanCard(turnState.restoredPlan, turnState.planCardTitle || "任务清单");
    }
    if (turn.user) userTurnOrdinal += 1;

    let finalText = "";
    let hadActivity = false;
    const assistantMsgs = turn.msgs.filter((msg) => msg.role === "assistant");
    const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1];
    const turnHasTooling = turn.msgs.some(
      (msg) =>
        msg.role === "assistant" &&
        (msg.reasoning_content || (msg.tool_calls?.length ?? 0) > 0),
    );

    for (const msg of turn.msgs) {
      if (msg.role === "tool") continue;
      if (msg.role !== "assistant") continue;

      if (msg.reasoning_content || msg.tool_calls?.length) {
        if (!hadActivity) {
          beginRestoredRunActivity();
          hadActivity = true;
        }
      }

      if (msg.reasoning_content) {
        renderRestoredThinking(msg.reasoning_content);
        if (state.runActivityStats) {
          state.runActivityStats.thinkingChars += String(msg.reasoning_content).length;
        }
      }

      if (msg.tool_calls?.length) {
        if (state.runActivityStats) {
          state.runActivityStats.step += 1;
        }
        const stepText = plainUserContent(msg.content).trim();
        if (stepText) {
          appendRestoredAssistantText(stepText);
        }

        for (const tc of msg.tool_calls) {
          const name = tc.function?.name ?? "tool";
          let args = {};
          try {
            args = JSON.parse(tc.function?.arguments ?? "{}");
          } catch {
            args = {};
          }

          if (name === "update_plan") {
            if (Array.isArray(args.items)) {
              turnState.restoredPlan = args.items;
              renderPlanCard(args.items, turnState.planCardTitle || "任务清单");
            }
            continue;
          }
          if (name === "spawn_agent") continue;

          const toolMsg = turn.msgs.find(
            (m) => m.role === "tool" && m.tool_call_id === tc.id,
          );
          const result = toolMsg?.content ?? "";

          if (!state.stepToolGroupBody?.isConnected) beginStepToolGroup();
          const restoredLine = pushEventIn(
            getToolEventMount(),
            toolLineText(name, args, true),
            "tool-event is-done",
            buildToolEventDetail(name, args, result),
          );
          bumpStepToolGroupCount();
          trackRunActivityStats(`✓ ${name}`);

          const patchInfo = extractPatchFromToolCall(name, args, result);
          if (patchInfo) {
            pushRestoredPatchEvent(patchInfo);
            const inlineDiff = buildInlineDiffHtml(patchInfo);
            if (inlineDiff) restoredLine?.insertAdjacentHTML("beforeend", inlineDiff);
          }
        }
      } else {
        const answer = plainUserContent(msg.content).trim();
        if (!answer) continue;
        if (turnHasTooling && msg !== lastAssistantMsg) {
          if (!hadActivity) {
            beginRestoredRunActivity();
            hadActivity = true;
          }
          appendRestoredAssistantText(answer);
        } else {
          finalText = answer;
        }
      }
    }

    if (hadActivity) {
      pushEventIn(state.runActivityBody, "执行完成", "done");
      finalizeRunActivity();
    }
    if (finalText || state.runPatches.size || hadActivity) {
      renderRestoredTurnConclusion(finalText, sid, hadActivity);
    }
  });
  state.eventRouteSessionId = prevRoute;
}

/** Replay the durable daemon event journal. Legacy sessions fall back to message reconstruction. */
function renderPersistedSessionEvents(sessionId, records) {
  const events = (records || []).map((record) => record?.event).filter(Boolean);
  if (!sessionId || !events.some((event) => event.type === "session_start")) return false;
  const previousRoute = state.eventRouteSessionId;
  const previousLive = state.liveRunSessionId;
  state.eventRouteSessionId = sessionId;
  state.liveRunSessionId = sessionId;
  try {
    for (const event of events) {
      if (!event || typeof event.type !== "string") continue;
      if (event.type === "session_start") {
        beginSessionTurn(sessionId);
        showChatEmpty(false);
        if (event.preview) renderUserPromptOnce(event.preview);
        continue;
      }
      if (event.type === "done") {
        flushStreamText();
        clearLiveStatusLine();
        clearNetworkPermissionBanner();
        renderRunConclusion(event.finalText || "", sessionId);
        continue;
      }
      handleLiveAgentEvent({ ...event, sessionId });
    }
    flushStreamText();
    syncStructuredTimelineFromDom(sessionId);
    sanitizeStructuredTimelineCache(sessionId);
    return true;
  } finally {
    state.eventRouteSessionId = previousRoute;
    state.liveRunSessionId = previousLive;
  }
}

async function restoreSessionTimeline(sessionId, switchGen, options = {}) {
  if (state.unreadDoneSessions.delete(sessionId)) renderProjects();
  const timeline = $("timeline");
  void loadTalentRoster();
  try {
    const res = await requireBridge().getSessionMessages(sessionId, 2000);
    if (!isViewSwitchCurrent(switchGen)) return;
    if (sessionId !== state.viewingTimelineSessionId) return;
    const messages = Array.isArray(res?.messages) ? res.messages : [];
    const persistedEvents = Array.isArray(res?.events) ? res.events : [];
    // An emptied session (e.g. after a full rewind truncation) shows the
    // new-chat state instead of a blank pane or a resurrected conclusion.
    if (!messages.length) {
      if (!persistedEvents.length) {
        clearTimeline();
        forgetSessionRunCaches(sessionId);
        showChatEmpty(true);
        return;
      }
    }
    // Snapshot AFTER the await: anything the user scrolled/toggled during the
    // daemon round-trip must win over what the view looked like before it.
    const previousUi = captureTimelineUiState(timeline);
    const shouldScrollToBottom =
      options.scrollToBottom === true ||
      (options.scrollToBottom !== false && isScrollAtBottom(timeline));
    showChatEmpty(false);
    if (sessionId === state.viewingTimelineSessionId) {
      syncStructuredTimelineFromDom(sessionId);
    }
    clearTimeline();
    const running = sessionRuns?.isSessionRunning(sessionId);
    const cacheOk =
      structuredTimelineCacheUsable(sessionId, running) &&
      structuredTimelineMatchesMessages(sessionId, messages);
    if (cacheOk) {
      loadSessionRunArtifacts(sessionId);
      renderTimelineFromState(sessionId, timeline);
    } else if (renderPersistedSessionEvents(sessionId, persistedEvents)) {
      ensureRestoredPromptFromPreview(sessionId, messages);
    } else {
      const activitySnapshot = snapshotRunActivitiesFromCache(sessionId);
      clearStructuredTimelineForRestore(sessionId);
      renderRestoredSession(
        sessionId,
        messages,
        Array.isArray(res?.checkpoints) ? res.checkpoints : [],
        Array.isArray(res?.dispatchPlans) ? res.dispatchPlans : [],
      );
      ensureRestoredPromptFromPreview(sessionId, messages);
      mergeRunActivitySnapshot(sessionId, activitySnapshot);
      dedupeDomUserPrompts($("timeline"), collectExpectedRestorePrompts(messages, sessionId));
      sanitizeStructuredTimelineCache(sessionId);
      realignRunActivitiesToTurns($("timeline"));
    }
    if (!isViewSwitchCurrent(switchGen)) return;
    if (sessionId !== state.viewingTimelineSessionId) return;
    repairTimelineDomStructure($("timeline"));
    rebindTimelineAfterRestore($("timeline"));
    loadSessionRunArtifacts(sessionId);
    reconcileSessionConclusion(sessionId);
    if (sessionRuns?.isSessionRunning(sessionId)) {
      ensureLiveRunSession(sessionId);
      reattachLiveRunDomRefs();
    }
    restoreTimelineUiState(
      {
        ...previousUi,
        timelineFollowBottom: shouldScrollToBottom,
      },
      $("timeline"),
    );
  } catch (e) {
    if (!isViewSwitchCurrent(switchGen)) return;
    pushEvent(`恢复会话失败: ${String(e)}`, "err");
  }
}

function pushEventIn(container, text, cls = "", detail) {
  const line = document.createElement("div");
  line.className = `event ${cls}`.trim();
  line.textContent = text;
  if (detail) {
    const sid = getActiveEventSessionId() || "_anonymous";
    const id = ++state.eventSeq;
    state.detailById.set(id, detail);
    getEventDetailStore(sid).set(id, detail);
    line.dataset.eventDetailId = String(id);
    line.dataset.eventDetailSession = sid;
    const serialized = serializeEventDetail(detail);
    if (serialized) line.dataset.forgeDetail = serialized;
    line.classList.add("clickable");
  }
  container.appendChild(line);
  if (
    (state.runActivityBody && container === state.runActivityBody) ||
    container?.classList?.contains("run-activity-stream") ||
    container?.classList?.contains("subagent-talent-body") ||
    container?.classList?.contains("step-tool-group-body")
  ) {
    if (container?.classList?.contains("run-activity-stream")) {
      maybeScrollTimeline();
    } else if (runActivityBodyShouldAutoScroll()) {
      scheduleRunViewScroll();
    }
  } else {
    maybeScrollTimeline();
  }
  recordTimelineEvent(container, line, text, cls, detail);
  return line;
}

function startStepGroup(step, maxSteps) {
  endStepToolGroup();
  ensureRunActivity();
  hoistOrphanNodesIntoRunActivity();
  if (state.runActivityStats) {
    state.runActivityStats.step = step;
    state.runActivityStats.maxSteps = maxSteps;
  }
  state.currentStepEl = state.runActivityEl;
  state.currentStepBody = state.runActivityBody;
  state.statusNode = null;
  state.streamTextNode = null;
  if (state.thinkingPre) {
    const chars = state.thinkingPre.textContent?.length ?? 0;
    endThinking(chars, undefined);
  }
  updateRunActivitySummary({
    live: formatTalentStepLabel(`Step ${step}/${maxSteps}`),
  });
  maybeScrollRunActivityIntoView();
}

function splitLiveResponseLines(text) {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  const lines = [];
  for (const paragraph of raw.split(/\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const parts = trimmed.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [trimmed];
    for (const part of parts) {
      const clean = part.trim();
      if (clean) lines.push(clean);
    }
  }
  return lines.length ? lines : raw.trim() ? [raw.trim()] : [];
}

function renderLiveResponseLines(host, rawText) {
  if (!host) return;
  host.dataset.rawText = rawText || "";
  if (isCodexRuntime()) {
    host.classList.add("codex-live-response");
    host.textContent = rawText || "";
    return;
  }
  const lines = splitLiveResponseLines(rawText);
  const frag = document.createDocumentFragment();
  lines.forEach((line, idx) => {
    const row = document.createElement("div");
    row.className = "live-response-line";
    row.dataset.index = String(idx + 1);
    const mark = document.createElement("span");
    mark.className = "live-response-line-mark";
    mark.textContent = String(idx + 1);
    const text = document.createElement("span");
    text.className = "live-response-line-text";
    text.textContent = line;
    row.append(mark, text);
    frag.appendChild(row);
  });
  host.replaceChildren(frag);
}

function ensureStreamTextNode() {
  if (state.streamTextNode) return state.streamTextNode;
  ensureRunActivity();
  const wrap = document.createElement("div");
  wrap.className = "event live-response-event run-conclusion-live";
  wrap.innerHTML = `
    <div class="live-response" role="article"></div>
  `;
  (state.runActivityBody || getTimelineMount()).appendChild(wrap);
  state.streamTextNode = wrap.querySelector(".live-response");
  return state.streamTextNode;
}

function flushStreamText() {
  if (!state.streamTextBuffer) return;
  const node = ensureStreamTextNode();
  const segmentText = String(node.dataset.rawText || "") + state.streamTextBuffer;
  renderLiveResponseLines(node, segmentText);
  state.streamTextRaw = segmentText;
  if (isCodexRuntime()) maybeStartCodexProvisionalFileActivities(segmentText);
  state.streamTextBuffer = "";
  if (node.closest(".run-activity-body")) {
    if (runActivityBodyShouldAutoScroll()) scheduleRunViewScroll();
  } else {
    maybeScrollTimeline();
  }
}

function finishStreamTextSegment(options = {}) {
  flushStreamText();
  const segmentText = String(state.streamTextNode?.dataset?.rawText || "").trim();
  const liveWrap = state.streamTextNode?.closest?.(".run-conclusion-live");
  const shouldSkipPersist = Boolean(options.skipPersist || state.runConclusionRendered);
  if (segmentText && !shouldSkipPersist) {
    ensureRunActivity();
    if (state.runActivityBody) {
      if (isCodexRuntime()) appendCodexCommentaryBlock(segmentText);
      else appendRestoredAssistantText(segmentText);
    }
  }
  if (liveWrap?.parentElement) liveWrap.remove();
  state.streamTextNode = null;
  state.streamTextBuffer = "";
  state.streamTextRaw = "";
}

function scheduleStreamFlush() {
  if (state.streamFlushTimer) return;
  state.streamFlushTimer = setTimeout(() => {
    state.streamFlushTimer = null;
    flushStreamText();
  }, 70);
}

function formatStatusMessage(ev) {
  const base = String(ev?.message ?? "处理中…").trim();
  const sec = ev?.elapsedSec;
  let display = base;
  if (!base.startsWith("已激活人才")) {
    display = formatTalentStepLabel(base, ev?.sessionId);
  }
  let text = `◇ ${display}`;
  if (typeof sec === "number" && sec > 0) {
    text += ` · 已等待 ${sec}s`;
  }
  if (typeof sec === "number" && sec >= 60) {
    text += "（模型较慢，可点停止后重试或换网络/配置）";
  }
  return text;
}

/** Update subagent card meta in place for heartbeat status (no extra timeline rows). */
function updateSubagentStatusMeta(ev) {
  if (!ev?.talent?.mention) return false;
  const entry = getSubagentEntry(ev.talent.mention);
  if (!entry?.details?.isConnected || entry.finalized) return false;
  const metaText = formatStatusMessage(ev).replace(/^◇\s*/, "");
  const metaEl = entry.details.querySelector(".run-activity-meta");
  if (metaEl) metaEl.textContent = metaText;
  const statusSid = ev.sessionId || getActiveEventSessionId();
  if (statusSid) syncSubagentShellEntry(statusSid, ev.talent, { meta: metaText });
  return true;
}

/** Live progress on the collapsed activity bar (no extra timeline rows). */
function updateStatusLine(textOrEv) {
  const sid =
    (typeof textOrEv === "object" && textOrEv?.sessionId) ||
    state.eventRouteSessionId ||
    state.liveRunSessionId ||
    sessionRuns?.getViewingSessionId() ||
    "";
  if (sid && isSessionRunConcluded(sid)) return;
  if (!sid && isSessionRunConcluded(sessionRuns?.getViewingSessionId())) return;

  const text =
    typeof textOrEv === "string"
      ? textOrEv
      : formatStatusMessage(textOrEv);
  const short = text.replace(/^◇\s*/, "");
  if (isCodexRuntime(sid)) {
    const noise =
      /commandExecution|Codex turn|Codex 初始化|Runtime:/i.test(short) ||
      /^Codex\b/i.test(short);
    if (noise) return;
  }
  if (state.runActivityStats) state.runActivityStats.lastStatus = enrichBareEditLiveLabel(short);
  ensureRunActivity();
  const labelEl = state.runActivityEl?.querySelector(".run-activity-label");
  if (labelEl) {
    labelEl.textContent = enrichBareEditLiveLabel(short);
    labelEl.classList.toggle(
      "is-warn",
      /已等待 [6-9]\d+s|已等待 \d{3,}s/.test(short),
    );
  }
  updateRunActivitySummary();
}

function clearLiveStatusLine() {
  state.statusNode?.remove();
  state.statusNode = null;
  state.runActivityEl?.querySelector(".run-activity-label")?.classList.remove("is-warn");
}

function getThinkingMount() {
  return (
    state.pushEventMountOverride ||
    state.runActivityBody ||
    state.currentStepBody ||
    getTimelineMount()
  );
}

/** Reuse the open thinking block in the current mount (survives offscreen virtual DOM reload). */
function findOpenThinkingPre(mount, talent) {
  if (!mount?.querySelectorAll) return null;
  const wantMention = normalizeTalentMention(talent?.mention || "");
  const blocks = mount.querySelectorAll("details.event.thinking");
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const summary = block.querySelector("summary");
    if (!summary?.textContent?.includes("思考中")) continue;
    const blockMention = block.dataset.talentMention || "";
    if (blockMention !== wantMention) continue;
    return block.querySelector(".event-pre");
  }
  return null;
}

function bindThinkingFromMount(talent) {
  const mount = getThinkingMount();
  const open = findOpenThinkingPre(mount, talent);
  if (open) state.thinkingPre = open;
  else if (state.thinkingPre && mount && !mount.contains(state.thinkingPre)) {
    state.thinkingPre = null;
  }
}

function beginThinking(talentOverride) {
  if (shouldFoldIntoRunActivity("thinking", "")) {
    ensureRunActivity();
    hoistOrphanNodesIntoRunActivity();
  }
  const mount = getThinkingMount();
  const existing = findOpenThinkingPre(mount, talentOverride);
  if (existing) {
    state.thinkingPre = existing;
    if (talentOverride) state.activeThinkingTalent = talentOverride;
    return;
  }
  if (!talentOverride) {
    bindThinkingFromMount();
    if (state.thinkingPre) return;
  }
  if (talentOverride) state.activeThinkingTalent = talentOverride;
  const wrap = document.createElement("details");
  wrap.className = "event thinking";
  wrap.dataset.thinkingId = String(++state.thinkingBlockSeq);
  if (talentOverride?.mention) {
    wrap.dataset.talentMention = normalizeTalentMention(talentOverride.mention);
  }
  wrap.open = false;
  const thinkingLabel = formatTalentStepLabel("思考中（可展开）", undefined, talentOverride);
  wrap.innerHTML = `
    <summary>${escapeHtml(thinkingLabel)}</summary>
    <pre class="event-pre"></pre>
  `;
  getThinkingMount().appendChild(wrap);
  state.thinkingPre = wrap.querySelector(".event-pre");
  const sid = getActiveEventSessionId();
  if (sid) {
    recordThinkingEntry(sid, wrap.dataset.thinkingId, talentOverride, thinkingLabel, "");
  }
}

function appendThinking(text, talentOverride) {
  const t = talentOverride || state.activeThinkingTalent;
  beginThinking(t);
  if (!state.thinkingPre) return;
  state.thinkingPre.textContent += text;
  if (state.runActivityStats) {
    state.runActivityStats.thinkingChars += String(text || "").length;
    updateRunActivitySummary();
  }
  const sid = getActiveEventSessionId();
  const holder = state.thinkingPre.closest("details");
  if (sid && holder?.dataset?.thinkingId) {
    recordThinkingEntry(
      sid,
      holder.dataset.thinkingId,
      t,
      holder.querySelector("summary")?.textContent || "",
      state.thinkingPre.textContent || "",
    );
  }
  maybeScrollActivityBody();
}

function endThinking(charCount, durationMs, talentOverride) {
  const t = talentOverride || state.activeThinkingTalent;
  const pre =
    findOpenThinkingPre(getThinkingMount(), t) ||
    (t?.mention && state.thinkingPre?.closest("details")?.dataset.talentMention ===
      normalizeTalentMention(t.mention)
      ? state.thinkingPre
      : !t
        ? state.thinkingPre
        : null);
  if (!pre) return;
  const holder = pre.closest("details");
  const actualChars = String(pre.textContent || "").trim().length;
  if (holder && actualChars === 0 && !(Number(charCount) > 0)) {
    const sid = getActiveEventSessionId();
    if (sid && holder.dataset.thinkingId) {
      removeThinkingEntry(sid, holder.dataset.thinkingId);
    }
    holder.remove();
    if (state.thinkingPre === pre) state.thinkingPre = null;
    if (!t || state.activeThinkingTalent?.mention === t.mention) {
      state.activeThinkingTalent = null;
    }
    return;
  }
  if (holder) {
    const sec = durationMs ? (durationMs / 1000).toFixed(1) : "0.0";
    const summary = holder.querySelector("summary");
    if (summary) {
      summary.textContent = formatTalentStepLabel(
        `思考完成 · ${charCount ?? 0} 字 · ${sec}s`,
        undefined,
        t,
      );
    }
    const sid = getActiveEventSessionId();
    if (sid && holder.dataset.thinkingId) {
      recordThinkingEntry(
        sid,
        holder.dataset.thinkingId,
        t,
        summary?.textContent || "",
        pre.textContent || "",
      );
    }
  }
  if (state.runActivityStats && charCount) {
    state.runActivityStats.thinkingChars += Number(charCount) || 0;
    updateRunActivitySummary();
  }
  if (state.thinkingPre === pre) state.thinkingPre = null;
  if (
    !t ||
    state.activeThinkingTalent?.mention === t.mention
  ) {
    state.activeThinkingTalent = null;
  }
  if (runActivityBodyShouldAutoScroll()) scheduleRunViewScroll();
}

function setCustomizeNavExpanded(expanded) {
  const group = $("navCustomizeGroup");
  const toggle = $("navCustomizeToggle");
  const items = $("navCustomizeItems");
  if (!group || !toggle || !items) return;
  group.classList.toggle("collapsed", !expanded);
  toggle.setAttribute("aria-expanded", String(expanded));
  items.hidden = !expanded;
}

function setTeamNavExpanded(expanded) {
  const group = $("navTeamGroup");
  const toggle = $("navTeamToggle");
  const items = $("navTeamItems");
  if (!group || !toggle || !items) return;
  group.classList.toggle("collapsed", !expanded);
  toggle.setAttribute("aria-expanded", String(expanded));
  items.hidden = !expanded;
}

function setNav(mode) {
  state.activeNav = mode;
  ["Chat", "Plugins", "Mcp", "Skills", "Hooks", "Channels", "Automations", "Runtimes"].forEach((name) => {
    const btn = $(`nav${name}Btn`);
    if (btn) btn.classList.toggle("active", mode === name.toLowerCase());
  });
  $("navTeamToggle")?.classList.toggle("active", mode === "talents");
  $("navTeamCenterBtn")?.classList.toggle("active", mode === "talents");
  if (!["plugins", "mcp", "skills", "hooks", "runtimes"].includes(mode)) {
    setCustomizeNavExpanded(false);
  }
  if (mode === "talents") {
    setTeamNavExpanded(true);
  }
  const isChat = mode === "chat";
  $("centerPanel")?.classList.toggle("chat-empty-mode", isChat && state.chatEmpty);
  $("chatEmpty").classList.toggle("hidden", !isChat || !state.chatEmpty);
  $("timeline").classList.toggle("hidden", !isChat || state.chatEmpty);
  $("composer").classList.toggle("hidden", !isChat);
  $("resourceView").classList.toggle("hidden", isChat);
  $("resourceToolbar")?.classList.toggle("hidden", isChat || mode !== "skills");
  $("pluginToolbar")?.classList.toggle("hidden", isChat || mode !== "plugins");
  $("hooksToolbar")?.classList.toggle("hidden", isChat || mode !== "hooks");
  $("talentsToolbar")?.classList.toggle("hidden", isChat || mode !== "talents");
  if (mode === "skills") syncSkillToolbarPanes();
  if (mode === "plugins") syncPluginToolbarPanes();
  if (mode === "hooks") syncHooksToolbarPanes();
  if (mode === "talents") syncTalentsToolbarPanes();
  $("runState").classList.toggle("hidden", !isChat);
  $("centerTitle").textContent =
    mode === "chat"
      ? state.chatEmpty
        ? "新对话"
        : "对话与运行事件"
      : mode === "plugins"
        ? "插件"
        : mode === "mcp"
          ? "MCP"
          : mode === "hooks"
            ? "Hooks"
            : mode === "channels"
              ? "渠道"
              : mode === "automations"
                ? "自动化"
                : mode === "runtimes"
                  ? "Agent Runtime"
                  : mode === "talents"
                    ? "人才中心"
                    : "Skills";
  if (!isChat) void renderResourceView();
  if (mode !== "channels") stopChannelsPoll();
}

function isProfileEnabledInCfg(cfg, profileId) {
  return cfg?.profiles?.[profileId]?.enabled !== false;
}

function firstEnabledProfileId(cfg) {
  const profiles = cfg?.profiles ?? {};
  return (
    Object.keys(profiles).find((id) => isProfileEnabledInCfg(cfg, id)) ?? ""
  );
}

function renderForgeProfileSelect(cfg) {
  const sel = $("profileSelect");
  if (!sel) return;
  const profiles = Object.keys(cfg?.profiles ?? {});
  let current = cfg?.activeProfile ?? profiles[0] ?? "";
  if (current && !isProfileEnabledInCfg(cfg, current)) {
    current = firstEnabledProfileId(cfg) || current;
  }
  sel.dataset.runtime = "forge";
  sel.title = "Forge 配置档";
  sel.innerHTML = "";
  profiles.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p;
    const disabled = !isProfileEnabledInCfg(cfg, p);
    opt.disabled = disabled;
    opt.textContent = disabled ? `${p}（已停用）` : p;
    sel.appendChild(opt);
  });
  sel.value = profiles.includes(current) ? current : profiles[0] ?? "";
}

function renderCodexModelSelect() {
  const sel = $("profileSelect");
  if (!sel) return;
  sel.dataset.runtime = "codex";
  sel.title = "Codex 模型";
  sel.innerHTML = "";
  if (state.loadingCodexModels) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "加载 Codex 模型…";
    sel.appendChild(opt);
    return;
  }
  if (!state.codexModels.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Codex 默认模型";
    sel.appendChild(opt);
    return;
  }
  state.codexModels.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.model || m.id;
    opt.textContent = m.displayName || m.model || m.id;
    if (m.description) opt.title = m.description;
    sel.appendChild(opt);
  });
  const preferred =
    state.selectedCodexModel ||
    state.codexModels.find((m) => m.isDefault)?.model ||
    state.codexModels[0]?.model ||
    state.codexModels[0]?.id ||
    "";
  sel.value = preferred;
  state.selectedCodexModel = sel.value;
}

function renderClaudeModelSelect() {
  const sel = $("profileSelect");
  if (!sel) return;
  sel.dataset.runtime = "claude-code";
  sel.title = "Claude Code 模型";
  sel.innerHTML = "";
  state.claudeModels.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.model || m.id;
    opt.textContent = m.displayName || m.model || m.id;
    sel.appendChild(opt);
  });
  const preferred =
    state.selectedClaudeModel ||
    state.claudeModels.find((m) => m.isDefault)?.model ||
    state.claudeModels[0]?.model ||
    "sonnet";
  sel.value = preferred;
  state.selectedClaudeModel = sel.value;
}

function renderCursorModelSelect() {
  const sel = $("profileSelect");
  if (!sel) return;
  sel.dataset.runtime = "cursor";
  sel.title = "Cursor Agent 模型";
  sel.innerHTML = "";
  if (state.loadingCursorModels) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "加载模型中…";
    sel.appendChild(opt);
    return;
  }
  if (!state.cursorModels.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "默认模型";
    sel.appendChild(opt);
    return;
  }
  state.cursorModels.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.model || m.id;
    opt.textContent = m.displayName || m.model || m.id;
    sel.appendChild(opt);
  });
  const preferred =
    state.selectedCursorModel ||
    state.cursorModels.find((m) => m.isDefault)?.model ||
    state.cursorModels[0]?.model ||
    state.cursorModels[0]?.id ||
    "";
  sel.value = preferred;
  state.selectedCursorModel = sel.value;
}

function renderCursorModeSelect() {
  const sel = $("runtimeModeSelect");
  if (!sel) return;
  sel.dataset.runtime = "cursor";
  sel.title = "Cursor Agent 模式";
  sel.classList.remove("hidden");
  sel.innerHTML = "";
  const modes = state.cursorModes.length
    ? state.cursorModes
    : [
        { id: "default", label: "Default", isDefault: true },
        { id: "agent", label: "Agent" },
        { id: "ask", label: "Ask" },
        { id: "plan", label: "Plan" },
      ];
  modes.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label || m.id;
    sel.appendChild(opt);
  });
  const preferred =
    state.selectedCursorMode ||
    modes.find((m) => m.isDefault)?.id ||
    modes[0]?.id ||
    "default";
  sel.value = preferred;
  state.selectedCursorMode = sel.value;
}

function renderRuntimeStatusTag() {
  const tag = $("runtimeStatusTag");
  if (!tag) return;
  const runtime = $("runtimeSelect")?.value || "forge";
  if (runtime !== "cursor") {
    tag.classList.add("hidden");
    tag.textContent = "";
    tag.title = "";
    return;
  }
  const probe = state.cursorRuntimeStatus;
  if (!probe) {
    tag.classList.add("hidden");
    return;
  }
  tag.classList.remove("hidden");
  const labels = {
    ready: "ready",
    needs_setup: "needs setup",
    binary_missing: "binary missing",
    auth_required: "needs setup",
  };
  const label = labels[probe.status] || probe.status || "unknown";
  tag.textContent = label;
  tag.title = probe.message || label;
  tag.classList.toggle("runtime-status-ready", probe.status === "ready");
  tag.classList.toggle("runtime-status-warn", probe.status !== "ready");
}

function hideRuntimeModeSelect() {
  const sel = $("runtimeModeSelect");
  if (!sel) return;
  sel.classList.add("hidden");
  sel.dataset.runtime = "";
  sel.innerHTML = "";
}

function renderRuntimeModelSelect() {
  const runtime = $("runtimeSelect")?.value || "forge";
  hideRuntimeModeSelect();
  renderRuntimeStatusTag();
  if (runtime === "codex") {
    renderCodexModelSelect();
  } else if (runtime === "claude-code") {
    renderClaudeModelSelect();
  } else if (runtime === "cursor") {
    renderCursorModelSelect();
    renderCursorModeSelect();
    renderRuntimeStatusTag();
  } else if (state.config) {
    renderForgeProfileSelect(state.config);
  }
}

async function loadCodexModelsForActiveProject({ force = false } = {}) {
  if (state.loadingCodexModels) return;
  if (!force && state.codexModels.length) {
    renderRuntimeModelSelect();
    return;
  }
  state.loadingCodexModels = true;
  renderRuntimeModelSelect();
  try {
    const cwd = getActiveProject()?.cwd;
    const res = await requireBridge().listCodexModels({ cwd });
    state.codexModels = Array.isArray(res?.models) ? res.models : [];
    if (!state.selectedCodexModel && state.codexModels.length) {
      const def = state.codexModels.find((m) => m.isDefault) || state.codexModels[0];
      state.selectedCodexModel = def.model || def.id || "";
    }
  } catch (e) {
    state.codexModels = [];
    notifyUser(`加载 Codex 模型失败: ${String(e)}`, "warn");
  } finally {
    state.loadingCodexModels = false;
    renderRuntimeModelSelect();
  }
}

async function loadCursorModelsForActiveProject({ force = false } = {}) {
  if (state.loadingCursorModels) return;
  if (!force && state.cursorModels.length && state.cursorRuntimeStatus) {
    renderRuntimeModelSelect();
    return;
  }
  state.loadingCursorModels = true;
  renderRuntimeModelSelect();
  try {
    const cwd = getActiveProject()?.cwd;
    const probe = await requireBridge().probeCursorRuntime({ cwd });
    state.cursorRuntimeStatus = probe;
    state.cursorModes = Array.isArray(probe?.modes) ? probe.modes : [];
    if (Array.isArray(probe?.models) && probe.models.length) {
      state.cursorModels = probe.models;
    } else {
      const res = await requireBridge().listCursorModels({ cwd });
      state.cursorModels = Array.isArray(res?.models) ? res.models : [];
    }
    if (!state.selectedCursorModel && state.cursorModels.length) {
      const def = state.cursorModels.find((m) => m.isDefault) || state.cursorModels[0];
      state.selectedCursorModel = def.model || def.id || "";
    }
    if (!state.selectedCursorMode && state.cursorModes.length) {
      const def = state.cursorModes.find((m) => m.isDefault) || state.cursorModes[0];
      state.selectedCursorMode = def.id || "default";
    }
    if (probe?.status && probe.status !== "ready") {
      notifyUser(probe.message || `Cursor: ${probe.status}`, "warn");
    }
  } catch (e) {
    state.cursorModels = [];
    state.cursorRuntimeStatus = {
      provider: "cursor",
      status: "needs_setup",
      message: String(e),
    };
    notifyUser(`加载 Cursor Runtime 失败: ${String(e)}`, "warn");
  } finally {
    state.loadingCursorModels = false;
    renderRuntimeModelSelect();
  }
}

function renderConfig(cfg) {
  state.config = cfg;
  const profiles = Object.keys(cfg.profiles ?? {});
  let current = cfg.activeProfile ?? profiles[0] ?? "";
  if (current && !isProfileEnabledInCfg(cfg, current)) {
    current = firstEnabledProfileId(cfg) || current;
  }
  ["quickActiveProfile"].forEach((id) => {
    const sel = $(id);
    sel.innerHTML = "";
    profiles.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p;
      const disabled = !isProfileEnabledInCfg(cfg, p);
      opt.disabled = disabled;
      opt.textContent = disabled ? `${p}（已停用）` : p;
      sel.appendChild(opt);
    });
    sel.value = profiles.includes(current) ? current : profiles[0] ?? "";
  });
  renderRuntimeModelSelect();
  window.ForgeModelProfilesUI?.renderModelProfilesList(
    $("modelProfilesList"),
    cfg,
  );
  $("maxStepsInput").value = String(cfg.limits?.maxSteps ?? 40);
  $("maxCtxInput").value = String(cfg.limits?.maxContextTokens ?? 64000);
  applyTheme(cfg?.ui?.theme ?? "system");
  if ($("themeSelect")) $("themeSelect").value = normalizeThemeMode(cfg?.ui?.theme);
  $("thinkingSelect").value = cfg?.ui?.thinking ?? "collapse";
  $("progressSelect").value = cfg?.ui?.progress ?? "compact";
  $("settingsAutoApplyCheck").checked = Boolean(cfg?.ui?.autoApplyPatches);
  if ($("settingsConfirmCommandsCheck"))
    $("settingsConfirmCommandsCheck").checked = Boolean(cfg?.ui?.confirmCommands);
  const rfl = cfg?.reflection ?? {};
  if ($("settingsReflectionCheck"))
    $("settingsReflectionCheck").checked = Boolean(rfl.enabled);
  const reviewerSel = $("reflectionReviewerSelect");
  if (reviewerSel) {
    reviewerSel.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "（默认：当前模型）";
    reviewerSel.appendChild(def);
    profiles.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p;
      const disabled = !isProfileEnabledInCfg(cfg, p);
      opt.disabled = disabled;
      opt.textContent = disabled ? `${p}（已停用）` : p;
      reviewerSel.appendChild(opt);
    });
    reviewerSel.value =
      rfl.reviewerProfile && profiles.includes(rfl.reviewerProfile)
        ? rfl.reviewerProfile
        : "";
  }
  if ($("reflectionMaxRoundsInput"))
    $("reflectionMaxRoundsInput").value = String(rfl.maxRounds ?? 1);
  if ($("reflectionSeveritySelect"))
    $("reflectionSeveritySelect").value = rfl.severityGate ?? "blocker";
  if ($("tab-permissions")?.classList.contains("active")) {
    loadPermissionsSettingsEditor();
  }
  $("configJsonInput").value = JSON.stringify(cfg, null, 2);
}

function loadPermissionsSettingsEditor() {
  const host = $("permissionsEditorHost");
  const ui = window.ForgePermissionsUI;
  if (!host || !ui) return;
  host.innerHTML = ui.renderPermissionsEditor(state.config);
}

function isAutomationEnabledInCfg(cfg) {
  return Boolean(cfg?.permissions?.automation?.enabled);
}

function renderAutomationPermissionsBanner() {
  if (isAutomationEnabledInCfg(state.config)) return "";
  return `<div class="automations-permissions-callout">
    <span class="automations-permissions-icon" aria-hidden="true">!</span>
    <p>自动化未启用。请先在设置中开启权限，才能创建和运行定时任务。</p>
    <button type="button" class="btn secondary btn-sm" id="automationOpenPermissionsBtn">打开权限设置</button>
  </div>`;
}

function wrapAutomationsPage(inner) {
  return `<div class="automations-page">${inner}</div>`;
}

function isChannelsEnabledInCfg(cfg) {
  return Boolean(cfg?.permissions?.channels?.enabled);
}

function renderChannelsPermissionsBanner() {
  if (isChannelsEnabledInCfg(state.config)) return "";
  return `<div class="channels-permissions-callout">
    <span class="channels-permissions-icon" aria-hidden="true">!</span>
    <p>渠道未启用。请先在设置中开启权限，才能添加外部消息渠道。</p>
    <button type="button" class="btn secondary btn-sm" id="channelsOpenPermissionsBtn">打开权限设置</button>
  </div>`;
}

const CHANNEL_KIND_ICONS = {
  mobile: { glyph: "M", tone: "mobile" },
  ilink: { glyph: "微", tone: "ilink" },
  feishu: { glyph: "飞", tone: "feishu" },
  dingtalk: { glyph: "钉", tone: "dingtalk" },
  http: { glyph: "API", tone: "http" },
};

function channelKindIconHtml(kind) {
  const meta = CHANNEL_KIND_ICONS[kind] ?? { glyph: "?", tone: "http" };
  return `<span class="channel-kind-icon channel-kind-icon--${meta.tone}" aria-hidden="true">${escapeHtml(meta.glyph)}</span>`;
}

function wrapChannelsPage(inner) {
  return `<div class="channels-page">${inner}</div>`;
}

function openSettingsTab(tabId) {
  const modal = $("settingsModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  document.querySelectorAll("#settingsModal .tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabId);
  });
  document.querySelectorAll("#settingsModal .tab-pane").forEach((p) => {
    p.classList.remove("active");
  });
  const pane = $(`tab-${tabId}`);
  if (pane) pane.classList.add("active");
  if (tabId === "hooks") void loadUserHooksSettingsEditor();
  if (tabId === "permissions") loadPermissionsSettingsEditor();
}

function normalizeSessionCwd(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function sessionCwdMatches(projectCwd, sessionCwd) {
  const a = normalizeSessionCwd(projectCwd);
  const b = normalizeSessionCwd(sessionCwd);
  return Boolean(a && b && a === b);
}

/** Insert or update a session row in the sidebar immediately (no wait for run to finish). */
function upsertSessionInWorkspace({ sessionId, cwd, preview }) {
  if (!sessionId) return;
  rememberSessionCwd(sessionId, cwd);
  const now = new Date().toISOString();
  const idx = state.sessionsAll.findIndex((s) => s.id === sessionId);
  const prev = idx >= 0 ? state.sessionsAll[idx] : null;
  const item = {
    id: sessionId,
    cwd: cwd || prev?.cwd || "",
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    messageCount: prev?.messageCount ?? 0,
    // Titles are first-write-wins: every turn's session_start carries that
    // turn's message, which used to rename the session to「可以」etc.
    lastPreview: prev?.lastPreview || preview || "",
  };
  if (idx >= 0) state.sessionsAll[idx] = { ...prev, ...item };
  else state.sessionsAll.unshift(item);

  for (const p of state.projects) {
    if (!sessionCwdMatches(p.cwd, item.cwd)) continue;
    state.expandedProjectIds.add(p.id);
    break;
  }
  renderProjects();
}

function sessionRowTime(s) {
  return new Date(s?.updatedAt || s?.createdAt || 0).getTime();
}

/** Merge daemon list with in-memory sidebar rows without clobbering fresher local updates. */
function mergeSessionRow(prev, incoming) {
  if (!prev) return incoming;
  if (!incoming) return prev;
  const prevNewer = sessionRowTime(prev) >= sessionRowTime(incoming);
  const lastPreview = prevNewer
    ? prev.lastPreview || incoming.lastPreview || ""
    : incoming.lastPreview || prev.lastPreview || "";
  return {
    ...incoming,
    ...prev,
    cwd: prev.cwd || incoming.cwd,
    createdAt: prev.createdAt || incoming.createdAt,
    updatedAt: prevNewer ? prev.updatedAt : incoming.updatedAt,
    lastPreview,
    messageCount: Math.max(
      Number(prev.messageCount) || 0,
      Number(incoming.messageCount) || 0,
    ),
  };
}

function renderSessions(sessions) {
  const incoming = Array.isArray(sessions)
    ? sessions
    : Array.isArray(sessions?.sessions)
      ? sessions.sessions
      : [];
  const byId = new Map(state.sessionsAll.map((s) => [s.id, s]));
  for (const s of incoming) {
    const prev = byId.get(s.id);
    byId.set(s.id, mergeSessionRow(prev, s));
  }
  state.sessionsAll = [...byId.values()].sort(
    (a, b) => sessionRowTime(b) - sessionRowTime(a),
  );
  for (const s of state.sessionsAll) rememberSessionCwd(s.id, s.cwd);
  renderProjects();
}

function sessionRowVersion(s) {
  if (!s) return "";
  return `${s.updatedAt || s.createdAt || ""}|${Number(s.messageCount) || 0}`;
}

async function refreshViewedSessionFromDaemonIfChanged() {
  if (state.externalSessionRefreshInFlight) return;
  const bridge = getBridge();
  if (!bridge?.listSessions) return;

  state.externalSessionRefreshInFlight = true;
  try {
    const [cfg, res] = await Promise.all([
      typeof bridge.getConfig === "function"
        ? bridge.getConfig().catch(() => null)
        : Promise.resolve(null),
      bridge.listSessions(80),
    ]);
    if (cfg && syncProjectsFromConfig(cfg)) {
      saveProjects();
      renderComposerProjectSelect();
    }
    const sessions = Array.isArray(res)
      ? res
      : Array.isArray(res?.sessions)
        ? res.sessions
        : [];
    const sessionId = sessionRuns?.getViewingSessionId();
    const incoming = sessions.find((s) => s.id === sessionId);
    const current = state.sessionsAll.find((s) => s.id === sessionId);
    renderSessions(res);
    if (
      state.activeNav !== "chat" ||
      !sessionId ||
      state.running ||
      state.runningSessions.has(sessionId) ||
      !incoming ||
      sessionRuns?.getViewingSessionId() !== sessionId
    ) return;
    // Compare against the last DAEMON version we synced to — the merged local row
    // keeps a local-clock updatedAt that never converges, which used to trigger a
    // full timeline rebuild every poll tick after each run.
    const ver = sessionRowVersion(incoming);
    const seen = state.externalSessionVersionSeen.get(sessionId);
    state.externalSessionVersionSeen.set(sessionId, ver);
    if (seen === undefined) {
      // First observation since viewing: the open itself restored from daemon.
      if (ver === sessionRowVersion(current)) return;
    } else if (seen === ver) {
      return;
    }
    const switchGen = state.viewSwitchGeneration;
    await restoreSessionTimeline(sessionId, switchGen);
  } catch {
    /* best-effort external channel refresh */
  } finally {
    state.externalSessionRefreshInFlight = false;
  }
}

function startExternalSessionAutoRefresh() {
  if (state.externalSessionRefreshTimer) return;
  state.externalSessionRefreshTimer = setInterval(() => {
    void refreshViewedSessionFromDaemonIfChanged();
  }, 3000);
}

function sidebarIcon(name, className = "sidebar-icon") {
  const icons = {
    archive:
      '<path d="M3 5h18"/><path d="M5 5l1.4 14h11.2L19 5"/><path d="M8 5V3h8v2"/>',
    "chevron-right": '<path d="m9 5 7 7-7 7"/>',
    compose:
      '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
    download:
      '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>',
    folder:
      '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-5l-2-2H4a2 2 0 0 0-2 2v12Z"/><path d="M2 10h20"/>',
    "folder-open":
      '<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 4H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    file:
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
    pin:
      '<path d="M12 3l9 9-3 1-4 4-1 4-4-4 4-4 1-3Z"/><path d="M9 15l-6 6"/>',
    reveal:
      '<path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h4.1l1.8 2H18.8A2.2 2.2 0 0 1 21 9.2v7.6A2.2 2.2 0 0 1 18.8 19H5.2A2.2 2.2 0 0 1 3 16.8Z"/><path d="M8 12h8"/>',
    rename:
      '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M13.5 7.5l3 3"/>',
    tree:
      '<path d="M12 3v6"/><path d="M7 9h10"/><path d="M7 9v6"/><path d="M17 9v6"/><path d="M5 15h4v4H5Z"/><path d="M15 15h4v4h-4Z"/>',
    x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  };
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${icons[name] || ""}</svg>`;
}

function treeFolderIcon(isOpen) {
  return sidebarIcon(isOpen ? "folder-open" : "folder", "ws-icon-svg");
}

function treeFileIcon() {
  return sidebarIcon("file", "ws-icon-svg");
}

/** Expand/collapse chevron: one SVG, rotated to vertical via .is-open in CSS. */
function treeChevron(isOpen) {
  return `<span class="ws-chevron${isOpen ? " is-open" : ""}">${sidebarIcon("chevron-right", "ws-chevron-svg")}</span>`;
}

function buildSessionItemMarkup(session, project) {
  const isActive = project.sessionId === session.id;
  const isRunning = state.runningSessions.has(session.id);
  const isPinned = state.pinnedSessionIds.has(session.id);
  const isUnread = !isActive && state.unreadDoneSessions.has(session.id);
  const classes = [
    "session-item",
    isActive ? "active" : "",
    isRunning ? "is-running" : "",
    isPinned ? "is-pinned" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const time = formatRelativeTime(session.updatedAt || session.createdAt);
  const fullTitle = stripMarkdownForTitle(session.lastPreview || "");
  const isChannel = /^\[微信/.test(fullTitle);
  const title = summarizeSessionTitle(session.lastPreview);
  return `
    <button type="button" class="${classes}" data-session="${escapeHtml(session.id)}" title="${escapeHtml(fullTitle)}">
      ${isUnread ? '<span class="session-unread-dot" title="已完成，尚未查看"></span>' : ""}
      <span class="session-title">${escapeHtml(title)}</span>
      <span class="session-meta">
        ${isChannel ? '<span class="session-channel-badge">微信</span>' : ""}
        ${isRunning ? '<span class="session-run-badge">运行</span>' : ""}
        <span class="session-time">${escapeHtml(time)}</span>
        <span class="session-actions" aria-hidden="true">
          <span class="session-action" data-session-action="pin" title="${isPinned ? "取消置顶" : "置顶对话"}">${sidebarIcon("pin", "session-action-icon")}</span>
          <span class="session-action" data-session-action="export" title="导出 Markdown">${sidebarIcon("download", "session-action-icon")}</span>
          <span class="session-action" data-session-action="archive" title="归档对话">${sidebarIcon("archive", "session-action-icon")}</span>
        </span>
      </span>
    </button>`;
}

function stripMarkdownForTitle(s) {
  return String(s || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SESSION_TITLE_MAX = 30;

function truncateSessionLabel(text, max = SESSION_TITLE_MAX) {
  const s = String(text || "").trim();
  if (!s) return "（空）";
  if (s.length <= max) return s;
  const slice = s.slice(0, max + 4);
  const punct = slice.search(/[，,。.；;：:!?、]/);
  if (punct >= 12) return s.slice(0, punct);
  return `${s.slice(0, max)}…`;
}

/** Sidebar title from first user question (semantic trim, slightly longer). */
function summarizeSessionTitle(raw) {
  let t = stripMarkdownForTitle(raw);
  if (!t) return "（空）";
  if (/^Conversation summary/i.test(t) || t.startsWith("会话摘要")) {
    return "历史已压缩";
  }

  const fillers = [
    /^一切就绪[。.，,！!]?\s*/,
    /^改完了[。.，,！!]?\s*/,
    /^好的[，,]?\s*/,
    /^已完成[。.，,]?\s*/,
    /^文件已生成\s*[✅✓]?\s*/,
    /^我已经.{0,32}[。.，,]\s*/,
    /^开始执行:\s*/,
    /^【Ask 模式】[^】]*】\s*/,
  ];
  for (const re of fillers) t = t.replace(re, "");
  t = t.trim();
  if (!t) return "（空）";

  const sprint = t.match(/Sprint\s*(\d+)/i);
  if (sprint && /总结/.test(t)) {
    return truncateSessionLabel(`总结 Sprint ${sprint[1]} 完成的改动`);
  }
  if (/总结.*改动|改动.*总结/.test(t) && t.length > SESSION_TITLE_MAX) {
    return truncateSessionLabel("总结本轮完成的改动");
  }

  return truncateSessionLabel(t);
}

function formatRelativeTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}天`;
  const w = Math.floor(d / 7);
  return `${w}周`;
}

async function handleProjectAction(action, project) {
  if (!project) return;
  if (action === "pin") {
    project.pinned = !project.pinned;
    saveProjects();
    renderProjects();
    return;
  }
  if (action === "rename") {
    const next = window.prompt("重命名项目", project.name || "");
    if (next == null) return;
    const name = next.trim();
    if (!name) return;
    project.name = name;
    saveProjects();
    renderProjects();
    renderComposerProjectSelect();
    if (state.chatEmpty) updateChatEmptyTitle();
    return;
  }
  if (action === "reveal") {
    const bridge = getBridge();
    if (!bridge?.revealPath) {
      showBootstrapBanner("当前版本暂不支持在 Finder 中显示");
      return;
    }
    try {
      await bridge.revealPath(project.cwd);
    } catch (e) {
      showBootstrapBanner(`无法在 Finder 中显示: ${String(e?.message || e)}`);
    }
    return;
  }
  if (action === "archive") {
    state.sessionsAll
      .filter((s) => sessionCwdMatches(project.cwd, s.cwd))
      .forEach((s) => state.archivedSessionIds.add(s.id));
    saveSessionUiPrefs();
    renderProjects();
    return;
  }
  if (action === "remove") {
    if (state.projects.length <= 1) {
      pushEvent("至少保留一个项目", "warn");
      return;
    }
    state.projects = state.projects.filter((x) => x.id !== project.id);
    state.expandedProjectIds.delete(project.id);
    if (state.activeProjectId === project.id) {
      state.activeProjectId = state.projects[0].id;
    }
    saveProjects();
    renderComposerProjectSelect();
    if (state.chatEmpty) updateChatEmptyTitle();
    renderSessions(state.sessionsAll);
    void renderResourceView();
  }
}

function handleSessionAction(action, sessionId) {
  if (!sessionId) return;
  if (action === "pin") {
    if (state.pinnedSessionIds.has(sessionId)) {
      state.pinnedSessionIds.delete(sessionId);
    } else {
      state.pinnedSessionIds.add(sessionId);
    }
    saveSessionUiPrefs();
    renderProjects();
    return;
  }
  if (action === "archive") {
    state.archivedSessionIds.add(sessionId);
    state.pinnedSessionIds.delete(sessionId);
    saveSessionUiPrefs();
    renderProjects();
    return;
  }
  if (action === "export") {
    void exportSessionMarkdown(sessionId);
  }
}

function buildSessionMarkdown(messages, meta) {
  const lines = [
    "# Forge 会话导出",
    "",
    `- 会话: ${meta.sessionId}`,
    `- 项目: ${meta.cwd || "（未知）"}`,
    `- 导出时间: ${new Date().toLocaleString()}`,
    "",
  ];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = plainUserContent(msg.content).trim();
      if (text) lines.push("## 🧑 用户", "", text, "");
      continue;
    }
    if (msg.role !== "assistant") continue;
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const tc of calls) {
      const name = tc.function?.name ?? "tool";
      let summary = "";
      try {
        summary = toolCallSummary(name, JSON.parse(tc.function?.arguments ?? "{}"));
      } catch {
        /* keep bare name */
      }
      lines.push(`- 🔧 \`${name}\`${summary ? ` · ${summary}` : ""}`);
    }
    if (calls.length) lines.push("");
    const text = plainUserContent(msg.content).trim();
    if (text) lines.push("## 🤖 助手", "", text, "");
  }
  return lines.join("\n");
}

async function exportSessionMarkdown(sessionId) {
  try {
    const res = await requireBridge().getSessionMessages(sessionId, 2000);
    const messages = Array.isArray(res?.messages) ? res.messages : [];
    if (!messages.length) {
      notifyUser("该会话没有可导出的消息", "warn");
      return;
    }
    const cwd =
      state.sessionCwdById.get(sessionId) ||
      state.sessionsAll.find((s) => s.id === sessionId)?.cwd ||
      "";
    const md = buildSessionMarkdown(messages, { sessionId, cwd });
    const saved = await requireBridge().saveTextFile({
      defaultName: `forge-session-${sessionId.slice(0, 8)}.md`,
      content: md,
    });
    if (saved?.ok) notifyUser(`已导出: ${saved.path}`, "status");
    else if (!saved?.canceled) notifyUser("导出失败", "warn");
  } catch (e) {
    notifyUser(`导出失败: ${String(e)}`, "err");
  }
}

function talentProjectCwd() {
  return getActiveProject()?.cwd || "";
}

function talentEmoji(t) {
  return (t && t.emoji) || "🧑";
}

function talentAvatarHtml(t, className = "talent-avatar") {
  const avatar = t?.avatar || "";
  if (/^data:image\/svg\+xml[;,]/i.test(avatar)) {
    return `<img class="${escapeHtml(className)}" src="${escapeHtml(avatar)}" alt="" aria-hidden="true" />`;
  }
  return `<span class="${escapeHtml(className)} talent-emoji" aria-hidden="true">${escapeHtml(talentEmoji(t))}</span>`;
}

function slugTalentMention(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function clearSessionTalentBusy(sessionId) {
  if (!sessionId) return;
  let changed = state.sessionTalentBusy.delete(sessionId);
  if (state.foregroundTalentBySession.delete(sessionId)) changed = true;
  if (changed) renderTalentRosterSidebar();
}

function normalizeTalentMentionKey(mention) {
  return String(mention || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function getForegroundTalent(sessionId) {
  const sid =
    sessionId ||
    state.eventRouteSessionId ||
    state.liveRunSessionId ||
    sessionRuns?.getViewingSessionId?.() ||
    "";
  if (!sid) return null;
  return state.foregroundTalentBySession.get(sid) || null;
}

/** Prefix step labels during foreground/subagent talent runs. */
function formatTalentStepLabel(label, sessionId, talentOverride) {
  const t = talentOverride || getForegroundTalent(sessionId);
  if (!t) return label;
  const emoji = t.emoji || "🧑";
  return `${emoji} ${t.displayName} · ${label}`;
}

function touchTalentActivity(mention) {
  const key = normalizeTalentMentionKey(mention);
  if (key) state.talentActivityAt.set(key, Date.now());
}

function isTalentBusy(mention) {
  const key = normalizeTalentMentionKey(mention);
  if (!key) return false;
  for (const set of state.sessionTalentBusy.values()) {
    if (set.has(key)) return true;
  }
  return false;
}

function addSessionTalentBusy(sessionId, mention) {
  const sid = sessionId || state.liveRunSessionId || state.eventRouteSessionId;
  const key = normalizeTalentMentionKey(mention);
  if (!sid || !key) return;
  let set = state.sessionTalentBusy.get(sid);
  if (!set) {
    set = new Set();
    state.sessionTalentBusy.set(sid, set);
  }
  set.add(key);
  touchTalentActivity(mention);
  renderTalentRosterSidebar();
}

function removeSessionTalentBusy(sessionId, mention) {
  const sid = sessionId || state.liveRunSessionId || state.eventRouteSessionId;
  const key = normalizeTalentMentionKey(mention);
  if (!sid || !key) return;
  const set = state.sessionTalentBusy.get(sid);
  if (!set) return;
  set.delete(key);
  touchTalentActivity(mention);
  if (!set.size) state.sessionTalentBusy.delete(sid);
  renderTalentRosterSidebar();
}

function sortTalentRosterForSidebar(talents) {
  const activityAt = (t) => {
    const key = normalizeTalentMentionKey(t.mention);
    const local = key ? state.talentActivityAt.get(key) || 0 : 0;
    const statsMs = t.stats?.lastUsed ? Date.parse(t.stats.lastUsed) || 0 : 0;
    return Math.max(local, statsMs);
  };
  return [...talents].sort((a, b) => {
    const busyA = isTalentBusy(a.mention) ? 1 : 0;
    const busyB = isTalentBusy(b.mention) ? 1 : 0;
    if (busyA !== busyB) return busyB - busyA;
    const actDiff = activityAt(b) - activityAt(a);
    if (actDiff !== 0) return actDiff;
    return a.displayName.localeCompare(b.displayName, "zh-CN");
  });
}

function renderTalentRosterSidebar() {
  const root = $("talentRosterSidebar");
  if (!root) return;
  const talents = sortTalentRosterForSidebar(state.talentsRoster ?? []);
  if (!talents.length) {
    root.innerHTML = `<div class="talent-roster-empty">
      <p class="tiny muted">暂无成员</p>
      <button type="button" class="btn secondary btn-sm" id="talentSidebarHireBtn">去人才中心</button>
    </div>`;
    $("talentSidebarHireBtn")?.addEventListener("click", () => {
      setNav("talents");
      setTalentsTab("market");
    });
    return;
  }
  root.innerHTML = talents
    .map((t) => {
      const busy = isTalentBusy(t.mention);
      const dotClass = !t.enabled ? "is-off" : busy ? "is-busy" : "is-idle";
      const dotTitle = !t.enabled ? "已禁用" : busy ? "执行中" : "空闲";
      return `<button type="button" class="talent-roster-item${t.enabled ? "" : " is-disabled"}" data-talent-sidebar="${escapeHtml(t.mention)}" role="listitem" title="@${escapeHtml(t.mention)}">
        ${talentAvatarHtml(t, "talent-avatar talent-avatar-sm")}
        <span class="talent-meta">
          <span class="talent-name">${escapeHtml(t.displayName)}</span>
          <span class="talent-role">${escapeHtml(t.role)}</span>
        </span>
        <span class="talent-status-dot ${dotClass}" title="${dotTitle}" aria-hidden="true"></span>
      </button>`;
    })
    .join("");
  root.querySelectorAll("[data-talent-sidebar]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mention = btn.getAttribute("data-talent-sidebar");
      if (mention) void openTalentDetail(mention);
    });
  });
}

function parseTalentListInput(raw) {
  return String(raw || "")
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function loadTalentRoster() {
  const bridge = requireBridge();
  if (!bridge?.listTalentRoster) return [];
  try {
    const cwd = talentProjectCwd();
    const res = await bridge.listTalentRoster(cwd ? { cwd } : {});
    state.talentsRoster = res?.talents ?? [];
    renderTalentRosterSidebar();
    return state.talentsRoster;
  } catch {
    state.talentsRoster = [];
    renderTalentRosterSidebar();
    return [];
  }
}

async function loadTalentTemplates() {
  const bridge = requireBridge();
  if (!bridge?.listTalentTemplates) return [];
  try {
    const q = (state.talentMarketQuery || "").trim();
    const cat = (state.talentMarketCategory || "").trim();
    const payload = { cwd: talentProjectCwd() || undefined };
    if (q) payload.query = q;
    if (cat) payload.category = cat;
    const res = await bridge.listTalentTemplates(payload);
    state.talentTemplates = res?.templates ?? [];
    return state.talentTemplates;
  } catch {
    state.talentTemplates = [];
    return [];
  }
}

function wrapTalentsPage(inner) {
  return `<div class="talents-page">${inner}</div>`;
}

function renderTalentsOverviewBar() {
  const roster = state.talentsRoster ?? [];
  const templates = state.talentTemplates ?? [];
  const enabled = roster.filter((t) => t.enabled).length;
  return `<section class="talents-overview">
    <div class="talents-overview-copy">
      <h3 class="talents-overview-title">人才中心</h3>
      <p class="talents-overview-desc">浏览模板、租用成员；对话中用 @mention 指定角色协作。当前 ${templates.length} 个市场模板 · ${roster.length} 人已租用${enabled !== roster.length ? `（${enabled} 启用）` : ""}</p>
    </div>
  </section>`;
}

const TALENT_CATEGORY_ZH = {
  academic: "学术研究",
  design: "设计",
  engineering: "工程",
  finance: "财务",
  "game-development": "游戏开发",
  gis: "地理空间",
  marketing: "市场营销",
  "paid-media": "付费媒体",
  product: "产品",
  "project-management": "项目管理",
  sales: "销售",
  security: "安全",
  "spatial-computing": "空间计算",
  specialized: "专业服务",
  strategy: "战略",
  support: "运营支持",
  testing: "测试",
};

function talentCategoryLabel(category) {
  return TALENT_CATEGORY_ZH[category] || category;
}

function renderTalentCategoryChips() {
  const categories = [
    ...new Set((state.talentTemplates ?? []).map((t) => t.category).filter(Boolean)),
  ].sort();
  if (!categories.length) return "";
  const active = state.talentMarketCategory || "";
  const chips = [
    `<button type="button" class="talent-cat-chip${!active ? " active" : ""}" data-talent-cat="">全部</button>`,
    ...categories.slice(0, 14).map(
      (cat) =>
        `<button type="button" class="talent-cat-chip${active === cat ? " active" : ""}" data-talent-cat="${escapeHtml(cat)}">${escapeHtml(talentCategoryLabel(cat))}</button>`,
    ),
  ];
  return `<div class="talent-category-chips" role="tablist">${chips.join("")}</div>`;
}

function filterTalentTemplatesForView() {
  const q = (state.talentMarketQuery || "").trim().toLowerCase();
  let templates = [...(state.talentTemplates ?? [])];
  if (q) {
    templates = templates.filter((t) => {
      const hay = `${t.id} ${t.category} ${t.role} ${t.description || ""} ${t.vibe || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }
  return templates.sort((a, b) => {
    if (a.hired !== b.hired) return a.hired ? 1 : -1;
    return `${a.category}/${a.role}`.localeCompare(`${b.category}/${b.role}`);
  });
}

function renderTalentMarketCard(t) {
  const hired = Boolean(t.hired);
  const selected = state.talentPreviewTemplateId === t.id && state.talentPreviewSource === "market";
  const action = hired
    ? `<span class="store-card-badge installed">已租用</span>`
    : `<button type="button" class="store-card-install talent-hire-btn" data-template-id="${escapeHtml(t.id)}">租用</button>`;
  return `<article class="store-card talent-market-card${hired ? " is-hired" : ""}${selected ? " is-selected" : ""}" data-template-id="${escapeHtml(t.id)}" tabindex="0" role="button">
    <div class="talent-market-card-head">
      ${talentAvatarHtml(t, "talent-avatar talent-avatar-md")}
      <h3 class="store-card-name">${escapeHtml(t.role)}</h3>
    </div>
    <div class="store-card-repo">${escapeHtml(talentCategoryLabel(t.category))} · ${escapeHtml(t.id)}</div>
    <p class="store-card-desc">${escapeHtml(t.description || t.vibe || "暂无简介")}</p>
    <div class="store-card-footer">
      <div class="store-card-meta">
        <span class="store-card-source">${hired ? "已加入团队" : "可租用"}</span>
      </div>
      ${action}
    </div>
  </article>`;
}

function renderTalentsMarketPane() {
  const pane = $("talentsMarketPane");
  if (!pane) return;
  if (state.talentsLoading) {
    pane.innerHTML = `<div class="store-status">正在加载人才市场…</div>`;
    return;
  }
  const templates = filterTalentTemplatesForView();
  if (!templates.length) {
    pane.innerHTML = `<section class="talents-empty">
      <div class="talents-empty-icon" aria-hidden="true">🧑</div>
      <h3>暂无模板</h3>
      <p class="tiny muted">点击上方「同步」从 GitHub 或本地 agency-agents 拉取模板库，然后在此租用人才。</p>
      <button type="button" class="btn secondary" id="talentsSyncEmptyBtn">同步模板库</button>
    </section>`;
    $("talentsSyncEmptyBtn")?.addEventListener("click", () => void syncTalentsFromUi());
    return;
  }
  const visible = templates.slice(0, 120);
  const more =
    templates.length > visible.length
      ? `<p class="store-hint">还有 ${templates.length - visible.length} 个结果，请用搜索或分类缩小范围。</p>`
      : "";
  pane.innerHTML = `${renderTalentCategoryChips()}<div class="talents-market-grid store-grid">${visible.map(renderTalentMarketCard).join("")}</div>${more}`;
  bindTalentsMarketPane(pane);
  if (state.talentPreviewSource === "market" && state.talentPreviewTemplateId) {
    highlightTalentPreviewCards();
  }
}

function filterTalentRosterForView() {
  const q = (state.talentRosterQuery || "").trim().toLowerCase();
  let talents = [...(state.talentsRoster ?? [])];
  if (q) {
    talents = talents.filter((t) => {
      const hay = `${t.displayName} ${t.mention} ${t.role} ${t.category} ${t.templateId}`.toLowerCase();
      return hay.includes(q);
    });
  }
  return talents.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function renderTalentsRosterPane() {
  const pane = $("talentsRosterPane");
  if (!pane) return;
  if (state.talentsLoading) {
    pane.innerHTML = `<div class="store-status">正在加载已租用人才…</div>`;
    return;
  }
  const talents = filterTalentRosterForView();
  if (!talents.length) {
    pane.innerHTML = `<section class="talents-empty">
      <div class="talents-empty-icon" aria-hidden="true">👥</div>
      <h3>还没有租用人才</h3>
      <p class="tiny muted">切换到「人才市场」浏览模板并租用；租用后可在对话中用 @mention 指定角色。</p>
      <button type="button" class="btn secondary" id="talentsOpenMarketBtn">去人才市场</button>
    </section>`;
    $("talentsOpenMarketBtn")?.addEventListener("click", () => setTalentsTab("market"));
    return;
  }
  pane.innerHTML = `<div class="talents-roster-grid">${talents
    .map((t) => {
      const stats =
        t.stats?.tasksDone > 0
          ? `已完成 ${t.stats.tasksDone} 次`
          : t.stats?.lastUsed
            ? `最近使用 ${formatRelativeTime(t.stats.lastUsed)}`
            : "尚未使用";
      const selected =
        state.talentPreviewSource === "roster" && state.talentPreviewTemplateId === t.templateId;
      return `<article class="talent-roster-card${t.enabled ? "" : " is-disabled"}${selected ? " is-selected" : ""}" data-talent-card="${escapeHtml(t.mention)}" tabindex="0" role="button">
        <div class="talent-roster-card-head">
          ${talentAvatarHtml(t, "talent-avatar talent-avatar-md")}
          <div class="talent-roster-card-meta">
            <strong>${escapeHtml(t.displayName)}</strong>
            <span class="tiny muted">@${escapeHtml(t.mention)}</span>
          </div>
        </div>
        <p class="talent-roster-card-role">${escapeHtml(t.role)}</p>
        <p class="talent-roster-card-sub">${escapeHtml(talentCategoryLabel(t.category))} · ${escapeHtml(stats)}</p>
        <div class="talent-roster-card-actions">
          <button type="button" class="btn secondary btn-sm" data-talent-mention="${escapeHtml(t.mention)}">插入 @</button>
          <button type="button" class="btn secondary btn-sm" data-talent-fire="${escapeHtml(t.mention)}">解约</button>
        </div>
      </article>`;
    })
    .join("")}</div>`;
  bindTalentsRosterPane(pane);
  if (state.talentPreviewSource === "roster" && state.talentPreviewTemplateId) {
    highlightTalentPreviewCards();
  }
}

function highlightTalentPreviewCards() {
  const templateId = state.talentPreviewTemplateId;
  if (!templateId) return;
  document.querySelectorAll(".talent-market-card[data-template-id]").forEach((card) => {
    card.classList.toggle("is-selected", card.getAttribute("data-template-id") === templateId);
  });
  document.querySelectorAll(".talent-roster-card[data-talent-card]").forEach((card) => {
    const mention = card.getAttribute("data-talent-card");
    const talent = (state.talentsRoster ?? []).find((t) => t.mention === mention);
    card.classList.toggle("is-selected", talent?.templateId === templateId);
  });
}

function clearTalentPreviewSelection() {
  state.talentPreviewTemplateId = null;
  state.talentPreviewSource = null;
  highlightTalentPreviewCards();
}

function buildTalentPreviewMeta(templateId, source = "market") {
  const listItem = (state.talentTemplates ?? []).find((t) => t.id === templateId);
  const rosterTalent = (state.talentsRoster ?? []).find((t) => t.templateId === templateId);
  const hired = Boolean(listItem?.hired || rosterTalent);
  return {
    templateId,
    source,
    hired,
    rosterMention: rosterTalent?.mention || "",
    emoji: rosterTalent ? talentEmoji(rosterTalent) : listItem?.emoji || "",
    avatar: rosterTalent?.avatar || listItem?.avatar || "",
    role: rosterTalent?.role || listItem?.role || templateId,
    category: rosterTalent?.category || listItem?.category || "",
    description: rosterTalent?.description || listItem?.description || listItem?.vibe || "",
    suggestedSkills: [],
    suggestedTools: [],
  };
}

async function openTalentTemplatePreview(templateId, source = "market") {
  if (!templateId) return;
  const meta = buildTalentPreviewMeta(templateId, source);
  showTalentTemplateDetail(meta, "加载模版…");

  const bridge = getBridge();
  if (!bridge?.getTalentTemplate) {
    showTalentTemplateDetail(meta, "（无法加载模版正文）");
    return;
  }
  try {
    const res = await bridge.getTalentTemplate({ templateId });
    const tpl = res?.template;
    if (state.activeTalentTemplateId !== templateId && state.talentPreviewTemplateId !== templateId) {
      return;
    }
    if (!tpl) {
      showTalentTemplateDetail(meta, "（未找到模版文件）");
      return;
    }
    showTalentTemplateDetail(
      {
        ...meta,
        role: tpl.role || meta.role,
        category: tpl.category || meta.category,
        description: tpl.description || meta.description,
        emoji: tpl.emoji || meta.emoji,
        avatar: tpl.avatar || meta.avatar,
        suggestedSkills: tpl.suggestedSkills || [],
        suggestedTools: tpl.suggestedTools || [],
      },
      tpl.systemPrompt || meta.description || "（无人设正文）",
    );
  } catch {
    if (state.talentPreviewTemplateId === templateId || state.activeTalentTemplateId === templateId) {
      showTalentTemplateDetail(meta, meta.description || "（加载模版失败）");
    }
  }
}

function bindTalentsMarketPane(root) {
  root.querySelectorAll(".talent-cat-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.talentMarketCategory = btn.getAttribute("data-talent-cat") || "";
      void loadTalentTemplates().then(() => renderTalentsMarketPane());
    });
  });
  root.querySelectorAll(".talent-hire-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const templateId = btn.getAttribute("data-template-id");
      if (templateId) openTalentHireModal(templateId);
    });
  });
  root.querySelectorAll(".talent-market-card[data-template-id]").forEach((card) => {
    const open = () => {
      const templateId = card.getAttribute("data-template-id");
      if (!templateId) return;
      void openTalentTemplatePreview(templateId, "market");
    };
    card.addEventListener("click", (e) => {
      if (e.target.closest(".talent-hire-btn")) return;
      open();
    });
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      open();
    });
  });
}

function bindTalentsRosterPane(root) {
  root.querySelectorAll("[data-talent-card]").forEach((card) => {
    const open = () => {
      const mention = card.getAttribute("data-talent-card");
      const talent = (state.talentsRoster ?? []).find((t) => t.mention === mention);
      if (talent?.templateId) void openTalentTemplatePreview(talent.templateId, "roster");
    };
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      open();
    });
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      open();
    });
  });
  root.querySelectorAll("[data-talent-mention]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mention = btn.getAttribute("data-talent-mention");
      if (mention) insertTalentMention(mention);
    });
  });
  root.querySelectorAll("[data-talent-fire]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mention = btn.getAttribute("data-talent-fire");
      if (mention) void fireTalentFromRoster(mention, btn);
    });
  });
}

function openTalentHireModal(templateId) {
  const tpl = (state.talentTemplates ?? []).find((t) => t.id === templateId);
  if (!tpl) return;
  const modal = $("talentHireModal");
  if (!modal) return;
  const defaultName = tpl.role || tpl.id;
  state.talentHireDraft = {
    templateId: tpl.id,
    role: tpl.role,
    description: tpl.description,
    emoji: tpl.emoji,
    avatar: tpl.avatar,
    displayName: defaultName,
    mention: slugTalentMention(defaultName) || slugTalentMention(tpl.id),
  };
  const icon = tpl.emoji ? `${tpl.emoji} ` : "";
  $("talentHireModalTitle").textContent = `租用 ${tpl.role || tpl.id}`;
  $("talentHireModalDesc").textContent =
    tpl.description || tpl.vibe || `${talentCategoryLabel(tpl.category)} · ${tpl.id}`;
  $("talentHireDisplayNameInput").value = state.talentHireDraft.displayName || "";
  const mentionInput = $("talentHireMentionInput");
  if (mentionInput) {
    mentionInput.value = state.talentHireDraft.mention || "";
    delete mentionInput.dataset.touched;
  }
  modal.classList.remove("hidden");
}

function closeTalentHireModal() {
  state.talentHireDraft = null;
  $("talentHireModal")?.classList.add("hidden");
}

async function submitTalentHire() {
  const draft = state.talentHireDraft;
  if (!draft?.templateId) return;
  const bridge = requireBridge();
  if (!bridge?.hireTalent) return;
  const displayName = ($("talentHireDisplayNameInput")?.value || "").trim();
  const mention = ($("talentHireMentionInput")?.value || "").trim();
  const btn = $("talentHireConfirmBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "…";
  }
  try {
    const res = await bridge.hireTalent({
      templateId: draft.templateId,
      displayName: displayName || undefined,
      mention: mention || undefined,
      cwd: talentProjectCwd() || undefined,
    });
    const talent = res?.talent;
    notifyUser(`已租用 ${talent?.displayName ?? draft.templateId} (@${talent?.mention ?? ""})`, "ok");
    closeTalentHireModal();
    await Promise.all([loadTalentRoster(), loadTalentTemplates()]);
    const item = (state.talentTemplates ?? []).find((t) => t.id === draft.templateId);
    if (item) item.hired = true;
    if (state.activeNav === "talents") {
      renderTalentsMarketPane();
      renderTalentsRosterPane();
      renderTalentsOverview();
      setTalentsTab("roster");
    }
  } catch (e) {
    notifyUser(`租用失败: ${String(e)}`, "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "租用";
    }
  }
}

async function openTalentDetail(mention) {
  const talent = (state.talentsRoster ?? []).find(
    (t) => t.mention === mention || t.instanceId === mention,
  );
  if (!talent) return;
  const modal = $("talentDetailModal");
  if (!modal) return;
  state.talentDetailKey = talent.mention;
  $("talentDetailModalTitle").textContent = talent.displayName;
  $("talentDetailDisplayNameInput").value = talent.displayName;
  $("talentDetailMentionInput").value = talent.mention;
  $("talentDetailEnabledInput").checked = Boolean(talent.enabled);
  const stats =
    talent.stats?.tasksDone > 0
      ? `已完成 ${talent.stats.tasksDone} 次`
      : talent.stats?.lastUsed
        ? `最近使用 ${formatRelativeTime(talent.stats.lastUsed)}`
        : "尚未使用";
  $("talentDetailMeta").textContent = `${talent.role} · ${talentCategoryLabel(talent.category)} · ${stats} · ${talent.permissionPreset}`;
  $("talentDetailSkillsInput").value = (talent.skills || []).join(", ");
  $("talentDetailToolsInput").value = (talent.tools || []).join(", ");
  const strictInput = $("talentDetailStrictSkillsInput");
  if (strictInput) strictInput.checked = Boolean(talent.strictSkills);
  $("talentDetailPromptPre").textContent = "加载中…";
  modal.classList.remove("hidden");
  const bridge = getBridge();
  if (bridge?.getTalentTemplate) {
    try {
      const res = await bridge.getTalentTemplate({ templateId: talent.templateId });
      const prompt = res?.template?.systemPrompt || talent.description || "（无人设正文）";
      $("talentDetailPromptPre").textContent = prompt;
    } catch {
      $("talentDetailPromptPre").textContent = talent.description || "（加载失败）";
    }
  } else {
    $("talentDetailPromptPre").textContent = talent.description || "（无法加载人设）";
  }
}

function closeTalentDetailModal() {
  state.talentDetailKey = null;
  $("talentDetailModal")?.classList.add("hidden");
}

async function saveTalentDetail() {
  const key = state.talentDetailKey;
  if (!key) return;
  const bridge = requireBridge();
  if (!bridge?.renameTalent || !bridge?.updateTalentBindings) return;
  const displayName = ($("talentDetailDisplayNameInput")?.value || "").trim();
  const mention = ($("talentDetailMentionInput")?.value || "").trim();
  const enabled = Boolean($("talentDetailEnabledInput")?.checked);
  const skills = parseTalentListInput($("talentDetailSkillsInput")?.value);
  const tools = parseTalentListInput($("talentDetailToolsInput")?.value);
  const strictSkills = Boolean($("talentDetailStrictSkillsInput")?.checked);
  const btn = $("talentDetailSaveBtn");
  if (btn) btn.disabled = true;
  try {
    const cwd = talentProjectCwd() || undefined;
    let target = key;
    if (displayName || (mention && mention !== key)) {
      const res = await bridge.renameTalent({
        instanceIdOrMention: key,
        displayName: displayName || undefined,
        mention: mention || undefined,
        cwd,
      });
      target = res?.talent?.mention || mention || key;
    }
    await bridge.updateTalentBindings({
      instanceIdOrMention: target,
      skills,
      tools,
      enabled,
      strictSkills,
      cwd,
    });
    notifyUser("人才设置已保存", "ok");
    closeTalentDetailModal();
    await Promise.all([loadTalentRoster(), loadTalentTemplates()]);
    if (state.activeNav === "talents") void renderTalentsView();
  } catch (e) {
    notifyUser(`保存失败: ${String(e)}`, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function hireTalentFromTemplate(templateId) {
  if (!(state.talentTemplates ?? []).some((t) => t.id === templateId)) {
    await loadTalentTemplates();
  }
  openTalentHireModal(templateId);
}

async function fireTalentFromRoster(mention, btn) {
  const bridge = requireBridge();
  if (!bridge?.fireTalent) return;
  const talent = (state.talentsRoster ?? []).find((t) => t.mention === mention);
  if (!talent) return;
  if (!confirm(`确定解约 ${talent.displayName} (@${mention})？`)) return;
  if (btn) btn.disabled = true;
  try {
    await bridge.fireTalent({
      instanceIdOrMention: mention,
      cwd: talentProjectCwd() || undefined,
    });
    notifyUser(`已解约 @${mention}`, "ok");
    if (state.talentDetailKey === mention) closeTalentDetailModal();
    await Promise.all([loadTalentRoster(), loadTalentTemplates()]);
    if (state.activeNav === "talents") void renderTalentsView();
  } catch (e) {
    notifyUser(`解约失败: ${String(e)}`, "err");
    if (btn) btn.disabled = false;
  }
}

function renderTalentsOverview() {
  const el = $("talentsOverviewHost");
  if (el) el.innerHTML = renderTalentsOverviewBar();
}

function syncTalentsToolbarPanes() {
  const tab = state.talentsTab;
  document.querySelectorAll(".talents-page-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-talents-tab") === tab);
  });
  $("talentsToolbarMarket")?.classList.toggle("hidden", tab !== "market");
  $("talentsToolbarRoster")?.classList.toggle("hidden", tab !== "roster");
}

function setTalentsTab(tab) {
  state.talentsTab = tab;
  clearTalentPreviewSelection();
  syncTalentsToolbarPanes();
  $("talentsMarketPane")?.classList.toggle("hidden", tab !== "market");
  $("talentsRosterPane")?.classList.toggle("hidden", tab !== "roster");
  if (tab === "market") renderTalentsMarketPane();
  else renderTalentsRosterPane();
}

async function syncTalentsFromUi() {
  const btn = $("talentsSyncBtn");
  const bridge = getBridge();
  if (!bridge?.syncTalents) {
    notifyUser("无法同步：桌面通信桥未就绪，请重启应用后再试。", "err");
    return;
  }
  const prevLabel = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "↻ 同步中…";
  }
  try {
    const res = await bridge.syncTalents({});
    notifyUser(`已同步 ${res.count} 个人才模板（${res.source}）`, "ok");
    if (res.notice) notifyUser(res.notice, "warn");
    await Promise.all([loadTalentTemplates(), loadTalentRoster()]);
    if (state.activeNav === "talents") void renderTalentsView();
  } catch (e) {
    notifyUser(`同步失败: ${String(e)}`, "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel || "↻ 同步";
    }
  }
}

async function renderTalentsView() {
  const root = $("resourceView");
  if (!root) return;
  state.talentsLoading = true;
  root.innerHTML = wrapTalentsPage(`<div class="store-status">正在加载…</div>`);
  try {
    await Promise.all([loadTalentTemplates(), loadTalentRoster()]);
  } finally {
    state.talentsLoading = false;
  }
  const previewId = state.activeTalentTemplateId || state.talentPreviewTemplateId;
  const previewSource = state.talentPreviewSource || "market";
  root.innerHTML = wrapTalentsPage(`
    <div id="talentsOverviewHost">${renderTalentsOverviewBar()}</div>
    <div id="talentsMarketPane" class="talents-page-pane${state.talentsTab !== "market" ? " hidden" : ""}"></div>
    <div id="talentsRosterPane" class="talents-page-pane${state.talentsTab !== "roster" ? " hidden" : ""}"></div>
  `);
  syncTalentsToolbarPanes();
  renderTalentsMarketPane();
  renderTalentsRosterPane();
  if (previewId) {
    void openTalentTemplatePreview(previewId, previewSource);
  }
}

function insertTalentMention(mention) {
  const input = $("messageInput");
  if (!input) return;
  setNav("chat");
  const token = `@${mention} `;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = `${input.value.slice(0, start)}${token}${input.value.slice(end)}`;
  const pos = start + token.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function bindTalentsUi() {
  document.querySelectorAll(".talents-page-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-talents-tab");
      if (tab === "market" || tab === "roster") setTalentsTab(tab);
    });
  });
  $("talentsSyncBtn")?.addEventListener("click", () => void syncTalentsFromUi());
  $("talentMarketSearchInput")?.addEventListener("input", (e) => {
    state.talentMarketQuery = e.target.value || "";
    renderTalentsMarketPane();
    renderTalentsOverview();
  });
  $("talentRosterSearchInput")?.addEventListener("input", (e) => {
    state.talentRosterQuery = e.target.value || "";
    renderTalentsRosterPane();
  });
  const hireModal = $("talentHireModal");
  $("talentHireModalCloseBtn")?.addEventListener("click", closeTalentHireModal);
  $("talentHireCancelBtn")?.addEventListener("click", closeTalentHireModal);
  hireModal?.querySelector(".modal-mask")?.addEventListener("click", closeTalentHireModal);
  $("talentHireConfirmBtn")?.addEventListener("click", () => void submitTalentHire());
  $("talentHireDisplayNameInput")?.addEventListener("input", (e) => {
    const name = e.target.value.trim();
    const mentionInput = $("talentHireMentionInput");
    if (mentionInput && !mentionInput.dataset.touched) {
      mentionInput.value = slugTalentMention(name);
    }
  });
  $("talentHireMentionInput")?.addEventListener("input", (e) => {
    if (e.target.value.trim()) e.target.dataset.touched = "1";
  });
  const detailModal = $("talentDetailModal");
  $("talentDetailModalCloseBtn")?.addEventListener("click", closeTalentDetailModal);
  $("talentDetailCancelBtn")?.addEventListener("click", closeTalentDetailModal);
  detailModal?.querySelector(".modal-mask")?.addEventListener("click", closeTalentDetailModal);
  $("talentDetailSaveBtn")?.addEventListener("click", () => void saveTalentDetail());
  $("talentDetailFireBtn")?.addEventListener("click", () => {
    const key = state.talentDetailKey;
    if (key) void fireTalentFromRoster(key, $("talentDetailFireBtn"));
  });
}

function renderProjects() {
  const root = $("projectList");
  root.innerHTML = "";
  const projects = [...state.projects].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return 0;
  });
  projects.forEach((p) => {
    const card = document.createElement("div");
    card.className = [
      "project-item",
      p.id === state.activeProjectId ? "active" : "",
      p.pinned ? "is-pinned" : "",
    ]
      .filter(Boolean)
      .join(" ");
    let projectSessions = state.sessionsAll
      .filter((s) => sessionCwdMatches(p.cwd, s.cwd))
      .filter((s) => !state.archivedSessionIds.has(s.id))
      .sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt || 0).getTime() -
          new Date(a.updatedAt || a.createdAt || 0).getTime(),
      );
    const runningForProject = projectSessions.filter((s) =>
      state.runningSessions.has(s.id),
    );
    const pinnedForProject = projectSessions.filter(
      (s) => !state.runningSessions.has(s.id) && state.pinnedSessionIds.has(s.id),
    );
    const rest = projectSessions.filter(
      (s) => !state.runningSessions.has(s.id) && !state.pinnedSessionIds.has(s.id),
    );
    projectSessions = [...runningForProject, ...pinnedForProject, ...rest];
    const expanded = state.expandedProjectIds.has(p.id);
    const draftRunning =
      state.pendingNewSessionByProject.has(p.id) &&
      !runningForProject.length;
    const sessionRows = projectSessions.length
      ? projectSessions
          .slice(0, 8)
          .map((s) => buildSessionItemMarkup(s, p))
          .join("")
      : "";
    const emptyRow = draftRunning
      ? `<div class="session-empty is-running"><span class="session-indicator" aria-hidden="true"></span><span>新会话</span><span class="session-run-badge">进行中</span></div>`
      : `<div class="session-empty">（新会话）</div>`;
    card.innerHTML = `
      <div class="project-head">
        <span class="project-icon" aria-hidden="true">${sidebarIcon("folder", "project-icon-svg")}</span>
        <div class="project-title">
          <div class="project-name-row">
            <span class="project-name">${escapeHtml(p.name)}</span>
            <span class="project-arrow${expanded ? " is-open" : ""}" aria-hidden="true">${sidebarIcon("chevron-right", "project-arrow-svg")}</span>
          </div>
          <div class="project-sub" title="${escapeHtml(p.cwd)}">${escapeHtml(p.cwd)}</div>
        </div>
        <div class="project-actions">
          <button type="button" class="project-menu-btn" title="项目操作" aria-label="项目操作">•••</button>
          <button type="button" class="project-compose-btn" title="在该工作空间新建对话" aria-label="在该工作空间新建对话">${sidebarIcon("compose", "project-compose-svg")}</button>
        </div>
      </div>
      <div class="project-menu hidden" role="menu">
        <button type="button" data-project-action="pin">${sidebarIcon("pin", "project-menu-icon")}${p.pinned ? "取消置顶项目" : "置顶项目"}</button>
        <button type="button" data-project-action="reveal">${sidebarIcon("reveal", "project-menu-icon")}在 Finder 中显示</button>
        <button type="button" disabled title="当前版本暂不支持创建永久工作树">${sidebarIcon("tree", "project-menu-icon")}创建永久工作树</button>
        <button type="button" data-project-action="rename">${sidebarIcon("rename", "project-menu-icon")}重命名项目</button>
        <button type="button" data-project-action="archive">${sidebarIcon("archive", "project-menu-icon")}归档对话</button>
        <button type="button" data-project-action="remove">${sidebarIcon("x", "project-menu-icon")}移除</button>
      </div>
      <div class="project-sessions ${expanded ? "" : "hidden"}">
        ${sessionRows || emptyRow}
      </div>
    `;
    card.querySelector(".project-menu-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = card.querySelector(".project-menu");
      document
        .querySelectorAll(".project-menu")
        .forEach((el) => {
          if (el !== menu) el.classList.add("hidden");
        });
      menu?.classList.toggle("hidden");
    });
    card.querySelector(".project-menu")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = e.target.closest("[data-project-action]")?.dataset
        ?.projectAction;
      if (action) void handleProjectAction(action, p);
    });
    card
      .querySelector(".project-compose-btn")
      ?.addEventListener("click", (e) => {
        e.stopPropagation();
        document
          .querySelectorAll(".project-menu")
          .forEach((el) => el.classList.add("hidden"));
        setNav("chat");
        setActiveProject(p.id, { newChat: true });
      });
    card.querySelectorAll(".session-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = e.target.closest("[data-session-action]")?.dataset
          ?.sessionAction;
        if (action) {
          handleSessionAction(action, item.getAttribute("data-session"));
          return;
        }
        const sid = item.getAttribute("data-session");
        if (!sid) return;
        const outgoingSid =
          state.viewingTimelineSessionId || getActiveProject()?.sessionId || "";
        const prevSid = p.sessionId;
        state.activeProjectId = p.id;
        state.expandedProjectIds.add(p.id);
        setNav("chat");
        void sessionRuns
          .switchSessionView(p, sid, prevSid, { outgoingSessionId: outgoingSid })
          .then(() => {
            renderProjects();
            renderComposerProjectSelect();
          });
      });
    });
    card.addEventListener("click", () => {
      if (state.expandedProjectIds.has(p.id)) state.expandedProjectIds.delete(p.id);
      else state.expandedProjectIds.add(p.id);
      setActiveProject(p.id, { newChat: false });
    });
    root.appendChild(card);
  });
}

const PLUGIN_SOURCE_ORDER = ["user", "project", "builtin"];
const PLUGIN_MANAGE_GROUP_ORDER = ["user", "project", "builtin", "orphan"];

function pluginSourceSectionLabel(source) {
  const map = {
    builtin: "Forge 内置",
    user: "已安装",
    project: "项目",
  };
  return map[source] ?? source;
}

function pluginSourceBadge(source) {
  const map = { builtin: "内置", user: "用户", project: "项目" };
  return map[source] ?? source;
}

function pluginMatchesQuery(plugin, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const caps = plugin.capabilities ?? {};
  const hay = [
    plugin.name,
    plugin.id,
    plugin.description,
    plugin.version,
    plugin.source,
    plugin.root,
    `skills:${caps.skills ?? 0}`,
    `mcp:${caps.mcpServers ?? 0}`,
    `cmds:${caps.commands ?? 0}`,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function pluginsBySource(plugins, query) {
  const filtered = (plugins || []).filter((p) => pluginMatchesQuery(p, query));
  const bySource = new Map();
  for (const p of filtered) {
    const key = p.source ?? "user";
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(p);
  }
  return bySource;
}

function resolvePluginsManageGroup(bySource, orphanCount) {
  const available = new Set([...bySource.keys()]);
  if (orphanCount > 0) available.add("orphan");
  if (available.has(state.pluginsManageGroup)) return state.pluginsManageGroup;
  for (const id of PLUGIN_MANAGE_GROUP_ORDER) {
    if (available.has(id)) return id;
  }
  return [...available][0] || "user";
}

function renderPluginsManageCategoryTabs(bySource, orphanCount) {
  const active = resolvePluginsManageGroup(bySource, orphanCount);
  state.pluginsManageGroup = active;
  const tabs = [];
  for (const id of PLUGIN_MANAGE_GROUP_ORDER) {
    if (id === "orphan") {
      if (!orphanCount) continue;
      tabs.push({ id, label: "未纳管", count: orphanCount });
      continue;
    }
    const list = bySource.get(id);
    if (!list) continue;
    tabs.push({ id, label: pluginSourceSectionLabel(id), count: list.length });
  }
  for (const [source, list] of bySource) {
    if (PLUGIN_MANAGE_GROUP_ORDER.includes(source)) continue;
    tabs.push({ id: source, label: String(source), count: list.length });
  }
  if (!tabs.length) return "";
  return `<div class="skill-category-tabs" role="tablist" aria-label="插件分类">
    ${tabs
      .map(
        (t) => `<button type="button" class="skill-category-tab${t.id === active ? " active" : ""}" data-plugin-group="${escapeHtml(
          t.id,
        )}" role="tab" aria-selected="${t.id === active}">${escapeHtml(t.label)}<span class="skill-category-count">${t.count}</span></button>`,
      )
      .join("")}
  </div>`;
}

function renderPluginCard(plugin) {
  const enabled = plugin.enabled !== false;
  const caps = pluginCapsLine(plugin.capabilities);
  const detail = [plugin.description, caps].filter(Boolean).join(" · ");
  const meta = `v${plugin.version}${detail ? ` · ${detail}` : ""}`;
  const toggleHtml = `<button type="button" class="skill-toggle${enabled ? " is-on" : ""}" data-plugin-toggle="${escapeHtml(plugin.id)}" data-enabled="${enabled ? "0" : "1"}" aria-pressed="${enabled}" aria-label="${enabled ? "禁用" : "启用"} ${escapeHtml(plugin.name)}"></button>`;
  const active = state.activePluginId === plugin.id ? " active" : "";
  const hub = globalThis.ForgeExtensionHub;
  const row = state.hubPluginRows.get(plugin.id);
  const chips = hub && row ? hub.agentChipsHtml(row, escapeHtml) : "";
  const actions = hub
    ? hub.manageActionsHtml(row || { id: plugin.id, inHub: false, discovered: {} }, escapeHtml, {
        toggleHtml,
      })
    : toggleHtml;
  return `<article class="skill-card skill-card-compact plugin-card manage-card skill-card-clickable${active}${enabled ? "" : " is-disabled"}" data-plugin-id="${escapeHtml(plugin.id)}" role="button" tabindex="0">
    <div class="skill-card-layout">
      <span class="skill-card-glyph plugin-card-glyph" aria-hidden="true">⊞</span>
      <div class="skill-card-content">
        <div class="skill-card-topline">
          <span class="skill-card-name">${escapeHtml(plugin.name)}</span>
          <span class="skill-card-source">${escapeHtml(pluginSourceBadge(plugin.source))}</span>
        </div>
        <p class="skill-card-desc" title="${escapeHtml(meta)}">${escapeHtml(meta)}</p>
      </div>
      ${actions}
    </div>
    ${chips}
  </article>`;
}

function renderPluginGroupsHtml(plugins, query, options = {}) {
  const bySource = pluginsBySource(plugins, query);
  const activeGroup = options.activeGroup;
  if (!plugins.length && !activeGroup) {
    return `<div class="skill-installed-empty">暂无插件。切换到「发现」安装，或使用 + 手动添加。</div>`;
  }
  if (query && ![...bySource.values()].some((list) => list.length)) {
    return `<div class="skill-installed-empty">没有匹配「${escapeHtml(query)}」的插件</div>`;
  }
  const sources = activeGroup
    ? [activeGroup].filter((s) => s !== "orphan" && bySource.has(s))
    : [...PLUGIN_SOURCE_ORDER.filter((s) => bySource.has(s)), ...[...bySource.keys()].filter((s) => !PLUGIN_SOURCE_ORDER.includes(s))];
  if (!sources.length) {
    return activeGroup
      ? `<div class="skill-installed-empty">此分类暂无插件</div>`
      : "";
  }
  return sources
    .map((source) => {
      const list = bySource.get(source) ?? [];
      return `<section class="skill-group skill-group-flat">
      <div class="skill-card-grid">${list.map((p) => renderPluginCard(p)).join("")}</div>
    </section>`;
    })
    .join("");
}

function syncPluginToolbarPanes() {
  const tab = state.pluginsTab;
  document.querySelectorAll("[data-plugin-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-plugin-tab") === tab);
  });
  $("pluginToolbarInstalled")?.classList.toggle("hidden", tab !== "installed");
  $("pluginToolbarDiscover")?.classList.toggle("hidden", tab !== "discover");
  $("pluginToolbarHint")?.classList.toggle("hidden", tab !== "discover");
}

/**
 * Load hub list + discovery for manage cards, filtered by kind.
 * @param {"skill"|"plugin"} kind
 */
async function loadHubManageData(kind) {
  let items = [];
  let discovery = [];
  try {
    const res = await requireBridge().hubList();
    items = res?.items ?? [];
    try {
      const disc = await requireBridge().hubDiscover();
      discovery = disc?.agents ?? [];
    } catch (e) {
      notifyUser(`探测各 Agent 已装扩展失败: ${String(e)}`, "warn");
    }
  } catch (e) {
    notifyUser(`加载 Hub 失败: ${String(e)}`, "warn");
  }
  const api = globalThis.ForgeExtensionHub;
  const map = api ? api.rowsById(items, discovery, kind) : new Map();
  if (kind === "plugin") {
    state.hubPluginRows = map;
    state.hubPluginDiscovery = discovery;
  } else {
    state.hubSkillRows = map;
    state.hubSkillDiscovery = discovery;
  }
  return { items, discovery, map };
}

function hubManageDeps(kind) {
  return {
    deploy: (extId, agent) =>
      requireBridge().hubDeploy({ extId, agents: [agent], scope: "user" }),
    undeploy: (extId, agent) =>
      requireBridge().hubUndeploy({ extId, agent, scope: "user" }),
    sync: (extId) => requireBridge().hubSync({ extId }),
    remove: (extId) => requireBridge().hubRemove({ extId }),
    importToHub: async (extId) => {
      const discovery =
        kind === "plugin" ? state.hubPluginDiscovery : state.hubSkillDiscovery;
      let src;
      for (const ag of discovery) {
        if (!ag?.available) continue;
        const hit = (ag.found || []).find(
          (f) => f.id === extId && (!kind || f.kind === kind),
        );
        if (hit) {
          src = { agent: ag.agent, kind: hit.kind };
          break;
        }
      }
      if (!src) throw new Error(`没找到 ${extId} 所在的 Agent`);
      return requireBridge().hubImport({ agent: src.agent, extId, kind: src.kind });
    },
    notify: (msg, level) => notifyUser(msg, level),
    confirm: (msg) => window.confirm(msg),
    refresh: async () => {
      await loadHubManageData(kind);
      if (kind === "plugin") {
        const cwd = getActiveProject()?.cwd;
        if (cwd) {
          const pluginRes = await requireBridge().listPlugins(cwd);
          state.plugins = pluginRes?.plugins ?? [];
          indexPluginsFromList(state.plugins);
        }
        renderPluginsInstalledPane();
      } else {
        await loadInstalledSkillsGroups();
        renderSkillsInstalledPane(state.skillsGroups);
      }
    },
  };
}

function setPluginsTab(tab) {
  state.pluginsTab = tab === "distribute" ? "installed" : tab;
  syncPluginToolbarPanes();
  void renderPluginView();
}

function renderPluginsInstalledPane() {
  const pane = $("pluginInstalledPane");
  if (!pane) return;
  const hub = globalThis.ForgeExtensionHub;
  const query = state.pluginsSearchQuery;
  const bySource = pluginsBySource(state.plugins, query);
  const orphans = hub
    ? hub.orphanRows(
        [...state.hubPluginRows.values()],
        state.plugins.map((p) => p.id),
      )
    : [];
  const activeGroup = resolvePluginsManageGroup(bySource, orphans.length);
  state.pluginsManageGroup = activeGroup;
  const tabs = renderPluginsManageCategoryTabs(bySource, orphans.length);

  let body = "";
  if (activeGroup === "orphan") {
    body = orphans.length
      ? `<section class="skill-group skill-group-flat"><div class="skill-card-grid manage-card-grid">${hub.orphanCardsHtml(
          orphans,
          escapeHtml,
        )}</div></section>`
      : `<div class="skill-installed-empty">没有未纳管的插件</div>`;
  } else {
    body = renderPluginGroupsHtml(state.plugins, query, { activeGroup });
  }

  pane.innerHTML =
    `${tabs}${body}` || `<div class="skill-installed-empty">暂无插件。</div>`;
  pane.querySelectorAll("[data-plugin-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-plugin-group");
      if (!id || id === state.pluginsManageGroup) return;
      state.pluginsManageGroup = id;
      renderPluginsInstalledPane();
    });
  });
  bindPluginCardClicks(pane);
  if (hub) hub.bindManageCards(pane, hubManageDeps("plugin"));
}

function renderPluginsDiscoverPane() {
  const pane = $("pluginDiscoverPane");
  if (!pane) return;
  const api = globalThis.ForgePluginsMarketplace;
  if (!api) {
    pane.innerHTML = `<div class="event warn">发现页脚本未加载</div>`;
    return;
  }
  pane.innerHTML = api.renderDiscoverHtml(state, escapeHtml);
  api.bindDiscover(pane, state, {
    importPlugin: (payload) => requireBridge().importPlugin(payload),
    notify: (msg, level) => notifyUser(msg, level),
    refreshDiscover: () => loadPluginsDiscover(),
    openGithub: (repo, subdir) => void openGithubRepo(repo, subdir),
    onInstalled: async () => {
      const cwd = getActiveProject()?.cwd;
      if (!cwd) return;
      const pluginRes = await requireBridge().listPlugins(cwd);
      state.plugins = pluginRes?.plugins ?? [];
      indexPluginsFromList(state.plugins);
    },
  });
  bindDiscoverInstalledOpen(pane, state.pluginsMarketItems, (item) => {
    const local =
      state.plugins.find((p) => p.id === item.id) ||
      state.plugins.find((p) => item.catalogId && p.id === item.catalogId);
    if (local) void openPluginDetail(local.id);
  });
}

async function loadPluginsDiscover() {
  const api = globalThis.ForgePluginsMarketplace;
  if (!api?.renderDiscoverHtml) return;
  state.pluginsMarketLoading = true;
  renderPluginsDiscoverPane();
  try {
    const q = state.pluginsMarketQuery.trim();
    const mode = q.length >= 2 ? "all" : "featured";
    const res = await requireBridge().searchPluginsMarketplace({ query: q, mode, limit: 40 });
    state.pluginsMarketItems = res?.items ?? [];
    state.pluginsMarketHint = res?.hint ?? "";
  } catch (e) {
    state.pluginsMarketItems = [];
    state.pluginsMarketHint = `搜索失败: ${String(e)}`;
  } finally {
    state.pluginsMarketLoading = false;
    renderPluginsDiscoverPane();
  }
}

function renderPluginView() {
  const root = $("resourceView");
  root.innerHTML = `<div class="plugins-page">
    <div id="pluginInstalledPane" class="skills-page-pane"></div>
    <div id="pluginDiscoverPane" class="skills-page-pane hidden"></div>
  </div>`;
  syncPluginToolbarPanes();
  $("pluginInstalledPane")?.classList.toggle("hidden", state.pluginsTab !== "installed");
  $("pluginDiscoverPane")?.classList.toggle("hidden", state.pluginsTab !== "discover");

  if (state.pluginsTab === "discover") {
    if (!state.pluginsMarketItems.length && !state.pluginsMarketLoading) {
      void loadPluginsDiscover();
    } else {
      renderPluginsDiscoverPane();
    }
    return;
  }
  void (async () => {
    await loadHubManageData("plugin");
    renderPluginsInstalledPane();
  })();
}

function bindPluginCardActions(root) {
  root.querySelectorAll("[data-plugin-toggle]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const id = btn.getAttribute("data-plugin-toggle");
      const enabled = btn.getAttribute("data-enabled") === "1";
      if (!id) return;
      try {
        await requireBridge().setPluginEnabled({
          pluginId: id,
          enabled,
          cwd: getActiveProject()?.cwd,
        });
        notifyUser(`${enabled ? "已启用" : "已禁用"}插件 ${id}`, "done");
        void renderResourceView();
      } catch (err) {
        notifyUser(`操作失败: ${String(err)}`, "err");
      }
    });
  });
}

function renderMcpListItem(m) {
  const args = (m.args ?? []).join(" ");
  const status = m.managedInConfig
    ? "已在当前配置启用/管理"
    : "已安装，尚未写入当前配置";
  return `<div class="event">
    <strong>${escapeHtml(m.name)}</strong><br/>
    <span class="tiny">${escapeHtml(m.command)} ${escapeHtml(args)}</span><br/>
    <span class="tiny">来源：${escapeHtml(m.source)}</span><br/>
    <span class="tiny">${escapeHtml(status)} · ${m.enabled ? "启用" : "禁用"}</span>
  </div>`;
}

async function renderMcpView() {
  const root = $("resourceView");
  root.innerHTML = `<div class="event status">正在加载 MCP 列表…</div>`;
  const cwd = getActiveProject()?.cwd;
  if (!cwd) {
    root.innerHTML = `<div class="event warn">请先为项目设置有效工作目录。</div>`;
    return;
  }
  try {
    const res = await requireBridge().listMcp(cwd);
    const installed = Array.isArray(res?.installed) ? res.installed : [];
    const configured = Array.isArray(res?.configured) ? res.configured : [];
    const unconfiguredCount = res?.unconfiguredCount ?? 0;
    root.innerHTML = `
      <div class="event"><strong>默认安装</strong></div>
      ${
        installed.length
          ? installed.map(renderMcpListItem).join("")
          : `<div class="event warn">未扫描到默认安装 MCP。</div>`
      }
      <div class="event"><strong>当前配置</strong></div>
      ${
        configured.length
          ? configured.map(renderMcpListItem).join("")
          : `<div class="event warn">当前配置中没有 MCP 服务器。</div>`
      }
      ${
        unconfiguredCount > 0
          ? `<div class="event warn">提示：有 ${unconfiguredCount} 个默认安装 MCP 未写入当前 config，可在设置 JSON 中加入 mcp.servers。</div>`
          : ""
      }
    `;
  } catch (e) {
    root.innerHTML = `<div class="event err">加载 MCP 失败: ${escapeHtml(String(e))}</div>
      <button type="button" class="btn secondary resource-retry-btn" data-retry="mcp">重试</button>`;
    bindResourceRetry(root);
  }
}

function bindResourceRetry(root) {
  root.querySelectorAll("[data-retry]").forEach((btn) => {
    btn.addEventListener("click", () => void renderResourceView());
  });
}

function skillMatchesQuery(skill, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const hay = [
    skill.name,
    skill.id,
    skill.description,
    skill.format,
    skill.path,
    ...(skill.triggers ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

const SKILL_MANAGE_GROUP_ORDER = ["user", "project", "plugin", "builtin", "orphan"];

function skillManageGroupLabel(groupId) {
  if (groupId === "orphan") return "未纳管";
  return groupTitleLabel({ id: groupId });
}

function skillGroupCount(group, query) {
  const skills = Array.isArray(group?.skills) ? group.skills : [];
  if (!query) return skills.length;
  return skills.filter((s) => skillMatchesQuery(s, query)).length;
}

function resolveSkillsManageGroup(groups, orphanCount) {
  const available = new Set((groups || []).map((g) => g.id).filter(Boolean));
  if (orphanCount > 0) available.add("orphan");
  if (available.has(state.skillsManageGroup)) return state.skillsManageGroup;
  for (const id of SKILL_MANAGE_GROUP_ORDER) {
    if (available.has(id)) return id;
  }
  return [...available][0] || "user";
}

function renderSkillsManageCategoryTabs(groups, query, orphanCount) {
  const active = resolveSkillsManageGroup(groups, orphanCount);
  state.skillsManageGroup = active;
  const tabs = [];
  for (const id of SKILL_MANAGE_GROUP_ORDER) {
    if (id === "orphan") {
      if (!orphanCount) continue;
      tabs.push({ id, label: skillManageGroupLabel(id), count: orphanCount });
      continue;
    }
    const group = (groups || []).find((g) => g.id === id);
    if (!group) continue;
    tabs.push({
      id,
      label: skillManageGroupLabel(id),
      count: skillGroupCount(group, query),
    });
  }
  // Any unexpected group ids from the daemon.
  for (const group of groups || []) {
    if (!group?.id || SKILL_MANAGE_GROUP_ORDER.includes(group.id)) continue;
    tabs.push({
      id: group.id,
      label: skillManageGroupLabel(group.id),
      count: skillGroupCount(group, query),
    });
  }
  if (!tabs.length) return "";
  return `<div class="skill-category-tabs" role="tablist" aria-label="Skill 分类">
    ${tabs
      .map(
        (t) => `<button type="button" class="skill-category-tab${t.id === active ? " active" : ""}" data-skill-group="${escapeHtml(
          t.id,
        )}" role="tab" aria-selected="${t.id === active}">${escapeHtml(t.label)}<span class="skill-category-count">${t.count}</span></button>`,
      )
      .join("")}
  </div>`;
}

function renderSkillsGroupsHtml(groups, query, options = {}) {
  const activeGroup = options.activeGroup;
  const filteredGroups = activeGroup
    ? (groups || []).filter((g) => g.id === activeGroup)
    : groups || [];
  const sections = filteredGroups
    .map((group) => {
      const skills = (Array.isArray(group.skills) ? group.skills : []).filter((s) =>
        skillMatchesQuery(s, query),
      );
      if (query && !skills.length) return "";
      return `<section class="skill-group skill-group-flat">
        ${
          skills.length
            ? `<div class="skill-card-grid">${skills.map((s) => renderSkillCard(s, group.id)).join("")}</div>`
            : `<div class="skill-group-empty">暂无</div>`
        }
      </section>`;
    })
    .filter(Boolean);
  if (!sections.length && query) {
    return `<div class="skill-installed-empty">没有匹配「${escapeHtml(query)}」的 Skill</div>`;
  }
  if (!sections.length && activeGroup && activeGroup !== "orphan") {
    return `<div class="skill-installed-empty">此分类暂无 Skill</div>`;
  }
  return sections.join("");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function groupTitleLabel(group) {
  const map = {
    builtin: "Forge 内置",
    plugin: "插件",
    project: "项目",
    user: "已安装",
  };
  return map[group.id] ?? group.title;
}

function groupBadgeLabel(groupId) {
  const map = {
    builtin: "内置",
    plugin: "插件",
    project: "项目",
    user: "用户",
  };
  return map[groupId] ?? groupTitleLabel({ id: groupId });
}

function renderSkillCard(skill, groupId) {
  const triggers = (skill.triggers ?? []).slice(0, 4).join(" · ");
  const detail = skill.description || triggers || "";
  const active = state.activeSkillId === skill.id ? " active" : "";
  const enabled = skill.enabled !== false;
  const canToggle = skill.manageable !== false;
  const sourceBadge = groupId
    ? `<span class="skill-card-source">${escapeHtml(groupBadgeLabel(groupId))}</span>`
    : "";
  const toggleHtml = canToggle
    ? `<button type="button" class="skill-toggle${enabled ? " is-on" : ""}" data-skill-toggle="${escapeHtml(skill.id)}" data-enabled="${enabled ? "0" : "1"}" aria-pressed="${enabled}" aria-label="${enabled ? "禁用" : "启用"} ${escapeHtml(skill.name)}"></button>`
    : `<span class="skill-toggle-locked" title="随插件开关">—</span>`;
  const hub = globalThis.ForgeExtensionHub;
  const row = state.hubSkillRows.get(skill.id);
  const chips = hub && row ? hub.agentChipsHtml(row, escapeHtml) : "";
  const actions = hub
    ? hub.manageActionsHtml(row || { id: skill.id, inHub: false, discovered: {} }, escapeHtml, {
        toggleHtml,
      })
    : toggleHtml;
  const descTitle = detail ? ` title="${escapeHtml(detail)}"` : "";
  return `<article class="skill-card skill-card-compact manage-card skill-card-clickable${active}${enabled ? "" : " is-disabled"}" data-skill-id="${escapeHtml(skill.id)}" role="button" tabindex="0">
    <div class="skill-card-layout">
      <span class="skill-card-glyph" aria-hidden="true">✦</span>
      <div class="skill-card-content">
        <div class="skill-card-topline">
          <span class="skill-card-name">${escapeHtml(skill.name)}</span>
          ${sourceBadge}
        </div>
        ${detail ? `<p class="skill-card-desc"${descTitle}>${escapeHtml(detail)}</p>` : ""}
      </div>
      ${actions}
    </div>
    ${chips}
  </article>`;
}

function bindSkillCardActions(root) {
  root.querySelectorAll("[data-skill-toggle]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation?.();
      const id = btn.getAttribute("data-skill-toggle");
      const enabled = btn.getAttribute("data-enabled") === "1";
      if (!id) return;
      try {
        await requireBridge().setSkillEnabled({
          skillId: id,
          enabled,
          cwd: getActiveProject()?.cwd,
        });
        notifyUser(`${enabled ? "已启用" : "已禁用"} Skill ${id}`, "done");
        void renderSkillsView();
      } catch (err) {
        notifyUser(`操作失败: ${String(err)}`, "err");
      }
    });
  });
}

function syncSkillToolbarPanes() {
  const tab = state.skillsTab;
  document.querySelectorAll("[data-skill-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-skill-tab") === tab);
  });
  $("skillToolbarInstalled")?.classList.toggle("hidden", tab !== "installed");
  $("skillToolbarDiscover")?.classList.toggle("hidden", tab !== "discover");
  $("skillToolbarHint")?.classList.toggle("hidden", tab !== "discover");
}

function setSkillsTab(tab) {
  state.skillsTab = tab === "distribute" ? "installed" : tab;
  syncSkillToolbarPanes();
  void renderSkillsView();
}

async function loadInstalledSkillsGroups() {
  const cwd = getActiveProject()?.cwd;
  if (!cwd) return [];
  const res = await requireBridge().listSkills(cwd);
  state.skillsGroups = Array.isArray(res?.groups) ? res.groups : [];
  indexSkillsFromGroups(state.skillsGroups);
  return state.skillsGroups;
}

async function loadSkillsDiscover() {
  const api = globalThis.ForgeSkillsMarketplace;
  if (!api?.renderDiscoverHtml) return;
  state.skillsMarketLoading = true;
  renderSkillsDiscoverPane();
  try {
    const q = state.skillsMarketQuery.trim();
    const mode = q.length >= 2 ? "all" : "featured";
    const res = await requireBridge().searchSkillsMarketplace({ query: q, mode, limit: 40 });
    state.skillsMarketItems = res?.items ?? [];
    state.skillsMarketHint = res?.hint ?? "";
  } catch (e) {
    state.skillsMarketItems = [];
    state.skillsMarketHint = `搜索失败: ${String(e)}`;
  } finally {
    state.skillsMarketLoading = false;
    renderSkillsDiscoverPane();
  }
}

function renderSkillsDiscoverPane() {
  const pane = $("skillDiscoverPane");
  if (!pane) return;
  const api = globalThis.ForgeSkillsMarketplace;
  if (!api) {
    pane.innerHTML = `<div class="event warn">发现页脚本未加载</div>`;
    return;
  }
  pane.innerHTML = api.renderDiscoverHtml(state, escapeHtml);
  api.bindDiscover(pane, state, {
    importSkill: (payload) => requireBridge().importSkill(payload),
    notify: (msg, level) => notifyUser(msg, level),
    refreshDiscover: () => loadSkillsDiscover(),
    openGithub: (repo, subdir) => void openGithubRepo(repo, subdir),
    onInstalled: () => loadInstalledSkillsGroups(),
  });
  bindDiscoverInstalledOpen(pane, state.skillsMarketItems, (item) => {
    const localId = item.catalogId || item.id;
    if (state.skillsById.has(localId)) void openSkillDetail(localId);
  });
}

function renderSkillsInstalledPane(groups) {
  const pane = $("skillInstalledPane");
  if (!pane) return;
  const hub = globalThis.ForgeExtensionHub;
  const query = state.skillsSearchQuery;
  const localIds = [];
  for (const g of groups || []) {
    for (const s of g.skills || []) localIds.push(s.id);
  }
  const orphans = hub
    ? hub.orphanRows([...state.hubSkillRows.values()], localIds)
    : [];
  const activeGroup = resolveSkillsManageGroup(groups, orphans.length);
  state.skillsManageGroup = activeGroup;
  const tabs = renderSkillsManageCategoryTabs(groups, query, orphans.length);

  let body = "";
  if (activeGroup === "orphan") {
    body = orphans.length
      ? `<section class="skill-group skill-group-flat"><div class="skill-card-grid manage-card-grid">${hub.orphanCardsHtml(
          orphans,
          escapeHtml,
        )}</div></section>`
      : `<div class="skill-installed-empty">没有未纳管的 Skill</div>`;
  } else {
    body = renderSkillsGroupsHtml(groups, query, { activeGroup });
  }

  pane.innerHTML =
    `${tabs}${body}` ||
    `<div class="skill-installed-empty">暂无已加载 Skill。切换到「发现」安装，或使用 + 手动添加。</div>`;
  pane.querySelectorAll("[data-skill-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-skill-group");
      if (!id || id === state.skillsManageGroup) return;
      state.skillsManageGroup = id;
      renderSkillsInstalledPane(state.skillsGroups);
    });
  });
  bindSkillCardClicks(pane);
  if (hub) hub.bindManageCards(pane, hubManageDeps("skill"));
}

function syncHooksToolbarPanes() {
  document.querySelectorAll(".hooks-page-tab").forEach((btn) => {
    const tab = btn.getAttribute("data-hooks-tab");
    btn.classList.toggle("active", tab === state.hooksTab);
  });
}

function setHooksTab(tab) {
  state.hooksTab = tab;
  syncHooksToolbarPanes();
  if (state.activeNav === "hooks") void renderHooksView();
}

function wireHooksSaveButton(host, scope, cwd) {
  const ui = window.ForgeHooksUI;
  const editor = host?.querySelector(".hooks-editor");
  if (!ui || !editor) return;
  editor.querySelector(".hooks-save-btn")?.addEventListener("click", async () => {
    try {
      const settings = ui.collectSettings(editor);
      const saved = await requireBridge().saveHooksSettings({
        scope,
        cwd,
        settings,
      });
      host.innerHTML = ui.renderEditorHtml(saved.settings, {
        scope: saved.scope,
        path: saved.path,
        exists: saved.exists,
      });
      const nextEditor = host.querySelector(".hooks-editor");
      ui.bindEditor(nextEditor);
      wireHooksSaveButton(host, scope, cwd);
      notifyUser("Hooks 配置已保存", "done");
      if (state.hooksTab === "discovered" && cwd) {
        await renderHooksDiscoveredPane($("hooksDiscoveredPane"), cwd);
      }
    } catch (e) {
      notifyUser(`保存失败: ${String(e)}`, "err");
    }
  });
}

async function mountHooksEditor(host, scope, cwd) {
  const ui = window.ForgeHooksUI;
  if (!ui || !host) return;
  host.innerHTML = `<div class="event status">正在加载 Hooks 配置…</div>`;
  try {
    const res = await requireBridge().getHooksSettings({ scope, cwd });
    host.innerHTML = ui.renderEditorHtml(res.settings, {
      scope: res.scope,
      path: res.path,
      exists: res.exists,
    });
    ui.bindEditor(host.querySelector(".hooks-editor"));
    wireHooksSaveButton(host, scope, cwd);
  } catch (e) {
    host.innerHTML = `<div class="event err">加载失败: ${escapeHtml(String(e))}</div>`;
  }
}

async function renderHooksDiscoveredPane(pane, cwd) {
  const ui = window.ForgeHooksUI;
  if (!pane || !ui) return;
  pane.innerHTML = `<div class="event status">正在扫描…</div>`;
  try {
    const rows = await requireBridge().listDiscoveredHooks(cwd);
    pane.innerHTML = ui.renderDiscoveredTable(rows);
  } catch (e) {
    pane.innerHTML = `<div class="event err">扫描失败: ${escapeHtml(String(e))}</div>`;
  }
}

async function renderHooksView() {
  const root = $("resourceView");
  const cwd = getActiveProject()?.cwd;
  const ui = window.ForgeHooksUI;
  if (!ui) {
    root.innerHTML = `<div class="event err">Hooks UI 未加载</div>`;
    return;
  }
  if (!cwd && state.hooksTab !== "guide") {
    root.innerHTML = `<div class="event warn">请先为项目设置有效工作目录。</div>`;
    return;
  }

  root.innerHTML = `<div class="hooks-page">
    <div id="hooksGuidePane" class="hooks-page-pane"></div>
    <div id="hooksProjectPane" class="hooks-page-pane hidden"></div>
    <div id="hooksLocalPane" class="hooks-page-pane hidden"></div>
    <div id="hooksDiscoveredPane" class="hooks-page-pane hidden"></div>
  </div>`;

  syncHooksToolbarPanes();
  $("hooksGuidePane")?.classList.toggle("hidden", state.hooksTab !== "guide");
  $("hooksProjectPane")?.classList.toggle("hidden", state.hooksTab !== "project");
  $("hooksLocalPane")?.classList.toggle("hidden", state.hooksTab !== "project-local");
  $("hooksDiscoveredPane")?.classList.toggle("hidden", state.hooksTab !== "discovered");

  if (state.hooksTab === "guide") {
    $("hooksGuidePane").innerHTML = ui.renderGuideHtml();
    return;
  }
  if (state.hooksTab === "project") {
    await mountHooksEditor($("hooksProjectPane"), "project", cwd);
    return;
  }
  if (state.hooksTab === "project-local") {
    await mountHooksEditor($("hooksLocalPane"), "project-local", cwd);
    return;
  }
  if (state.hooksTab === "discovered") {
    await renderHooksDiscoveredPane($("hooksDiscoveredPane"), cwd);
  }
}

async function loadUserHooksSettingsEditor() {
  const host = $("userHooksEditorHost");
  if (!host) return;
  await mountHooksEditor(host, "user");
}

function bindHooksPageUi() {
  document.querySelectorAll(".hooks-page-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-hooks-tab");
      if (tab) setHooksTab(tab);
    });
  });
}

function automationTimezone(automation) {
  if (automation?.trigger?.type === "cron" && automation.trigger.timezone) {
    return automation.trigger.timezone;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatAutomationTimestamp(iso, timezone) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const formatted = new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
    return `${formatted} (${tz})`;
  } catch {
    return String(iso).replace("T", " ").replace(/\.\d+Z$/, "Z");
  }
}

function formatNextRun(automation) {
  if (automation?.trigger?.type === "manual") return "手动";
  if (automation?.nextRunAt) {
    return formatAutomationTimestamp(
      automation.nextRunAt,
      automationTimezone(automation),
    );
  }
  return "—";
}

function activateProjectForCwd(cwd) {
  const target = normalizeSessionCwd(cwd);
  if (!target) return false;
  const project = state.projects.find((p) => sessionCwdMatches(p.cwd, target));
  if (!project) return false;
  if (state.activeProjectId !== project.id) {
    state.activeProjectId = project.id;
    state.expandedProjectIds.add(project.id);
    saveProjects();
    renderProjects();
    renderComposerProjectSelect();
  }
  return true;
}

function formatAutomationTrigger(automation) {
  if (automation?.trigger?.type === "cron") {
    return `${automation.trigger.cron} (${automation.trigger.timezone || "UTC"})`;
  }
  return "手动触发";
}

function stripComposerAutomationPrefix(message) {
  return String(message || "")
    .replace(/^开始执行[:：]\s*/i, "")
    .trim();
}

function looksLikeScheduledAutomationRequest(message) {
  const t = stripComposerAutomationPrefix(message);
  return /每\s*\d+\s*分钟|每分钟|每小时|每\s*\d+\s*小时|每天|每日|工作日|每周|定时|(?:^|\s)cron\b|schedule|hourly|daily|weekly/i.test(
    t,
  );
}

function hasExplicitAutomationCreateIntent(message) {
  const t = stripComposerAutomationPrefix(message);
  if (!looksLikeScheduledAutomationRequest(t)) return false;
  if (/不想|不要|先别|别\s*创建|无需|不是\s*定时|按普通对话|不要自动化/i.test(t)) {
    return false;
  }
  return /创建|新建|设置|设定|添加|生成|保存|启用|帮我设|请设|create|set up|setup/i.test(t);
}

async function submitAutomationDraftFromChat(message, cwd, { retainCreateMode } = {}) {
  const normalized = stripComposerAutomationPrefix(message);
  showChatEmpty(false);
  pushEvent(
    `解析自动化: ${normalized.slice(0, 80)}${normalized.length > 80 ? "…" : ""}`,
    "status",
  );
  try {
    const parsed = await requireBridge().parseAutomationDraft({
      message: normalized,
      cwd,
    });
    if (parsed?.questions?.length) {
      if (retainCreateMode) state.automationCreateMode = true;
      for (const q of parsed.questions) pushEvent(q, "warn");
      return true;
    }
    if (parsed?.draft) {
      $("messageInput").value = "";
      const draft = normalizeAutomationDraft(parsed.draft, cwd);
      if (draft.cron) {
        try {
          const payloadDraft = {
            name: draft.name,
            prompt: draft.prompt,
            cwd: draft.cwd,
            cron: draft.cron,
            timezone: draft.timezone,
            enabled: true,
          };
          if (draft.description) payloadDraft.description = draft.description;
          if (draft.notify?.enabled) payloadDraft.notify = draft.notify;
          const res = await requireBridge().createAutomation({
            draft: payloadDraft,
            skipConfirm: true,
          });
          pushEvent(
            `已创建定时自动化「${res?.automation?.name ?? draft.name}」。请到侧栏「自动化」查看；Daemon 常驻后才会到点执行。下次运行：${formatNextRun(res?.automation)}`,
            "done",
          );
          setNav("automations");
          return true;
        } catch (e) {
          pushEvent(`自动创建失败: ${String(e)}，请在编辑器中确认`, "warn");
        }
      }
      openAutomationEditorModal(parsed.draft);
      pushEvent("已解析自动化草稿，请在编辑器中确认并保存", "done");
      return true;
    }
    if (retainCreateMode) state.automationCreateMode = true;
    pushEvent("未能解析自动化，请补充 cron、名称或任务描述", "warn");
    return true;
  } catch (e) {
    if (retainCreateMode) state.automationCreateMode = true;
    pushEvent(`解析失败: ${String(e)}`, "err");
    return true;
  }
}

function automationStatusBadgeClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "success") return "success";
  if (s === "failed") return "failed";
  if (s === "running" || s === "pending") return "running";
  if (s === "skipped") return "skipped";
  return "skipped";
}

function automationStatusLabel(status) {
  const map = {
    success: "成功",
    failed: "失败",
    running: "运行中",
    pending: "等待中",
    skipped: "已跳过",
  };
  const key = String(status || "").toLowerCase();
  return map[key] || status || "—";
}

function renderAutomationStatusBadge(status) {
  const label = automationStatusLabel(status);
  return `<span class="automation-status-badge ${automationStatusBadgeClass(status)}">${escapeHtml(label)}</span>`;
}

function formatAutomationTimestampShort(iso, timezone) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return String(iso).replace("T", " ").replace(/\.\d+Z$/, "");
  }
}

function formatNextRunCompact(automation) {
  if (automation?.trigger?.type === "manual") return "仅手动触发";
  if (automation?.nextRunAt) {
    const tz = automationTimezone(automation);
    return `${formatAutomationTimestampShort(automation.nextRunAt, tz)} · ${tz}`;
  }
  return "未排程";
}

function automationTriggerSummary(automation) {
  if (automation?.trigger?.type === "cron") {
    return `Cron ${automation.trigger.cron}`;
  }
  return "手动触发";
}

function truncateAutomationText(text, max = 140) {
  const s = String(text || "").trim();
  if (!s) return "—";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function automationNotifyLabel(kind) {
  const labels = {
    ilink: "微信 iLink",
    feishu: "飞书",
    dingtalk: "钉钉",
    http: "自研 App / HTTP",
  };
  return labels[kind] || kind || "关闭";
}

function renderAutomationsOverviewBar(automations, daemonOk) {
  const enabledCount = automations.filter((a) => a.enabled).length;
  return `<section class="automations-overview${daemonOk ? "" : " is-daemon-off"}">
    <div class="automations-overview-copy">
      <h3 class="automations-overview-title">定时任务</h3>
      <p class="automations-overview-desc">
        ${automations.length} 个任务 · ${enabledCount} 个已启用${daemonOk ? "" : " · "}<span class="automations-daemon-hint${daemonOk ? " hidden" : ""}">需保持 Daemon 运行</span>
      </p>
    </div>
    <div class="automations-overview-actions">
      <button type="button" class="btn secondary btn-sm" id="automationCreateBtn">手动创建</button>
    </div>
  </section>`;
}

function normalizeAutomationDraft(draft, cwd) {
  const activeCwd = cwd || getActiveProject()?.cwd || "";
  return {
    name: draft?.name || "",
    description: draft?.description || "",
    cron: draft?.cron || "",
    timezone: draft?.timezone || "Asia/Shanghai",
    prompt: draft?.prompt || "",
    cwd: draft?.cwd || activeCwd,
    enabled: draft?.enabled !== false,
    notify: draft?.notify || { enabled: false },
  };
}

function closeAutomationEditorModal() {
  $("automationEditorModal")?.classList.add("hidden");
  state.automationEditorDraft = null;
}

function openAutomationEditorModal(draft) {
  const normalized = normalizeAutomationDraft(draft);
  state.automationEditorDraft = normalized;
  $("automationNameInput").value = normalized.name;
  $("automationDescInput").value = normalized.description;
  $("automationCronInput").value = normalized.cron;
  $("automationTzInput").value = normalized.timezone;
  $("automationPromptInput").value = normalized.prompt;
  $("automationCwdDisplay").textContent = normalized.cwd || "—";
  $("automationEnabledInput").checked = normalized.enabled;
  void renderAutomationNotifyChannelOptions(normalized);
  $("automationEditorModal")?.classList.remove("hidden");
}

async function renderAutomationNotifyChannelOptions(draft) {
  const select = $("automationNotifyChannelSelect");
  if (!select) return;
  const selectedChannelId = draft?.notify?.channelId || "";
  const selectedKind = draft?.notify?.channelKind || "";
  select.innerHTML = `<option value="">关闭</option><option value="__loading" disabled>正在加载渠道…</option>`;
  try {
    const res = await requireBridge().listChannels({
      cwd: draft?.cwd || getActiveProject()?.cwd,
    });
    const channels = (res?.channels || []).filter(
      (c) =>
        c.enabled &&
        ["ilink", "feishu", "dingtalk", "http"].includes(c.kind),
    );
    const options = [`<option value="">关闭</option>`];
    for (const channel of channels) {
      const value = `${channel.kind}:${channel.id}`;
      const selected =
        selectedChannelId === channel.id ||
        (!selectedChannelId && selectedKind === channel.kind);
      options.push(
        `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""}>${escapeHtml(
          `${automationNotifyLabel(channel.kind)} · ${channel.name}`,
        )}</option>`,
      );
    }
    if (draft?.notify?.enabled && selectedKind && !options.some((o) => o.includes("selected"))) {
      options.push(
        `<option value="${escapeHtml(`${selectedKind}:${selectedChannelId}`)}" selected>${escapeHtml(
          `${automationNotifyLabel(selectedKind)} · 当前配置`,
        )}</option>`,
      );
    }
    select.innerHTML = options.join("");
  } catch (e) {
    select.innerHTML = `<option value="">关闭</option>`;
    notifyUser(`加载通知渠道失败: ${String(e)}`, "warn");
  }
}

async function saveAutomationFromModal() {
  if (!isAutomationEnabledInCfg(state.config)) {
    notifyUser("请先在 设置 → 权限 中启用自动化", "warn");
    openSettingsTab("permissions");
    return;
  }
  const draft = normalizeAutomationDraft(
    {
      name: $("automationNameInput")?.value?.trim(),
      description: $("automationDescInput")?.value?.trim(),
      cron: $("automationCronInput")?.value?.trim(),
      timezone: $("automationTzInput")?.value?.trim(),
      prompt: $("automationPromptInput")?.value?.trim(),
      cwd: state.automationEditorDraft?.cwd,
      enabled: $("automationEnabledInput")?.checked,
      notify: (() => {
        const raw = $("automationNotifyChannelSelect")?.value || "";
        if (!raw) return { enabled: false };
        const [channelKind, channelId] = raw.split(":");
        return {
          enabled: true,
          channelKind,
          channelId: channelId || undefined,
        };
      })(),
    },
    state.automationEditorDraft?.cwd,
  );
  if (!draft.name || !draft.prompt) {
    notifyUser("名称和 Prompt 不能为空", "warn");
    return;
  }
  if (!draft.cwd) {
    notifyUser("请先选择有效项目目录", "warn");
    return;
  }
  const scheduleHint = /每\s*\d+\s*分钟|每分钟|每小时|每天|定时/i;
  if (!draft.cron && scheduleHint.test(`${draft.name} ${draft.prompt}`)) {
    notifyUser(
      "描述里包含定时频率，但 Cron 为空。例如每 3 分钟请填写：*/3 * * * *",
      "warn",
    );
    return;
  }
  const payloadDraft = {
    name: draft.name,
    prompt: draft.prompt,
    cwd: draft.cwd,
    enabled: draft.enabled,
  };
  if (draft.description) payloadDraft.description = draft.description;
  if (draft.cron) payloadDraft.cron = draft.cron;
  if (draft.timezone) payloadDraft.timezone = draft.timezone;
  if (draft.notify?.enabled) payloadDraft.notify = draft.notify;
  try {
    const res = await requireBridge().createAutomation({
      draft: payloadDraft,
      skipConfirm: true,
    });
    closeAutomationEditorModal();
    notifyUser(`已创建自动化: ${res?.automation?.name ?? draft.name}`, "done");
    setNav("automations");
  } catch (e) {
    notifyUser(`创建失败: ${String(e)}`, "err");
  }
}

/** 空状态快捷示例：点击后进入对话并预填中文定时任务描述 */
const AUTOMATION_CHAT_STARTERS = [
  {
    id: "daily-brief",
    label: "每日简报",
    message:
      "每个工作日早上9点，帮我整理本项目的今日工作重点简报，把要点发给我",
  },
  {
    id: "weekly-review",
    label: "每周回顾",
    message:
      "每周一早上9点，生成本项目周报：总结过去7天的提交、未关闭事项和风险",
  },
  {
    id: "project-monitor",
    label: "项目巡检",
    message:
      "每6小时自动检查一次项目健康：CI 状态、依赖是否过时、TODO 是否增多，有异常就汇总给我",
  },
];

function openAutomationChatStarter(message) {
  if (!isAutomationEnabledInCfg(state.config)) {
    notifyUser("请先在 设置 → 权限 中启用自动化", "warn");
    openSettingsTab("permissions");
    return;
  }
  const active = getActiveProject();
  if (!active?.cwd) {
    notifyUser("请先为项目设置有效工作目录", "warn");
    return;
  }
  setNav("chat");
  startNewChat({ prefill: message });
  const input = $("messageInput");
  if (input) {
    input.focus();
    const len = input.value.length;
    input.setSelectionRange(len, len);
  }
}

function renderAutomationEmptyState() {
  const starters = AUTOMATION_CHAT_STARTERS.map(
    (s) => `<button type="button" class="automation-starter-card" data-automation-starter="${escapeHtml(s.id)}">
      <strong>${escapeHtml(s.label)}</strong>
      <p>${escapeHtml(truncateAutomationText(s.message, 72))}</p>
    </button>`,
  ).join("");
  return `<section class="automations-empty">
    <div class="automations-empty-hero">
      <div class="automations-empty-glow" aria-hidden="true"></div>
      <div class="automations-empty-icon" aria-hidden="true">⏱</div>
      <h3>创建第一个自动化</h3>
      <p>在对话里用自然语言描述定时任务，例如 <code>每3分钟收集最新 AI 资讯发给我</code>，Agent 会帮你解析并创建。</p>
    </div>
    <div class="automations-starter-grid">${starters}</div>
    <button type="button" class="btn secondary automations-empty-manual-btn" id="automationCreateEmptyBtn">或手动填写表单创建</button>
  </section>`;
}

function renderAutomationRunList(runs, automation) {
  if (!runs?.length) {
    return `<p class="automation-detail-empty">暂无运行记录。</p>`;
  }
  const tz = automation ? automationTimezone(automation) : undefined;
  const cwd = automation?.cwd || "";
  return `<div class="automation-run-list">${runs
    .map((run) => {
      const summary = run.error || run.preview || "";
      const triggerLabel =
        run.trigger === "schedule"
          ? "定时"
          : run.trigger === "manual"
            ? "手动"
            : run.trigger || "—";
      const previewBlock = summary
        ? `<div class="automation-run-body">
        <p class="automation-run-preview">${escapeHtml(summary)}</p>
        ${summary.length > 150 ? `<button type="button" class="link-btn automation-run-expand-btn">展开全文</button>` : ""}
      </div>`
        : "";
      return `<article class="automation-run-item">
        <div class="automation-run-head">
          ${renderAutomationStatusBadge(run.status)}
          <span class="automation-run-trigger">${escapeHtml(triggerLabel)}</span>
          <span class="automation-run-time">${escapeHtml(formatAutomationTimestampShort(run.startedAt, tz))}${run.finishedAt ? ` → ${escapeHtml(formatAutomationTimestampShort(run.finishedAt, tz))}` : ""}</span>
          <button type="button" class="link-btn automation-session-link" data-session="${escapeHtml(run.sessionId)}" data-cwd="${escapeHtml(cwd)}">会话 ${escapeHtml(run.sessionId.slice(0, 8))}</button>
        </div>
        ${previewBlock}
      </article>`;
    })
    .join("")}</div>`;
}

function renderAutomationCardDetail(automation, runs) {
  return `<div class="automation-card-detail">
    <div class="automation-detail-grid">
      <div class="automation-detail-block">
        <span class="automation-detail-label">提示词</span>
        <pre class="automation-detail-prompt">${escapeHtml(automation.prompt || "")}</pre>
      </div>
      <div class="automation-detail-meta">
        <div><span class="automation-detail-label">触发</span><code>${escapeHtml(formatAutomationTrigger(automation))}</code></div>
        <div><span class="automation-detail-label">目录</span><code>${escapeHtml(automation.cwd || "")}</code></div>
        <div><span class="automation-detail-label">通知</span><code>${automation.notify?.enabled ? automationNotifyLabel(automation.notify.channelKind) : "关闭"}</code></div>
      </div>
    </div>
    <h4 class="automation-detail-history-title">运行历史</h4>
    ${renderAutomationRunList(runs, automation)}
  </div>`;
}

function renderAutomationCard(a, lastRun, expandedAutomation, expandedRuns) {
  const expanded = state.automationExpandedId === a.id;
  const disabled = !a.enabled;
  const detail =
    expanded && expandedAutomation
      ? renderAutomationCardDetail(expandedAutomation, expandedRuns)
      : "";
  return `<article class="automation-card${expanded ? " is-expanded" : ""}${disabled ? " is-disabled" : ""}" data-automation-id="${escapeHtml(a.id)}">
    <div class="automation-card-main" data-automation-id="${escapeHtml(a.id)}">
      <div class="automation-card-icon" aria-hidden="true">⏱</div>
      <div class="automation-card-body">
        <div class="automation-card-title-row">
          <strong>${escapeHtml(a.name)}</strong>
          ${lastRun ? renderAutomationStatusBadge(lastRun.status) : `<span class="automation-status-badge skipped">未运行</span>`}
        </div>
        <p class="automation-card-meta">
          <span>下次 ${escapeHtml(formatNextRunCompact(a))}</span>
          <span class="automation-card-meta-sep">·</span>
          <span>${escapeHtml(automationTriggerSummary(a))}</span>
        </p>
      </div>
      <div class="automation-card-side">
        <label class="toggle automation-card-toggle" title="启用/停用">
          <input type="checkbox" class="automation-toggle" data-automation-id="${escapeHtml(a.id)}" ${a.enabled ? "checked" : ""} />
        </label>
        <div class="automation-card-actions">
          <button type="button" class="btn primary btn-sm automation-run-btn" data-automation-id="${escapeHtml(a.id)}">立即运行</button>
          <button type="button" class="link-btn automation-delete-btn" data-automation-id="${escapeHtml(a.id)}">删除</button>
        </div>
        <span class="automation-card-chevron${expanded ? " is-open" : ""}" aria-hidden="true">${sidebarIcon("chevron-right", "automation-card-chevron-svg")}</span>
      </div>
    </div>
    ${detail}
  </article>`;
}

function bindAutomationSessionLinks(root) {
  root.querySelectorAll(".automation-session-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const sid = btn.getAttribute("data-session");
      const cwd = btn.getAttribute("data-cwd");
      if (cwd) activateProjectForCwd(cwd);
      const active = getActiveProject();
      if (!sid || !active) return;
      if (
        hasStructuredTimelineCache(sid) &&
        !structuredTimelineHasConclusion(sid) &&
        !sessionRuns?.isSessionRunning(sid)
      ) {
        forgetSessionRunCaches(sid);
      }
      const outgoingSid =
        state.viewingTimelineSessionId || active.sessionId || "";
      const prevSid = active.sessionId;
      setNav("chat");
      void sessionRuns
        ?.switchSessionView(active, sid, prevSid, { outgoingSessionId: outgoingSid })
        .then(() => {
          renderProjects();
          renderComposerProjectSelect();
        });
    });
  });
}

function bindAutomationsView(root, automations, lastRunById) {
  root.querySelector("#automationOpenPermissionsBtn")?.addEventListener("click", () => {
    openSettingsTab("permissions");
  });
  const openManualCreate = () => {
    if (!isAutomationEnabledInCfg(state.config)) {
      notifyUser("请先在 设置 → 权限 中启用自动化", "warn");
      openSettingsTab("permissions");
      return;
    }
    openAutomationEditorModal({});
  };
  root.querySelector("#automationCreateBtn")?.addEventListener("click", openManualCreate);
  root.querySelector("#automationCreateEmptyBtn")?.addEventListener("click", openManualCreate);
  root.querySelectorAll(".automation-starter-card[data-automation-starter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-automation-starter");
      const starter = AUTOMATION_CHAT_STARTERS.find((s) => s.id === id);
      if (starter) openAutomationChatStarter(starter.message);
    });
  });
  root.querySelectorAll(".automation-pill[data-automation-starter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-automation-starter");
      const starter = AUTOMATION_CHAT_STARTERS.find((s) => s.id === id);
      if (starter) openAutomationChatStarter(starter.message);
    });
  });
  root.querySelectorAll(".automation-card-main").forEach((row) => {
    row.addEventListener("click", async (e) => {
      if (e.target.closest("button, input, label, .automation-card-actions")) return;
      const id = row.getAttribute("data-automation-id");
      if (!id) return;
      state.automationExpandedId =
        state.automationExpandedId === id ? null : id;
      await renderAutomationsView();
    });
  });

  root.querySelectorAll(".automation-toggle").forEach((input) => {
    input.addEventListener("change", async () => {
      const id = input.getAttribute("data-automation-id");
      if (!id) return;
      try {
        await requireBridge().updateAutomation({
          id,
          patch: { enabled: input.checked },
        });
        notifyUser(input.checked ? "已启用" : "已停用", "done");
        await renderAutomationsView();
      } catch (e) {
        input.checked = !input.checked;
        notifyUser(`更新失败: ${String(e)}`, "err");
      }
    });
  });

  root.querySelectorAll(".automation-run-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-automation-id");
      if (!id) return;
      const auto = automations.find((a) => a.id === id);
      const name = auto?.name || id.slice(0, 8);
      const runLevel = state.config?.permissions?.automation?.run ?? "confirm";
      if (runLevel === "confirm" && !confirm(`立即运行自动化「${name}」？`)) return;
      if (runLevel === "deny") {
        notifyUser("权限配置禁止手动运行自动化", "warn");
        return;
      }
      if (auto?.cwd) activateProjectForCwd(auto.cwd);
      startNewChat();
      btn.disabled = true;
      try {
        const res = await requireBridge().runAutomation({
          id,
          trigger: "manual",
          skipConfirm: true,
        });
        const run = res?.run;
        const status = run?.status ?? "pending";
        if (status === "success") {
          notifyUser(`运行完成`, "done");
        } else if (status === "failed") {
          notifyUser(`运行失败: ${run?.error || "unknown"}`, "err");
        } else if (status === "skipped") {
          notifyUser(`已跳过: ${run?.error || "concurrent_run"}`, "warn");
        } else {
          notifyUser(`运行结束 (${status})`, "done");
        }
        if (run?.sessionId) {
          const active = getActiveProject();
          if (active) {
            const outgoingSid =
              state.viewingTimelineSessionId || active.sessionId || "";
            const prevSid = active.sessionId;
            await sessionRuns?.switchSessionView(active, run.sessionId, prevSid, {
              outgoingSessionId: outgoingSid,
            });
            renderProjects();
            renderComposerProjectSelect();
          }
        }
        await renderAutomationsView();
      } catch (err) {
        notifyUser(`运行失败: ${String(err)}`, "err");
      } finally {
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll(".automation-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-automation-id");
      if (!id) return;
      const name = automations.find((a) => a.id === id)?.name || id.slice(0, 8);
      if (!confirm(`确定删除自动化「${name}」？`)) return;
      try {
        await requireBridge().deleteAutomation({ id, skipConfirm: true });
        if (state.automationExpandedId === id) state.automationExpandedId = null;
        notifyUser("已删除", "done");
        await renderAutomationsView();
      } catch (err) {
        notifyUser(`删除失败: ${String(err)}`, "err");
      }
    });
  });

  root.querySelectorAll(".automation-run-expand-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = btn.closest(".automation-run-item");
      if (!item) return;
      const expanded = item.classList.toggle("is-preview-expanded");
      btn.textContent = expanded ? "收起" : "展开全文";
    });
  });

  bindAutomationSessionLinks(root);
}

async function renderAutomationsView() {
  const root = $("resourceView");
  const activeProject = getActiveProject();
  const cwd = activeProject?.cwd;
  if (!cwd) {
    root.innerHTML = `<div class="event warn">请先为项目设置有效工作目录。</div>`;
    return;
  }

  root.innerHTML = `<div class="event status">正在加载自动化…</div>`;

  let daemonOk = true;
  try {
    await requireBridge().daemonStatus();
  } catch {
    daemonOk = false;
  }

  try {
    const listRes = await requireBridge().listAutomations({ cwd });
    const automations = Array.isArray(listRes?.automations) ? listRes.automations : [];

    if (!automations.length) {
      root.innerHTML = wrapAutomationsPage(`${renderAutomationPermissionsBanner()}${renderAutomationsOverviewBar(automations, daemonOk)}${renderAutomationEmptyState()}`);
      bindAutomationsView(root, automations, {});
      return;
    }

    const lastRunPairs = await Promise.all(
      automations.map(async (a) => {
        try {
          const runsRes = await requireBridge().listAutomationRuns({
            automationId: a.id,
            limit: 1,
          });
          return [a.id, runsRes?.runs?.[0] ?? null];
        } catch {
          return [a.id, null];
        }
      }),
    );
    const lastRunById = Object.fromEntries(lastRunPairs);

    let expandedAutomation = null;
    let expandedRuns = [];
    if (state.automationExpandedId) {
      try {
        const detail = await requireBridge().getAutomation({
          id: state.automationExpandedId,
        });
        expandedAutomation = detail?.automation ?? null;
        const runsRes = await requireBridge().listAutomationRuns({
          automationId: state.automationExpandedId,
          limit: 20,
        });
        expandedRuns = runsRes?.runs ?? [];
      } catch {
        expandedAutomation = automations.find((a) => a.id === state.automationExpandedId) ?? null;
      }
    }

    const cards = automations
      .map((a) => {
        const lastRun = lastRunById[a.id];
        const runs =
          state.automationExpandedId === a.id && expandedAutomation?.id === a.id
            ? expandedRuns
            : [];
        const automationDetail =
          state.automationExpandedId === a.id ? expandedAutomation : null;
        return renderAutomationCard(a, lastRun, automationDetail, runs);
      })
      .join("");

    root.innerHTML = wrapAutomationsPage(`${renderAutomationPermissionsBanner()}${renderAutomationsOverviewBar(automations, daemonOk)}
      <section class="automations-card-list">${cards}</section>`);
    bindAutomationsView(root, automations, lastRunById);
  } catch (e) {
    root.innerHTML = wrapAutomationsPage(`<div class="automations-error-state">
      <div class="event err">加载自动化失败: ${escapeHtml(String(e))}</div>
      <button type="button" class="btn secondary resource-retry-btn" data-retry="automations">重试</button>
    </div>`);
    bindResourceRetry(root);
  }
}

function bindAutomationsPageUi() {
  const editorModal = $("automationEditorModal");
  const closeEditor = () => closeAutomationEditorModal();
  $("automationEditorCloseBtn")?.addEventListener("click", closeEditor);
  $("automationEditorCancelBtn")?.addEventListener("click", closeEditor);
  editorModal?.querySelector(".modal-mask")?.addEventListener("click", closeEditor);
  $("automationEditorSaveBtn")?.addEventListener("click", () => {
    void saveAutomationFromModal();
  });

}

let channelLoginPollTimer = null;
let channelLoginAdapterId = null;
let mobileManagerAdapterId = null;
let mobilePairingUriValue = "";
let channelsPollTimer = null;
let channelsRefreshInFlight = false;
let channelsLastRenderKey = "";

function stopChannelsPoll() {
  if (channelsPollTimer) {
    clearInterval(channelsPollTimer);
    channelsPollTimer = null;
  }
}

function startChannelsPoll() {
  if (state.activeNav !== "channels") return;
  if (channelsPollTimer) return;
  channelsPollTimer = setInterval(() => {
    if (state.activeNav !== "channels") {
      stopChannelsPoll();
      return;
    }
    const loginOpen = !$("channelLoginModal")?.classList.contains("hidden");
    const editorOpen = !$("channelEditorModal")?.classList.contains("hidden");
    const mobileOpen = !$("mobileChannelModal")?.classList.contains("hidden");
    if (loginOpen || editorOpen || mobileOpen) return;
    void renderChannelsView({ quiet: true });
  }, 3000);
}

function renderChannelStatusBadge(status, kind) {
  const map = {
    connected: ["已连接", "ok"],
    connecting: ["连接中", "warn"],
    disconnected: ["未连接", "warn"],
    error: ["错误", "err"],
    disabled: ["已停用", "muted"],
    login_required: ["需登录", "warn"],
  };
  const [defaultLabel, cls] = map[status] ?? [status || "—", "muted"];
  const label = kind === "mobile" && status === "connected" ? "已注册" : defaultLabel;
  return `<span class="channel-status-badge channel-status-${cls}">${escapeHtml(label)}</span>`;
}

function mobileConnectionHint(error) {
  const text = String(error || "");
  if (/401|403|unauthor|forbidden|credential|token/i.test(text)) {
    return "Relay 拒绝凭证：检查 Enrollment Token，必要时新建渠道重新注册";
  }
  if (/clock|time|expir|challenge/i.test(text)) {
    return "认证时间校验失败：同步公司电脑系统时间后重试";
  }
  if (/fetch|connect|network|ECONN|socket|dns/i.test(text)) {
    return "无法连接 Relay：检查公网、代理、防火墙和 Relay Origin";
  }
  return text || "检查公网连接、Enrollment Token 和本机时间";
}

function renderChannelReadinessChecks(c, rt, gw, daemonOk) {
  if (c.kind === "mobile") {
    const checks = [
      {
        ok: daemonOk,
        label: "Daemon 已连接",
        hint: "请保持 Forge Desktop 或后台 Daemon 运行",
      },
      {
        ok: Boolean(gw?.running && gw?.daemonConnected),
        label: "共享 Gateway 运行中",
        hint: "点击上方「启动 Gateway」；不需要启动第二个 Mobile Gateway",
      },
      {
        ok: Boolean(c.enabled),
        label: "Forge Mobile 已启用",
        hint: "打开渠道卡片右侧开关；关闭会断开手机，但不影响其他渠道",
      },
      {
        ok: typeof c.config?.relayOrigin === "string" && /^https?:\/\//i.test(c.config.relayOrigin),
        label: "Relay 已配置",
        hint: "重新添加渠道并填写有效的 Relay Origin",
      },
      {
        ok: rt?.status === "connected",
        label: rt?.status === "connecting" ? "正在注册 Relay" : "Relay 已注册",
        hint: mobileConnectionHint(rt?.lastError),
      },
    ];
    return renderChannelCheckList(checks);
  }
  if (c.kind !== "ilink") {
    const checks = [
      {
        ok: daemonOk,
        label: "Daemon 已连接",
        hint: "请保持 Forge Desktop 打开，自动化完成后由 Daemon 主动推送",
      },
      {
        ok: Boolean(c.enabled),
        label: "渠道已启用",
        hint: "打开渠道卡片右侧开关",
      },
      {
        ok: typeof c.config?.webhookUrl === "string" && /^https?:\/\//i.test(c.config.webhookUrl),
        label: "Webhook 已配置",
        hint: "编辑渠道并填写有效的 Webhook URL",
      },
    ];
    return renderChannelCheckList(checks);
  }
  const checks = [
    {
      ok: daemonOk,
      label: "Daemon 已连接",
      hint: "请保持 Forge Desktop 打开，或确保后台 Daemon 在运行",
    },
    {
      ok: Boolean(gw?.running && gw?.daemonConnected),
      label: "Gateway ↔ Daemon",
      hint: "先启动 Gateway；若已启动仍失败，检查 socket 路径是否与 Desktop 一致",
    },
    {
      ok: Boolean(gw?.running),
      label: "Gateway 运行中",
      hint: "点击上方「启动 Gateway」",
    },
    {
      ok: Boolean(c.enabled),
      label: "渠道已启用",
      hint: "打开渠道卡片右侧开关",
    },
    {
      ok: Boolean(c.config?.botToken),
      label: "微信已登录",
      hint: "点击「扫码登录」完成授权",
    },
    {
      ok: rt?.status === "connected",
      label: "长轮询正常",
      hint: rt?.lastError || "检查网络，或重新扫码登录",
    },
  ];
  return renderChannelCheckList(checks);
}

function renderChannelCheckList(checks) {
  return `<ul class="channel-readiness-list">
    ${checks
      .map(
        (ch) => `<li class="channel-readiness-item${ch.ok ? " is-ok" : " is-fail"}">
          <span class="channel-readiness-mark" aria-hidden="true">${ch.ok ? "✓" : "○"}</span>
          <span class="channel-readiness-label">${escapeHtml(ch.label)}</span>
          ${ch.ok ? "" : `<span class="channel-readiness-hint">${escapeHtml(ch.hint)}</span>`}
        </li>`,
      )
      .join("")}
  </ul>`;
}

function renderChannelActivityPanel(rt) {
  if (!rt) return "";
  const processing = Boolean(rt.processing);
  const events = Array.isArray(rt.recentEvents) ? rt.recentEvents : [];
  const pollLabel =
    rt.pollState === "polling"
      ? "轮询中"
      : rt.pollState === "waiting_login"
        ? "等待登录"
        : rt.lastPollAt
          ? `上次轮询 ${formatRelativeTime(rt.lastPollAt)}`
          : "尚未轮询";
  return `<div class="channel-activity">
    <div class="channel-activity-head">
      <span class="channel-activity-poll">${escapeHtml(pollLabel)}</span>
      ${
        processing
          ? `<span class="channel-activity-processing">Agent 处理中${
              rt.currentSessionId
                ? ` · 会话 ${escapeHtml(rt.currentSessionId.slice(0, 8))}…`
                : ""
            }</span>`
          : rt.lastRunStatus === "ok"
            ? `<span class="channel-activity-done">上次已成功回复</span>`
            : rt.lastRunStatus === "error"
              ? `<span class="channel-activity-fail">上次处理失败</span>`
              : ""
      }
    </div>
    ${
      events.length
        ? `<ol class="channel-activity-log">
          ${events
            .slice(0, 8)
            .map(
              (ev) => `<li class="channel-activity-log-item channel-activity-${ev.level || "info"}">
                <time>${escapeHtml(formatRelativeTime(ev.at))}</time>
                <span>${escapeHtml(ev.message)}</span>
              </li>`,
            )
            .join("")}
        </ol>`
        : `<p class="channel-activity-empty">暂无活动。向 Bot 发一条文字消息后，这里会显示收信与 Agent 进度。</p>`
    }
  </div>`;
}

function renderMobileSecurityActivity(rt) {
  const events = Array.isArray(rt?.recentEvents) ? rt.recentEvents : [];
  if (!events.length) {
    return `<p class="channel-activity-empty">暂无安全事件。生成配对码、撤销设备或连接失败后会记录在这里，不记录业务正文。</p>`;
  }
  return `<div class="channel-activity">
    <div class="channel-activity-head"><span class="channel-activity-poll">最近安全事件</span></div>
    <ol class="channel-activity-log">
      ${events
        .slice(0, 8)
        .map(
          (event) => `<li class="channel-activity-log-item channel-activity-${event.level || "info"}">
            <time>${escapeHtml(formatRelativeTime(event.at))}</time>
            <span>${escapeHtml(event.message)}</span>
          </li>`,
        )
        .join("")}
    </ol>
  </div>`;
}

function renderChannelsTroubleshooting(activeCwd) {
  return `<details class="channels-troubleshoot">
    <summary>收不到微信回复？按此排查</summary>
    <ol class="channels-troubleshoot-list">
      <li>确认左侧选中的是<strong>绑定渠道的项目</strong>（当前目录：<code>${escapeHtml(activeCwd || "—")}</code>）。会话只会出现在该项目的侧边栏。</li>
      <li>完成：添加渠道 → 扫码登录 → <strong>启用渠道</strong> → <strong>启动 Gateway</strong>。</li>
      <li>微信里需先<strong>给 Bot 发文字消息</strong>（Bot 不能主动开口）；仅支持文字，图片/语音会被跳过。</li>
      <li>看上方就绪检查是否全绿；若有红色项，按提示操作。</li>
      <li>活动日志出现「处理失败」时，展开错误信息；常见原因：Daemon 未连上、项目目录不存在、Agent 运行报错。</li>
      <li>修改代码或配置后：停止并重新<strong>启动 Gateway</strong>，必要时重启 Desktop。</li>
    </ol>
  </details>`;
}

function renderChannelsGatewayBar(gw) {
  const running = Boolean(gw?.running);
  const url = gw?.listenUrl ? escapeHtml(gw.listenUrl) : "—";
  const pid = gw?.pid ? ` · PID ${gw.pid}` : "";
  const daemonOk = Boolean(gw?.daemonConnected);
  return `<section class="channel-gateway-card${running ? " is-running" : ""}">
    <div class="channel-gateway-card-main">
      <div class="channel-gateway-symbol" aria-hidden="true">
        <span class="channel-gateway-symbol-ring"></span>
        <span class="channel-gateway-symbol-core">⬡</span>
      </div>
      <div class="channel-gateway-copy">
        <div class="channel-gateway-title-row">
          <h3 class="channel-gateway-title">Channel Gateway</h3>
          <span class="channel-gateway-pill${running ? " is-on" : ""}">
            <span class="channel-gateway-pill-dot"></span>
            ${running ? "运行中" : "已停止"}${pid}
          </span>
        </div>
        <p class="channel-gateway-desc">统一承载微信等消息渠道与 Forge Mobile 公网 Relay 连接，并转发给本机 Agent。</p>
        <div class="channel-gateway-url"><span class="channel-gateway-url-label">监听</span><code>${url}</code></div>
        <div class="channel-gateway-daemon${daemonOk ? " is-ok" : ""}">
          <span class="channel-gateway-daemon-dot"></span>
          ${
            running
              ? gw?.daemonConnected
                ? "Daemon 已连接"
                : "Daemon 未连接（无法运行 Agent）"
              : daemonOk
                ? "Gateway 未启动"
                : "Daemon 未运行"
          }
        </div>
      </div>
    </div>
    <div class="channel-gateway-actions">
      ${
        running
          ? `<button type="button" class="btn secondary btn-sm" id="channelGatewayStopBtn">停止 Gateway</button>`
          : `<button type="button" class="btn primary btn-sm" id="channelGatewayStartBtn">启动 Gateway</button>`
      }
      <button type="button" class="btn secondary btn-sm" id="channelAddBtn">添加渠道</button>
    </div>
  </section>`;
}

function renderChannelKindCards(kinds, options = {}) {
  const hiddenKinds = new Set(options.hiddenKinds || []);
  const list = (Array.isArray(kinds) ? kinds : []).filter(
    (kind) => !hiddenKinds.has(kind.kind),
  );
  const cards = list
    .map((k) => {
      const featured = k.kind === "ilink";
      const buttonLabel = k.kind === "mobile" ? "配置全局连接" : "立即添加";
      return `<article class="channel-kind-card${featured ? " is-featured" : ""}" data-channel-kind="${escapeHtml(k.kind)}">
        ${channelKindIconHtml(k.kind)}
        <div class="channel-kind-card-body">
          <strong>${escapeHtml(k.label)}</strong>
          <p>${escapeHtml(k.description || "")}</p>
        </div>
        <button type="button" class="btn ${featured ? "primary" : "secondary"} btn-sm channel-kind-add-btn" data-channel-kind="${escapeHtml(k.kind)}">${buttonLabel}</button>
      </article>`;
    })
    .join("");
  return `<div class="channels-kind-grid">${cards}</div>`;
}

function renderGlobalMobileSection(mobileChannels, kindLabels, runtimeById, gw, daemonOk) {
  const channels = Array.isArray(mobileChannels) ? mobileChannels : [];
  const conflict =
    channels.length > 1
      ? `<div class="event warn channels-global-mobile-conflict">检测到 ${channels.length} 个历史 Mobile 配置。请保留正在使用的一个，并删除其余配置。</div>`
      : "";
  const body = channels.length
    ? channels
        .map((channel) =>
          renderChannelCard(channel, kindLabels, runtimeById, gw, daemonOk, {
            globalMobile: true,
          }),
        )
        .join("")
    : `<article class="channels-global-mobile-setup">
        ${channelKindIconHtml("mobile")}
        <div>
          <strong>建立这台电脑的移动连接</strong>
          <p>只需配置一次 Relay。之后所有项目的访问范围都在设备授权中管理，不必为每个项目重复添加。</p>
        </div>
        <button type="button" class="btn primary btn-sm channel-kind-add-btn" data-channel-kind="mobile">配置全局连接</button>
      </article>`;
  return `<section class="channels-global-mobile-section">
    <div class="channels-global-mobile-head">
      <div>
        <span class="channels-section-eyebrow">HOST CONNECTION</span>
        <h4>Forge Mobile</h4>
      </div>
      <span class="channels-global-scope-pill">电脑级 · 全局唯一</span>
    </div>
    <p class="channels-global-mobile-intro">手机、公司电脑与公网 Relay 的端到端连接。Gateway 启动后会自动恢复，无需重复添加。</p>
    ${conflict}
    <div class="channels-card-list">${body}</div>
  </section>`;
}

function renderProjectChannelsSection(channels, kinds, kindLabels, runtimeById, gw, daemonOk) {
  const list = Array.isArray(channels) ? channels : [];
  if (!list.length) {
    return `<section class="channels-list-section channels-project-empty">
      <div class="channels-list-head">
        <div>
          <span class="channels-section-eyebrow">CURRENT PROJECT</span>
          <h4>项目消息渠道</h4>
        </div>
        <span class="channels-list-count">0 个</span>
      </div>
      <div class="channels-project-empty-copy">
        <strong>当前项目还没有消息渠道</strong>
        <p>微信、飞书、钉钉和 HTTP 通知仍按项目隔离；它们不会影响上面的全局 Mobile 连接。</p>
      </div>
      ${renderChannelKindCards(kinds, { hiddenKinds: ["mobile"] })}
    </section>`;
  }
  const cards = list
    .map((channel) => renderChannelCard(channel, kindLabels, runtimeById, gw, daemonOk))
    .join("");
  return `<section class="channels-list-section">
    <div class="channels-list-head">
      <div>
        <span class="channels-section-eyebrow">CURRENT PROJECT</span>
        <h4>项目消息渠道</h4>
      </div>
      <span class="channels-list-count">${list.length} 个 · 每 3 秒自动刷新</span>
    </div>
    <div class="channels-card-list">${cards}</div>
  </section>`;
}

function renderChannelCard(c, kindLabels, runtimeById, gw, daemonOk, options = {}) {
  const rt = runtimeById[c.id];
  const globalMobile = Boolean(options.globalMobile && c.kind === "mobile");
  const status =
    c.kind === "ilink" || c.kind === "mobile"
      ? rt?.status ?? (c.enabled ? "disconnected" : "disabled")
      : c.enabled
        ? c.config?.webhookUrl
          ? "connected"
          : "login_required"
        : "disabled";
  const hasToken = Boolean(c.config?.botToken);
  const showLogin = c.kind === "ilink" && !hasToken;
  const kindLabel = kindLabels[c.kind] || c.kind;
  const meta = globalMobile
    ? `电脑级全局连接 · 权限配置源 <code>${escapeHtml(c.cwd)}</code>`
    : `${escapeHtml(kindLabel)} · 项目 <code>${escapeHtml(c.cwd)}</code>`;
  return `<article class="channel-card${rt?.processing ? " is-processing" : ""}${globalMobile ? " is-global-mobile" : ""}" data-channel-id="${escapeHtml(c.id)}">
    ${channelKindIconHtml(c.kind)}
    <div class="channel-card-body">
      <div class="channel-card-title-row">
        <strong>${escapeHtml(c.name)}</strong>
        ${globalMobile ? `<span class="channel-scope-badge">全局</span>` : ""}
        ${renderChannelStatusBadge(status, c.kind)}
      </div>
      <p class="channel-card-meta">${meta}${
        c.lastMessageAt ? ` · 最近消息 ${escapeHtml(formatRelativeTime(c.lastMessageAt))}` : ""
      }</p>
      ${c.lastError ? `<p class="channel-card-error">${escapeHtml(c.lastError)}</p>` : ""}
      <div class="channel-card-diagnostics">
        <h5>就绪检查</h5>
        ${renderChannelReadinessChecks(c, rt, gw, daemonOk)}
      </div>
      ${
        c.kind === "ilink"
          ? renderChannelActivityPanel(rt)
          : c.kind === "mobile"
            ? renderMobileSecurityActivity(rt)
            : `<p class="channel-activity-empty">主动通知渠道：自动化完成后会向配置的 Webhook 发送结果。</p>`
      }
    </div>
    <div class="channel-card-side">
      <label class="toggle channel-card-toggle" title="启用/停用">
        <input type="checkbox" class="channel-toggle" data-channel-id="${escapeHtml(c.id)}" ${c.enabled ? "checked" : ""} ${showLogin ? "disabled" : ""} />
      </label>
      <div class="channel-card-actions">
        ${showLogin ? `<button type="button" class="btn primary btn-sm channel-login-btn" data-channel-id="${escapeHtml(c.id)}">扫码登录</button>` : ""}
        ${c.kind === "mobile" ? `<button type="button" class="btn primary btn-sm mobile-manage-btn" data-channel-id="${escapeHtml(c.id)}" ${c.enabled ? "" : "disabled"}>配对与设备</button>` : ""}
        <button type="button" class="btn secondary btn-sm channel-delete-btn" data-channel-id="${escapeHtml(c.id)}">${globalMobile ? "删除全局连接" : "删除"}</button>
      </div>
    </div>
  </article>`;
}

function channelRuntimeRenderFingerprint(rt) {
  if (!rt) return null;
  return {
    adapterId: rt.adapterId || "",
    status: rt.status || "",
    pollState: rt.pollState || "",
    processing: Boolean(rt.processing),
    currentSessionId: rt.currentSessionId || "",
    lastInboundPreview: rt.lastInboundPreview || "",
    lastRunStatus: rt.lastRunStatus || "",
    lastError: rt.lastError || "",
    recentEvents: Array.isArray(rt.recentEvents)
      ? rt.recentEvents.slice(0, 8).map((ev) => ({
          at: ev.at || "",
          level: ev.level || "",
          message: ev.message || "",
        }))
      : [],
  };
}

function channelsRenderFingerprint({ daemonOk, channels, gw, kinds }) {
  const adapters = Array.isArray(gw?.adapters) ? gw.adapters : [];
  return JSON.stringify({
    daemonOk: Boolean(daemonOk),
    gateway: {
      running: Boolean(gw?.running),
      pid: gw?.pid || null,
      listenUrl: gw?.listenUrl || "",
      daemonConnected: Boolean(gw?.daemonConnected),
      adapters: adapters.map(channelRuntimeRenderFingerprint),
    },
    kinds: (Array.isArray(kinds) ? kinds : []).map((k) => ({
      kind: k.kind || "",
      label: k.label || "",
      description: k.description || "",
    })),
    channels: (Array.isArray(channels) ? channels : []).map((c) => ({
      id: c.id || "",
      kind: c.kind || "",
      name: c.name || "",
      cwd: c.cwd || "",
      enabled: Boolean(c.enabled),
      description: c.description || "",
      lastMessageAt: c.lastMessageAt || "",
      lastError: c.lastError || "",
      hasBotToken: Boolean(c.config?.botToken),
      hasWebhookUrl: Boolean(c.config?.webhookUrl),
      relayOrigin: c.config?.relayOrigin || "",
      hasEnrollmentToken: Boolean(c.config?.enrollmentToken),
    })),
  });
}

function closeChannelEditorModal() {
  $("channelEditorModal")?.classList.add("hidden");
}

function renderChannelConfigFields(kinds) {
  const host = $("channelConfigFields");
  const kind = $("channelKindSelect")?.value;
  if (!host || !kind) return;
  const schema = (kinds || []).find((k) => k.kind === kind);
  const fields = Array.isArray(schema?.fields) ? schema.fields : [];
  host.innerHTML = fields
    .map((field) => {
      const type = field.type === "secret" ? "password" : "text";
      const required = field.required ? "required" : "";
      const placeholder = field.placeholder || field.default || "";
      return `<div class="field">
        <label for="channelConfig_${escapeHtml(field.key)}">${escapeHtml(field.label)}</label>
        <input id="channelConfig_${escapeHtml(field.key)}" type="${type}" class="modal-input channel-config-input" data-config-key="${escapeHtml(field.key)}" value="${escapeHtml(field.default ?? "")}" placeholder="${escapeHtml(placeholder)}" ${required} />
      </div>`;
    })
    .join("");
}

function readChannelConfigFields() {
  const config = {};
  $("channelConfigFields")
    ?.querySelectorAll(".channel-config-input")
    .forEach((input) => {
      const key = input.getAttribute("data-config-key");
      if (!key) return;
      const value = input.value?.trim();
      if (value) config[key] = value;
    });
  return config;
}

async function openChannelEditorModal(prefillKind) {
  const activeProject = getActiveProject();
  if (!activeProject?.cwd) {
    alert("请先为项目设置有效工作目录。");
    return;
  }
  const [kindsRes, channelsRes] = await Promise.all([
    requireBridge().listChannelKinds(),
    requireBridge().listChannels(),
  ]);
  const hasGlobalMobile = (channelsRes?.channels ?? []).some(
    (channel) => channel.kind === "mobile",
  );
  if (prefillKind === "mobile" && hasGlobalMobile) {
    notifyUser("Forge Mobile 已作为电脑级全局连接存在，请直接使用「配对与设备」管理。", "warn");
    return;
  }
  const kinds = (kindsRes?.kinds ?? []).filter(
    (kind) => kind.kind !== "mobile" || !hasGlobalMobile,
  );
  const sel = $("channelKindSelect");
  if (sel) {
    sel.innerHTML = kinds
      .map(
        (k) =>
          `<option value="${escapeHtml(k.kind)}">${escapeHtml(k.label)}</option>`,
      )
      .join("");
    if (prefillKind) sel.value = prefillKind;
    sel.onchange = () => renderChannelConfigFields(kinds);
  }
  renderChannelConfigFields(kinds);
  $("channelNameInput").value =
    prefillKind === "ilink"
      ? "微信 iLink"
      : prefillKind === "mobile"
        ? "Forge Mobile"
        : kinds.find((kind) => kind.kind === prefillKind)?.label ?? kinds[0]?.label ?? "";
  $("channelDescInput").value = "";
  $("channelCwdDisplay").textContent = activeProject.cwd;
  $("channelEditorModal")?.classList.remove("hidden");
}

async function saveChannelFromModal() {
  const activeProject = getActiveProject();
  const kind = $("channelKindSelect")?.value;
  const name = $("channelNameInput")?.value?.trim();
  if (!activeProject?.cwd || !kind || !name) {
    alert("请填写名称并选择项目目录。");
    return;
  }
  const config = readChannelConfigFields();
  const missing = Array.from(
    $("channelConfigFields")?.querySelectorAll(".channel-config-input[required]") || [],
  ).find((input) => !input.value?.trim());
  if (missing) {
    alert("请填写渠道必填配置。");
    missing.focus?.();
    return;
  }
  try {
    await requireBridge().createChannel({
      draft: {
        kind,
        name,
        description: $("channelDescInput")?.value?.trim() || undefined,
        cwd: activeProject.cwd,
        enabled: false,
        config,
      },
      skipConfirm: true,
    });
    closeChannelEditorModal();
    await renderChannelsView();
  } catch (e) {
    alert(`创建渠道失败: ${e}`);
  }
}

function stopChannelLoginPoll() {
  if (channelLoginPollTimer) {
    clearInterval(channelLoginPollTimer);
    channelLoginPollTimer = null;
  }
  channelLoginAdapterId = null;
}

function closeChannelLoginModal() {
  stopChannelLoginPoll();
  $("channelLoginModal")?.classList.add("hidden");
}

async function resolveChannelLoginQrSrc(login) {
  const raw = login?.qrcodeImgUrl?.trim();
  if (!raw) return null;
  if (raw.startsWith("data:image/")) return raw;
  if (/^https?:\/\//i.test(raw)) {
    if (globalThis.ForgeChannelLoginQr?.toDataUrl) {
      return globalThis.ForgeChannelLoginQr.toDataUrl(raw);
    }
    return null;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 64) {
    return `data:image/png;base64,${raw.replace(/\s/g, "")}`;
  }
  return raw;
}

async function renderChannelLoginQr(login) {
  const host = $("channelLoginQrHost");
  if (!host) return;
  if (!login?.qrcodeImgUrl && !login?.qrcode) {
    host.innerHTML = `<p class="tiny">正在获取二维码…</p>`;
    return;
  }
  host.innerHTML = `<p class="tiny">正在生成二维码…</p>`;
  try {
    const dataUrl = await resolveChannelLoginQrSrc(login);
    if (dataUrl) {
      host.innerHTML = `<img src="${escapeHtml(dataUrl)}" alt="iLink 登录二维码" class="channel-login-qr-img" />`;
      return;
    }
    if (login?.qrcodeImgUrl && /^https?:\/\//i.test(login.qrcodeImgUrl)) {
      host.innerHTML = `<p class="tiny">请用微信打开链接扫码：</p><p class="tiny channel-login-fallback-link"><a href="${escapeHtml(login.qrcodeImgUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(login.qrcodeImgUrl)}</a></p>`;
      return;
    }
    if (login?.qrcode) {
      host.innerHTML = `<p class="tiny">扫码令牌：</p><p class="tiny"><code>${escapeHtml(login.qrcode)}</code></p>`;
      return;
    }
    host.innerHTML = `<p class="tiny">无法生成二维码，请关闭后重试。</p>`;
  } catch (e) {
    host.innerHTML = `<p class="tiny">二维码生成失败：${escapeHtml(String(e))}</p>`;
  }
}

function updateChannelLoginStatus(login) {
  const el = $("channelLoginStatus");
  if (!el) return;
  const map = {
    wait: "等待扫码…",
    scaned: "已扫码，请在手机上确认",
    confirmed: "登录成功",
    expired: "二维码已过期，请关闭后重试",
  };
  el.textContent = login?.error || map[login?.status] || login?.status || "—";
}

async function openChannelLoginModal(adapterId) {
  stopChannelLoginPoll();
  channelLoginAdapterId = adapterId;
  $("channelLoginModal")?.classList.remove("hidden");
  await renderChannelLoginQr(null);
  updateChannelLoginStatus({ status: "wait" });
  try {
    const res = await requireBridge().channelStartLogin({ adapterId });
    await renderChannelLoginQr(res?.login);
    updateChannelLoginStatus(res?.login);
    channelLoginPollTimer = setInterval(() => {
      void (async () => {
        try {
          const poll = await requireBridge().channelPollLogin({ adapterId });
          updateChannelLoginStatus(poll?.login);
          if (poll?.login?.status === "confirmed") {
            stopChannelLoginPoll();
            closeChannelLoginModal();
            await renderChannelsView();
          } else if (poll?.login?.status === "expired") {
            stopChannelLoginPoll();
          }
        } catch (e) {
          updateChannelLoginStatus({ status: "expired", error: String(e) });
          stopChannelLoginPoll();
        }
      })();
    }, 2000);
  } catch (e) {
    updateChannelLoginStatus({ status: "expired", error: String(e) });
  }
}

function closeMobileChannelModal() {
  mobileManagerAdapterId = null;
  mobilePairingUriValue = "";
  $("mobileChannelModal")?.classList.add("hidden");
}

function mobilePairingUri(offer) {
  const bytes = new TextEncoder().encode(JSON.stringify(offer));
  const encoded = arrayBufferToBase64(bytes.buffer)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `forge://pair?code=${encoded}`;
}

async function renderMobilePairingOffer(offer) {
  const host = $("mobilePairingQrHost");
  if (!host) return;
  mobilePairingUriValue = mobilePairingUri(offer);
  host.classList.remove("hidden");
  host.innerHTML = `<p class="tiny">正在生成二维码…</p>`;
  try {
    const dataUrl = await globalThis.ForgeChannelLoginQr?.toDataUrl?.(mobilePairingUriValue);
    host.innerHTML = dataUrl
      ? `<img src="${escapeHtml(dataUrl)}" alt="Forge Mobile 配对二维码" class="channel-login-qr-img" />`
      : `<p class="tiny"><code>${escapeHtml(mobilePairingUriValue)}</code></p>`;
  } catch (error) {
    host.innerHTML = `<p class="tiny">二维码生成失败：${escapeHtml(String(error))}</p>`;
  }
  const expiresAt = new Date(offer.expiresAt);
  $("mobilePairingStatus").textContent = `一次性配对码有效至 ${expiresAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  $("mobilePairingCopyBtn")?.classList.remove("hidden");
  $("mobilePairingGenerateBtn").textContent = "重新生成（旧码立即失效）";
}

async function loadMobileDevices() {
  const host = $("mobileDeviceList");
  if (!host || !mobileManagerAdapterId) return;
  host.innerHTML = `<p class="tiny">正在加载…</p>`;
  try {
    const result = await requireBridge().listMobileDevices({
      adapterId: mobileManagerAdapterId,
    });
    const devices = Array.isArray(result?.devices) ? result.devices : [];
    const active = devices.filter((device) => !device.revokedAt);
    host.innerHTML = active.length
      ? active
          .map(
            (device) => `<article class="mobile-device-item">
              <div>
                <strong>${escapeHtml(device.displayName || "未命名设备")}</strong>
                <p>配对于 ${escapeHtml(formatRelativeTime(device.createdAt))}${device.lastSeenAt ? ` · 最后在线 ${escapeHtml(formatRelativeTime(device.lastSeenAt))}` : " · 尚未上线"}</p>
                <p>允许项目：${escapeHtml((device.allowedProjects || []).join("、") || "无")}</p>
              </div>
              <div class="mobile-device-item-actions">
                <button type="button" class="btn secondary btn-sm mobile-device-projects-btn" data-device-id="${escapeHtml(device.deviceId)}">修改项目</button>
                <button type="button" class="btn secondary btn-sm mobile-device-revoke-btn" data-device-id="${escapeHtml(device.deviceId)}">撤销</button>
              </div>
            </article>`,
          )
          .join("")
      : `<p class="tiny">暂无已配对设备。</p>`;
    host.querySelectorAll(".mobile-device-revoke-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const deviceId = button.getAttribute("data-device-id");
        if (!deviceId || !confirm("撤销后该设备会立即断开，且恢复凭证永久失效。继续？")) return;
        void requireBridge()
          .revokeMobileDevice({ adapterId: mobileManagerAdapterId, deviceId })
          .then(() => loadMobileDevices())
          .catch((error) => alert(`撤销设备失败: ${error}`));
      });
    });
    host.querySelectorAll(".mobile-device-projects-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const deviceId = button.getAttribute("data-device-id");
        const device = active.find((candidate) => candidate.deviceId === deviceId);
        if (!deviceId || !device) return;
        const value = prompt(
          "每行填写一个允许项目的绝对路径。只能选择该 Mobile 渠道权限中已授权的项目；留空表示禁止访问所有项目。",
          (device.allowedProjects || []).join("\n"),
        );
        if (value === null) return;
        const allowedProjects = [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
        void requireBridge()
          .updateMobileDeviceProjects({
            adapterId: mobileManagerAdapterId,
            deviceId,
            allowedProjects,
          })
          .then(() => loadMobileDevices())
          .catch((error) => alert(`修改项目授权失败: ${error}`));
      });
    });
  } catch (error) {
    host.innerHTML = `<p class="channel-card-error">加载设备失败：${escapeHtml(String(error))}</p>`;
  }
}

async function openMobileChannelModal(adapterId) {
  mobileManagerAdapterId = adapterId;
  mobilePairingUriValue = "";
  $("mobilePairingQrHost")?.classList.add("hidden");
  $("mobilePairingCopyBtn")?.classList.add("hidden");
  $("mobilePairingGenerateBtn").textContent = "生成配对二维码";
  $("mobilePairingStatus").textContent = "尚未生成配对码";
  $("mobileChannelModal")?.classList.remove("hidden");
  await loadMobileDevices();
}

async function generateMobilePairing() {
  if (!mobileManagerAdapterId) return;
  const button = $("mobilePairingGenerateBtn");
  button.disabled = true;
  try {
    const result = await requireBridge().createMobilePairing({
      adapterId: mobileManagerAdapterId,
      skipConfirm: true,
    });
    await renderMobilePairingOffer(result.offer);
  } catch (error) {
    $("mobilePairingStatus").textContent = `生成失败：${String(error)}`;
  } finally {
    button.disabled = false;
  }
}

function bindChannelsView(root, channels, gw) {
  root.querySelector("#channelsOpenPermissionsBtn")?.addEventListener("click", () => {
    openSettingsTab("permissions");
  });
  root.querySelector("#channelGatewayStartBtn")?.addEventListener("click", () => {
    void (async () => {
      try {
        await requireBridge().startChannelGateway({ skipConfirm: true });
        await renderChannelsView();
      } catch (e) {
        alert(`启动 Gateway 失败: ${e}`);
      }
    })();
  });
  root.querySelector("#channelGatewayStopBtn")?.addEventListener("click", () => {
    void (async () => {
      try {
        await requireBridge().stopChannelGateway();
        await renderChannelsView();
      } catch (e) {
        alert(`停止 Gateway 失败: ${e}`);
      }
    })();
  });
  const openAdd = () => void openChannelEditorModal();
  root.querySelector("#channelAddBtn")?.addEventListener("click", openAdd);
  root.querySelectorAll(".channel-kind-add-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-channel-kind") || "ilink";
      void openChannelEditorModal(kind);
    });
  });

  root.querySelectorAll(".channel-toggle").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.getAttribute("data-channel-id");
      if (!id) return;
      const channel = channels.find((candidate) => candidate.id === id);
      if (
        channel?.kind === "mobile" &&
        !input.checked &&
        !confirm("关闭 Forge Mobile 会立即断开现有手机连接，但微信等其他渠道会继续运行。继续？")
      ) {
        input.checked = true;
        return;
      }
      void requireBridge()
        .updateChannel({ id, patch: { enabled: input.checked } })
        .then(() => renderChannelsView())
        .catch((e) => {
          input.checked = !input.checked;
          alert(`更新失败: ${e}`);
        });
    });
  });

  root.querySelectorAll(".channel-login-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-channel-id");
      if (id) void openChannelLoginModal(id);
    });
  });

  root.querySelectorAll(".mobile-manage-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-channel-id");
      if (id) void openMobileChannelModal(id);
    });
  });

  root.querySelectorAll(".channel-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-channel-id");
      const channel = channels.find((candidate) => candidate.id === id);
      const name = channel?.name || id?.slice(0, 8);
      const message =
        channel?.kind === "mobile"
          ? `删除电脑级连接「${name}」？所有已配对手机会立即断开，设备凭证和 Relay 注册将无法继续使用。`
          : `删除渠道「${name}」？`;
      if (!id || !confirm(message)) return;
      void requireBridge()
        .deleteChannel({ id, skipConfirm: true })
        .then(() => renderChannelsView())
        .catch((e) => alert(`删除失败: ${e}`));
    });
  });
}

async function renderChannelsView(options = {}) {
  const quiet = Boolean(options.quiet);
  const root = $("resourceView");
  if (!root || state.activeNav !== "channels") return;
  if (quiet && channelsRefreshInFlight) return;
  channelsRefreshInFlight = true;
  const activeProject = getActiveProject();
  const cwd = activeProject?.cwd;
  let daemonOk = true;
  try {
    if (!cwd) {
      if (quiet && channelsLastRenderKey === "channels:no-cwd") return;
      root.innerHTML = `<div class="event warn">请先为项目设置有效工作目录。</div>`;
      channelsLastRenderKey = "channels:no-cwd";
      return;
    }

    if (!quiet) {
      root.innerHTML = `<div class="event status">正在加载渠道…</div>`;
    }

    try {
      await requireBridge().daemonStatus();
    } catch {
      daemonOk = false;
    }

    const [listRes, gwRes, kindsRes] = await Promise.all([
      requireBridge().listChannels({ cwd, includeGlobalMobile: true }),
      requireBridge().getChannelGatewayStatus(),
      requireBridge().listChannelKinds(),
    ]);
    const channels = Array.isArray(listRes?.channels) ? listRes.channels : [];
    const mobileChannels = channels.filter((channel) => channel.kind === "mobile");
    const projectChannels = channels.filter((channel) => channel.kind !== "mobile");
    const gw = gwRes ?? { running: false, adapters: [] };
    const kindLabels = Object.fromEntries(
      (kindsRes?.kinds ?? []).map((k) => [k.kind, k.label]),
    );
    const runtimeById = Object.fromEntries(
      (gw.adapters ?? []).map((a) => [a.adapterId, a]),
    );

    const kinds = kindsRes?.kinds ?? [];
    const nextRenderKey = channelsRenderFingerprint({
      daemonOk,
      channels,
      gw,
      kinds,
    });
    const hasRenderedChannelsPage = root.querySelector(".channels-page");
    if (quiet && hasRenderedChannelsPage && nextRenderKey === channelsLastRenderKey) {
      return;
    }
    channelsLastRenderKey = nextRenderKey;

    root.innerHTML = wrapChannelsPage(`${
      daemonOk
        ? ""
        : `<div class="channels-daemon-banner event warn">需保持 Daemon 运行，Gateway 才能转发消息。</div>`
    }${renderChannelsPermissionsBanner()}${renderChannelsGatewayBar(gw)}
      ${renderChannelsTroubleshooting(cwd)}
      ${renderGlobalMobileSection(mobileChannels, kindLabels, runtimeById, gw, daemonOk)}
      ${renderProjectChannelsSection(projectChannels, kinds, kindLabels, runtimeById, gw, daemonOk)}`);
    bindChannelsView(root, channels, gw);
    startChannelsPoll();
  } catch (e) {
    if (quiet) return;
    channelsLastRenderKey = `channels:error:${String(e)}`;
    root.innerHTML = wrapChannelsPage(`${
      daemonOk
        ? ""
        : `<div class="channels-daemon-banner event warn">需保持 Daemon 运行，Gateway 才能转发消息。</div>`
    }<div class="channels-error-state">
      <div class="event err">加载渠道失败: ${escapeHtml(String(e))}</div>
      <button type="button" class="btn secondary resource-retry-btn" data-retry="channels">重试</button>
    </div>`);
    bindResourceRetry(root);
  } finally {
    channelsRefreshInFlight = false;
  }
}

function bindChannelsPageUi() {
  const editorModal = $("channelEditorModal");
  const closeEditor = () => closeChannelEditorModal();
  $("channelEditorCloseBtn")?.addEventListener("click", closeEditor);
  $("channelEditorCancelBtn")?.addEventListener("click", closeEditor);
  editorModal?.querySelector(".modal-mask")?.addEventListener("click", closeEditor);
  $("channelEditorSaveBtn")?.addEventListener("click", () => {
    void saveChannelFromModal();
  });

  const loginModal = $("channelLoginModal");
  const closeLogin = () => closeChannelLoginModal();
  $("channelLoginCloseBtn")?.addEventListener("click", closeLogin);
  $("channelLoginCancelBtn")?.addEventListener("click", closeLogin);
  loginModal?.querySelector(".modal-mask")?.addEventListener("click", closeLogin);

  const mobileModal = $("mobileChannelModal");
  const closeMobile = () => closeMobileChannelModal();
  $("mobileChannelCloseBtn")?.addEventListener("click", closeMobile);
  $("mobileChannelCancelBtn")?.addEventListener("click", closeMobile);
  mobileModal?.querySelector(".modal-mask")?.addEventListener("click", closeMobile);
  $("mobilePairingGenerateBtn")?.addEventListener("click", () => {
    void generateMobilePairing();
  });
  $("mobilePairingCopyBtn")?.addEventListener("click", () => {
    if (!mobilePairingUriValue) return;
    void navigator.clipboard
      .writeText(mobilePairingUriValue)
      .then(() => notifyUser("配对链接已复制", "done"))
      .catch((error) => notifyUser(`复制失败: ${String(error)}`, "warn"));
  });
}

async function renderSkillsView() {
  const root = $("resourceView");
  const cwd = getActiveProject()?.cwd;
  if (!cwd) {
    root.innerHTML = `<div class="event warn">请先为项目设置有效工作目录。</div>`;
    return;
  }

  root.innerHTML = `<div class="skills-page">
    <div id="skillInstalledPane" class="skills-page-pane"></div>
    <div id="skillDiscoverPane" class="skills-page-pane hidden"></div>
  </div>`;

  syncSkillToolbarPanes();
  $("skillInstalledPane")?.classList.toggle("hidden", state.skillsTab !== "installed");
  $("skillDiscoverPane")?.classList.toggle("hidden", state.skillsTab !== "discover");

  if (state.skillsTab === "discover") {
    if (!state.skillsMarketItems.length && !state.skillsMarketLoading) {
      void loadSkillsDiscover();
    } else {
      renderSkillsDiscoverPane();
    }
    return;
  }

  const installedPane = $("skillInstalledPane");
  if (installedPane) {
    installedPane.innerHTML = `<div class="event status">正在加载…</div>`;
  }
  try {
    await loadHubManageData("skill");
    const groups = await loadInstalledSkillsGroups();
    renderSkillsInstalledPane(groups);
  } catch (e) {
    if (installedPane) {
      installedPane.innerHTML = `<div class="event err">加载失败: ${escapeHtml(String(e))}</div>
        <button type="button" class="btn secondary resource-retry-btn" data-retry="skills">重试</button>`;
      bindResourceRetry(installedPane);
    }
  }
}

function bindSkillPageUi() {
  document.querySelectorAll("[data-skill-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-skill-tab");
      if (tab) setSkillsTab(tab);
    });
  });

  $("skillMarketSearchInput")?.addEventListener("input", (e) => {
    state.skillsMarketQuery = e.target.value.trim();
    if (state.skillsMarketTimer) clearTimeout(state.skillsMarketTimer);
    state.skillsMarketTimer = setTimeout(() => {
      if (state.activeNav === "skills" && state.skillsTab === "discover") {
        void loadSkillsDiscover();
      }
    }, 320);
  });

  const manualModal = $("skillManualModal");
  const closeManual = () => manualModal?.classList.add("hidden");
  $("skillManualAddBtn")?.addEventListener("click", () => {
    $("skillManualRepoInput").value = "";
    manualModal?.classList.remove("hidden");
  });
  $("skillManualCancelBtn")?.addEventListener("click", closeManual);
  manualModal?.querySelector(".modal-mask")?.addEventListener("click", closeManual);
  $("skillManualConfirmBtn")?.addEventListener("click", async () => {
    const source = $("skillManualRepoInput")?.value?.trim();
    if (!source) {
      notifyUser("请输入 GitHub 仓库", "warn");
      return;
    }
    try {
      const res = await requireBridge().importSkill({ source });
      notifyUser(`已安装: ${res?.name ?? res?.id}`, "done");
      closeManual();
      await loadInstalledSkillsGroups();
      if (state.skillsTab === "discover") await loadSkillsDiscover();
      else renderSkillsInstalledPane(state.skillsGroups);
    } catch (e) {
      notifyUser(`安装失败: ${String(e)}`, "err");
    }
  });
}

async function renderResourceView() {
  if (state.activeNav === "talents") return void renderTalentsView();
  const cwd = getActiveProject()?.cwd;
  if (!cwd) {
    $("resourceView").innerHTML =
      `<div class="event warn">请先为项目设置有效工作目录。</div>`;
    return;
  }
  if (state.activeNav === "plugins") {
    if (state.pluginsTab === "installed") {
      $("resourceView").innerHTML = `<div class="event status">正在加载插件…</div>`;
    }
    try {
      const pluginRes = await requireBridge().listPlugins(cwd);
      state.plugins = pluginRes?.plugins ?? [];
      indexPluginsFromList(state.plugins);
      renderPluginView();
    } catch (e) {
      $("resourceView").innerHTML = `<div class="event err">加载插件失败: ${escapeHtml(String(e))}</div>
        <button type="button" class="btn secondary resource-retry-btn" data-retry="plugins">重试</button>`;
      bindResourceRetry($("resourceView"));
    }
    return;
  }
  if (state.activeNav === "mcp") return renderMcpView();
  if (state.activeNav === "skills") return void renderSkillsView();
  if (state.activeNav === "hooks") return void renderHooksView();
  if (state.activeNav === "channels") return void renderChannelsView();
  if (state.activeNav === "automations") return void renderAutomationsView();
  if (state.activeNav === "runtimes") return void renderRuntimesView();
}

async function renderRuntimesView() {
  const root = $("resourceView");
  if (!root || state.activeNav !== "runtimes") return;
  const cwd = getActiveProject()?.cwd;
  if (!cwd) {
    root.innerHTML = `<div class="event warn">请先为项目设置有效工作目录。</div>`;
    return;
  }
  root.innerHTML = `<div class="event status">正在检测 Agent Runtime…</div>`;
  try {
    const [listed, warm] = await Promise.all([
      requireBridge().listRuntimes({ cwd }),
      requireBridge().listWarmAcpSessions(),
    ]);
    state.runtimeProviders = Array.isArray(listed?.providers) ? listed.providers : [];
    state.runtimeWarmSessions = Array.isArray(warm?.sessions) ? warm.sessions : [];
    if (!state.runtimeProviders.some((p) => p.id === state.runtimeSelectedProvider)) {
      state.runtimeSelectedProvider = state.runtimeProviders[0]?.id || "forge";
    }
    const cursorProvider = state.runtimeProviders.find((p) => p.id === "cursor");
    if (cursorProvider) {
      state.cursorRuntimeStatus = cursorProvider;
      state.cursorModels = cursorProvider.models || state.cursorModels;
      state.cursorModes = cursorProvider.modes || state.cursorModes;
    }
    const prefs = loadRuntimePrefs();
    await loadCodexModelsForActiveProject();
    window.ForgeRuntimeUI.renderPage(
      root,
      state.runtimeProviders,
      prefs,
      state.runtimeSelectedProvider,
      state.runtimeWarmSessions,
      {
        codexModels: state.codexModels,
        claudeModels: state.claudeModels,
      },
    );
    window.ForgeRuntimeUI.bindPage(root, {
      onSelectProvider: (id) => {
        state.runtimeSelectedProvider = id;
        void renderRuntimesView();
      },
      onUseProvider: (id) => {
        setDefaultRuntimeProvider(id);
        void renderRuntimesView();
      },
      onRefresh: () => {
        state.cursorModels = [];
        state.cursorRuntimeStatus = null;
        void renderRuntimesView();
      },
      onCursorPrefChange: (patch) => {
        saveRuntimePrefs({ cursor: { ...loadRuntimePrefs().cursor, ...patch } });
        if (patch.model !== undefined) state.selectedCursorModel = patch.model;
        if (patch.mode !== undefined) state.selectedCursorMode = patch.mode;
        applyRuntimePrefsToComposer();
      },
      onCodexPrefChange: (patch) => {
        saveRuntimePrefs({ codex: { ...loadRuntimePrefs().codex, ...patch } });
        if (patch.model !== undefined) state.selectedCodexModel = patch.model;
        applyRuntimePrefsToComposer();
      },
      onClaudePrefChange: (patch) => {
        saveRuntimePrefs({ claude: { ...loadRuntimePrefs().claude, ...patch } });
        if (patch.model !== undefined) state.selectedClaudeModel = patch.model;
        applyRuntimePrefsToComposer();
      },
      onRefreshCodex: () => {
        state.codexModels = [];
        void loadCodexModelsForActiveProject({ force: true }).then(() => renderRuntimesView());
      },
      onCloseWarmSession: (provider, sessionId) => {
        void requireBridge()
          .closeAcpSession({ provider, sessionId })
          .then(() => renderRuntimesView())
          .catch((e) => notifyUser(`关闭 warm session 失败: ${String(e)}`, "warn"));
      },
    });
  } catch (e) {
    root.innerHTML = `<div class="event err">加载 Runtime 失败: ${escapeHtml(String(e))}</div>
      <button type="button" class="btn secondary resource-retry-btn" data-retry="runtimes">重试</button>`;
    bindResourceRetry(root);
  }
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach((p) =>
        p.classList.remove("active"),
      );
      btn.classList.add("active");
      $(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "hooks") void loadUserHooksSettingsEditor();
      if (btn.dataset.tab === "permissions") loadPermissionsSettingsEditor();
    });
  });
}

async function reloadConfigAndSessions() {
  const bridge = requireBridge();
  const cfg = await bridge.getConfig();
  renderConfig(cfg);
  if (syncProjectsFromConfig(cfg)) {
    saveProjects();
    renderComposerProjectSelect();
  }
  renderSessions(await bridge.listSessions());
  if (state.activeNav === "talents") void renderTalentsView();
  else void loadTalentRoster();
}

function bindSettingsModal() {
  const modal = $("settingsModal");
  $("openSettingsBtn").addEventListener("click", () => {
    modal.classList.remove("hidden");
    if ($("tab-hooks")?.classList.contains("active")) void loadUserHooksSettingsEditor();
    if ($("tab-permissions")?.classList.contains("active")) loadPermissionsSettingsEditor();
  });
  $("closeSettingsBtn").addEventListener("click", () => modal.classList.add("hidden"));
}

function bindProjectModal() {
  const modal = $("projectModal");
  const close = () => modal.classList.add("hidden");
  $("addProjectBtn").addEventListener("click", () => {
    $("projectNameInput").value = "";
    const active = getActiveProject();
    $("projectCwdInput").value =
      active?.cwd || state.defaultCwd || "";
    modal.classList.remove("hidden");
  });
  $("pickProjectDirBtn")?.addEventListener("click", async () => {
    const bridge = getBridge();
    if (!bridge?.pickDirectory) {
      notifyUser("桌面通信桥未就绪，无法选择目录", "err");
      return;
    }
    const wasOpen = !modal.classList.contains("hidden");
    if (wasOpen) modal.classList.add("hidden");
    try {
      const dir = await bridge.pickDirectory();
      if (dir) $("projectCwdInput").value = dir;
    } catch (e) {
      notifyUser(`选择目录失败: ${String(e)}`, "err");
    } finally {
      if (wasOpen) modal.classList.remove("hidden");
    }
  });
  $("closeProjectBtn").addEventListener("click", close);
  modal.querySelector(".modal-mask").addEventListener("click", close);
  $("saveProjectBtn").addEventListener("click", () => {
    const name = $("projectNameInput").value.trim();
    const cwd = $("projectCwdInput").value.trim();
    if (!name || !cwd) {
      notifyUser("项目名称和路径不能为空", "warn");
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
    state.projects.push({ id, name, cwd, sessionId: "" });
    state.activeProjectId = id;
    renderComposerProjectSelect();
    void refreshGitBranchForProject();
    saveProjects();
    renderSessions(state.sessionsAll);
    close();
    pushEvent(`已新增项目: ${name}`, "done");
    void reloadConfigAndSessions();
  });
}

/** In-session find (Cmd/Ctrl+F): highlight via the CSS Custom Highlight API — no DOM mutation, so the timeline cache stays clean. */
const timelineFind = { matches: [], index: -1, query: "" };

function collectTimelineFindMatches(query) {
  const tl = $("timeline");
  const q = String(query || "").toLowerCase();
  const matches = [];
  if (!tl || !q) return matches;
  const walker = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const lower = String(node.nodeValue || "").toLowerCase();
    let from = 0;
    let at;
    while ((at = lower.indexOf(q, from)) !== -1) {
      matches.push({ node, start: at, end: at + q.length });
      from = at + q.length;
      if (matches.length >= 500) return matches;
    }
  }
  return matches;
}

function applyFindHighlights() {
  if (typeof Highlight === "undefined" || !CSS.highlights) return;
  const all = new Highlight();
  const active = new Highlight();
  timelineFind.matches.forEach((m, i) => {
    try {
      const r = new Range();
      r.setStart(m.node, m.start);
      r.setEnd(m.node, m.end);
      (i === timelineFind.index ? active : all).add(r);
    } catch {
      /* node detached by a repaint — re-collected on next action */
    }
  });
  CSS.highlights.set("forge-find", all);
  CSS.highlights.set("forge-find-active", active);
}

function updateFindCount() {
  const el = $("timelineFindCount");
  if (!el) return;
  const n = timelineFind.matches.length;
  el.textContent = timelineFind.query
    ? n
      ? `${timelineFind.index + 1}/${n}`
      : "无结果"
    : "";
}

function runTimelineFind() {
  const input = $("timelineFindInput");
  const q = String(input?.value || "").trim();
  const prev = timelineFind.matches[timelineFind.index];
  timelineFind.query = q;
  timelineFind.matches = collectTimelineFindMatches(q);
  timelineFind.index = prev
    ? timelineFind.matches.findIndex(
        (m) => m.node === prev.node && m.start === prev.start,
      )
    : -1;
}

function stepTimelineFind(dir, opts = {}) {
  const n = timelineFind.matches.length;
  if (!n) {
    updateFindCount();
    applyFindHighlights();
    return;
  }
  if (!(opts.stay && timelineFind.index >= 0)) {
    timelineFind.index = ((timelineFind.index + dir) % n + n) % n;
  }
  const m = timelineFind.matches[timelineFind.index];
  if (m) revealFindMatch(m);
  updateFindCount();
  applyFindHighlights();
}

function revealFindMatch(m) {
  for (
    let d = m.node.parentElement?.closest("details");
    d;
    d = d.parentElement?.closest("details")
  ) {
    if (!d.open) d.open = true;
  }
  markProgrammaticScroll($("timeline"), 400);
  m.node.parentElement?.scrollIntoView({ block: "center" });
  state.timelineFollowBottom = false;
}

function closeTimelineFind() {
  $("timelineFindBar")?.classList.add("hidden");
  timelineFind.matches = [];
  timelineFind.index = -1;
  timelineFind.query = "";
  if (typeof Highlight !== "undefined" && CSS.highlights) {
    CSS.highlights.delete("forge-find");
    CSS.highlights.delete("forge-find-active");
  }
  $("messageInput")?.focus();
}

function bindTimelineFind() {
  const bar = $("timelineFindBar");
  const input = $("timelineFindInput");
  if (!bar || !input) return;
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === "f") {
      if (state.activeNav !== "chat" || state.chatEmpty) return;
      e.preventDefault();
      bar.classList.remove("hidden");
      input.focus();
      input.select();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeTimelineFind();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runTimelineFind();
      stepTimelineFind(e.shiftKey ? -1 : 1);
    }
  });
  input.addEventListener("input", () => {
    runTimelineFind();
    stepTimelineFind(1, { stay: true });
  });
  $("findNextBtn")?.addEventListener("click", () => {
    runTimelineFind();
    stepTimelineFind(1);
  });
  $("findPrevBtn")?.addEventListener("click", () => {
    runTimelineFind();
    stepTimelineFind(-1);
  });
  $("findCloseBtn")?.addEventListener("click", () => closeTimelineFind());
}

function bindSessionSearch() {
  const btn = $("sessionSearchBtn");
  const panel = $("sessionSearchPanel");
  const input = $("sessionSearchInput");
  const results = $("sessionSearchResults");
  if (!btn || !panel || !input || !results) return;
  let timer = null;
  let seq = 0;

  btn.addEventListener("click", () => {
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) input.focus();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") panel.classList.add("hidden");
  });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void runSessionSearch(), 250);
  });

  async function runSessionSearch() {
    const q = input.value.trim();
    const my = ++seq;
    if (q.length < 2) {
      results.innerHTML = q
        ? `<p class="session-search-hint">至少输入 2 个字符</p>`
        : "";
      return;
    }
    results.innerHTML = `<p class="session-search-hint">搜索中…</p>`;
    try {
      const res = await requireBridge().searchSessions({ query: q, limit: 20 });
      if (my !== seq) return;
      const hits = res?.hits ?? [];
      if (!hits.length) {
        results.innerHTML = `<p class="session-search-hint">没有匹配的会话</p>`;
        return;
      }
      results.innerHTML = hits
        .map((h) => {
          const dir = String(h.cwd || "").split("/").pop() || h.cwd || "";
          const time = h.updatedAt
            ? new Date(h.updatedAt).toLocaleDateString()
            : "";
          return `<button type="button" class="session-search-hit" data-hit-session="${escapeHtml(h.sessionId)}" data-hit-cwd="${escapeHtml(h.cwd || "")}">
            <span class="hit-head"><span class="hit-dir">${escapeHtml(dir)}</span><span class="hit-meta">${h.matchCount} 处 · ${escapeHtml(time)}</span></span>
            <span class="hit-snippet">${escapeHtml(h.snippet || "")}</span>
          </button>`;
        })
        .join("");
      results.querySelectorAll("[data-hit-session]").forEach((el) => {
        el.addEventListener("click", () => {
          panel.classList.add("hidden");
          openSearchedSession(
            el.getAttribute("data-hit-session") || "",
            el.getAttribute("data-hit-cwd") || "",
          );
        });
      });
    } catch (e) {
      if (my === seq) {
        results.innerHTML = `<p class="session-search-hint">搜索失败: ${escapeHtml(String(e))}</p>`;
      }
    }
  }
}

function openSearchedSession(sessionId, cwd) {
  if (!sessionId) return;
  const project =
    state.projects.find((p) => p.cwd === cwd) ||
    state.projects.find((p) => sessionCwdMatches(p.cwd, cwd)) ||
    getActiveProject();
  if (!project) {
    notifyUser("找不到该会话所属的项目，请先添加对应目录为项目", "warn");
    return;
  }
  rememberSessionCwd(sessionId, cwd);
  const outgoingSid =
    state.viewingTimelineSessionId || getActiveProject()?.sessionId || "";
  const prevSid = project.sessionId;
  state.activeProjectId = project.id;
  state.expandedProjectIds.add(project.id);
  setNav("chat");
  void sessionRuns
    ?.switchSessionView(project, sessionId, prevSid, {
      outgoingSessionId: outgoingSid,
    })
    .then(() => {
      renderProjects();
      renderComposerProjectSelect();
    });
}

let slashPaletteApi = null;
let fileMentionApi = null;

function bindSlashPalette() {
  const input = $("messageInput");
  const paletteEl = $("slashPalette");
  const api = globalThis.ForgeSlashPalette;
  if (!input || !paletteEl || !api?.init) return;
  slashPaletteApi = api.init({
    input,
    paletteEl,
    listSkills: async () => {
      const bridge = getBridge();
      if (!bridge?.listSkills) return { groups: [] };
      const cwd = getActiveProject()?.cwd;
      return bridge.listSkills(cwd);
    },
    isDisabled: () => state.running,
    onAction: (action) => {
      if (action === "new-chat") startNewChat();
    },
  });
}

function bindFileMention() {
  const input = $("messageInput");
  const paletteEl = $("mentionPalette");
  const api = globalThis.ForgeFileMention;
  if (!input || !paletteEl || !api?.init) return;
  fileMentionApi = api.init({
    input,
    paletteEl,
    listDir: (relPath) => listWorkspaceDir(relPath),
    getCwd: () => getActiveProject()?.cwd || "",
    listTalents: () =>
      (state.talentsRoster ?? []).filter((t) => t.enabled !== false),
  });
}

/** Either composer palette (slash commands or @file mentions) is on screen. */
function composerPaletteOpen() {
  const slash = $("slashPalette");
  const mention = $("mentionPalette");
  return Boolean(
    (slash && !slash.classList.contains("hidden")) ||
      (mention && !mention.classList.contains("hidden")),
  );
}

function bindActions() {
  if (!getBridge()) return;
  $("navChatBtn").addEventListener("click", () => startNewChat());

  setCustomizeNavExpanded(false);
  setTeamNavExpanded(false);
  $("navCustomizeToggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const expanded = $("navCustomizeToggle")?.getAttribute("aria-expanded") === "true";
    setCustomizeNavExpanded(!expanded);
  });
  $("navTeamToggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    // Clicking anywhere on the bar toggles the group. Expanding also opens the
    // talent center; collapsing just folds it away.
    const expanded = $("navTeamToggle")?.getAttribute("aria-expanded") === "true";
    if (expanded) {
      setTeamNavExpanded(false);
      return;
    }
    setNav("talents");
    setTeamNavExpanded(true);
  });
  $("navTeamCenterBtn")?.addEventListener("click", () => {
    setNav("talents");
    setTeamNavExpanded(true);
  });
  $("navPluginsBtn").addEventListener("click", () => setNav("plugins"));
  $("navMcpBtn").addEventListener("click", () => setNav("mcp"));
  $("navSkillsBtn").addEventListener("click", () => setNav("skills"));
  $("navHooksBtn").addEventListener("click", () => setNav("hooks"));
  $("navChannelsBtn")?.addEventListener("click", () => setNav("channels"));
  $("navAutomationsBtn")?.addEventListener("click", () => setNav("automations"));
  $("navRuntimesBtn")?.addEventListener("click", () => setNav("runtimes"));

  $("toggleRightBtn").addEventListener("click", () => {
    // Clicking the active code panel closes it; otherwise switch the right
    // region to the code panel (taking it over from the terminal if needed).
    const closeIt = state.rightOpen && state.rightMode === "code";
    openRight(!closeIt, "code");
  });
  $("terminalToggleBtn")?.addEventListener("click", () => {
    const closeIt = state.rightOpen && state.rightMode === "terminal";
    openRight(!closeIt, "terminal");
  });
  $("terminalCloseBtn")?.addEventListener("click", () => openRight(false));
  bindRightPanelOutsideClose();
  document.addEventListener("click", () => {
    document
      .querySelectorAll(".project-menu")
      .forEach((menu) => menu.classList.add("hidden"));
  });

  $("toggleWorkspaceExplorerBtn")?.addEventListener("click", () => {
    if (!state.rightOpen) openRight(true);
    const next = !state.workspaceExplorerOpen;
    if (next && state.explorerMode === "workspace") {
      expandExplorerToFile(state.workspaceActiveFile);
    }
    setWorkspaceExplorerOpen(next);
  });
  $("daemonBtn").addEventListener("click", async () => {
    const out = $("daemonOut");
    try {
      const st = await requireBridge().daemonStatus();
      const skills = st?.runtime?.skills ?? "?";
      const plugins = st?.runtime?.plugins ?? "?";
      const sessions = st?.sessions?.count ?? "?";
      out.textContent = `Daemon v${st?.version ?? "?"} · skills ${skills} · plugins ${plugins} · 会话 ${sessions}${st?.activeRun ? " · 运行中" : ""}`;
    } catch (e) {
      out.textContent = `Daemon 不可用: ${String(e)}`;
    }
  });

  bindSkillPageUi();
  bindHooksPageUi();
  bindAutomationsPageUi();
  bindChannelsPageUi();
  bindComposerAttachments();

  $("skillSearchInput")?.addEventListener("input", (e) => {
    state.skillsSearchQuery = e.target.value.trim();
    if (state.activeNav === "skills" && state.skillsTab === "installed") {
      renderSkillsInstalledPane(state.skillsGroups);
    }
  });

  document.querySelectorAll("[data-plugin-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-plugin-tab");
      if (tab) setPluginsTab(tab);
    });
  });

  $("pluginSearchInput")?.addEventListener("input", (e) => {
    state.pluginsSearchQuery = e.target.value.trim();
    if (state.activeNav === "plugins" && state.pluginsTab === "installed") {
      renderPluginsInstalledPane();
    }
  });

  $("pluginMarketSearchInput")?.addEventListener("input", (e) => {
    state.pluginsMarketQuery = e.target.value.trim();
    if (state.pluginsMarketTimer) clearTimeout(state.pluginsMarketTimer);
    state.pluginsMarketTimer = setTimeout(() => {
      if (state.activeNav === "plugins" && state.pluginsTab === "discover") {
        void loadPluginsDiscover();
      }
    }, 320);
  });

  const pluginManualModal = $("pluginManualModal");
  const closePluginManual = () => pluginManualModal?.classList.add("hidden");
  $("pluginManualAddBtn")?.addEventListener("click", () => {
    $("pluginManualRepoInput").value = "";
    pluginManualModal?.classList.remove("hidden");
  });
  $("pluginManualCancelBtn")?.addEventListener("click", closePluginManual);
  pluginManualModal?.querySelector(".modal-mask")?.addEventListener("click", closePluginManual);
  $("pluginManualConfirmBtn")?.addEventListener("click", async () => {
    const source = $("pluginManualRepoInput")?.value?.trim();
    if (!source) {
      notifyUser("请输入 GitHub 插件仓库", "warn");
      return;
    }
    try {
      const res = await requireBridge().importPlugin({ source });
      notifyUser(`已安装插件: ${res?.name ?? res?.id}`, "done");
      closePluginManual();
      const cwd = getActiveProject()?.cwd;
      if (cwd) {
        const pluginRes = await requireBridge().listPlugins(cwd);
        state.plugins = pluginRes?.plugins ?? [];
        indexPluginsFromList(state.plugins);
      }
      if (state.pluginsTab === "discover") await loadPluginsDiscover();
      else renderPluginsInstalledPane();
    } catch (e) {
      notifyUser(`安装失败: ${String(e)}`, "err");
    }
  });
  async function switchSelectedProfile() {
    if ($("profileSelect")?.dataset.runtime === "codex") {
      state.selectedCodexModel = $("profileSelect")?.value || "";
      notifyUser(
        state.selectedCodexModel
          ? `Codex 模型: ${state.selectedCodexModel}`
          : "Codex 将使用默认模型",
        "done",
      );
      return;
    }
    if ($("profileSelect")?.dataset.runtime === "claude-code") {
      state.selectedClaudeModel = $("profileSelect")?.value || "sonnet";
      notifyUser(`Claude Code 模型: ${state.selectedClaudeModel}`, "done");
      return;
    }
    if ($("profileSelect")?.dataset.runtime === "cursor") {
      state.selectedCursorModel = $("profileSelect")?.value || "";
      notifyUser(
        state.selectedCursorModel
          ? `Cursor 模型: ${state.selectedCursorModel}`
          : "Cursor 将使用默认模型",
        "done",
      );
      return;
    }
    const profile = $("profileSelect").value;
    try {
      const cfg = await requireBridge().switchProfile(profile);
      renderConfig(cfg);
      pushEvent(`已切换配置档 -> ${profile}`, "done");
    } catch (e) {
      pushEvent(`切换配置档失败: ${String(e)}`, "err");
      renderConfig(state.config);
    }
  }

  $("profileSelect").addEventListener("change", () => {
    void switchSelectedProfile();
  });

  $("runtimeModeSelect")?.addEventListener("change", () => {
    if ($("runtimeModeSelect")?.dataset.runtime === "cursor") {
      state.selectedCursorMode = $("runtimeModeSelect")?.value || "default";
      notifyUser(`Cursor 模式: ${state.selectedCursorMode}`, "done");
    }
  });

  $("runtimeSelect")?.addEventListener("change", () => {
    const runtime = $("runtimeSelect")?.value || "forge";
    state.acpPrewarmKey = "";
    saveRuntimePrefs({ defaultProvider: runtime });
    renderRuntimeModelSelect();
    if (runtime === "codex") void loadCodexModelsForActiveProject();
    if (runtime === "cursor") {
      void loadCursorModelsForActiveProject();
      scheduleAcpPrewarm();
    }
    notifyUser(
      runtime === "codex"
        ? "本轮将使用 Codex Runtime"
        : runtime === "claude-code"
          ? "本轮将使用 Claude Code Runtime"
          : runtime === "cursor"
            ? "本轮将使用 Cursor Agent (ACP)"
            : "本轮将使用 Forge Agent",
      "done",
    );
  });

  $("themeSelect")?.addEventListener("change", () => {
    applyTheme($("themeSelect")?.value || "system");
  });

  $("saveQuickBtn").addEventListener("click", async () => {
    const patch = {
      activeProfile: $("quickActiveProfile").value,
      limits: {
        ...(state.config?.limits ?? {}),
        maxSteps: Number($("maxStepsInput").value),
        maxContextTokens: Number($("maxCtxInput").value),
      },
      ui: {
        ...(state.config?.ui ?? {}),
        theme: $("themeSelect")?.value || "system",
        thinking: $("thinkingSelect").value,
        progress: $("progressSelect").value,
        autoApplyPatches: $("settingsAutoApplyCheck").checked,
        confirmCommands: $("settingsConfirmCommandsCheck")?.checked ?? false,
      },
      reflection: {
        ...(state.config?.reflection ?? {}),
        enabled: $("settingsReflectionCheck")?.checked ?? false,
        reviewerProfile: $("reflectionReviewerSelect")?.value || "",
        maxRounds: Number($("reflectionMaxRoundsInput")?.value) || 1,
        severityGate: $("reflectionSeveritySelect")?.value || "blocker",
      },
    };
    const cfg = await requireBridge().saveConfig(patch);
    renderConfig(cfg);
    pushEvent("已保存快捷配置", "done");
  });

  $("savePermissionsBtn")?.addEventListener("click", async () => {
    const ui = window.ForgePermissionsUI;
    if (!ui) return;
    const collected = ui.collectPermissionsFromEditor($("permissionsEditorHost"));
    const patch = {
      permissions: {
        ...(state.config?.permissions ?? {}),
        ...collected,
        fileSystem: {
          ...(state.config?.permissions?.fileSystem ?? {}),
          ...collected.fileSystem,
        },
        network: {
          ...(state.config?.permissions?.network ?? {}),
          ...collected.network,
        },
        memory: {
          ...(state.config?.permissions?.memory ?? {}),
          ...collected.memory,
        },
        software: {
          ...(state.config?.permissions?.software ?? {}),
          ...collected.software,
        },
        automation: {
          ...(state.config?.permissions?.automation ?? {}),
          ...collected.automation,
        },
        notifications: {
          ...(state.config?.permissions?.notifications ?? {}),
          ...collected.notifications,
        },
        browser: {
          ...(state.config?.permissions?.browser ?? {}),
          ...collected.browser,
        },
        apps: {
          ...(state.config?.permissions?.apps ?? {}),
          ...collected.apps,
        },
        secrets: {
          ...(state.config?.permissions?.secrets ?? {}),
          ...collected.secrets,
        },
        audit: {
          ...(state.config?.permissions?.audit ?? {}),
          ...collected.audit,
        },
      },
    };
    try {
      const cfg = await requireBridge().saveConfig(patch);
      renderConfig(cfg);
      pushEvent("已保存权限配置", "done");
      if (state.activeNav === "automations") void renderAutomationsView();
      if (state.activeNav === "channels") void renderChannelsView();
    } catch (e) {
      pushEvent(`保存权限失败: ${String(e)}`, "err");
    }
  });

  $("addModelProfileBtn")?.addEventListener("click", () => {
    window.ForgeModelProfilesUI?.addEmptyProfileCard(
      $("modelProfilesList"),
      state.config,
    );
  });

  $("saveModelProfilesBtn")?.addEventListener("click", async () => {
    try {
      const ui = window.ForgeModelProfilesUI;
      const { profiles, activeProfile } = ui.collectProfilesFromList(
        $("modelProfilesList"),
        state.config,
      );
      const cfg = await requireBridge().saveConfig({
        profiles,
        activeProfile,
        replaceProfiles: true,
      });
      renderConfig(cfg);
      pushEvent("已保存模型配置", "done");
    } catch (e) {
      pushEvent(`模型配置错误: ${String(e)}`, "err");
    }
  });

  $("saveJsonBtn").addEventListener("click", async () => {
    try {
      const cfg = await requireBridge().saveConfigJson(JSON.parse($("configJsonInput").value));
      renderConfig(cfg);
      pushEvent("已保存完整配置 JSON", "done");
    } catch (e) {
      pushEvent(`JSON 格式错误: ${String(e)}`, "err");
    }
  });

  async function executeAgentRun(active, message, attachments, runtime) {
    const runtimeName = runtimeDisplayName(runtime);
    const runtimeProvider = normalizeRuntimeProvider(runtime);
    const preview =
      message ||
      (attachments.some((a) => a.kind === "image")
        ? `[${attachments.length} 个附件]`
        : attachments.map((a) => a.name).join(", "));

    if (!active.sessionId && state.pendingNewSessionByProject.has(active.id)) {
      notifyUser("当前项目正在创建新会话，请稍候再发", "warn");
      return;
    }

    pushPromptHistory(message);
    const clientRunId = sessionRuns.registerClientRun(active, preview);
    const routeSid = active.sessionId || null;
    const viewingThis =
      !routeSid || sessionRuns.isViewingSession(routeSid);

    if (routeSid) {
      state.runtimeBySession.set(routeSid, runtimeProvider);
      beginSessionTurn(routeSid);
    } else {
      setTimelineRuntime(runtimeProvider);
      state.runConclusionRendered = false;
    }

    if (viewingThis) {
      showChatEmpty(false);
      if (routeSid) {
        sessionRuns.markSessionRunning(routeSid, true);
        sessionRuns.withEventRoute(routeSid, () => {
          // Existing sessions may skip an immediate session_start event for follow-up turns.
          // Render this turn's prompt now so run-activity/tools/conclusion anchor correctly.
          renderUserPromptOnce(preview);
          updateStatusLine({
            message: `已请求 ${runtimeName}，等待后端确认…`,
            elapsedSec: 0,
          });
        });
      } else {
        renderUserPromptOnce(preview);
        updateStatusLine({
          message: `已请求 ${runtimeName}，等待后端确认…`,
          elapsedSec: 0,
        });
      }
    }

    let result = null;
    let runError = null;
    try {
      result = await requireBridge().run({
        cwd: active.cwd,
        message: message || preview,
        sessionId: active.sessionId || null,
        hookSource: state.pendingHookSource || undefined,
        clientRunId,
        autoApply: Boolean(state.config?.ui?.autoApplyPatches),
        attachments: attachments.length ? attachments : undefined,
        runtime,
      });
      if (result?.sessionId) {
        state.runtimeBySession.set(result.sessionId, runtimeProvider);
        if (sessionRuns.isViewingSession(result.sessionId)) {
          setTimelineRuntime(runtimeProvider);
        }
      }
      const now = new Date().toISOString();
      const idx = state.sessionsAll.findIndex((s) => s.id === result.sessionId);
      const prev = idx >= 0 ? state.sessionsAll[idx] : null;
      const sessionItem = {
        id: result.sessionId,
        cwd: active.cwd,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        messageCount: prev?.messageCount ?? 0,
        lastPreview:
          prev?.lastPreview || (message || result.finalText || "").slice(0, 120),
      };
      if (idx >= 0) state.sessionsAll[idx] = { ...state.sessionsAll[idx], ...sessionItem };
      else state.sessionsAll.unshift(sessionItem);

      const meta = state.clientRuns.get(clientRunId);
      if (
        meta &&
        meta.projectId === state.activeProjectId &&
        sessionRuns.isViewingSession(result.sessionId)
      ) {
        active.sessionId = result.sessionId;
        saveProjects();
      }

      if (sessionRuns.isViewingSession(result.sessionId)) {
        const stopped = state.stopRequestedBySession.get(result.sessionId);
        if (stopped && state.runActivityStats) {
          state.runActivityStats.stopped = true;
        }
        if (!state.conclusionDomRenderedThisTurn.has(result.sessionId)) {
          renderRunConclusion(result.finalText, result.sessionId);
        } else {
          forgeSessionLog("conclusion:run-result-skipped", {
            sessionId: result.sessionId,
            hasFinalText: Boolean(result.finalText),
          });
        }
        $("messageInput").value = "";
        clearComposerAttachments();
      } else {
        if (result.finalText) {
          state.runFinalTextBySession.set(
            result.sessionId,
            dedupeConclusionAgainstStepNarratives(result.finalText, result.sessionId),
          );
        }
        if (!state.conclusionDomRenderedThisTurn.has(result.sessionId)) {
          sessionRuns.appendOffscreenDone(result.sessionId, result.finalText);
        }
        reconcileSessionConclusion(result.sessionId);
      }

      renderSessions(state.sessionsAll);
      requireBridge()
        .listSessions()
        .then((s) => {
          renderSessions(s);
          // Seed the daemon version so the next poll doesn't rebuild a timeline
          // we just rendered live.
          const rows = Array.isArray(s) ? s : (s?.sessions ?? []);
          const row = rows.find((r) => r.id === result.sessionId);
          if (row) {
            state.externalSessionVersionSeen.set(
              result.sessionId,
              sessionRowVersion(row),
            );
          }
        });
    } catch (e) {
      runError = e;
      if (routeSid) sessionRuns.markSessionRunning(routeSid, false);
      if (viewingThis) {
        const line = pushEvent(`执行失败: ${String(e)}`, "err");
        if (line && message) {
          line.insertAdjacentHTML(
            "beforeend",
            `<button type="button" class="event-retry-btn" data-retry-message="${escapeHtml(message.slice(0, 4000))}">重试</button>`,
          );
        }
      } else if (result?.sessionId) {
        sessionRuns.appendOffscreenEvent(
          result.sessionId,
          `执行失败: ${String(e)}`,
          "err",
        );
      }
    } finally {
      state.pendingHookSource = null;
      sessionRuns.clearClientRun(clientRunId);
      const finishedSid = result?.sessionId || routeSid;
      const wasStopped = Boolean(
        finishedSid && state.stopRequestedBySession.get(finishedSid),
      );
      if (finishedSid) {
        sessionRuns.markSessionRunning(finishedSid, false);
        state.stopRequestedBySession.delete(finishedSid);
        if (
          sessionRuns.isViewingSession(finishedSid) &&
          !state.conclusionDomRenderedThisTurn.has(finishedSid)
        ) {
          forgeSessionLog("conclusion:finally-fallback", {
            sessionId: finishedSid,
            hasResult: Boolean(result?.finalText),
          });
          renderRunConclusion(result?.finalText ?? "", finishedSid);
        }
      }
      clearLiveStatusLine();
      sessionRuns.syncComposerRunChrome();
      if (finishedSid && !wasStopped) {
        notifyRunFinishedInBackground(
          finishedSid,
          !runError,
          runError ? String(runError) : result?.finalText,
        );
      }
      if (finishedSid && !sessionRuns.isViewingSession(finishedSid)) {
        state.unreadDoneSessions.add(finishedSid);
        renderProjects();
      }
      if (finishedSid) dispatchQueuedRun(finishedSid, wasStopped);
    }
  }

  /** Send the next queued composer message once the session's current run ends. */
  function dispatchQueuedRun(sessionId, wasStopped) {
    const arr = state.queuedRunsBySession.get(sessionId);
    if (!arr?.length) return;
    if (wasStopped) {
      state.queuedRunsBySession.delete(sessionId);
      renderComposerQueue();
      notifyUser("已停止执行，该会话排队中的消息已取消", "warn");
      return;
    }
    const next = arr.shift();
    if (!arr.length) state.queuedRunsBySession.delete(sessionId);
    renderComposerQueue();
    const project = state.projects.find((p) => p.id === next.projectId);
    if (!project?.cwd) return;
    // Copy: route to the queued session even if the project is viewing another one now.
    void executeAgentRun(
      { ...project, sessionId },
      next.message,
      next.attachments,
      next.runtime,
    );
  }

  async function handleComposerSubmit(opts = {}) {
    const stopSid = sessionRuns.getComposerStopSessionId();
    const active = getActiveProject();
    const pendingDraft = sessionRuns.isNewChatDraftRunning();

  if (stopSid && state.runningSessions.has(stopSid)) {
      // Enter queues for the next turn; only the stop button cancels the run.
      if (opts.viaEnter) {
        const message = $("messageInput").value.trim();
        const attachments = state.composerAttachments.map((x) => x.attachment);
        if (!message && !attachments.length) return;
        if (message.startsWith("/")) {
          notifyUser("执行中无法使用斜杠命令，请等待本轮完成", "warn");
          return;
        }
        enqueueComposerRun(
          stopSid,
          active?.id || "",
          message,
          attachments,
          getSelectedRuntimeRequest(),
        );
        $("messageInput").value = "";
        clearComposerAttachments();
        return;
      }
      if (state.stopRequestedBySession.get(stopSid)) {
        notifyUser("已发送停止请求，正在等待后端结束本轮", "status");
        return;
      }
      state.stopRequestedBySession.set(stopSid, true);
      sessionRuns.syncComposerRunChrome();
      try {
        await requireBridge().cancelRun(stopSid);
        pushEvent("正在停止执行…", "warn");
      } catch (e) {
        state.stopRequestedBySession.delete(stopSid);
        sessionRuns.syncComposerRunChrome();
        pushEvent(`停止失败: ${String(e)}`, "err");
      }
      return;
    }

    if (pendingDraft && opts.viaEnter) {
      notifyUser("新会话正在创建中，请稍候再发送", "warn");
      return;
    }

    if (pendingDraft) {
      notifyUser("正在停止提交中的新对话…", "status");
      try {
        await requireBridge().cancelRun();
        pushEvent("正在停止执行…", "warn");
      } catch (e) {
        pushEvent(`停止失败: ${String(e)}`, "err");
      }
      for (const [crId, meta] of state.clientRuns) {
        if (meta.projectId === active?.id) sessionRuns.clearClientRun(crId);
      }
      sessionRuns.syncComposerRunChrome();
      return;
    }

    const message = $("messageInput").value.trim();
    const attachments = state.composerAttachments.map((x) => x.attachment);
    if (!message && !attachments.length) return;
    if (message && (await tryHandleSlashCommand(message))) return;

    if (!active?.cwd) {
      notifyUser("请先选择有效项目目录", "warn");
      return;
    }
    if (active.sessionId && !sessionBelongsToActiveProject(active.sessionId)) {
      active.sessionId = "";
      saveProjects();
    }

    if (state.automationCreateMode) {
      if (attachments.length) {
        notifyUser("创建自动化时不支持附件，请仅发送文字描述", "warn");
        return;
      }
      state.automationCreateMode = false;
      const handled = await submitAutomationDraftFromChat(message, active.cwd, {
        retainCreateMode: true,
      });
      if (handled) return;
    }

    if (
      message &&
      !attachments.length &&
      looksLikeScheduledAutomationRequest(message)
    ) {
      if (!isAutomationEnabledInCfg(state.config)) {
        notifyUser(
          "检测到定时任务描述。定时执行请先在 设置 → 权限 中启用「自动化」，然后从侧栏「自动化」创建；当前将按普通对话执行（不会自动重复）。",
          "warn",
        );
      } else if (hasExplicitAutomationCreateIntent(message)) {
        notifyUser(
          "检测到明确的定时创建意图，将创建「自动化」而非普通对话（不会在此会话里重复执行）。",
          "status",
        );
        const handled = await submitAutomationDraftFromChat(message, active.cwd);
        if (handled) return;
      } else {
        const shouldCreate = window.confirm(
          [
            "检测到你提到了定时执行，但未明确要创建任务。",
            "",
            "选择“确定”：现在创建自动化任务",
            "选择“取消”：按普通对话继续（不创建、不重复执行）",
          ].join("\\n"),
        );
        if (shouldCreate) {
          notifyUser("已确认创建自动化，开始解析任务草稿。", "status");
          const handled = await submitAutomationDraftFromChat(message, active.cwd);
          if (handled) return;
        } else {
          notifyUser(
            "已按普通对话执行（未创建自动化）。若之后要创建，请明确说“创建/设置定时任务”。",
            "status",
          );
        }
      }
    }

    void executeAgentRun(active, message, attachments, getSelectedRuntimeRequest());
  }

  $("runBtn").addEventListener("click", () => {
    void handleComposerSubmit();
  });

  $("messageInput")?.addEventListener("input", () => {
    promptHistory.index = null;
  });

  let escStopArmedAt = 0;
  $("messageInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.isComposing) {
      // Palettes consume Escape first (they preventDefault when open).
      if (e.defaultPrevented || composerPaletteOpen()) return;
      const stopSid = sessionRuns?.getComposerStopSessionId?.();
      if (!stopSid || !state.runningSessions.has(stopSid)) return;
      e.preventDefault();
      const now = Date.now();
      if (now - escStopArmedAt < 1500) {
        escStopArmedAt = 0;
        void handleComposerSubmit();
      } else {
        escStopArmedAt = now;
        notifyUser("再按一次 Esc 停止当前执行", "status");
      }
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.isComposing) {
      if (!composerPaletteOpen()) handlePromptHistoryKey(e);
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    if (composerPaletteOpen()) return;
    const input = $("messageInput");
    if (input?.readOnly) return;
    e.preventDefault();
    void handleComposerSubmit({ viaEnter: true });
  });
}

function bindEventStream() {
  const bridge = getBridge();
  if (!bridge || typeof bridge.onEvent !== "function") return;
  bridge.onEvent((ev) => {
    if (!sessionRuns) return;
    try {
      handleForgeAgentEvent(ev);
    } catch (e) {
      console.error("[forge] event handler error", e);
    }
  });
}

function handleForgeAgentEvent(ev) {
    const sid = sessionRuns.getEventSessionId(ev);
    if (ev.type === "context_usage") {
      const usageSid = sid || ev.sessionId;
      if (usageSid) {
        const used = Number(ev.estimatedTokens) || 0;
        const max = Number(ev.maxContextTokens) || 0;
        state.contextUsageBySession.set(usageSid, {
          used,
          max,
          truncated: Boolean(ev.truncated),
        });
        renderContextMeter();
        // One-time nudge per session once the budget crosses 90%.
        const pct = max ? (used / max) * 100 : 0;
        if (pct >= 90 && !state.compactNudgedSessions.has(usageSid)) {
          state.compactNudgedSessions.add(usageSid);
          if (sessionRuns?.isViewingSession?.(usageSid)) {
            notifyUser(
              `上下文已用 ${Math.round(pct)}%——点击右下「上下文」标签可立即压缩历史（/compact）`,
              "warn",
            );
          }
        } else if (pct < 80) {
          state.compactNudgedSessions.delete(usageSid);
        }
      }
      return;
    }
    if (ev.type === "session_start" || ev.type === "done") {
      forgeSessionLog(`event:${ev.type}`, {
        sid,
        viewingTimelineSessionId: state.viewingTimelineSessionId,
        projectSessionId: sessionRuns.getViewingSessionId(),
        liveRunSessionId: state.liveRunSessionId,
        clientRunId: ev.clientRunId,
      });
    }

    if (ev.type === "done" && ev.sessionId) {
      sessionRuns.markSessionRunning(ev.sessionId, false);
      if (!sessionRuns.isViewingSession(ev.sessionId)) {
        state.unreadDoneSessions.add(ev.sessionId);
      }
      const cwd =
        ev.cwd ||
        state.sessionCwdById.get(ev.sessionId) ||
        state.sessionsAll.find((s) => s.id === ev.sessionId)?.cwd;
      const row = state.sessionsAll.find((s) => s.id === ev.sessionId);
      const prevPreview = row?.lastPreview;
      const donePreview =
        prevPreview && /^\[微信/.test(prevPreview)
          ? prevPreview
          : prevPreview ||
            (ev.finalText
              ? truncateSessionLabel(stripMarkdownForTitle(ev.finalText), 120)
              : "");
      upsertSessionInWorkspace({
        sessionId: ev.sessionId,
        cwd,
        preview: donePreview,
      });
      window.setTimeout(() => {
        void requireBridge()
          .listSessions(80)
          .then((s) => renderSessions(s))
          .catch(() => {});
      }, 50);
    }

    if (ev.type === "session_start") {
      rememberSessionCwd(ev.sessionId, ev.cwd);
      state.planCardTitle = "任务清单";
      state.dispatchPlanLocked = false;
      state.runConclusionBySession.delete(ev.sessionId);
      state.conclusionDomRenderedThisTurn.delete(ev.sessionId);
      state.runConclusionRendered = false;
      sessionRuns.onSessionStart(ev);
      if (ev.preview && /^\[微信/.test(ev.preview)) {
        for (const p of state.projects) {
          if (sessionCwdMatches(p.cwd, ev.cwd)) {
            state.expandedProjectIds.add(p.id);
            break;
          }
        }
      }
      if (
        sessionRuns.shouldRouteEventToView(ev.sessionId) &&
        sessionBelongsToActiveProject(ev.sessionId)
      ) {
        if (!state.runtimeBySession.has(ev.sessionId)) {
          state.runtimeBySession.set(ev.sessionId, "forge");
        }
        state.viewingTimelineSessionId = ev.sessionId;
        sessionRuns.withEventRoute(ev.sessionId, () => {
          beginSessionTurn(ev.sessionId);
          showChatEmpty(false);
          if (ev.preview) renderUserPromptOnce(ev.preview);
          updateStatusLine({ message: "正在提交任务…", elapsedSec: 0 });
        });
      } else if (ev.preview) {
        if (!state.runtimeBySession.has(ev.sessionId)) {
          state.runtimeBySession.set(ev.sessionId, "forge");
        }
        sessionRuns.runOffscreen(ev.sessionId, () => {
          state.runConclusionBySession.delete(ev.sessionId);
          state.conclusionDomRenderedThisTurn.delete(ev.sessionId);
          resetRunActivityState();
          renderUserPromptOnce(ev.preview);
          updateStatusLine({ message: "正在提交任务…", elapsedSec: 0 });
        });
      }
      return;
    }

    if (!sid) {
      if (ev.type === "status") {
        const viewing = sessionRuns.getViewingSessionId();
        if (viewing && isSessionRunConcluded(viewing)) return;
        if (
          viewing &&
          state.runningSessions.has(viewing) &&
          sessionBelongsToActiveProject(viewing)
        ) {
          if (!state.viewingTimelineSessionId) {
            state.viewingTimelineSessionId = viewing;
          }
          return sessionRuns.withEventRoute(viewing, () => updateStatusLine(ev));
        }
      }
      return;
    }

    if (
      !sessionRuns.shouldRouteEventToView(sid) ||
      !sessionBelongsToActiveProject(sid)
    ) {
      sessionRuns.appendOffscreenAgentEvent(sid, ev, (e) =>
        handleLiveAgentEvent(e, { offscreen: true }),
      );
      return;
    }

    return sessionRuns.withEventRoute(sid, () => {
      const viewingSid = sessionRuns.getViewingSessionId();
      if (viewingSid && viewingSid !== sid) {
        forgeSessionLog("route:live-mismatch-offscreen", {
          sid,
          viewingSid,
          type: ev.type,
        });
        sessionRuns.appendOffscreenAgentEvent(sid, ev, (e) =>
          handleLiveAgentEvent(e, { offscreen: true }),
        );
        return;
      }
      if (!sessionBelongsToActiveProject(sid)) return;
      if (state.viewingTimelineSessionId !== sid) {
        forgeSessionLog("route:sync-viewing-timeline", {
          sid,
          was: state.viewingTimelineSessionId,
          type: ev.type,
        });
        state.viewingTimelineSessionId = sid;
      }
      ensureLiveRunSession(sid);
      if (ev.type === "session_start") return;
      return handleLiveAgentEvent(ev);
    });
}

function handleLiveAgentEvent(ev, opts = {}) {
  const prevMount = state.pushEventMountOverride;
  const talentBody = resolveSubagentEventMount(ev);
  if (talentBody) state.pushEventMountOverride = talentBody;
  try {
    handleLiveAgentEventBody(ev, opts);
  } finally {
    state.pushEventMountOverride = prevMount;
  }
}

function handleLiveAgentEventBody(ev, opts = {}) {
    if (ev.type === "session_start") return;
    if (ev.type === "hooks_applied") {
      finishStreamTextSegment();
      pushEvent(
        `Hook 已注入: ${(ev.sources || []).join(", ")}`,
        "skill-hit",
      );
      return;
    }
    if (ev.type === "skill_active") {
      finishStreamTextSegment();
      if (
        (ev.matchMode === "explicit" || ev.matchMode === "implicit") &&
        ev.matched &&
        ev.skillName
      ) {
        const via = ev.matchMode === "implicit" ? " · 触发词匹配" : "";
        pushEvent(
          `预加载 Skill: ${ev.skillName}${ev.skillId ? ` (${ev.skillId})` : ""}${via} · 已加载 ${ev.loadedCount} 个`,
          "skill-hit",
        );
      } else {
        pushEvent(
          `已加载 ${ev.loadedCount} 个 Skill（模型从目录按需选择，未预加载）`,
          "status",
        );
      }
      return;
    }
    if (ev.type === "skill_used") {
      finishStreamTextSegment();
      pushEvent(
        `模型加载 Skill: ${ev.skillName} (${ev.skillId})`,
        "skill-hit",
      );
      return;
    }
    if (ev.type === "step_start") {
      finishStreamTextSegment();
      if (
        !ev.talent &&
        state.activeSubagentMentions.size === 0 &&
        !state.coordinatorPhaseAnnounced
      ) {
        state.coordinatorPhaseAnnounced = true;
        pushEvent("◇ 团队负责人汇总中…", "status");
      }
      startStepGroup(ev.step, ev.maxSteps);
      return;
    }
    if (ev.type === "thinking_start") {
      finishStreamTextSegment();
      if (ev.talent) state.activeThinkingTalent = ev.talent;
      beginThinking(ev.talent);
      if (isCodexRuntime(ev.sessionId)) {
        const holder = state.thinkingPre?.closest("details.thinking");
        const summary = holder?.querySelector("summary");
        if (summary) summary.textContent = "正在思考";
      }
      return;
    }
    if (ev.type === "thinking_delta") {
      finishStreamTextSegment();
      if (ev.talent) state.activeThinkingTalent = ev.talent;
      appendThinking(ev.delta || "", ev.talent);
      return;
    }
    if (ev.type === "thinking_end") {
      endThinking(ev.charCount, ev.durationMs, ev.talent);
      return;
    }
    if (ev.type === "permission_request") {
      finishStreamTextSegment();
      if (
        ev.kind === "network" ||
        ev.kind === "software" ||
        ev.kind === "command" ||
        ev.kind === "acp" ||
        ev.kind === "codex" ||
        ev.kind === "claude-code"
      ) {
        showNetworkPermissionRequest(ev);
      }
      return;
    }
    if (ev.type === "patch_proposed") {
      finishStreamTextSegment();
      recordRunPatch(ev);
      const patchPath = normalizeWorkspaceRelPath(getActiveProject()?.cwd, ev.path);
      if (state.normalizedFileActivityPaths.has(patchPath)) return;
      pushEvent(`补丁: ${patchPath}（${ev.applied ? "已应用" : "待应用"}）`, ev.applied ? "done" : "warn", {
        title: `Patch · ${patchPath}`,
        meta: ev.applied ? "已应用" : "待应用",
        content: ev.unifiedDiff,
        patch: {
          path: ev.path,
          unifiedDiff: ev.unifiedDiff,
          applied: Boolean(ev.applied),
        },
      });
      return;
    }
    if (ev.type === "checkpoint") {
      finishStreamTextSegment();
      const cpSid = ev.sessionId || state.eventRouteSessionId || state.liveRunSessionId;
      if (cpSid && ev.sha) state.runCheckpointShaBySession.set(cpSid, String(ev.sha));
      attachCheckpointToPrompt(ev.sha, ev.turnIndex);
      const cacheSid = state.eventRouteSessionId || state.liveRunSessionId;
      if (cacheSid) syncTimelineCacheForSession(cacheSid);
      return;
    }
    if (ev.type === "intent_plan") {
      finishStreamTextSegment();
      renderIntentPlanCard(ev);
      const cacheSid = state.eventRouteSessionId || state.liveRunSessionId;
      if (cacheSid) syncTimelineCacheForSession(cacheSid);
      return;
    }
    if (ev.type === "plan_update") {
      if (state.dispatchPlanLocked) return;
      finishStreamTextSegment();
      renderPlanCard(ev.items || [], state.planCardTitle || "任务清单");
      const cacheSid = state.eventRouteSessionId || state.liveRunSessionId;
      if (cacheSid) syncTimelineCacheForSession(cacheSid);
      return;
    }
    if (ev.type === "dispatch_plan") {
      finishStreamTextSegment();
      state.planCardTitle = "团队负责人计划";
      state.dispatchPlanLocked = true;
      applyDispatchTimelineEvent(ev);
      const cacheSid = state.eventRouteSessionId || state.liveRunSessionId;
      if (cacheSid) syncTimelineCacheForSession(cacheSid);
      return;
    }
    if (ev.type === "dispatch_wave_start") {
      finishStreamTextSegment();
      applyDispatchTimelineEvent(ev);
      const cacheSid = state.eventRouteSessionId || state.liveRunSessionId;
      if (cacheSid) syncTimelineCacheForSession(cacheSid);
      return;
    }
    if (ev.type === "talent_active") {
      finishStreamTextSegment();
      const t = ev.talent;
      const sid = ev.sessionId || state.liveRunSessionId || state.eventRouteSessionId;
      if (t?.mention) {
        addSessionTalentBusy(sid, t.mention);
        if (sid) state.foregroundTalentBySession.set(sid, t);
      }
      applyDispatchTimelineEvent(ev);
      if (t) {
        const emoji = t.emoji || "🧑";
        const modeLabel =
          ev.mode === "foreground" ? "前台接管本轮" : "已派出任务";
        pushEvent(`${emoji} ${t.displayName} · ${modeLabel}`, "skill-hit", {
          title: `${t.displayName} (@${t.mention})`,
          meta: t.role || "人才",
        });
      }
      return;
    }
    if (ev.type === "subagent_start") {
      finishStreamTextSegment();
      ensureRunActivity();
      const t = ev.talent;
      if (t?.mention) addSessionTalentBusy(ev.sessionId, t.mention);
      if (t) {
        applyDispatchTimelineEvent(ev);
        const taskText = String(ev.task || "");
        const taskBody = taskText.includes(": ")
          ? taskText.slice(taskText.indexOf(": ") + 2)
          : taskText;
        const group = createSubagentActivityGroup(
          t,
          truncateToolSummary(taskBody, 80),
          ev.dispatchWave,
        );
        if (group?.body) {
          pushEventIn(group.body, `▶ ${t.displayName} 开始任务`, "status");
        }
      } else {
        pushEvent(`🤖 子代理 · ${truncateToolSummary(ev.task || "", 80)}`, "skill-hit");
      }
      return;
    }
    if (ev.type === "subagent_end") {
      finishStreamTextSegment();
      const t = ev.talent;
      if (t?.mention) removeSessionTalentBusy(ev.sessionId, t.mention);
      if (t) applyDispatchTimelineEvent(ev);
      const summary = String(ev.summary || "");
      const body =
        t && summary.includes(": ")
          ? summary.slice(summary.indexOf(": ") + 2)
          : summary;
      if (t?.mention && getSubagentEntry(t.mention)) {
        finalizeSubagentActivityGroup(t, body || summary);
      } else if (t?.mention) {
        rebuildSubagentActivityMapFromDom();
        if (getSubagentEntry(t.mention)) {
          finalizeSubagentActivityGroup(t, body || summary);
        } else {
          state.activeSubagentMentions.delete(normalizeTalentMention(t.mention));
          pushEvent(t ? `✓ ${t.displayName} 完成` : `✓ 子代理完成`, "done", {
            title: t ? `${t.displayName} (@${t.mention})` : "子代理结果",
            meta: t?.role || "subagent",
            content: body || summary,
          });
        }
      } else {
        pushEvent(t ? `✓ ${t.displayName} 完成` : `✓ 子代理完成`, "done", {
          title: t ? `${t.displayName} (@${t.mention})` : "子代理结果",
          meta: t?.role || "subagent",
          content: body || summary,
        });
      }
      return;
    }
    if (ev.type === "runtime_activity") {
      if (opts.offscreen) return;
      handleRuntimeActivityEvent(ev);
      return;
    }
    if (ev.type === "tool_start") {
      // Plan tool → plan card; spawn_agent → subagent_start/end cards. Not lines.
      if (ev.name === "update_plan" || ev.name === "spawn_agent") return;
      if (isCodexRuntime(ev.sessionId)) return;
      finishStreamTextSegment();
      beginToolLine(ev.name, ev.args, ev.callId, ev.talent);
      return;
    }
    if (ev.type === "tool_end") {
      if (ev.name === "update_plan" || ev.name === "spawn_agent") return;
      if (isCodexRuntime(ev.sessionId)) return;
      if (ev.callId && state.normalizedFileActivityCallIds.delete(String(ev.callId))) return;
      finishStreamTextSegment();
      completeToolLine(ev.name, ev.result ?? "", ev.callId);
      return;
    }
    if (ev.type === "text_delta") {
      if (opts.offscreen) return;
      if (ev.talent?.mention) {
        appendSubagentStreamText(ev.talent, ev.delta || "");
        return;
      }
      state.sawStreamTextInRun = true;
      state.streamTextBuffer += ev.delta || "";
      scheduleStreamFlush();
      return;
    }
    if (ev.type === "codex_activity") {
      if (opts.offscreen) return;
      if (ev.sessionId) state.runtimeBySession.set(ev.sessionId, "codex");
      setTimelineRuntime("codex");
      handleCodexActivityEvent(ev);
      return;
    }
    if (ev.type === "status") {
      if (
        ev.phase === "tool" &&
        String(ev.message || "").startsWith(CODEX_CHIP_PREFIX)
      ) {
        try {
          const payload = JSON.parse(ev.message.slice(CODEX_CHIP_PREFIX.length));
          if (ev.sessionId) state.runtimeBySession.set(ev.sessionId, "codex");
          setTimelineRuntime("codex");
          handleCodexActivityEvent({ ...payload, sessionId: ev.sessionId });
          return;
        } catch {
          /* fall through */
        }
      }
      const activated = ev.message?.match(/已激活人才 @([^（\s]+)/u);
      if (activated?.[1]) addSessionTalentBusy(ev.sessionId, activated[1]);
      if (ev.phase === "runtime") {
        const provider = runtimeProviderFromStatusMessage(ev.message);
        const runtimeSid =
          ev.sessionId || state.eventRouteSessionId || state.liveRunSessionId || "";
        if (provider && runtimeSid) state.runtimeBySession.set(runtimeSid, provider);
        if (provider) setTimelineRuntime(provider);
        return updateStatusLine(ev);
      }
      if (opts.offscreen) {
        if (updateSubagentStatusMeta(ev)) return;
        sessionRuns.appendOffscreenEvent(
          ev.sessionId,
          formatStatusMessage(ev),
          "status",
        );
        return;
      }
      const statusSid = ev.sessionId || sessionRuns.getViewingSessionId();
      if (statusSid && isSessionRunConcluded(statusSid)) return;
      if (updateSubagentStatusMeta(ev)) return;
      if (ev.message?.includes("团队负责人正在汇总")) {
        state.dispatchPlanLocked = true;
        applyDispatchTimelineEvent(ev);
      }
      return updateStatusLine(ev);
    }
    if (ev.type === "warning") {
      if (/skills context budget/i.test(String(ev.message || ""))) return;
      finishStreamTextSegment();
      return pushEvent(`⚠ ${ev.message}`, "warn");
    }
    if (ev.type === "error") {
      finishStreamTextSegment();
      clearNetworkPermissionBanner();
      return pushEvent(`✖ ${ev.message}`, "err");
    }
    if (ev.type === "reflection_start" || ev.type === "reflection_verdict") {
      finishStreamTextSegment();
      applyReflectionEvent(ev);
      const cacheSid = ev.sessionId || state.eventRouteSessionId || state.liveRunSessionId;
      if (cacheSid) syncTimelineCacheForSession(cacheSid);
      return;
    }
    if (ev.type === "done") {
      if (opts.offscreen) {
        sessionRuns.markSessionRunning(ev.sessionId, false);
        sessionRuns.runOffscreen(ev.sessionId, () => {
          finalizeRunConclusionOnMount(ev.finalText, ev.sessionId);
          markReflectionDelivered(ev.sessionId);
        });
        flushTimelineCacheSync();
        if (
          structuredTimelineHasConclusion(ev.sessionId) &&
          !structuredTimelineHasUserTurn(ev.sessionId)
        ) {
          state.normalTimelineBySession.delete(ev.sessionId);
        }
        clearSessionTalentBusy(ev.sessionId);
        return;
      }
      if (!sessionRuns.onSessionDone(ev)) {
        forgeSessionLog("done:offscreen-only", { sessionId: ev.sessionId });
        clearSessionTalentBusy(ev.sessionId);
        return;
      }
      flushStreamText();
      clearLiveStatusLine();
      clearNetworkPermissionBanner();
      renderRunConclusion(ev.finalText, ev.sessionId);
      markReflectionDelivered(ev.sessionId);
      syncTimelineCacheForSession(ev.sessionId);
      clearSessionTalentBusy(ev.sessionId);
      return;
    }
}

async function bootstrap() {
  showBootstrapBanner(null);
  initSessionRuns();

  loadPanelWidths();
  applyPanelWidths();
  bindPanelResize();

  bindTabs();
  bindSettingsModal();
  bindProjectModal();
  bindComposerProjectSelect();
  bindComposerGitBranchSelect();

  const bridge = getBridge();
  if (!bridge || typeof bridge.onEvent !== "function") {
    showBootstrapBanner(
      "桌面通信桥未就绪（preload 未加载）。请执行 pnpm --filter @forge/desktop run build 后重新启动桌面端。",
    );
    return;
  }

  bindActions();
  bindSlashPalette();
  bindFileMention();
  bindSessionSearch();
  bindTalentsUi();
  bindTimelineFind();
  bindContextMeterCompact();
  bindTimelineScrollFollow();
  bindTimelineClickDelegation();
  bindEventStream();

  try {
    if (typeof bridge.getDefaultCwd === "function") {
      state.defaultCwd = await bridge.getDefaultCwd();
    }
  } catch {
    /* keep empty defaultCwd */
  }

  state.projects = await loadProjects();
  loadSessionUiPrefs();
  loadRuntimePrefs();
  applyRuntimePrefsToComposer();
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PROJECT_EXPANDED_KEY) || "[]");
    if (Array.isArray(raw)) state.expandedProjectIds = new Set(raw);
  } catch {
    state.expandedProjectIds = new Set();
  }
  state.activeProjectId =
    localStorage.getItem(LS_ACTIVE_PROJECT_KEY) || state.projects[0]?.id || "default";
  if (!state.projects.length) state.projects = [await createDefaultProject()];
  if (!state.projects.some((p) => p.id === state.activeProjectId)) {
    state.activeProjectId = state.projects[0].id;
  }
  state.expandedProjectIds.add(state.activeProjectId);
  renderProjects();
  renderComposerProjectSelect();
  void refreshGitBranchForProject();
  startGitBranchAutoRefresh();
  startExternalSessionAutoRefresh();
  saveProjects();
  scheduleAcpPrewarm();

  startNewChat();
  openRight(false);

  void reloadConfigAndSessions().catch((e) => {
    showBootstrapBanner(`后台加载配置/会话失败: ${String(e)}`);
  });
}

bootstrap().catch((e) => {
  showBootstrapBanner(`初始化失败: ${String(e)}`);
});
