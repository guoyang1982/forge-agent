import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  Branches,
  createForgeMobileApi,
  PendingPermission,
  RunContext,
  Runtime,
  WorkspaceFile,
} from "../data/forge-mobile-api";
import type { ProjectItem } from "./project-sanitize";
import type { MessageAttachment, MessageItem, SessionItem } from "./session-sanitize";
import { appendStreamingText, parseRunEvents, type RunUiEvent } from "./run-event-sanitize";
import {
  buildConversationView,
  buildTimelineItems,
  type ToolView,
} from "./conversation-view";
import type { MobileWorkbenchAction } from "../state/mobile-workbench-state";
import { ForgeMark } from "../ui/components";
import { MarkdownBody } from "../ui/markdown";
import { makeStyles } from "../ui/make-styles";
import { colors, radii, spacing } from "../ui/theme";
import {
  assertAttachmentBudget,
  pasteClipboardImage,
  pickDocumentAttachments,
  pickImagesFromLibrary,
  takePhotoAttachment,
} from "../composer/pick-attachments";
import { toRpcAttachments, type PendingAttachment } from "../composer/attachment-types";
import { extractMentionedPaths, formatMentionToken } from "../composer/mentions";
import {
  speakText,
  stopSpeaking,
  textForSpeech,
} from "../voice/speech";
import {
  cancelSenseVoiceRecording,
  prepareSenseVoiceEngine,
  SENSEVOICE_WAVE_BARS,
  startSenseVoiceRecording,
  stopSenseVoiceRecordingAndTranscribe,
  subscribeSenseVoiceLevels,
} from "../voice/sensevoice-dictation";
import {
  formatSenseVoiceSizeHint,
  isSenseVoiceReady,
  subscribeSenseVoiceModel,
} from "../voice/sensevoice-model";
import {
  clearComposerDraft,
  loadComposerDraft,
  saveComposerDraft,
} from "../storage/composer-draft-store";
import {
  applyAttachmentPreviews,
  loadSessionAttachmentPreviews,
  saveSessionAttachmentPreviews,
} from "../storage/attachment-preview-cache";
import { loadComposerTipsSeen, loadLastRunContext, saveComposerTipsSeen, saveLastRunContext } from "../storage/preferences-store";
import { notifyPermissionNeeded, notifyRunFinished } from "../notifications/local-notify";

/**
 * Lift content above the software keyboard.
 * Android edge-to-edge often breaks window adjustResize, so we pad manually.
 * Subtract safe-area bottom because the app shell already insets that region.
 */
function useKeyboardLift(): number {
  const insets = useSafeAreaInsets();
  const [lift, setLift] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const onShow = (event: KeyboardEvent) => {
      setLift(Math.max(0, event.endCoordinates.height - insets.bottom));
    };
    const onHide = () => setLift(0);

    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [insets.bottom]);

  return lift;
}

type Api = ReturnType<typeof createForgeMobileApi>;

/** Fallback only for Cursor-style agents when runtime.list omits modes. */
const CURSOR_STYLE_MODES = [
  { id: "default", label: "default" },
  { id: "plan", label: "plan" },
  { id: "ask", label: "ask" },
] as const;
const COMPOSER_PLACEHOLDER = "输入问题或需求…";

function isDeviceRunLimitError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return /rate_limited|device run limit/i.test(message);
}

function formatConversationError(cause: unknown, fallback = "操作失败"): string {
  if (isDeviceRunLimitError(cause)) {
    return "当前设备已有任务在运行。请先点停止结束任务，或等待完成后再发送。";
  }
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return fallback;
}

