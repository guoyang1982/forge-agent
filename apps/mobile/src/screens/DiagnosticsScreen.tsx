import { FlatList, Pressable, Text, View } from "react-native";
import type { ConnectionDiagnostic } from "../diagnostics/connection-diagnostics";
import { makeStyles } from "../ui/make-styles";
import { radii, spacing } from "../ui/theme";

export function DiagnosticsScreen(props: {
  entries: ConnectionDiagnostic[];
  onBack: () => void;
  onClear: () => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={props.onBack}><Text style={styles.back}>‹ 返回</Text></Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>连接诊断</Text>
          <Text style={styles.subtitle}>仅记录脱敏连接状态，不记录 Prompt、回复或凭证</Text>
        </View>
        <Pressable onPress={props.onClear}><Text style={styles.clear}>清空</Text></Pressable>
      </View>
      <FlatList
        data={props.entries}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>暂无诊断事件</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={[styles.dot, item.level === "error" ? styles.error : item.level === "warn" ? styles.warn : styles.info]} />
            <View style={styles.body}>
              <Text style={styles.event}>{item.event}</Text>
              <Text style={styles.meta}>{item.hostId} · {new Date(item.at).toLocaleTimeString()}</Text>
              {item.message ? <Text style={styles.message}>{item.message}</Text> : null}
            </View>
          </View>
        )}
      />
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.lg + 2, paddingTop: spacing.lg + 2 },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: spacing.lg + 2 },
  headerCopy: { flex: 1 },
  back: { color: colors.brandActive, paddingVertical: spacing.sm },
  clear: { color: colors.danger, paddingVertical: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: "700" },
  subtitle: { color: colors.textSecondary, fontSize: 11, marginTop: spacing.xs },
  list: { gap: spacing.sm, paddingBottom: spacing.xl + 4 },
  empty: { color: colors.textMuted, textAlign: "center", marginTop: 80 },
  row: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg - 3,
    padding: spacing.md,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  info: { backgroundColor: "#60a5fa" },
  warn: { backgroundColor: colors.warning },
  error: { backgroundColor: colors.danger },
  body: { flex: 1 },
  event: { color: colors.textPrimary, fontSize: 13, fontWeight: "700" },
  meta: { color: colors.textMuted, fontSize: 10, marginTop: 3 },
  message: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: spacing.sm - 2 },
}));
