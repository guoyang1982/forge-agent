import { FlatList, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import type { MobileHostSummary } from "../storage/host-store";
import type { MobileConnectionState } from "../transport/mobile-relay-client";
import { StatusPill, connectionStateLabel } from "../ui/components";
import { colors, radii, spacing } from "../ui/theme";

export function SettingsScreen(props: {
  hosts: MobileHostSummary[];
  connections: Record<string, MobileConnectionState>;
  selectedHostId: string | null;
  onSelectHost: (hostId: string) => void;
  onRemoveHost: (hostId: string) => void;
  onAddHost: () => void;
  onOpenDiagnostics: () => void;
}) {
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
              <Pressable style={styles.hostCardBody} onPress={() => props.onSelectHost(item.hostId)}>
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
              <Pressable style={styles.removeButton} onPress={() => props.onRemoveHost(item.hostId)}>
                <Text style={styles.remove}>移除</Text>
              </Pressable>
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
                  <Text style={styles.rowTitle}>推送通知</Text>
                  <Text style={styles.rowSubtitle}>首版暂不支持后台推送</Text>
                </View>
                <Text style={styles.rowValue}>未启用</Text>
              </View>
              <View style={[styles.row, styles.rowDivider]}>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle}>外观</Text>
                  <Text style={styles.rowSubtitle}>始终深色</Text>
                </View>
                <Switch value={true} disabled trackColor={{ true: colors.brand }} />
              </View>
            </View>

            <Text style={styles.sectionLabel}>安全连接</Text>
            <View style={styles.e2eeCard}>
              <Text style={styles.e2eeTitle}>🔒 端到端加密</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingTop: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: "700", marginBottom: spacing.lg },
  sectionLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 0.5, marginTop: spacing.lg, marginBottom: spacing.sm },
  hostList: { paddingBottom: spacing.xl },
  empty: { color: colors.textSecondary, textAlign: "center", lineHeight: 22, marginTop: spacing.xl, paddingHorizontal: spacing.xl },
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
  removeButton: { paddingHorizontal: spacing.sm, minHeight: 44, justifyContent: "center" },
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
    borderColor: "#1F3D2A",
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  e2eeTitle: { color: colors.success, fontSize: 14, fontWeight: "800" },
  cardText: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, minHeight: 44 },
  rowDivider: { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, marginTop: spacing.sm, paddingTop: spacing.sm },
  rowCopy: { flex: 1 },
  rowTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: "700" },
  rowSubtitle: { color: colors.textSecondary, fontSize: 11, marginTop: spacing.xs },
  rowValue: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
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
});
