import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [query, setQuery] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(props.workspaceFilter ?? null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextProjects = await props.api.projects();
      setProjects(nextProjects);
      const lists = await Promise.all(
        nextProjects.map((project) =>
          props.api.sessions(project.path, query.trim() || undefined).catch(() => [] as SessionItem[]),
        ),
      );
      const byId = new Map<string, SessionItem>();
      for (const list of lists) {
        for (const session of list) byId.set(session.id, session);
      }
      setSessions([...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [props.api, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setWorkspaceId(props.workspaceFilter ?? null);
  }, [props.workspaceFilter]);

  const filtered = useMemo(() => {
    return sessions.filter((session) => {
      if (workspaceId && session.cwd !== workspaceId) return false;
      if (statusFilter === "running") return session.id === props.runningSessionId;
      if (statusFilter === "unread") return props.unreadSessionIds.includes(session.id);
      if (statusFilter === "done") {
        return session.id !== props.runningSessionId && session.messageCount > 0;
      }
      return true;
    });
  }, [sessions, workspaceId, statusFilter, props.runningSessionId, props.unreadSessionIds]);

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
          ) : (
            <Text style={styles.empty}>没有匹配的会话。</Text>
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

const styles = StyleSheet.create({
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
  empty: { color: colors.textSecondary, textAlign: "center", marginTop: 40 },
  error: { color: colors.danger, fontSize: 13 },
});
