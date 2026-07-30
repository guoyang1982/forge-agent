import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  Text,
  View,
} from "react-native";
import type { createForgeMobileApi, DiffContent } from "../data/forge-mobile-api";
import { SegmentedControl, StatusPill } from "../ui/components";
import { makeStyles } from "../ui/make-styles";
import { colors, radii, spacing } from "../ui/theme";

type Api = ReturnType<typeof createForgeMobileApi>;

export function DiffScreen(props: {
  api: Api;
  cwd: string;
  path: string;
  onBack: () => void;
  /** Long-press back: jump out of file/diff stack in one step. */
  onBackToRoot?: () => void;
  onMentionInSession?: (path: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const styles = useStyles();
  const [mode, setMode] = useState<"file" | "diff">("diff");
  const [diff, setDiff] = useState<DiffContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void props.api.diff(props.cwd, props.path).then((next) => {
      if (cancelled) return;
      setDiff(next);
      if (!next) setError("无法读取 Diff");
      setLoading(false);
    }).catch((cause) => {
      if (cancelled) return;
      setError(cause instanceof Error ? cause.message : "读取失败");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [props.api, props.cwd, props.path]);

  const lines = useMemo(() => (diff?.unifiedDiff ?? "").split("\n"), [diff?.unifiedDiff]);

  function lineBg(line: string) {
    if (line.startsWith("+") && !line.startsWith("+++")) return styles.addBg;
    if (line.startsWith("-") && !line.startsWith("---")) return styles.delBg;
    return null;
  }

  function lineStyle(line: string) {
    if (line.startsWith("+") && !line.startsWith("+++")) return styles.add;
    if (line.startsWith("-") && !line.startsWith("---")) return styles.del;
    if (line.startsWith("@@")) return styles.hunk;
    return styles.context;
  }

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable
          style={styles.back}
          onPress={props.onBack}
          onLongPress={props.onBackToRoot}
          delayLongPress={350}
          accessibilityLabel="返回"
          accessibilityHint={props.onBackToRoot ? "长按直接回到工作空间或会话" : undefined}
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.path} numberOfLines={2}>{props.path}</Text>
        <StatusPill label="只读" tone="neutral" />
      </View>

      <SegmentedControl
        value={mode}
        onChange={(next) => {
          setMode(next);
          if (next === "file") props.onOpenFile?.(props.path);
        }}
        options={[
          { key: "file", label: "文件" },
          { key: "diff", label: "Diff" },
        ]}
      />

      {loading ? <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {diff && mode === "diff" ? (
        <FlatList
          style={{ flex: 1 }}
          data={lines}
          keyExtractor={(line, index) => `${index}:${line.slice(0, 24)}`}
          initialNumToRender={40}
          windowSize={11}
          ListHeaderComponent={
            diff.truncated ? (
              <View style={styles.banner}>
                <Text style={styles.bannerText}>Diff 已截断：超过只读大小限制。</Text>
              </View>
            ) : null
          }
          renderItem={({ item: line, index }) => (
            <View style={[styles.lineRow, lineBg(line)]}>
              <Text style={styles.lineNo}>{index + 1}</Text>
              <Text style={lineStyle(line)}>{line || " "}</Text>
            </View>
          )}
          contentContainerStyle={styles.body}
        />
      ) : null}

      <View style={styles.actions}>
        <Pressable
          style={styles.action}
          onPress={() => {
            void Clipboard.setStringAsync(props.path).then(() => {
              Alert.alert("已复制", props.path);
            });
          }}
        >
          <Text style={styles.actionText}>复制路径</Text>
        </Pressable>
        <Pressable
          style={[styles.action, styles.actionPrimary]}
          onPress={() => props.onMentionInSession?.(props.path)}
        >
          <Text style={[styles.actionText, styles.actionTextPrimary]}>在会话中提及</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1, gap: spacing.md },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backText: { color: colors.brandActive, fontSize: 28, fontWeight: "300" },
  path: { flex: 1, color: colors.textPrimary, fontSize: 14, fontWeight: "600" },
  body: { paddingBottom: spacing.xl, minWidth: "100%" },
  banner: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  bannerText: { color: colors.warning, fontSize: 12, fontWeight: "600" },
  lineRow: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.sm, paddingVertical: 1 },
  lineNo: { width: 36, color: colors.textMuted, fontFamily: "Menlo", fontSize: 11, lineHeight: 16 },
  addBg: { backgroundColor: "#0F2418" },
  delBg: { backgroundColor: "#241216" },
  add: { color: colors.add, fontFamily: "Menlo", fontSize: 11, lineHeight: 16, flexShrink: 1 },
  del: { color: colors.del, fontFamily: "Menlo", fontSize: 11, lineHeight: 16, flexShrink: 1 },
  hunk: { color: colors.brandActive, fontFamily: "Menlo", fontSize: 11, lineHeight: 16, flexShrink: 1 },
  context: { color: colors.textSecondary, fontFamily: "Menlo", fontSize: 11, lineHeight: 16, flexShrink: 1 },
  actions: { flexDirection: "row", gap: spacing.sm, paddingBottom: spacing.sm },
  action: {
    flex: 1,
    minHeight: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  actionPrimary: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  actionText: { color: colors.textPrimary, fontWeight: "700" },
  actionTextPrimary: { color: colors.brandActive },
  error: { color: colors.danger, fontSize: 13 },
}));
