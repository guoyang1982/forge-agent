import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MobileRelayClient } from "../transport/mobile-relay-client";
import {
  parseCreatedProject,
  parseProjects,
  type ProjectItem,
} from "./project-sanitize";
import {
  parseMessages,
  parseSessions,
  type MessageItem,
  type SessionItem,
} from "./session-sanitize";
import { parseRunEvent, type RunUiEvent } from "./run-event-sanitize";

export function SessionScreen(props: {
  client: MobileRelayClient;
  hostName: string;
  onBack: () => void;
}) {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectItem | null>(null);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SessionItem | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [runSessionId, setRunSessionId] = useState("");
  const [streamText, setStreamText] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [tools, setTools] = useState<Array<{ callId: string; name: string; status: "running" | "done" }>>([]);
  const [permissionRequest, setPermissionRequest] = useState<
    (Extract<RunUiEvent, { kind: "permission" }> & { sessionId: string }) | null
  >(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setProjects(parseProjects(await props.client.call("project.list", {})));
    } catch (cause) {
      setError(publicError(cause));
    } finally {
      setLoading(false);
    }
  }, [props.client]);

  const loadSessions = useCallback(async () => {
    if (!selectedProject) {
      setSessions([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = query.trim()
        ? await props.client.call("session.search", {
            query: query.trim(),
            cwd: selectedProject.path,
            limit: 50,
          })
        : await props.client.call("session.list", {
            cwd: selectedProject.path,
            limit: 50,
          });
      setSessions(parseSessions(result));
    } catch (cause) {
      setError(publicError(cause));
    } finally {
      setLoading(false);
    }
  }, [props.client, query, selectedProject]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (selectedProject) void loadSessions();
  }, [loadSessions, selectedProject]);

  const createProject = async () => {
    const parent = projects.find((project) => project.kind === "workspace");
    const name = projectName.trim();
    if (!parent || !name || loading) return;
    setLoading(true);
    setError("");
    try {
      const created = parseCreatedProject(await props.client.call("project.create", {
        parentPath: parent.path,
        name,
      }));
      if (!created) throw new Error("电脑返回的项目数据无效");
      setProjectName("");
      setShowCreateProject(false);
      await loadProjects();
      setSelectedProject(created);
    } catch (cause) {
      setError(publicError(cause));
    } finally {
      setLoading(false);
    }
  };

  const openSession = async (session: SessionItem) => {
    setSelected(session);
    setLoading(true);
    setError("");
    try {
      const result = await props.client.call("session.messages", {
        sessionId: session.id,
        limit: 200,
      });
      setMessages(parseMessages(result));
    } catch (cause) {
      setError(publicError(cause));
    } finally {
      setLoading(false);
    }
  };

  const startAgentRun = async (newSession: boolean) => {
    const message = prompt.trim();
    const cwd = selected?.cwd ?? selectedProject?.path;
    const continuingSessionId = !newSession && selected?.id ? selected.id : null;
    if (!cwd || !message || running) return;
    const draft: SessionItem = {
      id: continuingSessionId ?? "",
      cwd,
      updatedAt: new Date().toISOString(),
      messageCount: continuingSessionId ? selected?.messageCount ?? 0 : 1,
      lastPreview: message,
    };
    if (newSession) {
      setSelected(draft);
      setMessages([{ key: "draft:user", role: "user", text: message }]);
    }
    setPrompt("");
    setRunning(true);
    setError("");
    setStreamText("");
    setTools([]);
    setPermissionRequest(null);
    setRunStatus("正在启动 Agent…");
    let targetSessionId = continuingSessionId ?? "";
    const run = props.client.startRun(
      { cwd, message, sessionId: continuingSessionId },
      (frame) => {
        const event = parseRunEvent(frame.event);
        if (!event) return;
        if (event.kind === "session") {
          targetSessionId = event.sessionId;
          setRunSessionId(event.sessionId);
          setSelected((current) => current ? { ...current, id: event.sessionId } : current);
        } else if (event.kind === "text") {
          setStreamText((current) => `${current}${event.delta}`.slice(-100_000));
        } else if (event.kind === "status") {
          setRunStatus(event.label);
        } else if (event.kind === "tool") {
          setTools((current) => {
            const next = current.filter((tool) => tool.callId !== event.callId);
            return [...next, event].slice(-12);
          });
        } else if (event.kind === "permission") {
          setRunStatus(`等待权限确认：${event.summary}`);
          const permissionSessionId = event.sessionId || targetSessionId;
          if (permissionSessionId) setPermissionRequest({ ...event, sessionId: permissionSessionId });
        } else if (event.kind === "done") {
          targetSessionId = event.sessionId;
          setRunSessionId(event.sessionId);
          setSelected((current) => current ? { ...current, id: event.sessionId } : current);
          if (event.finalText) setStreamText((current) => current || event.finalText || "");
          setRunStatus("已完成");
        } else if (event.kind === "error") {
          setRunStatus(event.message);
        }
      },
    );
    try {
      await run.result;
      if (targetSessionId) await openSession({ ...draft, id: targetSessionId });
      await loadSessions();
    } catch (cause) {
      setError(publicError(cause));
    } finally {
      props.client.unsubscribe(run.subscriptionId);
      setRunning(false);
      setRunSessionId("");
    }
  };

  const cancelRun = async () => {
    if (!runSessionId) return;
    try {
      await props.client.call("run.cancel", { sessionId: runSessionId });
      setRunStatus("正在取消…");
    } catch (cause) {
      setError(publicError(cause));
    }
  };

  const respondPermission = async (approved: boolean, optionId?: string) => {
    const request = permissionRequest;
    if (!request) return;
    try {
      await props.client.call("permission.respond", {
        requestId: request.requestId,
        sessionId: request.sessionId,
        approved,
        ...(optionId ? { optionId } : {}),
      });
      setPermissionRequest(null);
      setRunStatus(approved ? "已允许一次，继续运行…" : "已拒绝，等待 Agent 处理…");
    } catch (cause) {
      setError(publicError(cause));
    }
  };

  if (selected) {
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={() => { setSelected(null); setMessages([]); }}><Text style={styles.back}>‹ 会话</Text></Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>{selected.lastPreview || "新会话"}</Text>
            <Text style={styles.meta} numberOfLines={1}>{selected.cwd}</Text>
          </View>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <FlatList
          style={styles.messageScroller}
          data={messages}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.messageList}
          refreshControl={selected.id ? <RefreshControl refreshing={loading} onRefresh={() => void openSession(selected)} tintColor="#8b5cf6" /> : undefined}
          ListEmptyComponent={!loading ? <Text style={styles.empty}>输入任务后，Forge 会在这个项目中开始工作</Text> : null}
          renderItem={({ item }) => (
            <View style={[styles.message, item.role === "user" ? styles.userMessage : styles.agentMessage]}>
              <Text style={styles.messageRole}>{roleLabel(item.role)}</Text>
              <Text style={styles.messageText}>{item.text}</Text>
            </View>
          )}
        />
        {running || streamText || tools.length ? (
          <ScrollView style={styles.runPanel}>
            <View style={styles.runHead}>
              <Text style={styles.runStatus}>{runStatus || (running ? "Agent 运行中…" : "最近结果")}</Text>
              {running ? (
                <Pressable disabled={!runSessionId} onPress={() => void cancelRun()}>
                  <Text style={[styles.cancel, !runSessionId && styles.disabled]}>取消</Text>
                </Pressable>
              ) : null}
            </View>
            {tools.map((tool) => <Text key={tool.callId} style={styles.toolLine}>{tool.status === "running" ? "●" : "✓"} {tool.name}</Text>)}
            {streamText ? <Text style={styles.streamText}>{streamText}</Text> : null}
          </ScrollView>
        ) : null}
        {permissionRequest ? (
          <View style={styles.permissionCard}>
            <Text style={styles.permissionTitle}>需要你的确认</Text>
            <Text style={styles.permissionSummary}>{permissionRequest.summary}</Text>
            <View style={styles.permissionActions}>
              {permissionRequest.options.length ? permissionRequest.options.map((option) => (
                <Pressable key={option.optionId} style={option.allow ? styles.primaryAction : styles.secondaryAction} onPress={() => void respondPermission(option.allow, option.optionId)}>
                  <Text style={option.allow ? styles.primaryActionText : styles.secondaryActionText}>{option.name}</Text>
                </Pressable>
              )) : (
                <>
                  <Pressable style={styles.secondaryAction} onPress={() => void respondPermission(false)}><Text style={styles.secondaryActionText}>拒绝</Text></Pressable>
                  <Pressable style={styles.primaryAction} onPress={() => void respondPermission(true)}><Text style={styles.primaryActionText}>允许一次</Text></Pressable>
                </>
              )}
            </View>
          </View>
        ) : null}
        <View style={styles.composer}>
          <TextInput value={prompt} onChangeText={setPrompt} placeholder="告诉 Forge 要开发或修改什么…" placeholderTextColor="#667085" multiline editable={!running} style={styles.composerInput} />
          <View style={styles.composerActions}>
            {selected.id ? (
              <Pressable disabled={running || !prompt.trim()} style={styles.secondaryAction} onPress={() => void startAgentRun(true)}><Text style={styles.secondaryActionText}>新会话</Text></Pressable>
            ) : null}
            <Pressable disabled={running || !prompt.trim()} style={[styles.primaryAction, (running || !prompt.trim()) && styles.disabledButton]} onPress={() => void startAgentRun(!selected.id)}>
              <Text style={styles.primaryActionText}>{selected.id ? "续接运行" : "开始工作"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  if (selectedProject) {
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={() => { setSelectedProject(null); setSessions([]); setQuery(""); }}><Text style={styles.back}>‹ 项目</Text></Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>{selectedProject.name}</Text>
            <Text style={styles.meta} numberOfLines={1}>{selectedProject.path}</Text>
          </View>
        </View>
        <View style={styles.newTaskCard}>
          <Text style={styles.sectionTitle}>在这个项目中开始新任务</Text>
          <TextInput value={prompt} onChangeText={setPrompt} placeholder="例如：分析项目并修复登录问题…" placeholderTextColor="#667085" multiline style={styles.projectPrompt} />
          <Pressable disabled={!prompt.trim()} style={[styles.primaryAction, styles.startButton, !prompt.trim() && styles.disabledButton]} onPress={() => void startAgentRun(true)}>
            <Text style={styles.primaryActionText}>新建会话并开始工作</Text>
          </Pressable>
        </View>
        <View style={styles.searchRow}>
          <TextInput value={query} onChangeText={setQuery} onSubmitEditing={() => void loadSessions()} placeholder="搜索这个项目的会话" placeholderTextColor="#667085" style={styles.search} />
          <Pressable style={styles.searchButton} onPress={() => void loadSessions()}><Text style={styles.searchButtonText}>搜索</Text></Pressable>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {loading && !sessions.length ? <ActivityIndicator color="#8b5cf6" /> : null}
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadSessions()} tintColor="#8b5cf6" />}
          ListEmptyComponent={!loading ? <Text style={styles.emptyCompact}>这个项目还没有会话，可直接在上方输入任务</Text> : null}
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => void openSession(item)}>
              <Text style={styles.cardTitle} numberOfLines={2}>{item.lastPreview || "未命名会话"}</Text>
              <Text style={styles.cardFoot}>{item.messageCount} 条消息 · {formatTime(item.updatedAt)}</Text>
            </Pressable>
          )}
        />
      </View>
    );
  }

  const workspaceRoot = projects.find((project) => project.kind === "workspace");
  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={props.onBack}><Text style={styles.back}>‹ 电脑</Text></Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>{props.hostName}</Text>
          <Text style={styles.meta}>选择电脑上的项目，或创建新项目</Text>
        </View>
        <Pressable onPress={() => setShowCreateProject((current) => !current)}><Text style={styles.addProject}>＋ 新建</Text></Pressable>
      </View>
      {showCreateProject ? (
        <View style={styles.createPanel}>
          <Text style={styles.sectionTitle}>创建工作项目目录</Text>
          <Text style={styles.meta} numberOfLines={1}>位置：{workspaceRoot?.path ?? "没有可创建项目的授权工作区"}</Text>
          <TextInput value={projectName} onChangeText={setProjectName} autoCapitalize="none" autoCorrect={false} placeholder="项目目录名，如 my-new-app" placeholderTextColor="#667085" style={styles.search} />
          <Pressable disabled={!workspaceRoot || !projectName.trim() || loading} style={[styles.primaryAction, styles.startButton, (!workspaceRoot || !projectName.trim() || loading) && styles.disabledButton]} onPress={() => void createProject()}>
            <Text style={styles.primaryActionText}>创建并进入项目</Text>
          </Pressable>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading && !projects.length ? <ActivityIndicator color="#8b5cf6" /> : null}
      <FlatList
        data={projects}
        keyExtractor={(item) => item.path}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadProjects()} tintColor="#8b5cf6" />}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>当前设备还没有获得项目目录授权，请在 Desktop 的 Mobile 渠道中授权</Text> : null}
        renderItem={({ item }) => (
          <Pressable style={styles.projectCard} onPress={() => { setSelectedProject(item); setQuery(""); }}>
            <View style={styles.projectIcon}><Text style={styles.projectIconText}>{item.kind === "workspace" ? "工" : "项"}</Text></View>
            <View style={styles.projectCopy}>
              <Text style={styles.cardTitle}>{item.name}</Text>
              <Text style={styles.meta} numberOfLines={1}>{item.path}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function roleLabel(role: MessageItem["role"]): string {
  return role === "user" ? "你" : role === "assistant" ? "Forge" : role === "tool" ? "工具" : "系统";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
}

function publicError(error: unknown): string {
  return (error instanceof Error ? error.message : "加载失败").slice(0, 240);
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#080b10", paddingHorizontal: 18, paddingTop: 18 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 18 },
  headerCopy: { flex: 1 },
  back: { color: "#a78bfa", fontSize: 15, paddingVertical: 8 },
  title: { color: "#f8fafc", fontSize: 20, fontWeight: "700" },
  meta: { color: "#788397", fontSize: 12, marginTop: 4 },
  addProject: { color: "#c4b5fd", fontWeight: "700", paddingVertical: 8 },
  sectionTitle: { color: "#e5e7eb", fontSize: 14, fontWeight: "700", marginBottom: 8 },
  createPanel: { backgroundColor: "#111720", borderColor: "#37305b", borderWidth: 1, borderRadius: 15, padding: 14, gap: 10, marginBottom: 14 },
  newTaskCard: { backgroundColor: "#151124", borderColor: "#5b3fa0", borderWidth: 1, borderRadius: 15, padding: 14, marginBottom: 14 },
  projectPrompt: { minHeight: 64, maxHeight: 120, color: "#f8fafc", backgroundColor: "#0b0f16", borderColor: "#293242", borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, textAlignVertical: "top" },
  startButton: { alignSelf: "flex-end", marginTop: 10 },
  searchRow: { flexDirection: "row", gap: 8, marginBottom: 14 },
  search: { flex: 1, color: "#f8fafc", backgroundColor: "#10151e", borderColor: "#293242", borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  searchButton: { justifyContent: "center", backgroundColor: "#7c3aed", borderRadius: 12, paddingHorizontal: 16 },
  searchButtonText: { color: "white", fontWeight: "700" },
  error: { color: "#fca5a5", backgroundColor: "#241216", borderRadius: 10, padding: 10, marginBottom: 10 },
  list: { gap: 10, paddingBottom: 28 },
  card: { backgroundColor: "#10151e", borderColor: "#202936", borderWidth: 1, borderRadius: 15, padding: 15 },
  projectCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#10151e", borderColor: "#202936", borderWidth: 1, borderRadius: 15, padding: 14 },
  projectIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: "#2d2050", alignItems: "center", justifyContent: "center" },
  projectIconText: { color: "#c4b5fd", fontWeight: "800" },
  projectCopy: { flex: 1 },
  chevron: { color: "#8b5cf6", fontSize: 28 },
  cardTitle: { color: "#eef2f7", fontSize: 15, fontWeight: "700", lineHeight: 20 },
  cardFoot: { color: "#667085", fontSize: 11, marginTop: 10 },
  empty: { color: "#697386", textAlign: "center", marginTop: 70, lineHeight: 20 },
  emptyCompact: { color: "#697386", textAlign: "center", marginTop: 28, lineHeight: 20 },
  messageList: { gap: 10, paddingBottom: 28 },
  messageScroller: { flex: 1 },
  message: { borderRadius: 14, padding: 13, maxWidth: "92%" },
  userMessage: { backgroundColor: "#35205f", alignSelf: "flex-end" },
  agentMessage: { backgroundColor: "#111923", alignSelf: "flex-start", borderColor: "#253040", borderWidth: 1 },
  messageRole: { color: "#a78bfa", fontSize: 10, fontWeight: "800", marginBottom: 5 },
  messageText: { color: "#e5e7eb", fontSize: 14, lineHeight: 20 },
  runPanel: { maxHeight: 220, backgroundColor: "#0d141d", borderColor: "#283345", borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 10 },
  runHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  runStatus: { color: "#a78bfa", fontSize: 12, fontWeight: "700", flex: 1 },
  cancel: { color: "#f87171", fontWeight: "700", padding: 4 },
  disabled: { opacity: 0.35 },
  toolLine: { color: "#93a4b8", fontSize: 11, marginTop: 6 },
  streamText: { color: "#e5e7eb", fontSize: 13, lineHeight: 19, marginTop: 8 },
  composer: { borderTopColor: "#202936", borderTopWidth: 1, paddingTop: 10, paddingBottom: 6, gap: 8 },
  composerInput: { minHeight: 54, maxHeight: 120, color: "#f8fafc", backgroundColor: "#10151e", borderColor: "#293242", borderWidth: 1, borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10, textAlignVertical: "top" },
  composerActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  secondaryAction: { borderColor: "#344054", borderWidth: 1, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 9 },
  secondaryActionText: { color: "#c5ceda", fontWeight: "600" },
  primaryAction: { backgroundColor: "#7c3aed", borderRadius: 10, paddingHorizontal: 15, paddingVertical: 9 },
  primaryActionText: { color: "white", fontWeight: "700" },
  disabledButton: { opacity: 0.4 },
  permissionCard: { backgroundColor: "#211932", borderColor: "#6d4bc3", borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 10 },
  permissionTitle: { color: "#c4b5fd", fontSize: 12, fontWeight: "800" },
  permissionSummary: { color: "#e5e7eb", fontSize: 13, lineHeight: 19, marginTop: 6 },
  permissionActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 10, flexWrap: "wrap" },
});
