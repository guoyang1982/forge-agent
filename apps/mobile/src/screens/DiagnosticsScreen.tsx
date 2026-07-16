import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { ConnectionDiagnostic } from "../diagnostics/connection-diagnostics";

export function DiagnosticsScreen(props: {
  entries: ConnectionDiagnostic[];
  onBack: () => void;
  onClear: () => void;
}) {
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

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#080b10", paddingHorizontal: 18, paddingTop: 18 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 18 },
  headerCopy: { flex: 1 },
  back: { color: "#a78bfa", paddingVertical: 8 },
  clear: { color: "#f87171", paddingVertical: 8 },
  title: { color: "#f8fafc", fontSize: 20, fontWeight: "700" },
  subtitle: { color: "#788397", fontSize: 11, marginTop: 4 },
  list: { gap: 8, paddingBottom: 28 },
  empty: { color: "#697386", textAlign: "center", marginTop: 80 },
  row: { flexDirection: "row", gap: 10, backgroundColor: "#10151e", borderColor: "#202936", borderWidth: 1, borderRadius: 13, padding: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  info: { backgroundColor: "#60a5fa" },
  warn: { backgroundColor: "#fbbf24" },
  error: { backgroundColor: "#f87171" },
  body: { flex: 1 },
  event: { color: "#e5e7eb", fontSize: 13, fontWeight: "700" },
  meta: { color: "#667085", fontSize: 10, marginTop: 3 },
  message: { color: "#9aa5b5", fontSize: 12, lineHeight: 17, marginTop: 6 },
});
