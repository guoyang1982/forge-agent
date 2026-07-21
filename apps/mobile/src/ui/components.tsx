import type { ReactNode } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { MobileHostSummary } from "../storage/host-store";
import type { MobileConnectionState } from "../transport/mobile-relay-client";
import type { MobileWorkbenchState } from "../state/mobile-workbench-state";
import { colors, radii, spacing } from "./theme";

const forgeIcon = require("../../assets/forge-icon.png");

export type TabKey = MobileWorkbenchState["activeTab"];

const TAB_ICON_SIZE = 24;

const TABS: Array<{
  key: TabKey;
  label: string;
  Icon: (props: { color: string; filled: boolean; size?: number }) => ReactNode;
}> = [
  { key: "workbench", label: "工作台", Icon: HomeTabIcon },
  { key: "workspaces", label: "工作空间", Icon: FolderTabIcon },
  { key: "sessions", label: "会话", Icon: ChatTabIcon },
  { key: "settings", label: "设置", Icon: GearTabIcon },
];

export function BottomTabs(props: { activeTab: TabKey; onChange: (tab: TabKey) => void }) {
  return (
    <View style={styles.tabBar}>
      {TABS.map((tab) => {
        const active = tab.key === props.activeTab;
        const color = active ? colors.brandActive : colors.textMuted;
        const Icon = tab.Icon;
        return (
          <Pressable
            key={tab.key}
            style={styles.tab}
            onPress={() => props.onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <View style={styles.tabIconSlot}>
              <Icon color={color} filled={active} size={TAB_ICON_SIZE} />
            </View>
            <Text style={[styles.tabLabel, active ? styles.tabLabelActive : null]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Shared 24×24 slot so every tab icon has equal visual dimensions. */
function TabIconFrame(props: { size: number; children: ReactNode }) {
  return (
    <View style={{ width: props.size, height: props.size, alignItems: "center", justifyContent: "center" }}>
      {props.children}
    </View>
  );
}

function HomeTabIcon(props: { color: string; filled: boolean; size?: number }) {
  const size = props.size ?? TAB_ICON_SIZE;
  const stroke = 1.75;
  const bodyW = size * 0.52;
  const bodyH = size * 0.38;
  const roofBase = size * 0.72;
  const roofH = size * 0.3;
  const doorW = size * 0.16;
  const doorH = size * 0.2;
  return (
    <TabIconFrame size={size}>
      <View style={{ alignItems: "center" }}>
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: roofBase / 2,
            borderRightWidth: roofBase / 2,
            borderBottomWidth: roofH,
            borderLeftColor: "transparent",
            borderRightColor: "transparent",
            borderBottomColor: props.color,
            marginBottom: -stroke * 0.5,
          }}
        />
        <View
          style={{
            width: bodyW,
            height: bodyH,
            backgroundColor: props.filled ? props.color : "transparent",
            borderWidth: props.filled ? 0 : stroke,
            borderColor: props.color,
            borderTopWidth: 0,
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          <View
            style={{
              width: doorW,
              height: doorH,
              backgroundColor: props.filled ? colors.surface : props.color,
              borderTopLeftRadius: 1,
              borderTopRightRadius: 1,
            }}
          />
        </View>
      </View>
    </TabIconFrame>
  );
}

function FolderTabIcon(props: { color: string; filled: boolean; size?: number }) {
  const size = props.size ?? TAB_ICON_SIZE;
  const stroke = 1.75;
  const tabW = size * 0.38;
  const tabH = size * 0.14;
  const bodyW = size * 0.78;
  const bodyH = size * 0.52;
  return (
    <TabIconFrame size={size}>
      <View style={{ alignItems: "flex-start" }}>
        <View
          style={{
            width: tabW,
            height: tabH,
            backgroundColor: props.filled ? props.color : "transparent",
            borderWidth: props.filled ? 0 : stroke,
            borderColor: props.color,
            borderBottomWidth: 0,
            borderTopLeftRadius: 3,
            borderTopRightRadius: 3,
            marginLeft: size * 0.04,
          }}
        />
        <View
          style={{
            width: bodyW,
            height: bodyH,
            backgroundColor: props.filled ? props.color : "transparent",
            borderWidth: props.filled ? 0 : stroke,
            borderColor: props.color,
            borderRadius: 3,
            marginTop: props.filled ? 0 : -stroke,
          }}
        />
      </View>
    </TabIconFrame>
  );
}

function ChatTabIcon(props: { color: string; filled: boolean; size?: number }) {
  const size = props.size ?? TAB_ICON_SIZE;
  const stroke = 1.75;
  const bubbleW = size * 0.78;
  const bubbleH = size * 0.58;
  const plus = size * 0.26;
  const plusStroke = 1.75;
  const plusColor = props.filled ? colors.surface : props.color;
  return (
    <TabIconFrame size={size}>
      <View
        style={{
          width: bubbleW,
          height: bubbleH,
          backgroundColor: props.filled ? props.color : "transparent",
          borderWidth: props.filled ? 0 : stroke,
          borderColor: props.color,
          borderRadius: 5,
        }}
      >
        <View
          style={{
            position: "absolute",
            top: size * 0.1,
            right: size * 0.1,
            width: plus,
            height: plus,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View style={{ position: "absolute", width: plus, height: plusStroke, backgroundColor: plusColor, borderRadius: 1 }} />
          <View style={{ position: "absolute", width: plusStroke, height: plus, backgroundColor: plusColor, borderRadius: 1 }} />
        </View>
      </View>
    </TabIconFrame>
  );
}

function GearTabIcon(props: { color: string; filled: boolean; size?: number }) {
  const size = props.size ?? TAB_ICON_SIZE;
  const stroke = 1.75;
  const outer = size * 0.78;
  const hub = size * 0.28;
  const toothW = size * 0.18;
  const toothH = size * 0.14;
  const toothStyle = {
    position: "absolute" as const,
    width: toothW,
    height: toothH,
    backgroundColor: props.color,
    borderRadius: 1.5,
  };
  return (
    <TabIconFrame size={size}>
      <View style={{ width: outer, height: outer, alignItems: "center", justifyContent: "center" }}>
        {/* N / E / S / W teeth */}
        <View style={[toothStyle, { top: 0, left: (outer - toothW) / 2 }]} />
        <View style={[toothStyle, { bottom: 0, left: (outer - toothW) / 2 }]} />
        <View style={[toothStyle, { left: 0, top: (outer - toothH) / 2, width: toothH, height: toothW }]} />
        <View style={[toothStyle, { right: 0, top: (outer - toothH) / 2, width: toothH, height: toothW }]} />
        {/* Diagonal teeth */}
        <View style={[toothStyle, { top: size * 0.08, left: size * 0.08, width: toothH, height: toothW, transform: [{ rotate: "45deg" }] }]} />
        <View style={[toothStyle, { top: size * 0.08, right: size * 0.08, width: toothH, height: toothW, transform: [{ rotate: "-45deg" }] }]} />
        <View style={[toothStyle, { bottom: size * 0.08, left: size * 0.08, width: toothH, height: toothW, transform: [{ rotate: "-45deg" }] }]} />
        <View style={[toothStyle, { bottom: size * 0.08, right: size * 0.08, width: toothH, height: toothW, transform: [{ rotate: "45deg" }] }]} />
        <View
          style={{
            width: outer * 0.62,
            height: outer * 0.62,
            borderRadius: outer * 0.31,
            backgroundColor: props.filled ? props.color : colors.surface,
            borderWidth: props.filled ? 0 : stroke,
            borderColor: props.color,
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1,
          }}
        >
          <View
            style={{
              width: hub,
              height: hub,
              borderRadius: hub / 2,
              backgroundColor: props.filled ? colors.surface : "transparent",
              borderWidth: stroke,
              borderColor: props.color,
            }}
          />
        </View>
      </View>
    </TabIconFrame>
  );
}

/** Primary brand mark in page titles and host headers (matches Workbench two-line header). */
export const FORGE_MARK_MD = 32;
/** In-content identity (e.g. agent turn avatar). */
export const FORGE_MARK_SM = 22;
/** Inline meta next to secondary header text. */
export const FORGE_MARK_XS = 14;

export type ForgeMarkSize = "xs" | "sm" | "md" | number;

const FORGE_MARK_SIZES = {
  xs: FORGE_MARK_XS,
  sm: FORGE_MARK_SM,
  md: FORGE_MARK_MD,
} as const;

export function ForgeMark(props: { size?: ForgeMarkSize }) {
  const size = typeof props.size === "number" ? props.size : FORGE_MARK_SIZES[props.size ?? "md"];
  const radius = size * 0.28;
  return (
    <View style={[styles.mark, { width: size, height: size, borderRadius: radius }]}>
      <Image
        source={forgeIcon}
        accessibilityLabel="Forge"
        resizeMode="cover"
        style={{ width: size, height: size, borderRadius: radius }}
      />
    </View>
  );
}

export function MobileShell(props: {
  title?: string;
  subtitle?: string;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  headerRight?: ReactNode;
  banner?: ReactNode;
  hideHeader?: boolean;
  hideTabs?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={styles.shell}>
      {!props.hideHeader && props.title ? (
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <View style={styles.headerBrandRow}>
              <ForgeMark size="md" />
              <Text style={styles.title}>{props.title}</Text>
            </View>
            {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
          </View>
          {props.headerRight ? <View style={styles.headerRight}>{props.headerRight}</View> : null}
        </View>
      ) : null}
      {props.banner}
      <View style={styles.content}>{props.children}</View>
      {props.hideTabs ? null : (
        <BottomTabs activeTab={props.activeTab} onChange={props.onTabChange} />
      )}
    </View>
  );
}

export function HostPicker(props: {
  hosts: MobileHostSummary[];
  selectedHostId: string | null;
  connections: Record<string, MobileConnectionState>;
  onSelect: (hostId: string) => void;
  compact?: boolean;
}) {
  if (props.hosts.length === 0) return null;
  const selected = props.hosts.find((host) => host.hostId === props.selectedHostId) ?? props.hosts[0];
  const state = selected ? props.connections[selected.hostId] : undefined;

  if (props.compact && selected) {
    return (
      <View style={styles.compactHost}>
        <Pressable
          style={styles.compactHostButton}
          onPress={() => {
            const index = props.hosts.findIndex((host) => host.hostId === selected.hostId);
            const next = props.hosts[(index + 1) % props.hosts.length];
            if (next) props.onSelect(next.hostId);
          }}
        >
          <ForgeMark size="md" />
          <View style={styles.compactHostCopy}>
            <View style={styles.compactTitleRow}>
              <Text style={styles.compactBrand}>Forge</Text>
              <Text style={styles.compactSep}>·</Text>
              <Text style={styles.compactHostName} numberOfLines={1}>{selected.displayName}</Text>
              <Text style={styles.compactChevron}>▾</Text>
            </View>
            <View style={styles.e2eeRow}>
              <View style={[styles.hostDot, connectionDotStyle(state)]} />
              <Text style={styles.e2eeText}>
                {state === "authenticated" ? "已连接 · 端到端加密 (E2EE)" : connectionStateLabel(state)}
              </Text>
            </View>
          </View>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.hostRow} contentContainerStyle={styles.hostRowContent}>
      {props.hosts.map((host) => {
        const active = host.hostId === props.selectedHostId;
        return (
          <Pressable
            key={host.hostId}
            style={[styles.hostChip, active ? styles.hostChipActive : null]}
            onPress={() => props.onSelect(host.hostId)}
          >
            <View style={[styles.hostDot, connectionDotStyle(props.connections[host.hostId])]} />
            <Text style={styles.hostChipText} numberOfLines={1}>{host.displayName}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function ConnectionBanner(props: { state: MobileConnectionState | undefined; label?: string }) {
  if (!props.state || props.state === "authenticated") return null;
  const tone = props.state === "error" ? styles.bannerError : props.state === "closed" ? styles.bannerWarn : styles.bannerInfo;
  return (
    <View style={[styles.banner, tone]}>
      <Text style={styles.bannerText}>{props.label ?? connectionStateLabel(props.state)}</Text>
    </View>
  );
}

export function connectionStateLabel(state: MobileConnectionState | undefined): string {
  if (state === "connecting") return "连接中…";
  if (state === "authenticated") return "已连接 · 端到端加密 (E2EE)";
  if (state === "error") return "连接错误 · 点击重试";
  if (state === "closed") return "已断开 · 点击重连";
  return "点击连接";
}

function connectionDotStyle(state: MobileConnectionState | undefined): StyleProp<ViewStyle> {
  if (state === "authenticated") return { backgroundColor: colors.success };
  if (state === "error") return { backgroundColor: colors.danger };
  if (state === "connecting") return { backgroundColor: colors.warning };
  return { backgroundColor: colors.textSecondary };
}

export function PrimaryButton(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  tone?: "brand" | "danger" | "warning";
}) {
  const tone = props.tone ?? "brand";
  return (
    <Pressable
      disabled={props.disabled}
      style={[
        styles.primaryButton,
        tone === "danger" ? styles.primaryDanger : null,
        tone === "warning" ? styles.primaryWarning : null,
        props.style,
        props.disabled ? styles.buttonDisabled : null,
      ]}
      onPress={props.onPress}
    >
      <Text style={styles.primaryButtonText}>{props.label}</Text>
    </Pressable>
  );
}

export function SecondaryButton(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      disabled={props.disabled}
      style={[styles.secondaryButton, props.style, props.disabled ? styles.buttonDisabled : null]}
      onPress={props.onPress}
    >
      <Text style={styles.secondaryButtonText}>{props.label}</Text>
    </Pressable>
  );
}

export function Card(props: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, props.style]}>{props.children}</View>;
}

export function SectionTitle(props: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{props.label}</Text>
      {props.actionLabel && props.onAction ? (
        <Pressable style={styles.sectionAction} onPress={props.onAction} hitSlop={8}>
          <Text style={styles.sectionActionText}>{props.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EmptyState(props: { message: string }) {
  return <Text style={styles.empty}>{props.message}</Text>;
}

export function PlaceholderScreen(props: { title: string; description: string }) {
  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderTitle}>{props.title}</Text>
      <Text style={styles.placeholderText}>{props.description}</Text>
    </View>
  );
}

export function StatusPill(props: {
  label: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "brand";
}) {
  const tone = props.tone ?? "neutral";
  return (
    <View style={[styles.pill, tone === "success" ? styles.pillSuccess
      : tone === "warning" ? styles.pillWarning
        : tone === "danger" ? styles.pillDanger
          : tone === "brand" ? styles.pillBrand
            : styles.pillNeutral]}>
      <Text style={[styles.pillText, tone === "success" ? { color: colors.success }
        : tone === "warning" ? { color: colors.warning }
          : tone === "danger" ? { color: colors.danger }
            : tone === "brand" ? { color: colors.brandActive }
              : { color: colors.textSecondary }]}>{props.label}</Text>
    </View>
  );
}

export function ProgressStages(props: { stages: string[]; activeIndex: number }) {
  return (
    <View style={styles.stages}>
      {props.stages.map((stage, index) => {
        const active = index === props.activeIndex;
        const done = index < props.activeIndex;
        return (
          <View key={stage} style={styles.stageItem}>
            <View style={[
              styles.stageDot,
              done ? styles.stageDotDone : null,
              active ? styles.stageDotActive : null,
            ]}>
              {done ? <Text style={styles.stageCheck}>✓</Text> : null}
            </View>
            <Text style={[styles.stageLabel, active ? styles.stageLabelActive : done ? styles.stageLabelDone : null]}>
              {stage}
            </Text>
            {index < props.stages.length - 1 ? (
              <View style={[styles.stageLine, done || active ? styles.stageLineOn : null]} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function QuickAction(props: {
  label: string;
  hint?: string;
  icon?: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      style={[styles.quickAction, props.primary ? styles.quickActionPrimary : null]}
      onPress={props.onPress}
    >
      <Text style={[styles.quickActionIcon, props.primary ? { color: colors.brandActive } : null]}>
        {props.icon ?? (props.primary ? "＋" : "⬚")}
      </Text>
      <Text style={[styles.quickActionLabel, props.primary ? styles.quickActionLabelPrimary : null]}>
        {props.label}
      </Text>
      {props.hint ? <Text style={styles.quickActionHint}>{props.hint}</Text> : null}
    </Pressable>
  );
}

export function SearchField(props: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  onSubmit?: () => void;
}) {
  return (
    <View style={styles.searchWrap}>
      <Text style={styles.searchIcon}>⌕</Text>
      <TextInput
        style={styles.searchInput}
        value={props.value}
        onChangeText={props.onChangeText}
        onSubmitEditing={props.onSubmit}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
    </View>
  );
}

export function SegmentedControl<T extends string>(props: {
  options: Array<{ key: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {props.options.map((option) => {
        const active = option.key === props.value;
        return (
          <Pressable
            key={option.key}
            style={[styles.segment, active ? styles.segmentActive : null]}
            onPress={() => props.onChange(option.key)}
          >
            <Text style={[styles.segmentText, active ? styles.segmentTextActive : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function FilterChips<T extends string>(props: {
  options: Array<{ key: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipScroll}
      contentContainerStyle={styles.chipRow}
    >
      {props.options.map((option) => {
        const active = option.key === props.value;
        return (
          <Pressable
            key={option.key}
            style={[styles.filterChip, active ? styles.filterChipActive : null]}
            onPress={() => props.onChange(option.key)}
          >
            <Text style={[styles.filterChipText, active ? styles.filterChipTextActive : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function ListRow(props: {
  title: string;
  subtitle?: string;
  meta?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
}) {
  const body = (
    <>
      {props.leading}
      <View style={styles.listRowCopy}>
        <Text style={styles.listRowTitle} numberOfLines={2}>{props.title}</Text>
        {props.subtitle ? <Text style={styles.listRowSubtitle} numberOfLines={1}>{props.subtitle}</Text> : null}
        {props.meta ? <Text style={styles.listRowMeta} numberOfLines={1}>{props.meta}</Text> : null}
      </View>
      {props.trailing}
    </>
  );
  if (!props.onPress) return <View style={styles.listRow}>{body}</View>;
  return <Pressable style={styles.listRow} onPress={props.onPress}>{body}</Pressable>;
}

export function WorkspaceGlyph(props: { name: string }) {
  return (
    <View style={styles.workspaceGlyph}>
      <Text style={styles.workspaceGlyphText}>{props.name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerCopy: { flex: 1 },
  headerBrandRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  headerRight: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: "700" },
  subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: spacing.xs },
  content: { flex: 1, paddingHorizontal: spacing.lg },
  mark: {
    overflow: "hidden",
    backgroundColor: "#0B0614",
    alignItems: "center",
    justifyContent: "center",
  },
  tabBar: {
    flexDirection: "row",
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 54, gap: 2 },
  tabIconSlot: {
    width: TAB_ICON_SIZE,
    height: TAB_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  tabLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "600" },
  tabLabelActive: { color: colors.brandActive, fontWeight: "800" },
  compactHost: { marginBottom: spacing.md },
  compactHostButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 52,
  },
  compactHostCopy: { flex: 1, gap: 4 },
  compactTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  compactBrand: { color: colors.textPrimary, fontSize: 20, fontWeight: "800" },
  compactSep: { color: colors.textSecondary, fontSize: 18, fontWeight: "600" },
  compactHostName: { color: colors.textPrimary, fontSize: 20, fontWeight: "700", flexShrink: 1 },
  compactChevron: { color: colors.textSecondary, fontSize: 14, marginLeft: spacing.xs },
  e2eeRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  e2eeText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  hostRow: { flexGrow: 0, marginBottom: spacing.md },
  hostRowContent: { gap: spacing.sm },
  hostChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    justifyContent: "center",
  },
  hostChipActive: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  hostChipText: { color: colors.textPrimary, fontSize: 13, fontWeight: "600", maxWidth: 140 },
  hostDot: { width: 8, height: 8, borderRadius: 4 },
  banner: { marginBottom: spacing.md, borderRadius: radii.md, padding: spacing.md },
  bannerInfo: { backgroundColor: colors.brandSoft, borderColor: colors.brand, borderWidth: 1 },
  bannerWarn: { backgroundColor: colors.warningSoft, borderColor: colors.warning, borderWidth: 1 },
  bannerError: { backgroundColor: colors.dangerSoft, borderColor: colors.danger, borderWidth: 1 },
  bannerText: { color: colors.textPrimary, fontSize: 12, fontWeight: "600" },
  primaryButton: {
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  primaryDanger: { backgroundColor: colors.danger },
  primaryWarning: { backgroundColor: colors.warning },
  primaryButtonText: { color: "white", fontWeight: "700" },
  secondaryButton: {
    borderColor: colors.borderAlt,
    borderWidth: 1,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  secondaryButtonText: { color: "#c5ceda", fontWeight: "600" },
  buttonDisabled: { opacity: 0.4 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
    marginTop: spacing.xs,
    minHeight: 28,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  sectionAction: {
    minHeight: 28,
    justifyContent: "center",
    paddingLeft: spacing.md,
  },
  sectionActionText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  empty: {
    color: colors.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    marginTop: 40,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.xl, gap: spacing.sm },
  placeholderTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: "700" },
  placeholderText: { color: colors.textSecondary, fontSize: 13, textAlign: "center", lineHeight: 20 },
  pill: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  pillNeutral: { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
  pillSuccess: { backgroundColor: colors.successSoft, borderColor: "#1B5E34" },
  pillWarning: { backgroundColor: colors.warningSoft, borderColor: "#7A5410" },
  pillDanger: { backgroundColor: colors.dangerSoft, borderColor: "#7F1D1D" },
  pillBrand: { backgroundColor: colors.brandSoft, borderColor: colors.brand },
  pillText: { fontSize: 11, fontWeight: "700" },
  stages: { flexDirection: "row", alignItems: "center", marginVertical: spacing.sm },
  stageItem: { flexDirection: "row", alignItems: "center", flex: 1 },
  stageDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "transparent",
    borderWidth: 1.5,
    borderColor: colors.borderAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  stageDotDone: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  stageDotActive: {
    backgroundColor: colors.brand,
    borderColor: "#E9D5FF",
    borderWidth: 2,
    shadowColor: colors.brand,
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  stageCheck: { color: "white", fontSize: 9, fontWeight: "900", lineHeight: 10 },
  stageLabel: { color: colors.textMuted, fontSize: 11, marginLeft: 6, marginRight: 4 },
  stageLabelActive: { color: colors.brandActive, fontWeight: "800" },
  stageLabelDone: { color: colors.brandActive, fontWeight: "700" },
  stageLine: { flex: 1, height: 2, backgroundColor: colors.border, marginRight: 4, minWidth: 12 },
  stageLineOn: { backgroundColor: colors.brand },
  quickAction: {
    flex: 1,
    minHeight: 84,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.md,
    justifyContent: "center",
    gap: 4,
  },
  quickActionPrimary: { backgroundColor: colors.brandSoft, borderColor: colors.brand },
  quickActionIcon: { color: colors.textSecondary, fontSize: 16, fontWeight: "700" },
  quickActionLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: "700" },
  quickActionLabelPrimary: { color: colors.brandActive },
  quickActionHint: { color: colors.textSecondary, fontSize: 11 },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  searchIcon: { color: colors.textMuted, fontSize: 16 },
  searchInput: { flex: 1, color: colors.textPrimary, fontSize: 14, minHeight: 44 },
  segmented: {
    flexDirection: "row",
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.md,
    padding: 3,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentActive: { backgroundColor: colors.brand },
  segmentText: { color: colors.textSecondary, fontWeight: "600", fontSize: 13 },
  segmentTextActive: { color: "white", fontWeight: "800" },
  chipScroll: { flexGrow: 0, flexShrink: 0, maxHeight: 44 },
  chipRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    alignItems: "center",
    paddingRight: spacing.lg,
  },
  filterChip: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  filterChipActive: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  filterChipText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  filterChipTextActive: { color: colors.brandActive, fontWeight: "800" },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    minHeight: 64,
  },
  listRowCopy: { flex: 1, gap: 3 },
  listRowTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: "600" },
  listRowSubtitle: { color: colors.textSecondary, fontSize: 12 },
  listRowMeta: { color: colors.textMuted, fontSize: 11 },
  workspaceGlyph: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.brandSoft,
    borderColor: colors.brand,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceGlyphText: { color: colors.brandActive, fontWeight: "800", fontSize: 16 },
});
