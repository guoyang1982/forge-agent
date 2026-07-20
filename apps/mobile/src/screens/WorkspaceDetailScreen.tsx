import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { createForgeMobileApi, DiffItem, WorkspaceFile } from "../data/forge-mobile-api";
import type { SessionItem } from "./session-sanitize";
import {
  ListRow,
  PrimaryButton,
  SearchField,
  SectionTitle,
  SegmentedControl,
  StatusPill,
  WorkspaceGlyph,
} from "../ui/components";
import { colors, radii, spacing } from "../ui/theme";

type Api = ReturnType<typeof createForgeMobileApi>;
type DetailTab = "overview" | "files" | "sessions";

export function WorkspaceDetailScreen(props: {
  api: Api;
  cwd: string;
  runningSessionId?: string | null;
  liveText?: string;
  onBack: () => void;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onOpenSession: (session: SessionItem) => void;
  onNewSession: () => void;
  onCancelRun?: (sessionId: string) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [branch, setBranch] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [diffs, setDiffs] = useState<DiffItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [dirPath, setDirPath] = useState(".");
  const [entries, setEntries] = useState<WorkspaceFile[]>([]);
  const [fileQuery, setFileQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadMeta = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [branches, nextDiffs, nextSessions] = await Promise.all([
        props.api.branches(props.cwd),
        props.api.diffs(props.cwd),
        props.api.sessions(props.cwd),
      ]);
      setBranch(branches.current);
      setDirty(branches.dirty);
      setDiffs(nextDiffs);
      setSessions([...nextSessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [props.api, props.cwd]);

  const loadFiles = useCallback(async (path: string) => {
    setLoading(true);
    setError("");
    try {
      setEntries(await props.api.files(props.cwd, path));
      setDirPath(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法列出目录");
    } finally {
      setLoading(false);
    }
  }, [props.api, props.cwd]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === "files") void loadFiles(dirPath === "." ? "." : dirPath);
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const parentPath = dirPath === "." ? null : dirPath.split("/").slice(0, -1).join("/") || ".";
  const visibleEntries = entries.filter((entry) => {
    const needle = fileQuery.trim().toLowerCase();
    return !needle || entry.name.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle);
  });

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable style={styles.back} onPress={props.onBack}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <WorkspaceGlyph name={basename(props.cwd)} />
        <View style={styles.headerCopy}>
          <Text style={styles.title} numberOfLines={1}>{basename(props.cwd)}</Text>
          <Text style={styles.meta} numberOfLines={1}>{props.cwd}</Text>
        </View>
        <StatusPill label="已连接" tone="success" />
      </View>

      <SegmentedControl
        value={tab}
        onChange={setTab}
        options={[
          { key: "overview", label: "概览" },
          { key: "files", label: "文件" },
          { key: "sessions", label: "会话" },
        ]}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {tab === "overview" ? (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadMeta()} tintColor={colors.brand} />}
        >
          <View style={styles.badgeRow}>
            <StatusPill label={branch ? `分支 ${branch}` : "非 Git"} tone="neutral" />
            {dirty ? <StatusPill label="有未提交修改" tone="warning" /> : null}
            <StatusPill label="只读" tone="neutral" />
          </View>

          <Text style={styles.section}>活跃任务</Text>
          {(() => {
            const activeSession = props.runningSessionId
              ? sessions.find((item) => item.id === props.runningSessionId) ?? null
              : null;
            const activeInWorkspace = Boolean(
              props.runningSessionId
              && (!activeSession || pathsEqual(activeSession.cwd, props.cwd)),
            );
            if (!activeInWorkspace) {
              return (
                <View style={styles.card}>
                  <Text style={styles.emptyInline}>当前没有运行中的任务</Text>
                </View>
              );
            }
            const title = activeSession?.lastPreview
              || props.liveText?.slice(0, 80)
              || "任务执行中";
            const startedLabel = activeSession?.updatedAt
              ? `启动于 ${formatRelative(activeSession.updatedAt)} · 由你`
              : "运行中 · 由你";
            return (
              <View style={styles.activeTaskCard}>
                <Pressable
                  style={styles.activeTaskMain}
                  onPress={() => {
                    if (activeSession) props.onOpenSession(activeSession);
                  }}
                >
                  <View style={styles.taskGlyph}>
                    <Text style={styles.taskGlyphText}>☰</Text>
                  </View>
                  <View style={styles.activeTaskCopy}>
                    <View style={styles.activeTaskTitleRow}>
                      <Text style={styles.cardTitle} numberOfLines={1}>{title}</Text>
                      <StatusPill label="运行中" tone="brand" />
                    </View>
                    <Text style={styles.meta} numberOfLines={1}>{startedLabel}</Text>
                  </View>
                </Pressable>
                {props.onCancelRun && props.runningSessionId ? (
                  <Pressable
                    style={styles.stopSquare}
                    onPress={() => props.onCancelRun?.(props.runningSessionId!)}
                    accessibilityLabel="停止"
                  >
                    <View style={styles.stopSquareInner} />
                  </Pressable>
                ) : null}
              </View>
            );
          })()}

          <SectionTitle
            label="最近变更"
            actionLabel={"查看全部 >"}
            onAction={() => setTab("files")}
          />
          {diffs.length === 0 ? (
            <Text style={styles.emptyInline}>工作区没有 Diff。</Text>
          ) : (
            diffs.slice(0, 4).map((item) => (
              <ListRow
                key={item.path}
                title={item.path}
                subtitle={item.binary ? "二进制" : `+${item.additions} / -${item.deletions}`}
                onPress={() => props.onOpenDiff(item.path)}
              />
            ))
          )}

          <SectionTitle
            label="最近会话"
            actionLabel={"查看全部 >"}
            onAction={() => setTab("sessions")}
          />
          {sessions.length === 0 ? (
            <Text style={styles.emptyInline}>此工作空间还没有会话。</Text>
          ) : (
            sessions.slice(0, 3).map((session) => {
              const running = session.id === props.runningSessionId;
              return (
                <ListRow
                  key={session.id}
                  title={session.lastPreview || session.id.slice(0, 8)}
                  subtitle={
                    running
                      ? `${formatRelative(session.updatedAt) || "刚刚"} · 运行中`
                      : `${formatRelative(session.updatedAt) || session.id} · 已完成`
                  }
                  trailing={
                    <View style={[styles.statusDot, running ? styles.statusDotRun : styles.statusDotDone]}>
                      {running ? null : <Text style={styles.statusCheck}>✓</Text>}
                    </View>
                  }
                  onPress={() => props.onOpenSession(session)}
                />
              );
            })
          )}
        </ScrollView>
      ) : null}

      {tab === "files" ? (
        <View style={styles.flex}>
          <View style={styles.filesHead}>
            <Text style={styles.filesTitle}>文件</Text>
            <StatusPill label="只读" tone="neutral" />
            <View style={{ flex: 1 }} />
            <StatusPill label={branch || "非 Git"} tone="brand" />
          </View>
          <SearchField
            value={fileQuery}
            onChangeText={setFileQuery}
            placeholder="搜索文件或目录"
          />
          <Text style={styles.pathLine} numberOfLines={1}>{dirPath === "." ? basename(props.cwd) : dirPath}</Text>
          {parentPath ? (
            <Pressable style={styles.upRow} onPress={() => void loadFiles(parentPath)}>
              <Text style={styles.upText}>‹ 上级目录</Text>
            </Pressable>
          ) : null}
          <FlatList
            data={visibleEntries}
            keyExtractor={(item) => item.path}
            refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadFiles(dirPath)} tintColor={colors.brand} />}
            contentContainerStyle={styles.body}
            ListEmptyComponent={
              loading ? <ActivityIndicator color={colors.brand} /> : <Text style={styles.emptyInline}>目录为空。</Text>
            }
            ListFooterComponent={
              <Text style={styles.footerCount}>{visibleEntries.length} 个项目</Text>
            }
            renderItem={({ item }) => (
              <Pressable
                style={styles.fileRow}
                onPress={() => {
                  if (item.kind === "directory") void loadFiles(item.path);
                  else props.onOpenFile(item.path);
                }}
              >
                <Text style={styles.fileIcon}>
                  {item.kind === "directory" ? "📁" : item.kind === "binary" ? "📦" : "📄"}
                </Text>
                <View style={styles.fileCopy}>
                  <Text style={styles.fileName}>{item.name}</Text>
                  <Text style={styles.meta}>
                    {item.kind === "directory" ? "目录" : item.kind === "binary" ? "二进制" : "文件"}
                    {item.kind !== "directory" ? ` · ${formatBytes(item.size)}` : ""}
                  </Text>
                </View>
              </Pressable>
            )}
          />
        </View>
      ) : null}

      {tab === "sessions" ? (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadMeta()} tintColor={colors.brand} />}
          contentContainerStyle={styles.body}
          ListHeaderComponent={<PrimaryButton label="新建会话" onPress={props.onNewSession} />}
          ListEmptyComponent={<Text style={styles.emptyInline}>此工作空间还没有会话。</Text>}
          renderItem={({ item }) => (
            <ListRow
              title={item.lastPreview || item.id.slice(0, 8)}
              subtitle={item.updatedAt || item.id}
              onPress={() => props.onOpenSession(item)}
            />
          )}
        />
      ) : null}
    </View>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function pathsEqual(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

function formatRelative(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso ? iso.slice(0, 16) : "";
  const delta = Date.now() - time;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(time).toLocaleDateString();
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  page: { flex: 1, gap: spacing.md, paddingTop: spacing.xs },
  flex: { flex: 1, gap: spacing.sm },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backText: { color: colors.brandActive, fontSize: 28, fontWeight: "300", marginTop: -2 },
  headerCopy: { flex: 1 },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: "700" },
  meta: { color: colors.textSecondary, fontSize: 12 },
  body: { gap: spacing.sm, paddingBottom: spacing.xl, paddingTop: spacing.sm },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  section: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  sectionInline: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  sectionAction: {
    color: colors.brandActive,
    fontSize: 12,
    fontWeight: "700",
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  activeTaskCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 72,
  },
  activeTaskMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minWidth: 0,
  },
  taskGlyph: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  taskGlyphText: { color: colors.textSecondary, fontSize: 16, fontWeight: "700" },
  activeTaskCopy: { flex: 1, gap: 4, minWidth: 0 },
  activeTaskTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  cardTitle: { color: colors.textPrimary, fontWeight: "700", flexShrink: 1, fontSize: 15 },
  stopSquare: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  stopSquareInner: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: colors.textPrimary,
  },
  statusDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  statusDotRun: { backgroundColor: colors.brand },
  statusDotDone: { backgroundColor: colors.success },
  statusCheck: { color: "white", fontSize: 10, fontWeight: "900", lineHeight: 11 },
  filesHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  filesTitle: { color: colors.textPrimary, fontSize: 20, fontWeight: "700" },
  pathLine: { color: colors.textMuted, fontSize: 12 },
  upRow: { minHeight: 44, justifyContent: "center" },
  upText: { color: colors.brandActive, fontWeight: "700" },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 56,
  },
  fileIcon: { fontSize: 18 },
  fileCopy: { flex: 1, gap: 2 },
  fileName: { color: colors.textPrimary, fontWeight: "600" },
  footerCount: { color: colors.textMuted, textAlign: "center", marginTop: spacing.md, fontSize: 12 },
  emptyInline: { color: colors.textSecondary, fontSize: 13, marginVertical: spacing.sm },
  error: { color: colors.danger, fontSize: 13 },
});
