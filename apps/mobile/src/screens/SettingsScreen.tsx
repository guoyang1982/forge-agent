import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MobileHostSummary } from "../storage/host-store";
import type { MobileConnectionState } from "../transport/mobile-relay-client";
import { StatusPill, connectionStateLabel } from "../ui/components";
import { makeStyles } from "../ui/make-styles";
import {
  clearHiddenSessionIds,
  loadHiddenSessionIds,
  unhideSessionId,
} from "../storage/hidden-sessions-store";
import {
  THEME_DEFINITIONS,
  useTheme,
  radii,
  spacing,
} from "../ui/theme";

export function SettingsScreen(props: {
  hosts: MobileHostSummary[];
  connections: Record<string, MobileConnectionState>;
  selectedHostId: string | null;
  notificationsEnabled: boolean;
  onSelectHost: (hostId: string) => void;
  onRemoveHost: (hostId: string) => void;
  onRenameHost: (hostId: string, displayName: string) => void;
  onNotificationsEnabledChange: (enabled: boolean) => void;
  onAddHost: () => void;
  onOpenDiagnostics: () => void;
}) {
  const styles = useStyles();
  const { themeId, preference, setThemeId, colors, mode } = useTheme();
  const [renameTarget, setRenameTarget] = useState<MobileHostSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [hiddenSessionIds, setHiddenSessionIds] = useState<string[]>([]);
  const [showHiddenModal, setShowHiddenModal] = useState(false);

  useEffect(() => {
    let active = true;
    void loadHiddenSessionIds().then((ids) => {
      if (active) setHiddenSessionIds(ids);
    });
    return () => {
      active = false;
    };
  }, []);

  const confirmRemove = (host: MobileHostSummary) => {
    Alert.alert(
      "移除电脑",
      `确定移除「${host.displayName}」？将删除本机配对凭证，需重新扫码配对。`,
      [
        { text: "取消", style: "cancel" },
        { text: "移除", style: "destructive", onPress: () => props.onRemoveHost(host.hostId) },
      ],
    );
  };

  const openRename = (host: MobileHostSummary) => {
    setRenameDraft(host.displayName);
    setRenameTarget(host);
  };

  const currentThemeLabel = useMemo(() => {
    if (preference === "system") return `跟随系统（${mode === "dark" ? "深色" : "浅色"}）`;
    return THEME_DEFINITIONS.find((item) => item.id === themeId)?.label ?? themeId;
  }, [preference, themeId, mode]);

  return (
    <View style={styles.page}>
      <FlatList
        data={props.hosts}
        keyExtractor={(item) => item.hostId}
        contentContainerStyle={styles.hostList}
        ListHeaderComponent={
          <>
            <Text style={styles.title}>设备与设置</Text>
            <Text style={styles.sectionLabel}>已配对的电脑</Text>
          </>
        }
        ListEmptyComponent={<Text style={styles.empty}>还没有配对电脑。请在 Forge Desktop 的渠道页生成二维码。</Text>}
        renderItem={({ item }) => {
          const state = props.connections[item.hostId];
          const online = state === "authenticated";
          const selected = item.hostId === props.selectedHostId;
          return (
            <View style={[styles.hostCard, selected ? styles.hostCardActive : null]}>
              <Pressable
                style={styles.hostCardBody}
                onPress={() => props.onSelectHost(item.hostId)}
                onLongPress={() => openRename(item)}
              >
                <View style={styles.hostTitleRow}>
                  <Text style={styles.hostTitle}>{item.displayName}</Text>
                  {selected ? <StatusPill label="当前" tone="brand" /> : null}
                </View>
                <Text style={styles.hostMeta}>{item.relayOrigin}</Text>
                <View style={styles.statusRow}>
                  <View style={[styles.dot, online ? styles.dotOnline : styles.dotOffline]} />
                  <Text style={[styles.hostState, online ? styles.hostStateOnline : null]}>
                    {online ? "已连接" : connectionStateLabel(state)}
                  </Text>
                  {online ? <StatusPill label="E2EE" tone="success" /> : null}
                </View>
              </Pressable>
              <View style={styles.hostActions}>
                <Pressable style={styles.renameButton} onPress={() => openRename(item)}>
                  <Text style={styles.rename}>改名</Text>
                </Pressable>
                <Pressable style={styles.removeButton} onPress={() => confirmRemove(item)}>
                  <Text style={styles.remove}>移除</Text>
                </Pressable>
              </View>
            </View>
          );
        }}
        ListFooterComponent={
          <>
            <Pressable style={styles.pairButton} onPress={props.onAddHost}>
              <Text style={styles.pairButtonText}>＋ 配对新电脑</Text>
            </Pressable>

            <Text style={styles.sectionLabel}>偏好设置</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle}>本地通知</Text>
                  <Text style={styles.rowSubtitle}>
                    当前安装包暂未启用通知通道（修复启动崩溃中）。远程推送尚未支持。
                  </Text>
                </View>
                <Switch
                  value={props.notificationsEnabled}
                  onValueChange={props.onNotificationsEnabledChange}
                  trackColor={{ true: colors.brand, false: colors.border }}
                  thumbColor={props.notificationsEnabled ? colors.brandActive : colors.textMuted}
                />
              </View>
              <View style={[styles.row, styles.rowDivider]}>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle}>外观主题</Text>
                  <Text style={styles.rowSubtitle}>当前：{currentThemeLabel} · {mode === "dark" ? "深色" : "浅色"}</Text>
                </View>
              </View>
              <View style={styles.themeGrid}>
                <Pressable
                  style={[styles.themeCard, preference === "system" ? styles.themeCardActive : null]}
                  onPress={() => setThemeId("system")}
                  accessibilityRole="button"
                  accessibilityState={{ selected: preference === "system" }}
                  accessibilityLabel="跟随系统主题"
                >
                  <View style={styles.themeSwatches}>
                    <View style={[styles.swatch, { backgroundColor: "#080B10" }]} />
                    <View style={[styles.swatch, { backgroundColor: "#F4F6FA" }]} />
                    <View style={[styles.swatch, { backgroundColor: "#8B5CF6" }]} />
                  </View>
                  <Text style={styles.themeLabel}>跟随系统</Text>
                  <Text style={styles.themeMode}>自动</Text>
                </Pressable>
                {THEME_DEFINITIONS.map((theme) => {
                  const active = preference === theme.id;
                  return (
                    <Pressable
                      key={theme.id}
                      style={[styles.themeCard, active ? styles.themeCardActive : null]}
                      onPress={() => setThemeId(theme.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`主题 ${theme.label}`}
                    >
                      <View style={styles.themeSwatches}>
                        <View style={[styles.swatch, { backgroundColor: theme.colors.background }]} />
                        <View style={[styles.swatch, { backgroundColor: theme.colors.surface }]} />
                        <View style={[styles.swatch, { backgroundColor: theme.colors.brand }]} />
                      </View>
                      <Text style={styles.themeLabel}>{theme.label}</Text>
                      <Text style={styles.themeMode}>{theme.mode === "dark" ? "深色" : "浅色"}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <Text style={styles.sectionLabel}>会话可见性</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle}>本机隐藏会话</Text>
                  <Text style={styles.rowSubtitle}>已隐藏 {hiddenSessionIds.length} 条。仅影响当前设备显示。</Text>
                </View>
                <Pressable
                  style={styles.manageButton}
                  onPress={() => setShowHiddenModal(true)}
                  accessibilityRole="button"
                  accessibilityLabel="管理已隐藏会话"
                >
                  <Text style={styles.manageButtonText}>管理</Text>
                </Pressable>
              </View>
            </View>

            <Text style={styles.sectionLabel}>安全连接</Text>
            <View style={styles.e2eeCard}>
              <Text style={styles.e2eeTitle}>端到端加密</Text>
              <Text style={styles.cardText}>
                Forge 使用端到端加密（E2EE）保护你的数据。所有消息与文件在设备之间直接加密传输。设备凭证保存在系统安全存储中，不写入普通文件。
              </Text>
            </View>

            <Text style={styles.sectionLabel}>连接诊断</Text>
            <Pressable style={styles.diagnosticsButton} onPress={props.onOpenDiagnostics}>
              <Text style={styles.diagnosticsButtonText}>检查连接状态</Text>
              <Text style={styles.diagnosticsButtonHint}>仅记录脱敏状态，不记录 Prompt、回复或凭证</Text>
            </Pressable>
          </>
        }
      />

      <Modal visible={renameTarget !== null} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}>
        <Pressable style={styles.renameBackdrop} onPress={() => setRenameTarget(null)}>
          <View style={styles.renameSheet}>
            <Text style={styles.renameTitle}>重命名电脑</Text>
            <TextInput
              style={styles.renameInput}
              value={renameDraft}
              onChangeText={setRenameDraft}
              placeholder="显示名称"
              placeholderTextColor={colors.textMuted}
              autoFocus
            />
            <View style={styles.renameActions}>
              <Pressable style={styles.renameCancel} onPress={() => setRenameTarget(null)}>
                <Text style={styles.renameCancelText}>取消</Text>
              </Pressable>
              <Pressable
                style={styles.renameSave}
                onPress={() => {
                  const next = renameDraft.trim();
                  if (renameTarget && next) props.onRenameHost(renameTarget.hostId, next);
                  setRenameTarget(null);
                }}
              >
                <Text style={styles.renameSaveText}>保存</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={showHiddenModal} transparent animationType="fade" onRequestClose={() => setShowHiddenModal(false)}>
        <Pressable style={styles.renameBackdrop} onPress={() => setShowHiddenModal(false)}>
          <Pressable style={styles.renameSheet} onPress={(event) => event.stopPropagation()}>
            <Text style={styles.renameTitle}>已隐藏会话</Text>
            {hiddenSessionIds.length === 0 ? (
              <Text style={styles.cardText}>当前没有隐藏会话。</Text>
            ) : (
              <View style={styles.hiddenList}>
                {hiddenSessionIds.slice(0, 20).map((id) => (
                  <View key={id} style={styles.hiddenRow}>
                    <Text style={styles.hiddenId}>{id}</Text>
                    <Pressable
                      style={styles.hiddenAction}
                      onPress={() => {
                        void unhideSessionId(id).then((ids) => setHiddenSessionIds(ids));
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="恢复隐藏会话"
                    >
                      <Text style={styles.hiddenActionText}>恢复</Text>
                    </Pressable>
                  </View>
                ))}
                {hiddenSessionIds.length > 20 ? (
                  <Text style={styles.rowSubtitle}>仅展示前 20 条，可先恢复后继续查看。</Text>
                ) : null}
              </View>
            )}
            <View style={styles.renameActions}>
              <Pressable style={styles.renameCancel} onPress={() => setShowHiddenModal(false)}>
                <Text style={styles.renameCancelText}>关闭</Text>
              </Pressable>
              <Pressable
                style={styles.renameSave}
                onPress={() => {
                  if (hiddenSessionIds.length === 0) {
                    setShowHiddenModal(false);
                    return;
                  }
                  Alert.alert("恢复全部", "确认恢复当前设备上隐藏的全部会话？", [
                    { text: "取消", style: "cancel" },
                    {
                      text: "恢复全部",
                      onPress: () => {
                        void clearHiddenSessionIds().then((ids) => setHiddenSessionIds(ids));
                      },
                    },
                  ]);
                }}
              >
                <Text style={styles.renameSaveText}>恢复全部</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1, paddingTop: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: "700", marginBottom: spacing.lg },
  sectionLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  hostList: { paddingBottom: spacing.xl },
  empty: {
    color: colors.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    marginTop: spacing.xl,
    paddingHorizontal: spacing.xl,
  },
  hostCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginBottom: spacing.sm + spacing.xs,
  },
  hostCardActive: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  hostCardBody: { flex: 1, gap: spacing.xs },
  hostTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  hostTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: "700", flexShrink: 1 },
  hostMeta: { color: colors.textSecondary, fontSize: 12 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOnline: { backgroundColor: colors.success },
  dotOffline: { backgroundColor: colors.danger },
  hostState: { color: colors.textSecondary, fontSize: 12, fontWeight: "700" },
  hostStateOnline: { color: colors.success },
  hostActions: { alignItems: "flex-end", gap: spacing.sm },
  renameButton: { paddingHorizontal: spacing.sm, minHeight: 36, justifyContent: "center" },
  rename: { color: colors.brandActive, fontWeight: "600" },
  removeButton: { paddingHorizontal: spacing.sm, minHeight: 36, justifyContent: "center" },
  remove: { color: colors.danger, fontWeight: "600" },
  pairButton: {
    minHeight: 48,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.sm,
  },
  pairButtonText: { color: colors.brandActive, fontWeight: "800" },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  e2eeCard: {
    backgroundColor: colors.successSoft,
    borderColor: colors.borderAlt,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  e2eeTitle: { color: colors.success, fontSize: 14, fontWeight: "800" },
  cardText: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: 44,
  },
  rowDivider: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  rowCopy: { flex: 1 },
  rowTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: "700" },
  rowSubtitle: { color: colors.textSecondary, fontSize: 11, marginTop: spacing.xs },
  manageButton: {
    minHeight: 36,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.brandSoft,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
  manageButtonText: { color: colors.brandActive, fontSize: 12, fontWeight: "700" },
  themeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  themeCard: {
    width: "47%",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    padding: spacing.sm,
    gap: 4,
  },
  themeCardActive: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  themeSwatches: { flexDirection: "row", gap: 4, marginBottom: 4 },
  swatch: { flex: 1, height: 18, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  themeLabel: { color: colors.textPrimary, fontSize: 12, fontWeight: "700" },
  themeMode: { color: colors.textMuted, fontSize: 10 },
  diagnosticsButton: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    minHeight: 44,
  },
  diagnosticsButtonText: { color: colors.textPrimary, fontSize: 14, fontWeight: "700" },
  diagnosticsButtonHint: { color: colors.textSecondary, fontSize: 11, marginTop: spacing.xs },
  renameBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    padding: spacing.lg,
  },
  renameSheet: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  renameTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: "700" },
  renameInput: {
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
  },
  renameActions: { flexDirection: "row", gap: spacing.sm },
  hiddenList: { gap: spacing.sm, maxHeight: 280 },
  hiddenRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  hiddenId: { flex: 1, color: colors.textSecondary, fontSize: 11 },
  hiddenAction: {
    minHeight: 34,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
  hiddenActionText: { color: colors.textPrimary, fontSize: 12, fontWeight: "700" },
  renameCancel: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  renameCancelText: { color: colors.textSecondary, fontWeight: "700" },
  renameSave: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.md,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  renameSaveText: { color: "#fff", fontWeight: "800" },
}));
