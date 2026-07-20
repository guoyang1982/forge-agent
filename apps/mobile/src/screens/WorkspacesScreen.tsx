import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { createForgeMobileApi } from "../data/forge-mobile-api";
import type { ProjectItem } from "./project-sanitize";
import type { MobileConnectionState } from "../transport/mobile-relay-client";
import {
  FilterChips,
  ListRow,
  PrimaryButton,
  SearchField,
  StatusPill,
  WorkspaceGlyph,
} from "../ui/components";
import type { MobileHostSummary } from "../storage/host-store";
import { colors, radii, spacing } from "../ui/theme";

type Api = ReturnType<typeof createForgeMobileApi>;
type ScopeFilter = "all" | "mine" | "joined";

export function WorkspacesScreen(props: {
  api: Api;
  hosts: MobileHostSummary[];
  connections: Record<string, MobileConnectionState>;
  selectedHostId: string | null;
  onSelectHost: (hostId: string) => void;
  onOpenWorkspace: (cwd: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [parentPath, setParentPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const connected = props.selectedHostId
    ? props.connections[props.selectedHostId] === "authenticated"
    : false;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setProjects(await props.api.projects());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [props.api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((item) => {
      if (needle && !item.name.toLowerCase().includes(needle) && !item.path.toLowerCase().includes(needle)) {
        return false;
      }
      // MVP: device grants don't expose ownership; keep chips visual and treat all as visible.
      if (scope === "mine") return item.kind === "workspace" || item.kind === "project";
      if (scope === "joined") return item.kind === "project";
      return true;
    });
  }, [projects, query, scope]);

  const createProject = async () => {
    if (!parentPath.trim() || !name.trim()) {
      Alert.alert("缺少信息", "请填写父目录路径和工作空间名称。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const created = await props.api.createProject(parentPath.trim(), name.trim());
      if (!created) throw new Error("创建失败");
      setCreating(false);
      setName("");
      await refresh();
      props.onOpenWorkspace(created.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Text style={styles.title}>工作空间</Text>
        <Pressable style={styles.addButton} onPress={() => setCreating((value) => !value)}>
          <Text style={styles.addButtonText}>{creating ? "收起" : "＋"}</Text>
        </Pressable>
      </View>

      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder="搜索工作空间"
        onSubmit={() => void refresh()}
      />

      <View style={styles.chips}>
        <FilterChips
          value={scope}
          onChange={setScope}
          options={[
            { key: "all", label: "全部" },
            { key: "mine", label: "我创建的" },
            { key: "joined", label: "我参与的" },
          ]}
        />
      </View>

      {creating ? (
        <View style={styles.createBox}>
          <TextInput
            style={styles.input}
            value={parentPath}
            onChangeText={setParentPath}
            placeholder="父目录绝对路径"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="工作空间名称"
            placeholderTextColor={colors.textMuted}
          />
          <PrimaryButton label="创建工作空间" onPress={() => void createProject()} />
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.path}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.brand} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
          ) : (
            <Text style={styles.empty}>没有匹配的工作空间。</Text>
          )
        }
        renderItem={({ item }) => (
          <ListRow
            leading={<WorkspaceGlyph name={item.name} />}
            title={item.name}
            subtitle={item.path}
            meta={item.kind === "workspace" ? "工作空间" : "项目"}
            trailing={<StatusPill label={connected ? "在线" : "离线"} tone={connected ? "success" : "neutral"} />}
            onPress={() => props.onOpenWorkspace(item.path)}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingTop: spacing.sm, gap: spacing.md },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
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
  chips: { marginTop: -spacing.xs },
  createBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  input: {
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
  },
  list: { gap: spacing.sm, paddingBottom: spacing.xl },
  empty: { color: colors.textSecondary, textAlign: "center", marginTop: 60 },
  error: { color: colors.danger, fontSize: 13 },
});
