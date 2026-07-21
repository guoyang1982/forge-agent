import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  Branches,
  createForgeMobileApi,
  PendingPermission,
  RunContext,
  Runtime,
} from "../data/forge-mobile-api";
import type { ProjectItem } from "./project-sanitize";
import type { MessageItem, SessionItem } from "./session-sanitize";
import { appendStreamingText, parseRunEvents, type RunUiEvent } from "./run-event-sanitize";
import {
  buildConversationView,
  buildTimelineItems,
  type ToolView,
} from "./conversation-view";
import type { MobileWorkbenchAction } from "../state/mobile-workbench-state";
import { ForgeMark } from "../ui/components";
import { MarkdownBody } from "../ui/markdown";
import { colors, radii, spacing } from "../ui/theme";

type Api = ReturnType<typeof createForgeMobileApi>;

/** Fallback only for Cursor-style agents when runtime.list omits modes. */
const CURSOR_STYLE_MODES = [
  { id: "default", label: "default" },
  { id: "plan", label: "plan" },
  { id: "ask", label: "ask" },
] as const;
const COMPOSER_PLACEHOLDER = "描述你的需求，或粘贴代码、截图。输入 @ 引用文件或上下文";

export function ConversationScreen(props: {
  api: Api;
  hostName: string;
  connectionState?: string;
  sessionId: string | null;
  cwd: string | null;
  needsHistoryRefresh: boolean;
  dispatch: (action: MobileWorkbenchAction) => void;
  onBack: () => void;
  onOpenDiff: (cwd: string, path: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [persistedEvents, setPersistedEvents] = useState<RunUiEvent[]>([]);
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
  const [running, setRunning] = useState(false);
  const [liveEvents, setLiveEvents] = useState<RunUiEvent[]>([]);
  const [liveText, setLiveText] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [permission, setPermission] = useState<PendingPermission | null>(null);
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

  const reloadMessages = useCallback(async (sessionId: string) => {
    // session.messages — persisted history + events for timeline rebuild
    const history = typeof props.api.sessionHistory === "function"
      ? await props.api.sessionHistory(sessionId)
      : { messages: await props.api.messages(sessionId), events: [] as RunUiEvent[] };
    setMessages(history.messages);
    setPersistedEvents(history.events);
    props.dispatch({ type: "session.persisted", sessionId, messages: history.messages });
    props.dispatch({ type: "history.refreshed", sessionId });
  }, [props]);

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextProjects = await props.api.projects();
      setProjects(nextProjects);
      const cwd = props.cwd || nextProjects[0]?.path || "";

      let nextRuntimes: Runtime[] = [];
      let runtimeError = "";
      try {
        nextRuntimes = await props.api.runtimes(cwd || undefined);
      } catch {
        // Older gateways reject runtime.list with cwd — retry with empty params.
        try {
          nextRuntimes = await props.api.runtimes();
        } catch (retryCause) {
          runtimeError = retryCause instanceof Error ? retryCause.message : "加载 Agent 失败";
        }
      }
      setRuntimes(nextRuntimes);
      const preferred = nextRuntimes.find((item) => item.available) || nextRuntimes[0];
      const provider = preferred?.provider || "";
      setContext({
        cwd,
        branch: null,
        provider,
        model: preferred?.models[0] || "",
        permissionMode: preferred?.modes[0]?.id || "",
        sandboxMode: "workspace-write",
      });

      if (cwd) {
        try {
          const branchInfo = await props.api.branches(cwd);
          setBranches(branchInfo);
          setContext((current) => ({ ...current, branch: branchInfo.current }));
        } catch {
          // Non-git workspaces are valid; keep branch empty.
          setBranches({
            isRepo: false,
            current: null,
            detached: false,
            dirty: false,
            branches: [],
          });
        }
      }
      if (props.sessionId) {
        await reloadMessages(props.sessionId);
        const pending = await props.api.pendingPermissions(props.sessionId);
        if (pending[0]) setPermission(pending[0]);
      }
      if (runtimeError) {
        setError(runtimeError);
      } else if (nextRuntimes.length === 0) {
        setError("未获取到 Agent 列表。请在电脑端重新编译并重启 Channel Gateway 后再试。");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [props, reloadMessages]);

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
    if (!props.needsHistoryRefresh || !props.sessionId) return;
    void (async () => {
      try {
        await reloadMessages(props.sessionId!);
        // permission.pending — restore sticky card after reconnect
        const pending = await props.api.pendingPermissions(props.sessionId!);
        setPermission(pending[0] ?? null);
        if (props.sessionId) {
          try {
            const sub = props.api.subscribeRun(props.sessionId, (frame) => {
              handleLiveFrame(frame, props.sessionId!);
            });
            subscriptionRef.current = sub.subscriptionId;
            await sub.result;
          } catch {
            // Fall back to persisted history when the run no longer exists.
            await reloadMessages(props.sessionId!);
          }
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "恢复历史失败");
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
      } else if (event.kind === "error") {
        setRunStatus(event.message);
      }
    }
  };

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

  const startRun = async (newSession: boolean) => {
    const message = prompt.trim();
    if (!context.cwd || !message || running) return;
    if (!context.provider.trim()) {
      setError("请先选择 Agent（点击下方 Agent 芯片）");
      setPicker("agent");
      return;
    }
    const continuingSessionId = !newSession && session?.id ? session.id : null;
    const draftKey = `draft:user:${Date.now()}`;
    if (newSession || !session) {
      setSession({
        id: continuingSessionId ?? "",
        cwd: context.cwd,
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        lastPreview: message,
      });
      setMessages([{ key: draftKey, role: "user", text: message }]);
    } else {
      setMessages((current) => [
        ...current,
        { key: draftKey, role: "user", text: message },
      ]);
    }
    setPrompt("");
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
      { message, sessionId: continuingSessionId },
      (frame) => handleLiveFrame(frame, continuingSessionId || ""),
    );
    subscriptionRef.current = run.subscriptionId;
    try {
      await run.result;
      const finalId = sessionIdRef.current;
      if (finalId) {
        await reloadMessages(finalId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "运行失败");
      // Drop the optimistic bubble so a retry does not stack duplicates.
      setMessages((current) => current.filter((item) => item.key !== draftKey));
      const finalId = sessionIdRef.current;
      if (finalId) {
        try {
          await reloadMessages(finalId);
          // User message may already be persisted — leave composer empty.
        } catch {
          setPrompt(message);
        }
      } else {
        setPrompt(message);
      }
    } finally {
      if (subscriptionRef.current) props.api.unsubscribe(subscriptionRef.current);
      subscriptionRef.current = null;
      // Always drop the live answer once the run ends — timeline uses persisted messages.
      setLiveText("");
      setRunning(false);
      props.dispatch({ type: "run.started", sessionId: null });
    }
  };

  const cancelRun = async () => {
    const sessionId = sessionIdRef.current || session?.id;
    if (!sessionId) {
      setError("会话尚未就绪，请稍后再停止");
      return;
    }
    setRunStatus("正在停止…");
    try {
      // run.cancel — daemon abort for this session (cross-device via shared cancel_run)
      await props.api.cancelRun(sessionId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "停止失败";
      setError(message);
      setRunStatus("停止失败");
      Alert.alert("停止失败", message);
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

  const canSend = Boolean(prompt.trim() && context.cwd && !running);
  const statusPillLabel = running
    ? (runStatus && runStatus !== "已完成" ? runStatus : "思考中…")
    : "";

  const renderFileCards = (files: typeof viewModel.files) => files.map((file) => (
    <Pressable
      key={file.key}
      style={styles.fileCard}
      onPress={() => context.cwd && props.onOpenDiff(context.cwd, file.path)}
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
          ? options.answers.filter(Boolean).map((text, index) => (
            <View key={`answer:${index}:${text.slice(0, 16)}`} style={styles.answerBlock}>
              <MarkdownBody text={text} />
            </View>
          ))
          : null}

        {!running && options.showRuntime && files.length > 0 ? (
          <View style={styles.resultCard}>
            <Text style={styles.resultTitle}>变更文件</Text>
            {files.map((file) => (
              <Pressable
                key={`done:${file.key}`}
                style={styles.resultFileRow}
                onPress={() => context.cwd && props.onOpenDiff(context.cwd, file.path)}
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

        {!running && options.showRuntime && options.answers.length > 0 ? (
          <View style={styles.answerActions}>
            <Text style={styles.answerActionGlyph}>👍</Text>
            <Text style={styles.answerActionGlyph}>👎</Text>
            <Pressable
              style={styles.copyAction}
              onPress={() => void Share.share({ message: options.answers.join("\n\n") })}
            >
              <Text style={styles.copyActionText}>复制</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.page}>
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
        <Pressable style={styles.menuButton} accessibilityLabel="更多">
          <Text style={styles.menuGlyph}>⋮</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading && messages.length === 0 ? <ActivityIndicator color={colors.brand} style={styles.loader} /> : null}

      <FlatList
        style={styles.timelineList}
        data={timelineItems}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.timeline}
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
                <Text style={styles.bubbleText}>{item.text}</Text>
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
        {permission ? (
          <View style={styles.permissionCard}>
            <View style={styles.permissionHead}>
              <Text style={styles.permissionTitle}>需要你的确认</Text>
              <View style={styles.permissionBadge}>
                <Text style={styles.permissionBadgeText}>权限</Text>
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
          </View>
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

        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={prompt}
            onChangeText={setPrompt}
            placeholder={COMPOSER_PLACEHOLDER}
            placeholderTextColor={colors.textMuted}
            multiline
            editable={!running}
          />
          {running ? (
            <Pressable style={styles.stopSquare} onPress={() => void cancelRun()} accessibilityLabel="停止">
              <View style={styles.stopSquareInner} />
            </Pressable>
          ) : (
            <Pressable
              style={[styles.sendSquare, !canSend ? styles.disabled : null]}
              disabled={!canSend}
              onPress={() => void startRun(!session?.id)}
              accessibilityLabel="发送"
            >
              <Text style={styles.sendGlyph}>✈</Text>
            </Pressable>
          )}
        </View>
      </View>

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

const styles = StyleSheet.create({
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
  timelineList: { flex: 1, minHeight: 0 },
  timeline: { gap: spacing.md, paddingBottom: spacing.lg, flexGrow: 1 },
  userBubble: {
    alignSelf: "stretch",
    backgroundColor: colors.surface,
    borderColor: colors.border,
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
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.sm,
  },
  systemText: { color: colors.textSecondary, fontSize: 12 },
  bubbleText: { color: colors.textPrimary, fontSize: 14, lineHeight: 21 },
  agentTurn: {
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
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
    marginLeft: "auto",
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    minHeight: 28,
    justifyContent: "center",
  },
  copyActionText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
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
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: 14,
    lineHeight: 20,
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
});
