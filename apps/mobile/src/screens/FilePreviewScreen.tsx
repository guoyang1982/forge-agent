import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { createForgeMobileApi, WorkspaceContent } from "../data/forge-mobile-api";
import { SegmentedControl, StatusPill } from "../ui/components";
import { CodeHighlight } from "../ui/code-highlight";
import { MarkdownBody } from "../ui/markdown";
import { colors, radii, spacing } from "../ui/theme";

type Api = ReturnType<typeof createForgeMobileApi>;

export function FilePreviewScreen(props: {
  api: Api;
  cwd: string;
  path: string;
  onBack: () => void;
  onMentionInSession?: (path: string) => void;
  onOpenDiff?: (path: string) => void;
}) {
  const [content, setContent] = useState<WorkspaceContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"file" | "diff">("file");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void props.api.file(props.cwd, props.path).then((next) => {
      if (cancelled) return;
      setContent(next);
      if (!next) setError("无法读取文件");
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

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable style={styles.back} onPress={props.onBack}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.path} numberOfLines={2}>{props.path}</Text>
      </View>

      <SegmentedControl
        value={mode}
        onChange={(next) => {
          setMode(next);
          if (next === "diff") props.onOpenDiff?.(props.path);
        }}
        options={[
          { key: "file", label: "文件" },
          { key: "diff", label: "Diff" },
        ]}
      />

      <View style={styles.badgeRow}>
        <StatusPill label="只读" tone="neutral" />
        {content?.kind === "text" ? <StatusPill label={content.language} tone="brand" /> : null}
      </View>

      {loading ? <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {content?.kind === "binary" ? (
        <View style={styles.metaCard}>
          <Text style={styles.metaTitle}>二进制文件</Text>
          <Text style={styles.meta}>类型：{content.mime || "unknown"}</Text>
          <Text style={styles.meta}>大小：{formatBytes(content.size)}</Text>
          <Text style={styles.meta}>首版仅展示元信息，不提供内容预览。</Text>
        </View>
      ) : null}

      {content?.kind === "text" && mode === "file" ? (
        <ScrollView contentContainerStyle={styles.body} horizontal={false}>
          {content.truncated ? (
            <View style={styles.banner}>
              <Text style={styles.bannerText}>内容已截断：超过只读预览大小限制。</Text>
            </View>
          ) : null}
          {isMarkdown(content.language, props.path) ? (
            <MarkdownBody text={content.content} />
          ) : (
            <ScrollView horizontal nestedScrollEnabled contentContainerStyle={styles.codeScroll}>
              <CodeHighlight
                code={content.content}
                language={content.language}
                path={props.path}
              />
            </ScrollView>
          )}
        </ScrollView>
      ) : null}

      <View style={styles.actions}>
        <Pressable style={styles.action} onPress={() => void Share.share({ message: props.path })}>
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

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isMarkdown(language: string, path: string): boolean {
  return /markdown|md/i.test(language) || /\.md$/i.test(path);
}

const styles = StyleSheet.create({
  page: { flex: 1, gap: spacing.md },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backText: { color: colors.brandActive, fontSize: 28, fontWeight: "300" },
  path: { flex: 1, color: colors.textPrimary, fontSize: 14, fontWeight: "600" },
  badgeRow: { flexDirection: "row", gap: spacing.sm },
  body: { paddingBottom: spacing.xl, gap: spacing.sm },
  codeScroll: { paddingBottom: spacing.sm, minWidth: "100%" },
  banner: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  bannerText: { color: colors.warning, fontSize: 12, fontWeight: "600" },
  metaCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  metaTitle: { color: colors.textPrimary, fontWeight: "700", fontSize: 15 },
  meta: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
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
});
