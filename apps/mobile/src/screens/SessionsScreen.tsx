import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import type { createForgeMobileApi } from "../data/forge-mobile-api";
import type { ProjectItem } from "./project-sanitize";
import type { SessionItem } from "./session-sanitize";
import type { MobileConnectionState } from "../transport/mobile-relay-client";
import {
  FilterChips,
  ListRow,
  SearchField,
  StatusPill,
  WorkspaceGlyph,
} from "../ui/components";
import type { MobileHostSummary } from "../storage/host-store";
import { hideSessionId, loadHiddenSessionIds } from "../storage/hidden-sessions-store";
import { makeStyles } from "../ui/make-styles";
import { colors, radii, spacing } from "../ui/theme";

type Api = ReturnType<typeof createForgeMobileApi>;
type StatusFilter = "all" | "running" | "unread" | "done";

export function SessionsScreen(props: {
  api: Api;
  hosts: MobileHostSummary[];
  connections: Record<string, MobileConnectionState>;
  selectedHostId: string | null;
  runningSessionId: string | null;
  unreadSessionIds: string[];
  workspaceFilter?: string | null;
  onSelectHost: (hostId: string) => void;
  onOpenSession: (session: SessionItem) => void;
  onNewSession: (cwd?: string) => void;
}) {
  const styles = useStyles();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(props.workspaceFilter ?? null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextProjects, nextSessions, hidden] = await Promise.all([
        props.api.projects(),
        props.api.sessions(undefined, query.trim() || undefined),
        loadHiddenSessionIds(),
      ]);
      setProjects(nextProjects);
      setHiddenIds(hidden);
      setSessions(nextSessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [props.api, query]);

  useEffect(() => {
    void refresh();
  }, [props.api]); // eslint-disable-line react-hooks/exhaustive-deps -- search runs on submit, not every keystroke

  useEffect(() => {
    setWorkspaceId(props.workspaceFilter ?? null);
  }, [props.workspaceFilter]);

  const filtered = useMemo(() => {
    return sessions.filter((session) => {
      if (hiddenIds.includes(session.id)) return false;
      if (workspaceId && session.cwd !== workspaceId) return false;
      if (statusFilter === "running") return session.id === props.runningSessionId;
      if (statusFilter === "unread") return props.unreadSessionIds.includes(session.id);
      if (statusFilter === "done") {
        return session.id !== props.runningSessionId && session.messageCount > 0;
      }
      return true;
    });
  }, [sessions, hiddenIds, workspaceId, statusFilter, props.runningSessionId, props.unreadSessionIds]);

  const workspaceOptions = useMemo(
    () => [{ path: null as string | null, name: "全部工作空间" }, ...projects.map((p) => ({ path: p.path, name: p.name }))],
    [projects],
  );

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Text style={styles.title}>会话</Text>
        <Pressable style={styles.addButton} onPress={() => props.onNewSession(workspaceId ?? undefined)}>
          <Text style={styles.addButtonText}>＋</Text>
        </Pressable>
      </View>

      <View style={styles.filters}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索会话"
          onSubmit={() => void refresh()}
        />
        <FilterChips
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { key: "all", label: "全部" },
            { key: "running", label: "运行中" },
            { key: "unread", label: "未读" },
            { key: "done", label: "已完成" },
          ]}
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.workspaceScroll}
          contentContainerStyle={styles.workspaceRow}
        >
          {workspaceOptions.map((item) => {
            const active = workspaceId === item.path;
            return (
              <Pressable
                key={item.path ?? "all"}
                style={[styles.workspaceChip, active ? styles.workspaceChipActive : null]}
                onPress={() => setWorkspaceId(item.path)}
              >
                <Text style={[styles.workspaceChipText, active ? styles.workspaceChipTextActive : null]}>
                  {item.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <FlatList
        style={styles.list}
        data={filtered}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.brand} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
          ) : sessions.length === 0 && statusFilter === "all" && !workspaceId && !query.trim() ? (
            <View style={styles.emptyBox}>
              <Text style={styles.empty}>还没有会话</Text>
              <Text style={styles.emptyHint}>新建会话后即可开始与 Agent 对话</Text>
              <Pressable style={styles.emptyCta} onPress={() => props.onNewSession(workspaceId ?? undefined)}>
                <Text style={styles.emptyCtaText}>新建会话</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.emptyBox}>
              <Text style={styles.empty}>没有匹配的会话</Text>
              <Text style={styles.emptyHint}>试试清除筛选，或切换工作空间</Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const unread = props.unreadSessionIds.includes(item.id);
          const running = item.id === props.runningSessionId;
          return (
            <ListRow
              leading={<WorkspaceGlyph name={basename(item.cwd)} />}
              title={item.lastPreview || item.id.slice(0, 8)}
              subtitle={basename(item.cwd)}
              meta={item.updatedAt ? item.updatedAt.slice(0, 16).replace("T", " ") : item.id.slice(0, 8)}
              trailing={
                <StatusPill
                  label={running ? "运行中" : unread ? "未读" : "已完成"}
                  tone={running ? "brand" : unread ? "warning" : "success"}
                />
              }
              onPress={() => props.onOpenSession(item)}
              onLongPress={() => {
                Alert.alert(
                  item.lastPreview?.slice(0, 40) || "会话操作",
                  "远端暂不支持永久删除。可在本机隐藏，或分享会话 ID。",
                  [
                    { text: "取消", style: "cancel" },
                    {
                      text: "本机隐藏",
                      style: "destructive",
                      onPress: () => {
                        void hideSessionId(item.id).then((ids) => {
                          setHiddenIds(ids);
                        });
                      },
                    },
                    {
                      text: "分享会话 ID",
                      onPress: () => void Share.share({ message: item.id }),
                    },
                    {
                      text: "复制预览",
                      onPress: () => {
                        void Clipboard.setStringAsync(item.lastPreview || item.id).then(() => {
                          Alert.alert("已复制", item.lastPreview || item.id);
                        });
                      },
                    },
                  ],
                );
              }}
              accessibilityLabel={`会话 ${item.lastPreview || item.id.slice(0, 8)}`}
              accessibilityHint="长按可隐藏或分享"
            />
          );
        }}
      />
    </View>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1, paddingTop: spacing.sm },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: "700" },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonText: { color: "white", fontSize: 22, fontWeight: "700", lineHeight: 24 },
  filters: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.background,
    zIndex: 2,
  },
  workspaceScroll: { flexGrow: 0, flexShrink: 0, maxHeight: 44 },
  workspaceRow: { gap: spacing.sm, alignItems: "center", paddingRight: spacing.lg },
  workspaceChip: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceChipActive: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  workspaceChipText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  workspaceChipTextActive: { color: colors.brandActive, fontWeight: "800" },
  list: { flex: 1, zIndex: 1 },
  listContent: { gap: spacing.sm, paddingBottom: spacing.xl, flexGrow: 1 },
  empty: { color: colors.textPrimary, textAlign: "center", fontSize: 16, fontWeight: "700" },
  emptyBox: { alignItems: "center", gap: spacing.sm, marginTop: 60, paddingHorizontal: spacing.xl },
  emptyHint: { color: colors.textSecondary, textAlign: "center", fontSize: 13, lineHeight: 18 },
  emptyCta: {
    marginTop: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyCtaText: { color: "white", fontWeight: "800" },
  error: { color: colors.danger, fontSize: 13 },
}));