export function ConversationScreen(props: {
  api: Api;
  hostId?: string;
  hostName: string;
  connectionState?: string;
  sessionId: string | null;
  cwd: string | null;
  runningSessionId?: string | null;
  notificationsEnabled?: boolean;
  pendingMention?: string | null;
  onConsumeMention?: () => void;
  needsHistoryRefresh: boolean;
  initialMessages?: MessageItem[];
  dispatch: (action: MobileWorkbenchAction) => void;
  onBack: () => void;
  onOpenDiff: (cwd: string, path: string) => void;
  onOpenFile?: (cwd: string, path: string) => void;
}) {
  const styles = useStyles();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>(props.initialMessages ?? []);
  const [persistedEvents, setPersistedEvents] = useState<RunUiEvent[]>([]);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
  const [oldestMessageId, setOldestMessageId] = useState<number | null>(null);
  const [oldestEventSequence, setOldestEventSequence] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [session, setSession] = useState<SessionItem | null>(
    props.sessionId && props.cwd
      ? {
          id: props.sessionId,
          cwd: props.cwd,
          updatedAt: "",
          messageCount: 0,
          lastPreview: "",
        }
      : null,
  );
  const [prompt, setPrompt] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [mentionedFiles, setMentionedFiles] = useState<string[]>([]);
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionDir, setMentionDir] = useState(".");
  const [mentionEntries, setMentionEntries] = useState<WorkspaceFile[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [dictationPreview, setDictationPreview] = useState("");
  const [voiceWave, setVoiceWave] = useState<number[]>(() =>
    Array.from({ length: SENSEVOICE_WAVE_BARS }, () => 0.08),
  );
  const [attachProgress, setAttachProgress] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<string | null>(null);
  const [sendProgress, setSendProgress] = useState<string | null>(null);
  const [retryHint, setRetryHint] = useState<string | null>(null);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const dictationBaseRef = useRef("");
  const dictationBusyRef = useRef(false);
  const pendingAttachTaskRef = useRef<(() => Promise<PendingAttachment[] | PendingAttachment | null>) | null>(null);
  const attachLaunchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftHydratedRef = useRef(false);
  const [running, setRunning] = useState(
    Boolean(props.runningSessionId && props.sessionId && props.runningSessionId === props.sessionId),
  );
  const [liveEvents, setLiveEvents] = useState<RunUiEvent[]>([]);
  const [liveText, setLiveText] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [pendingPermissionCount, setPendingPermissionCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [execOpen, setExecOpen] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const [showAllSteps, setShowAllSteps] = useState(false);
  const [picker, setPicker] = useState<"workspace" | "branch" | "agent" | "mode" | "model" | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [context, setContext] = useState<RunContext>({
    cwd: props.cwd ?? "",
    branch: null,
    provider: "",
    model: "",
    permissionMode: "",
    sandboxMode: "workspace-write",
  });
  const subscriptionRef = useRef<string | null>(null);
  const sessionIdRef = useRef(props.sessionId);
  const timelineRef = useRef<FlatList>(null);
  const handleLiveFrameRef = useRef<
    (frame: { event?: unknown; seq?: number; subscriptionId?: string }, fallbackSessionId: string) => void
  >(() => undefined);
  const historyRequestRef = useRef<{
    sessionId: string;
    promise: Promise<void>;
  } | null>(null);
  const keyboardLift = useKeyboardLift();

  useEffect(() => {
    return subscribeSenseVoiceModel((state) => {
      if (state.status === "DOWNLOADING") {
        setModelProgress(`下载语音模型 ${Math.round(state.progress?.percent ?? 0)}%…`);
        return;
      }
      if (state.status === "EXTRACTING") {
        setModelProgress("解压语音模型…");
        return;
      }
      if (state.status === "READY" || state.status === "MISSING") {
        setModelProgress(null);
        return;
      }
      if (state.status === "ERROR") {
        setModelProgress(null);
      }
    });
  }, []);

  useEffect(() => {
    if (!dictating) {
      setVoiceWave(Array.from({ length: SENSEVOICE_WAVE_BARS }, () => 0.08));
      return;
    }
    // Live mic levels from SenseVoice recording analysis (not a fake animation).
    return subscribeSenseVoiceLevels(setVoiceWave);
  }, [dictating]);

  useEffect(() => {
    return () => {
      void cancelSenseVoiceRecording();
      stopSpeaking();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const seen = await loadComposerTipsSeen();
      if (cancelled || seen) return;
      Alert.alert(
        "会话小提示",
        "可以附加图片/文件，用 @ 提及工作区文件，点麦克风离线听写（首次需下载模型），助手回复可点「朗读」。",
        [{ text: "知道了", onPress: () => void saveComposerTipsSeen(true) }],
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    draftHydratedRef.current = false;
    if (!props.hostId) return;
    let cancelled = false;
    void (async () => {
      const draft = await loadComposerDraft(props.hostId!, props.sessionId);
      if (cancelled || !draft) {
        draftHydratedRef.current = true;
        return;
      }
      if (draft.prompt) setPrompt(draft.prompt);
      if (draft.mentionedFiles.length) setMentionedFiles(draft.mentionedFiles);
      draftHydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [props.hostId, props.sessionId]);

  useEffect(() => {
    if (!props.hostId || !draftHydratedRef.current) return;
    const timer = setTimeout(() => {
      void saveComposerDraft({
        hostId: props.hostId!,
        sessionId: props.sessionId,
        prompt,
        mentionedFiles,
        updatedAt: new Date().toISOString(),
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [props.hostId, props.sessionId, prompt, mentionedFiles]);

  useEffect(() => {
    if (keyboardLift <= 0) return;
    const timer = setTimeout(() => {
      timelineRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(timer);
  }, [keyboardLift]);

  const markRunActive = useCallback((sessionId: string, status = "任务运行中…") => {
    setRunning(true);
    setRunStatus(status);
    props.dispatch({ type: "run.started", sessionId });
  }, [props]);

  const markRunIdle = useCallback(() => {
    setRunning(false);
    props.dispatch({ type: "run.started", sessionId: null });
  }, [props]);

  const attachToActiveRun = useCallback(async (sessionId: string): Promise<boolean> => {
    if (!sessionId || subscriptionRef.current) return false;
    try {
      const sub = props.api.subscribeRun(sessionId, (frame) => {
        handleLiveFrameRef.current(frame, sessionId);
      });
      subscriptionRef.current = sub.subscriptionId;
      await sub.result;
      markRunActive(sessionId, "任务仍在运行…");
      return true;
    } catch {
      if (subscriptionRef.current) {
        props.api.unsubscribe(subscriptionRef.current);
        subscriptionRef.current = null;
      }
      return false;
    }
  }, [markRunActive, props.api]);

  const applyHistoryPage = useCallback(async (
    page: {
      messages: MessageItem[];
      events: RunUiEvent[];
      truncated: boolean;
      oldestMessageId: number | null;
      oldestEventSequence: number | null;
    },
    mode: "replace" | "prepend",
    sessionIdForPreviews?: string | null,
  ) => {
    let messages = page.messages;
    if (sessionIdForPreviews) {
      const previews = await loadSessionAttachmentPreviews(sessionIdForPreviews);
      messages = applyAttachmentPreviews(page.messages, previews);
    }
    if (mode === "replace") {
      setMessages(messages);
      setPersistedEvents(page.events);
    } else {
      setMessages((current) => {
        const seen = new Set(current.map((row) => row.key));
        const older = messages.filter((row) => !seen.has(row.key));
        return [...older, ...current];
      });
      setPersistedEvents((current) => [...page.events, ...current].slice(-2_000));
    }
    setHasOlderHistory(page.truncated);
    setOldestMessageId(page.oldestMessageId);
    setOldestEventSequence(page.oldestEventSequence);
  }, []);

  const reloadMessages = useCallback((sessionId: string): Promise<void> => {
    if (historyRequestRef.current?.sessionId === sessionId) {
      return historyRequestRef.current.promise;
    }
    const promise = (async () => {
      // session.messages — first screen; older pages via session.history.page
      const history = typeof props.api.sessionHistory === "function"
        ? await props.api.sessionHistory(sessionId)
        : {
            messages: await props.api.messages(sessionId),
            events: [] as RunUiEvent[],
            truncated: false,
            oldestMessageId: null,
            oldestEventSequence: null,
          };
      await applyHistoryPage(history, "replace", sessionId);
      props.dispatch({ type: "session.persisted", sessionId, messages: history.messages });
      props.dispatch({ type: "history.refreshed", sessionId });
    })();
    historyRequestRef.current = { sessionId, promise };
    const clearRequest = () => {
      if (historyRequestRef.current?.promise === promise) historyRequestRef.current = null;
    };
    void promise.then(clearRequest, clearRequest);
    return promise;
  }, [applyHistoryPage, props]);

  const loadOlderHistory = useCallback(async () => {
    if (!props.sessionId || loadingOlder || !hasOlderHistory) return;
    if (oldestMessageId == null && oldestEventSequence == null) return;
    if (typeof props.api.sessionHistoryPage !== "function") {
      setHasOlderHistory(false);
      return;
    }
    setLoadingOlder(true);
    setError("");
    try {
      const page = await props.api.sessionHistoryPage(props.sessionId, {
        beforeMessageId: oldestMessageId,
        beforeEventSequence: oldestEventSequence,
      });
      await applyHistoryPage(page, "prepend", props.sessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载更早历史失败");
    } finally {
      setLoadingOlder(false);
    }
  }, [
    applyHistoryPage,
    hasOlderHistory,
    loadingOlder,
    oldestEventSequence,
    oldestMessageId,
    props,
  ]);

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      let runtimeError = "";
      const loadRuntimes = async (cwd: string): Promise<Runtime[]> => {
        try {
          return await props.api.runtimes(cwd || undefined);
        } catch {
          // Older gateways reject runtime.list with cwd — retry with empty params.
          try {
            return await props.api.runtimes();
          } catch (retryCause) {
            runtimeError = retryCause instanceof Error ? retryCause.message : "加载 Agent 失败";
            return [];
          }
        }
      };
      const loadBranches = (cwd: string): Promise<Branches | null> => cwd
        ? props.api.branches(cwd).catch(() => ({
            isRepo: false,
            current: null,
            detached: false,
            dirty: false,
            branches: [],
          } satisfies Branches))
        : Promise.resolve(null);
      const knownCwd = props.cwd || "";
      const projectsPromise = props.api.projects();
      const historyPromise = props.sessionId
        ? reloadMessages(props.sessionId)
        : Promise.resolve();
      const permissionPromise = props.sessionId
        ? props.api.pendingPermissions(props.sessionId)
        : Promise.resolve([] as PendingPermission[]);
      const sessionBootstrapPromise = Promise.all([historyPromise, permissionPromise]);
      // Projects may fail first; keep the already-started session requests observed.
      void sessionBootstrapPromise.catch(() => undefined);
      const eagerRuntimesPromise = knownCwd ? loadRuntimes(knownCwd) : null;
      const eagerBranchesPromise = knownCwd ? loadBranches(knownCwd) : null;
      const nextProjects = await projectsPromise;
      setProjects(nextProjects);
      const cwd = knownCwd || nextProjects[0]?.path || "";

      const [nextRuntimes, [, pending]] = await Promise.all([
        eagerRuntimesPromise ?? loadRuntimes(cwd),
        sessionBootstrapPromise,
      ]);
      setPermission(pending[0] ?? null);
      setPendingPermissionCount(pending.length);
      setRuntimes(nextRuntimes);
      const preferred = nextRuntimes.find((item) => item.available) || nextRuntimes[0];
      const remembered = props.hostId ? await loadLastRunContext(props.hostId) : null;
      const provider = remembered?.provider
        && nextRuntimes.some((item) => item.provider === remembered.provider)
        ? remembered.provider
        : (preferred?.provider || "");
      const runtime = nextRuntimes.find((item) => item.provider === provider) || preferred;
      const model = remembered?.model && runtime?.models.includes(remembered.model)
        ? remembered.model
        : (runtime?.models[0] || "");
      const permissionMode = remembered?.permissionMode && runtime?.modes.some((mode) => mode.id === remembered.permissionMode)
        ? remembered.permissionMode
        : (runtime?.modes[0]?.id || "");
      const rememberedCwd = remembered?.cwd
        && nextProjects.some((item) => item.path === remembered.cwd)
        ? remembered.cwd
        : cwd;
      setContext({
        cwd: rememberedCwd || cwd,
        branch: null,
        provider,
        model,
        permissionMode,
        sandboxMode: "workspace-write",
      });

      const branchInfo = await (eagerBranchesPromise ?? loadBranches(cwd));
      if (branchInfo) {
        setBranches(branchInfo);
        setContext((current) => ({ ...current, branch: branchInfo.current }));
      }
      if (runtimeError) {
        setError(runtimeError);
      } else if (nextRuntimes.length === 0) {
        setError("未获取到 Agent 列表。请在电脑端重新编译并重启 Channel Gateway 后再试。");
      }
      if (props.sessionId) {
        await attachToActiveRun(props.sessionId);
      }
    } catch (cause) {
      setError(formatConversationError(cause, "加载失败"));
    } finally {
      setLoading(false);
    }
  }, [attachToActiveRun, props, reloadMessages]);

  useEffect(() => {
    void loadBootstrap();
    return () => {
      if (subscriptionRef.current) {
        props.api.unsubscribe(subscriptionRef.current);
        subscriptionRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount bootstrap once per conversation open

  useEffect(() => {
    if (!props.hostId) return;
    if (!context.cwd && !context.provider) return;
    void saveLastRunContext(props.hostId, {
      cwd: context.cwd || undefined,
      provider: context.provider || undefined,
      model: context.model || undefined,
      permissionMode: context.permissionMode || undefined,
    });
  }, [props.hostId, context.cwd, context.provider, context.model, context.permissionMode]);

  useEffect(() => {
    if (!props.pendingMention?.trim()) return;
    const mention = props.pendingMention.trim();
    setPrompt((current) => {
      const token = `\`${mention}\``;
      if (current.includes(token) || current.includes(mention)) return current;
      return current.trim() ? `${current.trim()} ${token} ` : `${token} `;
    });
    props.onConsumeMention?.();
  }, [props.pendingMention, props.onConsumeMention]);

  useEffect(() => {
    sessionIdRef.current = props.sessionId;
    if (props.sessionId) {
      setSession((current) => current ? { ...current, id: props.sessionId! } : {
        id: props.sessionId!,
        cwd: props.cwd || context.cwd,
        updatedAt: "",
        messageCount: 0,
        lastPreview: "",
      });
    }
  }, [props.sessionId, props.cwd, context.cwd]);

  useEffect(() => {
    if (
      props.runningSessionId
      && props.sessionId
      && props.runningSessionId === props.sessionId
    ) {
      setRunning(true);
    }
  }, [props.runningSessionId, props.sessionId]);

  useEffect(() => {
    if (!props.needsHistoryRefresh || !props.sessionId) return;
    void (async () => {
      try {
        await reloadMessages(props.sessionId!);
        // permission.pending — restore sticky card after reconnect
        const pending = await props.api.pendingPermissions(props.sessionId!);
        setPermission(pending[0] ?? null);
        setPendingPermissionCount(pending.length);
        const attached = await attachToActiveRun(props.sessionId!);
        if (!attached) {
          await reloadMessages(props.sessionId!);
        }
      } catch (cause) {
        setError(formatConversationError(cause, "恢复历史失败"));
      }
    })();
  }, [props.needsHistoryRefresh, props.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLiveFrame = (frame: { event?: unknown; seq?: number; subscriptionId?: string }, fallbackSessionId: string) => {
    const events = parseRunEvents(frame.event);
    if (!events.length) return;
    const subscriptionId = typeof frame.subscriptionId === "string" ? frame.subscriptionId : "local";
    const seq = typeof frame.seq === "number" ? frame.seq : Date.now();
    for (const event of events) {
      props.dispatch({ type: "run.event", subscriptionId, seq, event });
    }
    setLiveEvents((current) => [...current, ...events].slice(-200));
    for (const event of events) {
      if (event.kind === "session") {
        sessionIdRef.current = event.sessionId;
        setSession((current) => current ? { ...current, id: event.sessionId } : current);
        props.dispatch({ type: "session.active", sessionId: event.sessionId });
      } else if (event.kind === "text") {
        setLiveText((current) => appendStreamingText(current, event.delta));
      } else if (event.kind === "status") {
        setRunStatus(event.label);
      } else if (event.kind === "thinking") {
        // Status pill keeps the latest short status; thinking body uses event stream.
        if (event.text.trim().length <= 80) setRunStatus(event.text.trim());
      } else if (event.kind === "permission") {
        const sessionId = event.sessionId || sessionIdRef.current || fallbackSessionId;
        if (sessionId) {
          setPermission({
            requestId: event.requestId,
            sessionId,
            summary: event.summary,
            options: event.options,
          });
          setPendingPermissionCount((count) => Math.max(1, count));
          if (props.notificationsEnabled !== false) {
            void notifyPermissionNeeded(event.summary);
          }
        }
      } else if (event.kind === "done") {
        sessionIdRef.current = event.sessionId;
        setSession((current) => current ? { ...current, id: event.sessionId } : current);
        if (event.finalText) {
          setLiveText((current) => current || event.finalText || "");
        }
        setRunStatus("已完成");
        setExecOpen(false);
        setCompletedOpen(false);
        markRunIdle();
        if (props.notificationsEnabled !== false) {
          void notifyRunFinished(event.finalText || "Forge Agent 已结束本轮运行");
        }
      } else if (event.kind === "error") {
        setRunStatus(event.message);
        setError(formatConversationError(new Error(event.message), event.message));
        markRunIdle();
      }
    }
  };
  handleLiveFrameRef.current = handleLiveFrame;

  const refreshBranches = async (cwd: string) => {
    const branchInfo = await props.api.branches(cwd);
    setBranches(branchInfo);
    setContext((current) => ({ ...current, cwd, branch: branchInfo.current }));
  };

  const switchBranch = async (branch: string, confirmDirty = false) => {
    if (running) {
      Alert.alert("无法切换", "任务运行中禁止切换分支。");
      return;
    }
    try {
      const result = await props.api.switchBranch(context.cwd, branch, confirmDirty);
      if (!result.ok && result.message === "WORKTREE_DIRTY") {
        Alert.alert(
          "工作区有未提交修改",
          "切换分支可能影响未提交文件。确认继续？",
          [
            { text: "取消", style: "cancel" },
            { text: "仍要切换", style: "destructive", onPress: () => void switchBranch(branch, true) },
          ],
        );
        return;
      }
      if (!result.ok) {
        Alert.alert("切换失败", result.message || "无法切换分支");
        return;
      }
      setMessages((current) => [
        ...current,
        { key: `system:branch:${Date.now()}`, role: "system", text: `已切换到分支 ${result.current || branch}` },
      ]);
      await refreshBranches(context.cwd);
      setPicker(null);
    } catch (cause) {
      Alert.alert("切换失败", cause instanceof Error ? cause.message : "无法切换分支");
    }
  };

  const cancelRun = async (explicitSessionId?: string) => {
    const sessionId = explicitSessionId || sessionIdRef.current || session?.id;
    if (!sessionId) {
      setError("会话尚未就绪，请稍后再停止");
      return;
    }
    setRunStatus("正在停止…");
    try {
      // run.cancel — daemon abort for this session (cross-device via shared cancel_run)
      await props.api.cancelRun(sessionId);
      markRunIdle();
      setRunStatus("已停止");
      setError("");
    } catch (cause) {
      const message = formatConversationError(cause, "停止失败");
      setError(message);
      setRunStatus("停止失败");
      Alert.alert("停止失败", message);
    }
  };

  const startRun = async (newSession: boolean) => {
    const message = prompt.trim() || (pendingAttachments.length ? "请查看附件" : "");
    if (!context.cwd || (!message && !pendingAttachments.length && !mentionedFiles.length) || running) return;
    if (!context.provider.trim()) {
      setError("请先选择 Agent（点击下方 Agent 芯片）");
      setPicker("agent");
      return;
    }
    let attachmentsPayload: ReturnType<typeof toRpcAttachments> = [];
    try {
      assertAttachmentBudget(pendingAttachments);
      attachmentsPayload = toRpcAttachments(pendingAttachments);
    } catch (cause) {
      Alert.alert("附件无效", cause instanceof Error ? cause.message : "请减少附件后重试");
      return;
    }
    const files = Array.from(new Set([
      ...mentionedFiles,
      ...extractMentionedPaths(message),
    ])).slice(0, 20);
    const continuingSessionId = !newSession && session?.id ? session.id : null;
    const draftKey = `draft:user:${Date.now()}`;
    const draftAttachments = pendingAttachments.map((item) => ({
      kind: item.kind,
      name: item.name,
      ...(item.localUri ? { localUri: item.localUri } : {}),
    }));
    if (newSession || !session) {
      setSession({
        id: continuingSessionId ?? "",
        cwd: context.cwd,
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        lastPreview: message,
      });
      setMessages([{
        key: draftKey,
        role: "user",
        text: message,
        ...(draftAttachments.length ? { attachments: draftAttachments } : {}),
      }]);
    } else {
      setMessages((current) => [
        ...current,
        {
          key: draftKey,
          role: "user",
          text: message,
          ...(draftAttachments.length ? { attachments: draftAttachments } : {}),
        },
      ]);
    }
    const savedPrompt = prompt;
    const savedMentions = mentionedFiles;
    setPrompt("");
    setPendingAttachments([]);
    setMentionedFiles([]);
    setRetryHint(null);
    setSendProgress(
      attachmentsPayload.length || files.length
        ? "正在发送…"
        : null,
    );
    setRunning(true);
    setLiveEvents([]);
    setLiveText("");
    setPermission(null);
    setThinkingOpen(true);
    setExecOpen(true);
    setCompletedOpen(false);
    setFilesOpen(true);
    setShowAllSteps(false);
    setPersistedEvents([]);
    setRunStatus("思考中…");
    setError("");
    props.dispatch({ type: "run.started", sessionId: continuingSessionId });
    const run = props.api.startRun(
      context,
      {
        message,
        sessionId: continuingSessionId,
        ...(attachmentsPayload.length ? { attachments: attachmentsPayload } : {}),
        ...(files.length ? { files } : {}),
      },
      (frame) => handleLiveFrame(frame, continuingSessionId || ""),
    );
    subscriptionRef.current = run.subscriptionId;
    let retainRunningUi = false;
    let resumeSessionId: string | null = null;
    try {
      await run.result;
      const finalId = sessionIdRef.current;
      if (finalId && draftAttachments.length) {
        void saveSessionAttachmentPreviews(
          finalId,
          draftAttachments.map((item) => ({
            kind: item.kind,
            name: item.name,
            ...(item.localUri ? { localUri: item.localUri } : {}),
          })),
        );
      }
      if (props.hostId) {
        void clearComposerDraft(props.hostId, finalId || continuingSessionId);
      }
      if (finalId) {
        await reloadMessages(finalId);
      }
    } catch (cause) {
      const messageText = formatConversationError(cause, "运行失败");
      setError(messageText);
      setRetryHint(messageText);
      setPrompt(savedPrompt);
      setMentionedFiles(savedMentions);
      if (props.hostId) {
        void saveComposerDraft({
          hostId: props.hostId,
          sessionId: continuingSessionId,
          prompt: savedPrompt,
          mentionedFiles: savedMentions,
          updatedAt: new Date().toISOString(),
        });
      }
      // Drop the optimistic bubble so a retry does not stack duplicates.
      setMessages((current) => current.filter((item) => item.key !== draftKey));
      const finalId = sessionIdRef.current || session?.id || continuingSessionId;
      if (isDeviceRunLimitError(cause) && finalId) {
        // Server still holds a live run — restore stop UI instead of looking idle.
        retainRunningUi = true;
        resumeSessionId = finalId;
        markRunActive(finalId, "另一任务仍在运行…");
        Alert.alert("无法开始新任务", messageText, [
          { text: "知道了", style: "cancel" },
          {
            text: "停止当前任务",
            style: "destructive",
            onPress: () => void cancelRun(finalId),
          },
        ]);
      }
      if (finalId) {
        try {
          await reloadMessages(finalId);
          // User message may already be persisted — leave composer empty.
        } catch {
          setPrompt(savedPrompt);
        }
      }
    } finally {
      if (subscriptionRef.current) props.api.unsubscribe(subscriptionRef.current);
      subscriptionRef.current = null;
      // Always drop the live answer once the run ends — timeline uses persisted messages.
      setLiveText("");
      setSendProgress(null);
      if (!retainRunningUi) {
        setRunning(false);
        props.dispatch({ type: "run.started", sessionId: null });
      } else if (resumeSessionId) {
        void attachToActiveRun(resumeSessionId);
      }
    }
  };

  const respondPermission = async (approved: boolean, optionId?: string) => {
    if (!permission) return;
    try {
      await props.api.respondPermission({
        requestId: permission.requestId,
        sessionId: permission.sessionId,
        approved,
        ...(optionId ? { optionId } : {}),
      });
      setPermission(null);
      setPendingPermissionCount((count) => Math.max(0, count - 1));
      setRunStatus(approved ? "已允许一次，继续运行…" : "已拒绝，等待 Agent 处理…");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "权限响应失败");
    }
  };

  const selectedRuntime = runtimes.find((item) => item.provider === context.provider);
  const title = session?.lastPreview
    || messages.find((item) => item.role === "user")?.text
    || "新会话";
  const workspaceName = basename(context.cwd) || "未选择工作空间";
  const agentLabel = selectedRuntime?.label || context.provider || "选择 Agent";
  const modelLabel = context.model || (selectedRuntime?.models[0] ? selectedRuntime.models[0] : "默认模型");
  const modeLabel =
    selectedRuntime?.modes.find((mode) => mode.id === context.permissionMode)?.label
    || context.permissionMode
    || (selectedRuntime?.modes[0]?.label ?? "默认");
  const modeChoices = selectedRuntime?.modes.length
    ? selectedRuntime.modes
    : selectedRuntime?.provider === "cursor"
      ? [...CURSOR_STYLE_MODES]
      : [];

  const viewModel = useMemo(
    () => buildConversationView(messages, liveEvents, liveText, runStatus, running, persistedEvents),
    [messages, liveEvents, liveText, runStatus, running, persistedEvents],
  );

  const timelineItems = useMemo(
    () => buildTimelineItems(messages, running, viewModel.tools),
    [messages, running, viewModel.tools],
  );

  const connected = !props.connectionState || props.connectionState === "authenticated";
  const canSend = Boolean(
    (prompt.trim() || pendingAttachments.length > 0 || mentionedFiles.length > 0)
      && context.cwd
      && !running
      && connected,
  );

  const openMentionPicker = async () => {
    if (!context.cwd) {
      Alert.alert("未选择工作空间", "请先选择工作空间");
      return;
    }
    setMentionOpen(true);
    setMentionDir(".");
    await loadMentionDir(".");
  };

  const loadMentionDir = async (path: string) => {
    if (!context.cwd) return;
    setMentionLoading(true);
    try {
      const entries = await props.api.files(context.cwd, path);
      setMentionDir(path);
      setMentionEntries(entries);
    } catch (cause) {
      Alert.alert("无法打开目录", cause instanceof Error ? cause.message : "读取失败");
    } finally {
      setMentionLoading(false);
    }
  };

  const insertMention = (path: string) => {
    const token = formatMentionToken(path);
    setMentionedFiles((current) => (current.includes(path) ? current : [...current, path].slice(0, 20)));
    setPrompt((current) => {
      if (current.includes(token)) return current;
      return current.trim() ? `${current.trim()} ${token} ` : `${token} `;
    });
    setMentionOpen(false);
  };

  const addAttachments = (items: PendingAttachment[]) => {
    if (!items.length) return;
    setPendingAttachments((current) => {
      const next = [...current, ...items].slice(0, 5);
      try {
        assertAttachmentBudget(next);
        return next;
      } catch (cause) {
        Alert.alert("附件超限", cause instanceof Error ? cause.message : "请减少附件");
        return current;
      }
    });
  };

  const runAttachTask = async (task: () => Promise<PendingAttachment[] | PendingAttachment | null>) => {
    try {
      const result = await task();
      if (!result) return;
      if (Array.isArray(result) && result.length === 0) {
        Alert.alert("未添加附件", "你还没有选择文件或图片。");
        return;
      }
      addAttachments(Array.isArray(result) ? result : [result]);
    } catch (cause) {
      Alert.alert("添加失败", cause instanceof Error ? cause.message : "无法添加附件");
    } finally {
      setAttachProgress(null);
    }
  };

  /** Android ImagePicker/Camera often no-ops if launched while a Modal is still dismissing. */
  const queueAttachTask = (task: () => Promise<PendingAttachment[] | PendingAttachment | null>) => {
    pendingAttachTaskRef.current = task;
    setAttachSheetOpen(false);
    if (attachLaunchTimerRef.current) clearTimeout(attachLaunchTimerRef.current);
    attachLaunchTimerRef.current = setTimeout(() => {
      attachLaunchTimerRef.current = null;
      const next = pendingAttachTaskRef.current;
      pendingAttachTaskRef.current = null;
      if (next) void runAttachTask(next);
    }, Platform.OS === "android" ? 700 : 80);
  };

  const startSenseVoiceSession = async () => {
    if (dictating || running || dictationBusyRef.current) return;
    dictationBusyRef.current = true;
    try {
      dictationBaseRef.current = prompt;
      setDictationPreview("");
      setModelProgress("准备语音模型…");
      await prepareSenseVoiceEngine((percent, status) => {
        setModelProgress(`${status} ${percent}%`);
      });
      setModelProgress(null);
      setDictating(true);
      setDictationPreview("听写中，点话筒结束");
      await startSenseVoiceRecording();
    } catch (cause) {
      setDictating(false);
      setDictationPreview("");
      setModelProgress(null);
      Alert.alert("无法听写", cause instanceof Error ? cause.message : "请检查麦克风权限");
    } finally {
      dictationBusyRef.current = false;
    }
  };

  const beginDictation = async () => {
    if (dictating || running || dictationBusyRef.current) return;
    const ready = await isSenseVoiceReady();
    if (ready) {
      await startSenseVoiceSession();
      return;
    }
    Alert.alert(
      "下载离线语音模型",
      `首次听写需要下载 SenseVoice 模型（${formatSenseVoiceSizeHint()}）。下载后可离线使用，无需 Google 语音服务。`,
      [
        { text: "取消", style: "cancel" },
        { text: "开始下载", onPress: () => void startSenseVoiceSession() },
      ],
    );
  };

  const endDictation = async () => {
    if (!dictating || dictationBusyRef.current) return;
    dictationBusyRef.current = true;
    setDictating(false);
    setDictationPreview("识别中…");
    setModelProgress("识别中…");
    try {
      const transcript = await stopSenseVoiceRecordingAndTranscribe();
      if (transcript) {
        const base = dictationBaseRef.current.trim();
        const next = base ? `${base} ${transcript}` : transcript;
        setPrompt(next);
        dictationBaseRef.current = next;
      } else {
        Alert.alert("未识别到语音", "没有听清内容，请靠近麦克风再说一次");
      }
    } catch (cause) {
      Alert.alert("听写失败", cause instanceof Error ? cause.message : "识别失败，请重试");
    } finally {
      setDictationPreview("");
      setModelProgress(null);
      dictationBusyRef.current = false;
    }
  };

  const toggleDictation = () => {
    if (dictating) void endDictation();
    else void beginDictation();
  };

  const toggleSpeak = (key: string, text: string) => {
    if (speakingKey === key) {
      stopSpeaking();
      setSpeakingKey(null);
      return;
    }
    const spoken = textForSpeech(text);
    if (!spoken) {
      Alert.alert("无法朗读", "这段内容没有可朗读的文字");
      return;
    }
    setSpeakingKey(key);
    speakText(spoken, {
      onDone: () => setSpeakingKey((current) => (current === key ? null : current)),
    });
  };
  const statusPillLabel = running
    ? (runStatus && runStatus !== "已完成" ? runStatus : "思考中…")
    : "";

  const renderFileCards = (files: typeof viewModel.files) => files.map((file) => (
    <Pressable
      key={file.key}
      style={styles.fileCard}
      onPress={() => {
        if (!context.cwd) return;
        if (props.onOpenFile) props.onOpenFile(context.cwd, file.path);
        else props.onOpenDiff(context.cwd, file.path);
      }}
      onLongPress={() => context.cwd && props.onOpenDiff(context.cwd, file.path)}
    >
      <View style={styles.fileGlyph}>
        <Text style={styles.fileGlyphMark}>▤</Text>
      </View>
      <View style={styles.fileCopy}>
        <View style={styles.fileTitleRow}>
          <Text style={styles.filePath} numberOfLines={1}>{file.path}</Text>
          {(file.additions !== undefined || file.deletions !== undefined) ? (
            <Text style={styles.fileStats}>
              {file.additions !== undefined ? (
                <Text style={styles.fileAdd}>+{file.additions}</Text>
              ) : null}
              {file.additions !== undefined && file.deletions !== undefined ? " " : null}
              {file.deletions !== undefined ? (
                <Text style={styles.fileDel}>-{file.deletions}</Text>
              ) : null}
            </Text>
          ) : null}
        </View>
        <Text style={styles.fileSummary} numberOfLines={2}>
          {file.summary
            || (file.status === "added"
              ? "新增文件"
              : file.status === "deleted"
                ? "删除文件"
                : "修改文件")}
        </Text>
      </View>
      <Text style={styles.fileChevron}>›</Text>
    </Pressable>
  ));

  const renderExecTimeline = (tools: ToolView[]) => {
    const visibleTools = showAllSteps ? tools : tools.slice(0, 3);
    return (
      <View style={styles.execTimeline}>
        {visibleTools.map((tool, index) => {
          const open = expandedTools[tool.callId] ?? tool.status === "running";
          const waiting = Boolean(permission) && tool.status === "running";
          return (
            <View key={tool.key} style={styles.execStep}>
              <View style={styles.execRail}>
                <View style={[
                  styles.execDot,
                  tool.status === "done" ? styles.execDotDone
                    : waiting ? styles.execDotWait
                      : styles.execDotRun,
                ]} />
                {index < visibleTools.length - 1 ? <View style={styles.execLine} /> : null}
              </View>
              <Pressable
                style={styles.toolCard}
                onPress={() => setExpandedTools((current) => ({
                  ...current,
                  [tool.callId]: !open,
                }))}
              >
                <View style={styles.toolHead}>
                  <Text style={styles.toolTitle} numberOfLines={1}>{tool.name}</Text>
                  <Text style={[
                    styles.toolStatus,
                    tool.status === "done" ? styles.toolStatusDone
                      : waiting ? styles.toolStatusWait
                        : styles.toolStatusRun,
                  ]}>
                    {tool.status === "done" ? "✓ 已完成"
                      : waiting ? "等待中"
                        : "● 运行中"}
                  </Text>
                </View>
                {tool.detail ? (
                  <Text style={styles.toolDetail} numberOfLines={2}>{tool.detail}</Text>
                ) : null}
                {open && tool.output ? (
                  <Text style={styles.toolOutput}>{tool.output}</Text>
                ) : null}
              </Pressable>
            </View>
          );
        })}
        {tools.length > 3 ? (
          <Pressable style={styles.viewAllButton} onPress={() => setShowAllSteps((value) => !value)}>
            <Text style={styles.viewAll}>
              {showAllSteps ? "收起步骤" : `查看全部 ${tools.length} 步`}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  const renderAgentSections = (options: {
    includeAnswer: boolean;
    answers: string[];
    showRuntime: boolean;
    tools: ToolView[];
  }) => {
    const tools = options.tools;
    const files = options.showRuntime ? viewModel.files : [];
    const showCompletedPill = !running && options.showRuntime
      && (tools.length > 0 || files.length > 0 || options.answers.length > 0);
    const showExec = options.showRuntime && tools.length > 0
      && (running || completedOpen || execOpen);

    return (
      <View style={styles.agentTurn}>
        <View style={styles.agentIdentity}>
          <ForgeMark size="sm" />
          <View style={styles.agentIdentityCopy}>
            <Text style={styles.agentName}>{agentLabel || "Forge Agent"}</Text>
            {!running && !showCompletedPill ? (
              <Text style={styles.agentMeta}>{props.hostName}</Text>
            ) : null}
          </View>
          {running && options.showRuntime ? <ActivityIndicator color={colors.brand} /> : null}
        </View>

        {running && options.showRuntime ? (
          <View style={styles.statusPill}>
            <Text style={styles.statusPillText}>ⓘ {statusPillLabel}</Text>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : null}

        {showCompletedPill ? (
          <Pressable
            style={styles.completedPill}
            onPress={() => {
              setCompletedOpen((value) => !value);
              setExecOpen((value) => !value);
            }}
            accessibilityRole="button"
            accessibilityLabel={completedOpen ? "收起执行过程" : "展开执行过程"}
          >
            <Text style={styles.completedPillText}>✓ {viewModel.completedSummary}</Text>
            <Text style={styles.completedPillChevron}>{completedOpen ? "▴" : "▾"}</Text>
          </Pressable>
        ) : null}

        {running && options.showRuntime && viewModel.thinking.length > 0 ? (
          <View style={styles.sectionCard}>
            <Pressable style={styles.sectionHead} onPress={() => setThinkingOpen((value) => !value)}>
              <Text style={styles.sectionTitle}>思考过程</Text>
              <Text style={styles.sectionChevron}>{thinkingOpen ? "▴" : "▾"}</Text>
            </Pressable>
            {thinkingOpen ? (
              <View style={styles.thinkingBody}>
                {viewModel.thinking.map((line, index) => (
                  <Text key={`${index}:${line.slice(0, 24)}`} style={styles.thinkingLine}>
                    · {line}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {showExec ? (
          <View style={styles.execSection}>
            <Pressable
              style={styles.sectionHead}
              onPress={() => {
                if (running) setExecOpen((value) => !value);
                else {
                  setCompletedOpen((value) => !value);
                  setExecOpen((value) => !value);
                }
              }}
            >
              <Text style={styles.sectionTitle}>
                {running
                  ? `执行过程  进行中 (${tools.length}步)`
                  : `执行过程 (${tools.length}步)`}
              </Text>
              <Text style={styles.sectionChevron}>{showExec ? "▴" : "▾"}</Text>
            </Pressable>
            {renderExecTimeline(tools)}
          </View>
        ) : null}

        {running && options.showRuntime && files.length > 0 ? (
          <View style={styles.sectionCard}>
            <Pressable style={styles.sectionHead} onPress={() => setFilesOpen((value) => !value)}>
              <Text style={styles.sectionTitle}>
                {`文件变更 (${files.length}个)`}
              </Text>
              <Text style={styles.sectionChevron}>{filesOpen ? "▴" : "▾"}</Text>
            </Pressable>
            {filesOpen ? renderFileCards(files) : null}
          </View>
        ) : null}

        {options.includeAnswer
          ? options.answers.filter(Boolean).map((text, index) => {
            const speakKey = `speak:${index}:${text.slice(0, 24)}`;
            return (
              <View key={`answer:${index}:${text.slice(0, 16)}`} style={styles.answerBlock}>
                <MarkdownBody text={text} />
                {!running && options.showRuntime ? (
                  <View style={styles.answerActions}>
                    <Pressable
                      style={[styles.copyAction, speakingKey === speakKey ? styles.copyActionActive : null]}
                      onPress={() => toggleSpeak(speakKey, text)}
                    >
                      <Text style={styles.copyActionText}>
                        {speakingKey === speakKey ? "停止朗读" : "朗读"}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={styles.copyAction}
                      onPress={() => void Share.share({ message: text })}
                    >
                      <Text style={styles.copyActionText}>复制</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          })
          : null}

        {!running && options.showRuntime && files.length > 0 ? (
          <View style={styles.resultCard}>
            <Text style={styles.resultTitle}>变更文件</Text>
            {files.map((file) => (
              <Pressable
                key={`done:${file.key}`}
                style={styles.resultFileRow}
                onPress={() => {
                  if (!context.cwd) return;
                  if (props.onOpenFile) props.onOpenFile(context.cwd, file.path);
                  else props.onOpenDiff(context.cwd, file.path);
                }}
                onLongPress={() => context.cwd && props.onOpenDiff(context.cwd, file.path)}
              >
                <Text style={styles.resultFilePath} numberOfLines={1}>{file.path}</Text>
                <Text style={styles.fileStats}>
                  {file.additions !== undefined ? (
                    <Text style={styles.fileAdd}>+{file.additions}</Text>
                  ) : null}
                  {file.additions !== undefined && file.deletions !== undefined ? " " : null}
                  {file.deletions !== undefined ? (
                    <Text style={styles.fileDel}>-{file.deletions}</Text>
                  ) : null}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {!running && options.showRuntime && viewModel.keyChanges.length > 0 ? (
          <View style={styles.resultCard}>
            <Text style={styles.resultTitle}>关键改动</Text>
            {viewModel.keyChanges.map((line, index) => (
              <Text key={`key:${index}`} style={styles.resultBullet}>· {line}</Text>
            ))}
          </View>
        ) : null}

        {!running && options.showRuntime && viewModel.verifications.length > 0 ? (
          <View style={styles.resultCard}>
            <Text style={styles.resultTitle}>验证结果</Text>
            {viewModel.verifications.map((item, index) => (
              <Text key={`verify:${index}`} style={styles.resultVerify}>
                ✓ {item.command}
                <Text style={styles.resultVerifyOk}>  {item.result}</Text>
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    );
  };

  const renderPermissionBody = () => {
    if (!permission) return null;
    return (
      <>
        <View style={styles.permissionHead}>
          <Text style={styles.permissionTitle}>需要你的确认</Text>
          <View style={styles.permissionBadge}>
            <Text style={styles.permissionBadgeText}>
              权限{pendingPermissionCount > 1 ? ` · ${pendingPermissionCount}` : ""}
            </Text>
          </View>
        </View>
        <Text style={styles.permissionLead}>即将执行以下操作</Text>
        <View style={styles.permissionCommand}>
          <Text style={styles.permissionSummary}>{permission.summary}</Text>
        </View>
        {context.cwd ? (
          <Text style={styles.permissionMeta}>工作目录 · {context.cwd}</Text>
        ) : null}
        <View style={styles.permissionWarn}>
          <Text style={styles.permissionWarnText}>此操作可能修改项目文件或依赖，请确认后再允许。</Text>
        </View>
        <View style={styles.permissionActions}>
          {permission.options.length > 0 ? (
            permission.options.map((option) => (
              <Pressable
                key={option.optionId}
                style={option.allow ? styles.allowButton : styles.denyButton}
                onPress={() => void respondPermission(option.allow, option.optionId)}
              >
                <Text style={option.allow ? styles.allowButtonText : styles.denyButtonText}>
                  {option.name}
                </Text>
              </Pressable>
            ))
          ) : (
            <>
              <Pressable style={styles.denyButton} onPress={() => void respondPermission(false)}>
                <Text style={styles.denyButtonText}>拒绝</Text>
              </Pressable>
              <Pressable style={styles.allowButton} onPress={() => void respondPermission(true)}>
                <Text style={styles.allowButtonText}>允许一次</Text>
              </Pressable>
            </>
          )}
        </View>
      </>
    );
  };

  return (
    <View style={[styles.page, keyboardLift > 0 ? { paddingBottom: keyboardLift } : null]}>
      <View style={styles.header}>
        <Pressable style={styles.back} onPress={props.onBack} accessibilityLabel="返回会话列表">
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <View style={styles.headerMetaRow}>
            <ForgeMark size="xs" />
            <Text style={styles.meta} numberOfLines={1}>
              {workspaceName}
              {props.connectionState === "authenticated" ? "" : " · 重连中"}
            </Text>
          </View>
        </View>
        <Pressable
          style={styles.menuButton}
          accessibilityLabel="更多"
          onPress={() => setMenuOpen(true)}
        >
          <Text style={styles.menuGlyph}>⋮</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {retryHint ? (
        <Pressable
          style={styles.retryBanner}
          onPress={() => {
            setRetryHint(null);
            void startRun(!session?.id);
          }}
        >
          <Text style={styles.retryBannerText}>发送失败，点此重试：{retryHint}</Text>
        </Pressable>
      ) : null}
      {props.connectionState && props.connectionState !== "authenticated" ? (
        <Text style={styles.reconnectHint}>
          {props.connectionState === "connecting" ? "正在重连电脑…" : "连接已断开，重连后可发送"}
        </Text>
      ) : null}
      {loading && messages.length === 0 ? <ActivityIndicator color={colors.brand} style={styles.loader} /> : null}

      <FlatList
        ref={timelineRef}
        style={styles.timelineList}
        data={timelineItems}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.timeline}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        ListHeaderComponent={
          hasOlderHistory ? (
            <Pressable
              style={styles.loadOlder}
              onPress={() => void loadOlderHistory()}
              disabled={loadingOlder}
            >
              {loadingOlder ? (
                <ActivityIndicator color={colors.brand} />
              ) : (
                <Text style={styles.loadOlderText}>加载更早的消息</Text>
              )}
            </Pressable>
          ) : null
        }
        ListFooterComponent={
          running ? (
            renderAgentSections({
              includeAnswer: true,
              answers: viewModel.liveAssistant ? [viewModel.liveAssistant] : [],
              showRuntime: true,
              tools: viewModel.tools,
            })
          ) : null
        }
        renderItem={({ item }) => {
          if (item.kind === "user") {
            return (
              <View style={styles.userBubble}>
                {item.attachments?.length ? (
                  <View style={styles.attachmentRow}>
                    {item.attachments.map((att: MessageAttachment, index: number) => (
                      att.kind === "image" && att.localUri ? (
                        <Image
                          key={`${item.key}:img:${index}`}
                          source={{ uri: att.localUri }}
                          style={styles.attachmentThumb}
                        />
                      ) : (
                        <View
                          key={`${item.key}:file:${index}`}
                          style={[
                            styles.attachmentChip,
                            att.kind === "image" ? styles.attachmentImagePlaceholder : null,
                          ]}
                        >
                          <Text style={styles.attachmentChipText} numberOfLines={1}>
                            {att.kind === "image"
                              ? `🖼 ${att.name || "图片附件"}`
                              : `📄 ${att.name || "文件附件"}`}
                          </Text>
                        </View>
                      )
                    ))}
                  </View>
                ) : null}
                {item.text ? <Text style={styles.bubbleText}>{item.text}</Text> : null}
              </View>
            );
          }
          if (item.kind === "agent") {
            const isLast = item.key === timelineItems[timelineItems.length - 1]?.key;
            if (running && isLast) {
              // Live agent turn is rendered in the footer so streaming stays sticky at the bottom.
              return null;
            }
            return renderAgentSections({
              includeAnswer: true,
              answers: item.answers,
              showRuntime: isLast,
              tools: isLast ? viewModel.tools : item.tools,
            });
          }
          return (
            <View style={styles.systemBubble}>
              <Text style={styles.systemText}>{item.text}</Text>
            </View>
          );
        }}
      />

      <View style={styles.dock}>
        {permission && keyboardLift <= 0 ? (
          <View style={styles.permissionCard}>{renderPermissionBody()}</View>
        ) : null}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.contextBar}
          contentContainerStyle={styles.contextBarContent}
        >
          <ContextChip
            value={basename(context.cwd) || "工作空间"}
            locked={running}
            onPress={() => setPicker("workspace")}
          />
          <ContextChip
            value={context.branch || "Git 分支"}
            locked={running}
            onPress={() => setPicker("branch")}
          />
          <ContextChip
            value={agentLabel}
            locked={running}
            onPress={() => setPicker("agent")}
          />
          <ContextChip
            value={modeLabel}
            locked={running}
            onPress={() => setPicker("mode")}
          />
          <ContextChip
            value={modelLabel}
            locked={running}
            onPress={() => setPicker("model")}
          />
        </ScrollView>

        {(attachProgress || sendProgress || modelProgress || dictating) ? (
          <View style={styles.progressBanner}>
            {attachProgress || sendProgress || modelProgress ? (
              <Text style={styles.progressBannerText}>
                {attachProgress || sendProgress || modelProgress}
              </Text>
            ) : null}
            {dictating ? (
              <View style={styles.waveWrap}>
                <View style={styles.waveRow}>
                  {voiceWave.map((level, index) => (
                    <View
                      // eslint-disable-next-line react/no-array-index-key
                      key={`wave:${index}`}
                      style={[styles.waveBar, { height: 4 + Math.round(level * 16) }]}
                    />
                  ))}
                </View>
                <Text style={styles.progressBannerText} numberOfLines={2}>
                  {dictationPreview || "听写中，点话筒结束"}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.composerColumn}>
          <TextInput
            style={styles.input}
            value={prompt}
            onChangeText={setPrompt}
            placeholder={COMPOSER_PLACEHOLDER}
            placeholderTextColor={colors.textMuted}
            multiline
            textAlignVertical="top"
            editable={!running}
          />
          <View style={styles.composerToolbar}>
            <View style={styles.composerTools}>
              <Pressable
                style={[styles.iconSquare, (running || Boolean(attachProgress)) ? styles.disabled : null]}
                disabled={running || Boolean(attachProgress)}
                onPress={() => setAttachSheetOpen(true)}
                accessibilityLabel="添加附件"
              >
                <Text style={styles.iconGlyph}>＋</Text>
              </Pressable>
              <Pressable
                style={[styles.iconSquare, (!connected || running) ? styles.disabled : null]}
                disabled={!connected || running}
                onPress={() => void openMentionPicker()}
                accessibilityLabel="提及工作区文件"
              >
                <Text style={styles.iconGlyph}>@</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.iconSquare,
                  dictating ? styles.iconSquareActive : null,
                  running ? styles.disabled : null,
                ]}
                disabled={running}
                onPress={toggleDictation}
                accessibilityLabel={dictating ? "结束语音输入" : "开始语音输入"}
                accessibilityHint="点按开始或结束听写"
              >
                <Text style={styles.iconGlyph}>{dictating ? "■" : "🎤"}</Text>
              </Pressable>
            </View>
            {running ? (
              <Pressable style={styles.stopSquare} onPress={() => void cancelRun()} accessibilityLabel="停止">
                <View style={styles.stopSquareInner} />
              </Pressable>
            ) : (
              <Pressable
                style={[styles.sendSquare, (!canSend || Boolean(attachProgress)) ? styles.disabled : null]}
                disabled={!canSend || Boolean(attachProgress)}
                onPress={() => void startRun(!session?.id)}
                accessibilityLabel="发送"
              >
                <Text style={styles.sendGlyph}>✈</Text>
              </Pressable>
            )}
          </View>
        </View>
        {mentionedFiles.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pendingAttachRow}
          >
            {mentionedFiles.map((path) => (
              <View key={`mention:${path}`} style={styles.mentionChip}>
                <Text style={styles.pendingAttachName} numberOfLines={1}>@{basename(path)}</Text>
                <Pressable
                  onPress={() => setMentionedFiles((current) => current.filter((item) => item !== path))}
                  accessibilityLabel="移除提及"
                >
                  <Text style={styles.pendingAttachRemove}>×</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        {pendingAttachments.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pendingAttachRow}
          >
            {pendingAttachments.map((item) => (
              <View key={item.id} style={styles.pendingAttachChip}>
                {item.kind === "image" && item.localUri ? (
                  <Image source={{ uri: item.localUri }} style={styles.pendingAttachThumb} />
                ) : (
                  <Text style={styles.pendingAttachName} numberOfLines={1}>{item.name}</Text>
                )}
                <Pressable
                  onPress={() => setPendingAttachments((current) => current.filter((row) => row.id !== item.id))}
                  accessibilityLabel="移除附件"
                >
                  <Text style={styles.pendingAttachRemove}>×</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
      </View>

      <Modal
        visible={Boolean(permission && keyboardLift > 0)}
        transparent
        animationType="fade"
        onRequestClose={() => undefined}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, styles.permissionCard]}>{renderPermissionBody()}</View>
        </View>
      </Modal>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>会话操作</Text>
            <Pressable
              style={styles.modalRow}
              onPress={() => {
                setMenuOpen(false);
                const id = session?.id || sessionIdRef.current;
                if (id) void Share.share({ message: id });
                else Alert.alert("暂无会话", "发送第一条消息后可分享会话 ID");
              }}
            >
              <Text style={styles.modalRowText}>分享会话 ID</Text>
            </Pressable>
            {context.cwd ? (
              <Pressable
                style={styles.modalRow}
                onPress={() => {
                  setMenuOpen(false);
                  void Share.share({ message: context.cwd });
                }}
              >
                <Text style={styles.modalRowText}>分享工作目录</Text>
                <Text style={styles.meta} numberOfLines={1}>{context.cwd}</Text>
              </Pressable>
            ) : null}
            {running ? (
              <Pressable
                style={styles.modalRow}
                onPress={() => {
                  setMenuOpen(false);
                  void cancelRun();
                }}
              >
                <Text style={[styles.modalRowText, { color: colors.danger }]}>停止当前任务</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.modalRow} onPress={() => setMenuOpen(false)}>
              <Text style={styles.modalRowText}>关闭</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={mentionOpen} transparent animationType="fade" onRequestClose={() => setMentionOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setMentionOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>提及工作区文件</Text>
            <Text style={styles.meta} numberOfLines={1}>{mentionDir === "." ? context.cwd : mentionDir}</Text>
            {mentionDir !== "." ? (
              <Pressable
                style={styles.modalRow}
                onPress={() => {
                  const parts = mentionDir.split("/").filter(Boolean);
                  parts.pop();
                  void loadMentionDir(parts.length ? parts.join("/") : ".");
                }}
              >
                <Text style={styles.modalRowText}>‹ 上级目录</Text>
              </Pressable>
            ) : null}
            {mentionLoading ? <ActivityIndicator color={colors.brand} /> : null}
            <ScrollView style={styles.mentionList}>
              {mentionEntries.map((entry) => (
                <Pressable
                  key={entry.path}
                  style={styles.modalRow}
                  onPress={() => {
                    if (entry.kind === "directory") void loadMentionDir(entry.path);
                    else insertMention(entry.path);
                  }}
                >
                  <Text style={styles.modalRowText} numberOfLines={1}>
                    {entry.kind === "directory" ? `📁 ${entry.name}` : `📄 ${entry.name}`}
                  </Text>
                </Pressable>
              ))}
              {!mentionLoading && mentionEntries.length === 0 ? (
                <Text style={styles.meta}>此目录为空</Text>
              ) : null}
            </ScrollView>
            <Pressable style={styles.modalRow} onPress={() => setMentionOpen(false)}>
              <Text style={styles.modalRowText}>取消</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={attachSheetOpen} transparent animationType="fade" onRequestClose={() => setAttachSheetOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setAttachSheetOpen(false)} />
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>添加附件</Text>
            <Pressable
              style={styles.modalRow}
              onPress={() => {
                queueAttachTask(() => pickImagesFromLibrary(
                  pendingAttachments.length,
                  (progress) => setAttachProgress(progress.label),
                ));
              }}
            >
              <Text style={styles.modalRowText}>相册图片</Text>
            </Pressable>
            <Pressable
              style={styles.modalRow}
              onPress={() => {
                queueAttachTask(() => takePhotoAttachment(
                  pendingAttachments.length,
                  (progress) => setAttachProgress(progress.label),
                ));
              }}
            >
              <Text style={styles.modalRowText}>拍照</Text>
            </Pressable>
            <Pressable
              style={styles.modalRow}
              onPress={() => {
                queueAttachTask(() => pasteClipboardImage(
                  pendingAttachments.length,
                  (progress) => setAttachProgress(progress.label),
                ));
              }}
            >
              <Text style={styles.modalRowText}>粘贴剪贴板图片</Text>
            </Pressable>
            <Pressable
              style={styles.modalRow}
              onPress={() => {
                queueAttachTask(() => pickDocumentAttachments(
                  pendingAttachments.length,
                  (progress) => setAttachProgress(progress.label),
                ));
              }}
            >
              <Text style={styles.modalRowText}>文件</Text>
            </Pressable>
            <Pressable style={styles.modalRow} onPress={() => setAttachSheetOpen(false)}>
              <Text style={styles.modalRowText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={picker !== null} transparent animationType="fade" onRequestClose={() => setPicker(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setPicker(null)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>
              {picker === "workspace" ? "工作空间"
                : picker === "branch" ? "Git 分支"
                  : picker === "agent" ? "Agent"
                    : picker === "mode" ? "模式"
                      : "模型"}
            </Text>
            <ScrollView style={styles.modalList}>
              {picker === "workspace" ? (
                projects.length === 0
                  ? <Text style={styles.meta}>暂无授权工作空间</Text>
                  : projects.map((project) => (
                <Pressable
                  key={project.path}
                  style={styles.modalRow}
                  onPress={() => {
                    void refreshBranches(project.path);
                    setPicker(null);
                  }}
                >
                  <Text style={styles.modalRowText}>{project.name}</Text>
                  <Text style={styles.meta} numberOfLines={1}>{project.path}</Text>
                </Pressable>
              ))
              ) : null}
              {picker === "branch" ? (
                (branches?.branches ?? []).length === 0
                  ? <Text style={styles.meta}>{branches?.isRepo === false ? "当前目录不是 Git 仓库" : "暂无分支"}</Text>
                  : (branches?.branches ?? []).map((branch) => (
                <Pressable key={branch} style={styles.modalRow} onPress={() => void switchBranch(branch)}>
                  <Text style={styles.modalRowText}>
                    {branch}{branch === branches?.current ? " · 当前" : ""}
                  </Text>
                </Pressable>
              ))
              ) : null}
              {picker === "agent" ? (
                runtimes.length === 0
                  ? <Text style={styles.meta}>暂无可用 Agent。请确认电脑端 Daemon 已启动并可探测 runtime。</Text>
                  : runtimes.map((runtime) => (
                <Pressable
                  key={runtime.provider}
                  style={styles.modalRow}
                  onPress={() => {
                    setContext((current) => ({
                      ...current,
                      provider: runtime.provider,
                      model: runtime.models[0] || "",
                      // Never keep another agent's mode (e.g. Cursor "default") for Codex.
                      permissionMode: runtime.modes[0]?.id || "",
                    }));
                    setError("");
                    setPicker(null);
                  }}
                >
                  <Text style={styles.modalRowText}>
                    {runtime.label || runtime.provider}
                    {runtime.available ? "" : " · 不可用"}
                  </Text>
                  <Text style={styles.meta}>{runtime.provider}{runtime.status ? ` · ${runtime.status}` : ""}</Text>
                </Pressable>
              ))
              ) : null}
              {picker === "mode" ? (
                modeChoices.length === 0
                  ? <Text style={styles.meta}>当前 Agent 使用默认权限策略，无需选择模式。</Text>
                  : modeChoices.map((mode) => (
                <Pressable
                  key={mode.id}
                  style={styles.modalRow}
                  onPress={() => {
                    setContext((current) => ({ ...current, permissionMode: mode.id }));
                    setPicker(null);
                  }}
                >
                  <Text style={styles.modalRowText}>{mode.label}</Text>
                  {mode.label !== mode.id ? (
                    <Text style={styles.meta}>{mode.id}</Text>
                  ) : null}
                </Pressable>
              ))
              ) : null}
              {picker === "model" ? (
                (selectedRuntime?.models ?? []).length === 0
                  ? <Text style={styles.meta}>当前 Agent 未提供模型列表，将使用默认模型。</Text>
                  : (selectedRuntime?.models ?? []).map((model) => (
                <Pressable
                  key={model}
                  style={styles.modalRow}
                  onPress={() => {
                    setContext((current) => ({ ...current, model }));
                    setPicker(null);
                  }}
                >
                  <Text style={styles.modalRowText}>{model}</Text>
                </Pressable>
              ))
              ) : null}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function ContextChip(props: {
  value: string;
  locked: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      style={[styles.chip, props.locked ? styles.chipLocked : null]}
      disabled={props.locked}
      onPress={props.onPress}
    >
      <Text style={styles.chipValue} numberOfLines={1}>{props.value}</Text>
      <Text style={styles.chipChevron}>▾</Text>
    </Pressable>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.sm,
    minHeight: 44,
  },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backText: { color: colors.brandActive, fontSize: 28, fontWeight: "300" },
  headerCopy: { flex: 1, gap: 2 },
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: "700" },
  headerMetaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  meta: { color: colors.textSecondary, fontSize: 12 },
  menuButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  menuGlyph: { color: colors.textSecondary, fontSize: 20, fontWeight: "700" },
  error: { color: colors.danger, marginBottom: spacing.sm, fontSize: 13 },
  loader: { marginVertical: spacing.md },
  loadOlder: {
    alignSelf: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    minWidth: 160,
    alignItems: "center",
  },
  loadOlderText: { color: colors.brand, fontSize: 13, fontWeight: "600" },
  timelineList: { flex: 1, minHeight: 0 },
  timeline: { gap: spacing.md, paddingBottom: spacing.lg, flexGrow: 1 },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "88%",
    backgroundColor: colors.brandSoft,
    borderColor: colors.brand,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  answerBlock: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  systemBubble: {
    alignSelf: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.sm,
  },
  systemText: { color: colors.textSecondary, fontSize: 12 },
  bubbleText: { color: colors.textPrimary, fontSize: 14, lineHeight: 21 },
  agentTurn: {
    gap: spacing.md,
    alignSelf: "stretch",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  reconnectHint: {
    color: colors.warning,
    fontSize: 12,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.xs,
  },
  agentIdentity: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  agentIdentityCopy: { flex: 1 },
  agentName: { color: colors.textPrimary, fontWeight: "700", fontSize: 14 },
  agentMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  statusPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderColor: colors.borderAlt,
    borderWidth: 1,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    minHeight: 32,
  },
  statusPillText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  completedPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.successSoft,
    borderColor: "#1F6B3A",
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    minHeight: 32,
  },
  completedPillText: { color: colors.success, fontSize: 12, fontWeight: "700" },
  completedPillChevron: { color: colors.success, fontSize: 12, fontWeight: "700" },
  sectionCard: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 32,
  },
  sectionTitle: { color: colors.textPrimary, fontWeight: "700", fontSize: 13 },
  sectionChevron: { color: colors.textSecondary, fontSize: 14 },
  thinkingBody: { gap: 6 },
  thinkingLine: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  execSection: { gap: spacing.sm },
  execTimeline: { gap: spacing.sm },
  execStep: { flexDirection: "row", gap: spacing.sm },
  execRail: { width: 16, alignItems: "center" },
  execDot: { width: 10, height: 10, borderRadius: 5, marginTop: 14 },
  execDotDone: { backgroundColor: colors.success },
  execDotRun: { backgroundColor: colors.brand },
  execDotWait: { backgroundColor: colors.warning },
  execLine: { flex: 1, width: 2, backgroundColor: "#1F3D2A", marginTop: 4 },
  toolCard: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    minHeight: 44,
    gap: spacing.xs,
  },
  toolHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  toolTitle: { flex: 1, color: colors.textPrimary, fontWeight: "600", fontSize: 13 },
  toolStatus: { fontSize: 11, fontWeight: "700" },
  toolStatusDone: { color: colors.success },
  toolStatusRun: { color: colors.brandActive },
  toolStatusWait: { color: colors.warning },
  toolDetail: { color: colors.textSecondary, fontFamily: "Menlo", fontSize: 11, marginTop: 2 },
  toolOutput: { color: colors.textSecondary, fontFamily: "Menlo", fontSize: 11, marginTop: spacing.xs },
  resultCard: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  resultTitle: { color: colors.textPrimary, fontWeight: "700", fontSize: 13 },
  resultFileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 28,
  },
  resultFilePath: { flex: 1, color: colors.textPrimary, fontSize: 13 },
  resultBullet: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  resultVerify: { color: colors.textPrimary, fontSize: 13, lineHeight: 19 },
  resultVerifyOk: { color: colors.success, fontWeight: "700" },
  answerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingTop: spacing.xs,
  },
  answerActionGlyph: { fontSize: 16, opacity: 0.7 },
  copyAction: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    minHeight: 28,
    justifyContent: "center",
  },
  copyActionActive: {
    borderColor: colors.brand,
    backgroundColor: colors.brandSoft,
  },
  copyActionText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  progressBanner: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
    gap: 4,
  },
  waveWrap: {
    width: "100%",
    gap: spacing.xs,
  },
  waveRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: 24,
  },
  waveBar: {
    flex: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.brand,
    opacity: 0.9,
  },
  progressBannerText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  retryBanner: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  retryBannerText: { color: colors.warning, fontSize: 12, fontWeight: "700" },
  mentionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.brandSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    maxWidth: 180,
  },
  mentionList: { maxHeight: 280, marginTop: spacing.sm },
  viewAllButton: {
    alignSelf: "center",
    minHeight: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.xs,
  },
  viewAll: { color: colors.brandActive, fontWeight: "700", fontSize: 13 },
  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  fileGlyph: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  fileGlyphMark: { color: colors.brandActive, fontSize: 14, fontWeight: "800" },
  fileCopy: { flex: 1, gap: 2, minWidth: 0 },
  fileTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  filePath: { flex: 1, color: colors.textPrimary, fontSize: 13, fontWeight: "600" },
  fileStats: { fontSize: 12, fontWeight: "700", flexShrink: 0 },
  fileAdd: { color: colors.add },
  fileDel: { color: colors.del },
  fileSummary: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  fileChevron: { color: colors.textMuted, fontSize: 18, fontWeight: "600" },
  dock: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  permissionCard: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
    borderWidth: 1.5,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  permissionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  permissionTitle: { color: colors.warning, fontWeight: "800", fontSize: 15 },
  permissionBadge: {
    backgroundColor: "#3A2A10",
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  permissionBadgeText: { color: colors.warning, fontSize: 11, fontWeight: "700" },
  permissionLead: { color: colors.textSecondary, fontSize: 12 },
  permissionCommand: {
    backgroundColor: "#120E08",
    borderRadius: radii.md,
    padding: spacing.md,
  },
  permissionSummary: { color: colors.textPrimary, fontSize: 13, lineHeight: 19, fontFamily: "Menlo" },
  permissionMeta: { color: colors.textSecondary, fontSize: 12 },
  permissionWarn: {
    backgroundColor: "#2A2010",
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  permissionWarnText: { color: colors.warning, fontSize: 12, lineHeight: 17 },
  permissionActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  denyButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  denyButtonText: { color: colors.danger, fontWeight: "700" },
  allowButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.md,
    backgroundColor: colors.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  allowButtonText: { color: "#1A1205", fontWeight: "800" },
  contextBar: {
    flexGrow: 0,
    flexShrink: 0,
    height: 40,
  },
  contextBarContent: {
    gap: spacing.sm,
    alignItems: "center",
    paddingRight: spacing.sm,
  },
  chip: {
    height: 36,
    maxWidth: 140,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  chipLocked: { opacity: 0.45 },
  chipValue: { color: colors.textPrimary, fontSize: 13, fontWeight: "600", maxWidth: 108 },
  chipChevron: { color: colors.textSecondary, fontSize: 11 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingBottom: spacing.xs,
  },
  composerColumn: {
    gap: spacing.sm,
    paddingBottom: spacing.xs,
  },
  composerToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  composerTools: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexShrink: 1,
  },
  iconSquare: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  iconSquareActive: {
    borderColor: colors.brand,
    backgroundColor: colors.brandSoft,
  },
  iconGlyph: { color: colors.textPrimary, fontSize: 18, fontWeight: "700" },
  pendingAttachRow: {
    gap: spacing.sm,
    paddingBottom: spacing.xs,
  },
  pendingAttachChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    maxWidth: 160,
  },
  pendingAttachThumb: { width: 36, height: 36, borderRadius: 6 },
  pendingAttachName: { color: colors.textPrimary, fontSize: 12, maxWidth: 100 },
  pendingAttachRemove: { color: colors.textMuted, fontSize: 18, paddingHorizontal: 4 },
  attachmentRow: { gap: spacing.sm, marginBottom: spacing.sm },
  attachmentThumb: { width: 120, height: 120, borderRadius: radii.md },
  attachmentChip: {
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  attachmentImagePlaceholder: {
    minWidth: 120,
    minHeight: 44,
    justifyContent: "center",
    borderStyle: "dashed",
  },
  attachmentChipText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  input: {
    width: "100%",
    minHeight: 72,
    maxHeight: 140,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    fontSize: 16,
    lineHeight: 22,
  },
  sendSquare: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  sendGlyph: { color: "white", fontSize: 18, fontWeight: "700" },
  stopSquare: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  stopSquareInner: {
    width: 14,
    height: 14,
    borderRadius: 2,
    backgroundColor: "white",
  },
  disabled: { opacity: 0.4 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    maxHeight: "70%",
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    padding: spacing.lg,
  },
  modalTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: "700", marginBottom: spacing.md },
  modalList: { maxHeight: 420 },
  modalRow: {
    minHeight: 44,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    justifyContent: "center",
    paddingVertical: spacing.sm,
  },
  modalRowText: { color: colors.textPrimary, fontWeight: "600" },
}));
