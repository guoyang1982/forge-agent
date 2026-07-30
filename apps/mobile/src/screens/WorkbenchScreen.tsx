import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import type { createForgeMobileApi } from "../data/forge-mobile-api";
import type { ProjectItem } from "./project-sanitize";
import type { SessionItem } from "./session-sanitize";
import type { MobileConnectionState } from "../transport/mobile-relay-client";
import {
  Card,
  HostPicker,
  QuickAction,
  SectionTitle,
} from "../ui/components";
import type { MobileHostSummary } from "../storage/host-store";
import { makeStyles } from "../ui/make-styles";
import { colors, radii, spacing } from "../ui/theme";

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

type Api = ReturnType<typeof createForgeMobileApi>;

export function WorkbenchScreen(props: {
  api: Api;
  hosts: MobileHostSummary[];
  connections: Record<string, MobileConnectionState>;
  selectedHostId: string | null;
  hostName: string;
  runningSessionId: string | null;
  liveText: string;
  liveStatus?: string;
  onSelectHost: (hostId: string) => void;
  onOpenWorkspace: (cwd: string) => void;
  onOpenSession: (session: SessionItem) => void;
  onNewSession: (cwd?: string) => void;
  onNewWorkspace: () => void;
  onViewAllSessions?: () => void;
  onViewAllWorkspaces?: () => void;
  onCancelRun?: (sessionId: string) => void;
}) {
  const styles = useStyles();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [status, setStatus] = useState<{ activeRun: boolean; runtime: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextProjects, nextSessions, nextStatus] = await Promise.all([
        props.api.projects(),
        props.api.sessions(),
        props.api.status(),
      ]);
      setProjects(nextProjects);
      setSessions(
        [...nextSessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 12),
      );
      setStatus({ activeRun: nextStatus.activeRun, runtime: nextStatus.runtime });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [props.api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runningSession = props.runningSessionId
    ? sessions.find((item) => item.id === props.runningSessionId) ?? null
    : null;
  const showRunning = Boolean(props.runningSessionId || status?.activeRun);
  const connected = props.selectedHostId
    ? props.connections[props.selectedHostId] === "authenticated"
    : false;

  useEffect(() => {
    if (!props.runningSessionId) {
      setElapsedSeconds(0);
      return;
    }
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds((value) => value + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [props.runningSessionId]);

  const recentSessions = sessions.slice(0, 3);
  const frequentProjects = projects.slice(0, 3);

  return (
    <View style={styles.page}>
      <HostPicker
        compact
        hosts={props.hosts}
        selectedHostId={props.selectedHostId}
        connections={props.connections}
        onSelect={props.onSelectHost}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.brand} />}
      >
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <SectionTitle label="当前任务" />
        {showRunning ? (
          <Card style={styles.runningCard}>
            <View style={styles.runningHead}>
              <View style={styles.taskGlyph}>
                <Text style={styles.taskGlyphText}>◈</Text>
              </View>
              <View style={styles.runningCopy}>
                <Text style={styles.runningTitle} numberOfLines={2}>
                  {runningSession?.lastPreview || props.liveText.slice(0, 80) || "任务执行中"}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {props.liveStatus || "对话与运行事件"}
                  {runningSession?.cwd ? ` · ${basename(runningSession.cwd)}` : ""}
                </Text>
              </View>
            </View>
            <View style={styles.timerRow}>
              <Text style={styles.timerText}>
                {props.runningSessionId ? `已用时 ${formatClock(elapsedSeconds)}` : "电脑端有任务在运行"}
              </Text>
              {props.runningSessionId && props.onCancelRun ? (
                <Pressable
                  style={styles.stopSquare}
                  onPress={() => props.onCancelRun?.(props.runningSessionId!)}
                  accessibilityLabel="停止"
                >
                  <View style={styles.stopSquareInner} />
                </Pressable>
              ) : (
                <View style={styles.stopPlaceholder} />
              )}
            </View>
          </Card>
        ) : (
          <Card style={styles.idleCard}>
            <Text style={styles.idleTitle}>暂无运行中的任务</Text>
            <Text style={styles.idleText}>
              {connected
                ? "从下方快速操作新建会话，或打开常用工作空间继续。"
                : "连接电脑后即可开始任务。"}
            </Text>
            <Pressable style={styles.idleAction} onPress={() => props.onNewSession()}>
              <Text style={styles.idleActionText}>新建会话</Text>
            </Pressable>
          </Card>
        )}

        <SectionTitle label="快速操作" />
        <View style={styles.actions}>
          <QuickAction
            primary
            icon="＋"
            label="新建会话"
            hint="在授权工作空间提问"
            onPress={() => props.onNewSession()}
          />
          <QuickAction
            icon="⬚"
            label="新建工作空间"
            hint="在授权目录下创建"
            onPress={props.onNewWorkspace}
          />
        </View>

        <SectionTitle
          label="最近会话"
          actionLabel="查看全部 >"
          onAction={props.onViewAllSessions}
        />
        {recentSessions.length === 0 ? (
          <Text style={styles.emptyInline}>还没有会话。新建一个即可开始。</Text>
        ) : (
          recentSessions.map((session) => {
            const running = session.id === props.runningSessionId;
            return (
              <Pressable
                key={session.id}
                style={styles.listCard}
                onPress={() => props.onOpenSession(session)}
              >
                <View style={styles.listMain}>
                  <Text style={styles.listTitle} numberOfLines={1}>
                    {session.lastPreview || session.id.slice(0, 8)}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {basename(session.cwd)}
                    {session.updatedAt ? ` · ${formatRelative(session.updatedAt)}` : ""}
                  </Text>
                </View>
                <View style={[styles.statusDot, running ? styles.statusDotRun : styles.statusDotDone]} />
              </Pressable>
            );
          })
        )}

        <SectionTitle
          label="常用工作空间"
          actionLabel="查看全部 >"
          onAction={props.onViewAllWorkspaces}
        />
        {frequentProjects.length === 0 ? (
          <Text style={styles.emptyInline}>尚未授权工作空间。请在桌面端确认设备授权。</Text>
        ) : (
          frequentProjects.map((project) => (
            <Pressable
              key={project.path}
              style={styles.listCard}
              onPress={() => props.onOpenWorkspace(project.path)}
            >
              <View style={styles.workspaceIcon}>
                <Text style={styles.workspaceIconText}>{project.name.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={styles.listMain}>
                <Text style={styles.listTitle}>{project.name}</Text>
                <Text style={styles.meta} numberOfLines={1}>{project.path}</Text>
              </View>
              <View style={[styles.statusDot, connected ? styles.statusDotDone : styles.statusDotOff]} />
            </Pressable>
          ))
        )}

        {loading && projects.length === 0 ? (
          <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
        ) : null}
      </ScrollView>
    </View>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function formatRelative(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso.slice(0, 16);
  const delta = Date.now() - time;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(time).toLocaleDateString();
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1, paddingTop: spacing.sm },
  content: { gap: spacing.md, paddingBottom: spacing.xl },
  error: { color: colors.danger, fontSize: 13 },
  runningCard: {
    gap: spacing.md,
    borderColor: "#2A2150",
    backgroundColor: colors.brandSoft,
  },
  runningHead: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  taskGlyph: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#241B45",
    borderWidth: 1,
    borderColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  taskGlyphText: { color: colors.brandActive, fontSize: 16, fontWeight: "800" },
  runningCopy: { flex: 1, gap: 4 },
  runningTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: "700" },
  timerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 44,
  },
  timerText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600", flex: 1 },
  stopSquare: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  stopSquareInner: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: colors.danger,
  },
  stopPlaceholder: { width: 40, height: 40 },
  idleCard: { gap: spacing.sm },
  idleTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: "700" },
  idleText: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  idleAction: {
    alignSelf: "flex-start",
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.brandSoft,
    borderWidth: 1,
    borderColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.xs,
  },
  idleActionText: { color: colors.brandActive, fontWeight: "700", fontSize: 13 },
  actions: { flexDirection: "row", gap: spacing.sm },
  listCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 64,
  },
  listMain: { flex: 1, gap: 4 },
  listTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: "600" },
  meta: { color: colors.textSecondary, fontSize: 12 },
  emptyInline: { color: colors.textSecondary, fontSize: 13, marginBottom: spacing.sm },
  workspaceIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.brandSoft,
    borderColor: colors.brand,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceIconText: { color: colors.brandActive, fontWeight: "800" },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusDotRun: { backgroundColor: colors.brand },
  statusDotDone: { backgroundColor: colors.success },
  statusDotOff: { backgroundColor: colors.textMuted },
}));
