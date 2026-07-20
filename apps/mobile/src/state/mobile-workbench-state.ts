import type { MessageItem } from "../screens/session-sanitize";
import { appendStreamingText, type RunUiEvent } from "../screens/run-event-sanitize";

export type MobileWorkbenchState = {
  lastSeqBySubscription: Record<string, number>;
  messagesBySession: Record<string, MessageItem[]>;
  runningSessionId: string | null;
  activeSessionId: string | null;
  liveEvents: RunUiEvent[];
  liveText: string;
  pendingPermission: Extract<RunUiEvent, { kind: "permission" }> | null;
  selectedHostId: string | null;
  lastHostId: string | null;
  activeTab: "workbench" | "workspaces" | "sessions" | "settings";
  workspaceId: string | null;
  unreadSessionIds: string[];
  needsHistoryRefresh: boolean;
  historyRefreshSessionIds: string[];
};

export const initialMobileWorkbenchState: MobileWorkbenchState = {
  lastSeqBySubscription: {},
  messagesBySession: {},
  runningSessionId: null,
  activeSessionId: null,
  liveEvents: [],
  liveText: "",
  pendingPermission: null,
  selectedHostId: null,
  lastHostId: null,
  activeTab: "workbench",
  workspaceId: null,
  unreadSessionIds: [],
  needsHistoryRefresh: false,
  historyRefreshSessionIds: [],
};

export type MobileWorkbenchAction =
  | { type: "host.selected"; hostId: string | null }
  | { type: "host.remembered"; hostId: string | null }
  | { type: "host.forgotten"; hostId: string }
  | { type: "workspace.selected"; workspaceId: string | null }
  | { type: "tab.selected"; tab: MobileWorkbenchState["activeTab"] }
  | { type: "session.active"; sessionId: string | null }
  | { type: "session.persisted"; sessionId: string; messages: MessageItem[] }
  | { type: "session.read"; sessionId: string }
  | { type: "run.started"; sessionId: string | null }
  | { type: "run.event"; subscriptionId: string; seq: number; event: RunUiEvent }
  | { type: "connection.reconnected" }
  | { type: "history.refreshed"; sessionId: string };

export function mobileWorkbenchReducer(
  state: MobileWorkbenchState,
  action: MobileWorkbenchAction,
): MobileWorkbenchState {
  switch (action.type) {
    case "host.selected":
      if (action.hostId === state.selectedHostId) return state;
      return {
        ...initialMobileWorkbenchState,
        selectedHostId: action.hostId,
        lastHostId: action.hostId ?? state.lastHostId,
      };
    case "host.remembered":
      return action.hostId === state.lastHostId
        ? state
        : { ...state, lastHostId: action.hostId };
    case "host.forgotten": {
      const wasSelected = action.hostId === state.selectedHostId;
      const wasRemembered = action.hostId === state.lastHostId;
      if (!wasSelected && !wasRemembered) return state;
      if (!wasSelected) return { ...state, lastHostId: null };
      return {
        ...initialMobileWorkbenchState,
        lastHostId: wasRemembered ? null : state.lastHostId,
      };
    }
    case "workspace.selected":
      return { ...state, workspaceId: action.workspaceId };
    case "tab.selected":
      return { ...state, activeTab: action.tab };
    case "session.active":
      return {
        ...state,
        activeSessionId: action.sessionId,
        unreadSessionIds: action.sessionId
          ? state.unreadSessionIds.filter((id) => id !== action.sessionId)
          : state.unreadSessionIds,
      };
    case "session.read":
      return { ...state, unreadSessionIds: state.unreadSessionIds.filter((id) => id !== action.sessionId) };
    case "run.started":
      return {
        ...state,
        runningSessionId: action.sessionId,
        liveEvents: [],
        liveText: "",
        pendingPermission: null,
      };
    case "run.event":
      return applyRunEvent(state, action);
    case "session.persisted":
      return applyPersistedSession(state, action.sessionId, action.messages);
    case "connection.reconnected": {
      const historyRefreshSessionIds = uniqueIds([state.activeSessionId, state.runningSessionId]);
      return { ...state, needsHistoryRefresh: historyRefreshSessionIds.length > 0, historyRefreshSessionIds };
    }
    case "history.refreshed": {
      const historyRefreshSessionIds = state.historyRefreshSessionIds.filter((id) => id !== action.sessionId);
      return {
        ...state,
        historyRefreshSessionIds,
        needsHistoryRefresh: historyRefreshSessionIds.length > 0,
      };
    }
  }
}

function applyRunEvent(
  state: MobileWorkbenchState,
  action: Extract<MobileWorkbenchAction, { type: "run.event" }>,
): MobileWorkbenchState {
  const previousSeq = state.lastSeqBySubscription[action.subscriptionId];
  if (!Number.isSafeInteger(action.seq) || action.seq < 0 || (previousSeq !== undefined && action.seq <= previousSeq)) {
    return state;
  }
  const next: MobileWorkbenchState = {
    ...state,
    lastSeqBySubscription: { ...state.lastSeqBySubscription, [action.subscriptionId]: action.seq },
    liveEvents: [...state.liveEvents, action.event].slice(-200),
  };
  if (action.event.kind === "text") {
    next.liveText = appendStreamingText(state.liveText, action.event.delta);
  } else if (action.event.kind === "session") {
    next.runningSessionId = action.event.sessionId;
  } else if (action.event.kind === "permission") {
    next.pendingPermission = action.event;
  } else if (action.event.kind === "done") {
    next.runningSessionId = action.event.sessionId;
    if (action.event.finalText && !next.liveText) next.liveText = action.event.finalText.slice(-100_000);
  }
  return next;
}

function applyPersistedSession(
  state: MobileWorkbenchState,
  sessionId: string,
  messages: MessageItem[],
): MobileWorkbenchState {
  const isRunning = state.runningSessionId === sessionId;
  return {
    ...state,
    messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
    runningSessionId: isRunning ? null : state.runningSessionId,
    liveEvents: isRunning ? [] : state.liveEvents,
    liveText: isRunning ? "" : state.liveText,
    pendingPermission: isRunning ? null : state.pendingPermission,
    unreadSessionIds: state.activeSessionId === sessionId
      ? state.unreadSessionIds.filter((id) => id !== sessionId)
      : uniqueIds([...state.unreadSessionIds, sessionId]),
  };
}

function uniqueIds(ids: Array<string | null>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}
