import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Alert, Appearance, AppState, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { ForgeMobilePairingOfferV1 } from "@forge/mobile-protocol";
import { parsePairingUri } from "./src/pairing/parse-pairing";
import {
  listHosts,
  loadHostSecret,
  reconcileHostsWithSecrets,
  removeHost,
  renameHost,
  saveHost,
  assertSecureStoreAvailable,
  type MobileHostSummary,
} from "./src/storage/host-store";
import {
  loadLastHostId,
  loadNotificationsEnabled,
  loadThemeId,
  saveLastHostId,
  saveNotificationsEnabled,
  saveThemeId,
  type ThemePreference,
} from "./src/storage/preferences-store";
import { resolveThemePreference } from "./src/ui/theme-preference";
import {
  ensureAndroidNotificationChannel,
  ensureNotificationPermission,
} from "./src/notifications/local-notify";
import {
  DEFAULT_THEME_ID,
  ThemeProvider,
  spacing,
  useTheme,
  type ThemeId,
} from "./src/ui/theme";
import { makeStyles } from "./src/ui/make-styles";
import {
  MobileRelayClient,
  type MobileConnectionState,
} from "./src/transport/mobile-relay-client";
import { ConnectionGenerations } from "./src/transport/connection-generations";
import { createForgeMobileApi } from "./src/data/forge-mobile-api";
import { DiagnosticsScreen } from "./src/screens/DiagnosticsScreen";
import { PairingScreen } from "./src/screens/PairingScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { WorkbenchScreen } from "./src/screens/WorkbenchScreen";
import { WorkspacesScreen } from "./src/screens/WorkspacesScreen";
import { WorkspaceDetailScreen } from "./src/screens/WorkspaceDetailScreen";
import { FilePreviewScreen } from "./src/screens/FilePreviewScreen";
import { DiffScreen } from "./src/screens/DiffScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ConversationScreen } from "./src/screens/ConversationScreen";
import type { SessionItem } from "./src/screens/session-sanitize";
import {
  diagnosticEntry,
  retryDelayMs,
  shouldRetryConnection,
  type ConnectionDiagnostic,
} from "./src/diagnostics/connection-diagnostics";
import {
  initialMobileWorkbenchState,
  mobileWorkbenchReducer,
} from "./src/state/mobile-workbench-state";
import {
  ConnectionBanner,
  EmptyState,
  HostPicker,
  MobileShell,
  PrimaryButton,
} from "./src/ui/components";
import { popNavToRoot, reduceNavStack, type NavTarget } from "./src/navigation/nav-stack";

export default function App() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(DEFAULT_THEME_ID);
  const [colorScheme, setColorScheme] = useState(Appearance.getColorScheme());
  const [themeReady, setThemeReady] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const themeId = resolveThemePreference(themePreference, colorScheme);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [storedTheme, notifyEnabled] = await Promise.all([
          loadThemeId(),
          loadNotificationsEnabled(),
        ]);
        if (cancelled) return;
        setThemePreference(storedTheme);
        setNotificationsEnabled(notifyEnabled);
        if (notifyEnabled) {
          void ensureAndroidNotificationChannel();
          void ensureNotificationPermission();
        }
      } catch {
        // Prefer a usable UI over a blank forever splash if prefs fail.
      } finally {
        if (!cancelled) setThemeReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme: next }) => {
      setColorScheme(next);
    });
    return () => sub.remove();
  }, []);

  const setThemeId = (id: ThemePreference) => {
    setThemePreference(id);
    void saveThemeId(id);
  };

  const onNotificationsEnabledChange = (enabled: boolean) => {
    setNotificationsEnabled(enabled);
    void saveNotificationsEnabled(enabled);
    if (enabled) {
      void ensureAndroidNotificationChannel();
      void ensureNotificationPermission();
    }
  };

  if (!themeReady) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: "#080B10" }} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider
        themeId={themeId}
        preference={themePreference}
        onThemeIdChange={setThemeId}
      >
        <MobileApp
          key={`${themePreference}:${themeId}`}
          notificationsEnabled={notificationsEnabled}
          onNotificationsEnabledChange={onNotificationsEnabledChange}
        />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/** Tracks how the remembered host from the last launch has resolved, to decide auto-selection fallback. */
type RememberedHostStatus = "none" | "pending" | "resolved";

function MobileApp(props: {
  notificationsEnabled: boolean;
  onNotificationsEnabledChange: (enabled: boolean) => void;
}) {
  const styles = useStyles();
  const { mode: themeMode } = useTheme();
  const [hosts, setHosts] = useState<MobileHostSummary[]>([]);
  const [pairing, setPairing] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [pendingPairing, setPendingPairing] = useState<{ hostId: string; relayOrigin: string } | null>(null);
  const [connections, setConnections] = useState<Record<string, MobileConnectionState>>({});
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnostic[]>([]);
  const [navStack, setNavStack] = useState<NavTarget[]>([]);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [pendingMention, setPendingMention] = useState<string | null>(null);
  const [state, dispatch] = useReducer(mobileWorkbenchReducer, initialMobileWorkbenchState);
  const clients = useRef(new Map<string, MobileRelayClient>());
  const pendingOffer = useRef<ForgeMobilePairingOfferV1 | null>(null);
  const hostsRef = useRef<MobileHostSummary[]>([]);
  const selectedHostIdRef = useRef<string | null>(null);
  const runningSessionIdRef = useRef<string | null>(null);
  const appActive = useRef(AppState.currentState === "active");
  const connectingHosts = useRef(new Set<string>());
  const intentionalCloses = useRef(new Set<string>());
  const retryAttempts = useRef(new Map<string, number>());
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const probeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingExplicitHostId = useRef<string | null>(null);
  const removedHostIds = useRef(new Set<string>());
  const pendingReconnectHostIds = useRef(new Set<string>());
  const connectionGenerations = useRef(new ConnectionGenerations());

  // Launch-time auto-entry bookkeeping (see Step 5 of the Task 4 brief).
  const autoSelectDone = useRef(false);
  const rememberedHostId = useRef<string | null>(null);
  const rememberedHostStatus = useRef<RememberedHostStatus>("none");
  const authenticatedOrder = useRef<string[]>([]);
  const persistedLastHostId = useRef<string | null | undefined>(undefined);

  const refresh = () => void listHosts().then(setHosts);
  useEffect(() => {
    hostsRef.current = hosts;
  }, [hosts]);

  useEffect(() => {
    selectedHostIdRef.current = state.selectedHostId;
  }, [state.selectedHostId]);

  useEffect(() => {
    runningSessionIdRef.current = state.runningSessionId;
  }, [state.runningSessionId]);

  useEffect(() => {
    if (
      persistedLastHostId.current === undefined ||
      persistedLastHostId.current === state.lastHostId
    ) return;
    persistedLastHostId.current = state.lastHostId;
    void saveLastHostId(state.lastHostId);
  }, [state.lastHostId]);

  useEffect(() => {
    if (
      persistedLastHostId.current === undefined ||
      !state.lastHostId ||
      hosts.some((host) => host.hostId === state.lastHostId)
    ) return;
    dispatch({ type: "host.forgotten", hostId: state.lastHostId });
  }, [hosts, state.lastHostId]);

  const addDiagnostic = (
    hostId: string,
    level: ConnectionDiagnostic["level"],
    event: string,
    message = "",
  ) => {
    const entry = diagnosticEntry({ hostId, level, event, message });
    setDiagnostics((current) => [entry, ...current].slice(0, 100));
  };

  const clearHostTimers = (hostId: string) => {
    const retry = retryTimers.current.get(hostId);
    if (retry) clearTimeout(retry);
    retryTimers.current.delete(hostId);
    const probe = probeTimers.current.get(hostId);
    if (probe) clearTimeout(probe);
    probeTimers.current.delete(hostId);
  };

  const closeHost = (hostId: string) => {
    connectionGenerations.current.invalidate(hostId);
    clearHostTimers(hostId);
    const client = clients.current.get(hostId);
    if (!client) return;
    intentionalCloses.current.add(hostId);
    client.close();
    intentionalCloses.current.delete(hostId);
    clients.current.delete(hostId);
  };

  const clearConnectionState = (hostId: string) => {
    setConnections((current) => {
      const next = { ...current };
      delete next[hostId];
      return next;
    });
  };

  const markConnecting = (hostId: string) => {
    setConnections((current) => ({ ...current, [hostId]: "connecting" }));
  };

  /** Applies the Step 5 auto-entry rule: prefer the remembered host, otherwise the first host to authenticate. */
  const maybeAutoSelect = (hostId: string, authenticated: boolean) => {
    if (autoSelectDone.current) return;
    if (authenticated && !authenticatedOrder.current.includes(hostId)) {
      authenticatedOrder.current.push(hostId);
    }
    if (hostId === rememberedHostId.current) {
      if (authenticated) {
        autoSelectDone.current = true;
        dispatch({ type: "host.selected", hostId });
        return;
      }
      rememberedHostStatus.current = "resolved";
    }
    if (rememberedHostStatus.current !== "pending" && authenticatedOrder.current.length > 0) {
      autoSelectDone.current = true;
      dispatch({ type: "host.selected", hostId: authenticatedOrder.current[0] ?? null });
    }
  };

  const onConnectionState = (hostId: string, generation: number) => (
    connState: MobileConnectionState,
    error?: string,
  ) => {
    if (
      connectionGenerations.current.disposed ||
      removedHostIds.current.has(hostId) ||
      !connectionGenerations.current.isCurrent(hostId, generation)
    ) return;
    setConnections((current) => ({ ...current, [hostId]: connState }));
    if (connState === "authenticated") {
      retryAttempts.current.set(hostId, 0);
      addDiagnostic(hostId, "info", "E2EE 已连接");
      maybeAutoSelect(hostId, true);
      if (selectedHostIdRef.current === hostId) {
        dispatch({ type: "connection.reconnected" });
      }
    } else if (connState === "error") {
      addDiagnostic(hostId, "error", "连接失败", error);
      maybeAutoSelect(hostId, false);
      if (!intentionalCloses.current.has(hostId)) scheduleReconnect(hostId, error ?? "连接失败");
    } else if (connState === "closed") {
      addDiagnostic(hostId, "info", "连接已关闭");
      maybeAutoSelect(hostId, false);
      if (!intentionalCloses.current.has(hostId)) scheduleReconnect(hostId, "连接已关闭");
    } else {
      addDiagnostic(hostId, "info", "正在连接");
    }
  };

  const scheduleReconnect = (hostId: string, reason: string) => {
    if (!appActive.current || retryTimers.current.has(hostId) || !shouldRetryConnection(reason)) return;
    const host = hostsRef.current.find((item) => item.hostId === hostId);
    if (!host) return;
    const attempt = retryAttempts.current.get(hostId) ?? 0;
    const delay = retryDelayMs(attempt);
    retryAttempts.current.set(hostId, attempt + 1);
    addDiagnostic(hostId, "warn", "等待重连", `${Math.ceil(delay / 1000)} 秒后重试`);
    const timer = setTimeout(() => {
      retryTimers.current.delete(hostId);
      void connectHost(host, { silent: true, select: false });
    }, delay);
    retryTimers.current.set(hostId, timer);
  };

  const startProbe = (host: MobileHostSummary, client: MobileRelayClient, generation: number) => {
    const previous = probeTimers.current.get(host.hostId);
    if (previous) clearTimeout(previous);
    const probe = async () => {
      if (
        !appActive.current ||
        removedHostIds.current.has(host.hostId) ||
        !connectionGenerations.current.isCurrent(host.hostId, generation) ||
        clients.current.get(host.hostId) !== client
      ) return;
      try {
        await client.call("status.get", {});
        probeTimers.current.set(host.hostId, setTimeout(() => void probe(), 30_000));
      } catch (error) {
        addDiagnostic(host.hostId, "warn", "活性探测失败", error instanceof Error ? error.message : "timeout");
        closeHost(host.hostId);
        setConnections((current) => ({ ...current, [host.hostId]: "error" }));
        scheduleReconnect(host.hostId, error instanceof Error ? error.message : "probe failed");
      }
    };
    probeTimers.current.set(host.hostId, setTimeout(() => void probe(), 30_000));
  };

  const acceptCode = (value: string) => {
    try {
      const offer = parsePairingUri(value);
      pendingOffer.current = offer;
      setPendingPairing({ hostId: offer.hostId, relayOrigin: offer.relayOrigin });
      setManualCode("");
      Alert.alert("配对码有效", "下一步将连接 Relay 并完成端到端握手。凭证尚未写入普通存储。");
    } catch (error) {
      Alert.alert("无法配对", error instanceof Error ? error.message : "配对码无效");
    }
  };

  const closePairing = () => {
    pendingOffer.current = null;
    setPendingPairing(null);
    setManualCode("");
    setPairing(false);
  };

  const completePairing = async () => {
    const offer = pendingOffer.current;
    if (!offer) return;
    closeHost(offer.hostId);
    const generation = connectionGenerations.current.begin(offer.hostId);
    pendingReconnectHostIds.current.delete(offer.hostId);
    removedHostIds.current.delete(offer.hostId);
    // The one-time secret leaves UI state before any network operation and is never logged.
    pendingOffer.current = null;
    setPendingPairing(null);
    let client: MobileRelayClient | null = null;
    try {
      await assertSecureStoreAvailable();
      if (
        connectionGenerations.current.disposed ||
        removedHostIds.current.has(offer.hostId) ||
        !connectionGenerations.current.isCurrent(offer.hostId, generation)
      ) return;
      client = await MobileRelayClient.pair(
        offer,
        onConnectionState(offer.hostId, generation),
      );
      if (
        connectionGenerations.current.disposed ||
        removedHostIds.current.has(offer.hostId) ||
        !connectionGenerations.current.isCurrent(offer.hostId, generation)
      ) {
        intentionalCloses.current.add(offer.hostId);
        client.close();
        intentionalCloses.current.delete(offer.hostId);
        clearConnectionState(offer.hostId);
        return;
      }
      const summary: MobileHostSummary = {
        hostId: offer.hostId,
        deviceId: offer.deviceId,
        relayOrigin: offer.relayOrigin,
        hostE2eePublicKey: offer.hostE2eePublicKey,
        displayName: `Forge ${offer.hostId.slice(-6)}`,
        pairedAt: new Date().toISOString(),
      };
      await saveHost(summary, {
        version: 1,
        deviceToken: client.state.deviceToken,
        resumeToken: client.state.resumeToken,
      });
      const nextHosts = await listHosts();
      if (
        connectionGenerations.current.disposed ||
        removedHostIds.current.has(offer.hostId) ||
        !connectionGenerations.current.isCurrent(offer.hostId, generation)
      ) {
        intentionalCloses.current.add(offer.hostId);
        client.close();
        intentionalCloses.current.delete(offer.hostId);
        clearConnectionState(offer.hostId);
        return;
      }
      clients.current.set(offer.hostId, client);
      hostsRef.current = nextHosts;
      setHosts(nextHosts);
      startProbe(summary, client, generation);
      setPairing(false);
      autoSelectDone.current = true;
      dispatch({ type: "host.selected", hostId: offer.hostId });
      dispatch({ type: "tab.selected", tab: "sessions" });
      Alert.alert("配对成功", "设备凭证已写入系统安全存储，E2EE 连接已建立。");
    } catch (error) {
      if (client) {
        intentionalCloses.current.add(offer.hostId);
        client.close();
        intentionalCloses.current.delete(offer.hostId);
      }
      if (!connectionGenerations.current.disposed) {
        Alert.alert("配对失败", error instanceof Error ? error.message : "无法建立安全连接");
      }
    }
  };

  const connectHost = async (
    host: MobileHostSummary,
    options: { silent?: boolean; select?: boolean } = {},
  ) => {
    if (connectingHosts.current.has(host.hostId)) return;
    connectingHosts.current.add(host.hostId);
    markConnecting(host.hostId);
    const retry = retryTimers.current.get(host.hostId);
    if (retry) clearTimeout(retry);
    retryTimers.current.delete(host.hostId);
    closeHost(host.hostId);
    const generation = connectionGenerations.current.begin(host.hostId);
    try {
      const secret = await loadHostSecret(host.hostId);
      if (!secret) {
        removedHostIds.current.add(host.hostId);
        connectionGenerations.current.invalidate(host.hostId);
        pendingReconnectHostIds.current.delete(host.hostId);
        if (pendingExplicitHostId.current === host.hostId) {
          pendingExplicitHostId.current = null;
        }
        await removeHost(host.hostId);
        const nextHosts = await listHosts();
        hostsRef.current = nextHosts;
        setHosts(nextHosts);
        dispatch({
          type: "host.forgotten",
          hostId: host.hostId,
        });
        clearConnectionState(host.hostId);
        addDiagnostic(host.hostId, "error", "本地凭证缺失", "Host 已移除，请重新配对");
        Alert.alert("需要重新配对", `${host.displayName} 的安全凭证已不存在，旧 Host 记录已自动移除。`);
        return;
      }
      if (
        connectionGenerations.current.disposed ||
        removedHostIds.current.has(host.hostId) ||
        !connectionGenerations.current.isCurrent(host.hostId, generation) ||
        !hostsRef.current.some((current) => current.hostId === host.hostId)
      ) return;
      const client = await MobileRelayClient.resume(
        {
          version: 1,
          relayOrigin: host.relayOrigin,
          hostId: host.hostId,
          hostE2eePublicKey: host.hostE2eePublicKey,
          deviceId: host.deviceId,
          deviceToken: secret.deviceToken,
          resumeToken: secret.resumeToken,
        },
        onConnectionState(host.hostId, generation),
      );
      const explicitlyRequested = pendingExplicitHostId.current === host.hostId;
      if (
        connectionGenerations.current.disposed ||
        removedHostIds.current.has(host.hostId) ||
        !connectionGenerations.current.isCurrent(host.hostId, generation) ||
        !hostsRef.current.some((current) => current.hostId === host.hostId)
      ) {
        const shouldClearConnection =
          connectionGenerations.current.disposed ||
          removedHostIds.current.has(host.hostId) ||
          !hostsRef.current.some((current) => current.hostId === host.hostId);
        intentionalCloses.current.add(host.hostId);
        client.close();
        intentionalCloses.current.delete(host.hostId);
        if (shouldClearConnection) clearConnectionState(host.hostId);
        return;
      }
      clients.current.set(host.hostId, client);
      startProbe(host, client, generation);
      if (options.select !== false || explicitlyRequested) {
        dispatch({ type: "host.selected", hostId: host.hostId });
        dispatch({ type: "tab.selected", tab: "sessions" });
        if (explicitlyRequested) pendingExplicitHostId.current = null;
      }
    } catch (error) {
      if (!options.silent && !connectionGenerations.current.disposed) {
        Alert.alert("连接失败", error instanceof Error ? error.message : "无法连接电脑");
      }
    } finally {
      connectingHosts.current.delete(host.hostId);
      if (
        pendingReconnectHostIds.current.delete(host.hostId) &&
        appActive.current &&
        !connectionGenerations.current.disposed &&
        !removedHostIds.current.has(host.hostId) &&
        hostsRef.current.some((current) => current.hostId === host.hostId)
      ) {
        void connectHost(host, { silent: true, select: false });
      }
    }
  };

  useEffect(() => {
    let disposed = false;
    void Promise.all([reconcileHostsWithSecrets(), loadLastHostId()]).then(([{ hosts: savedHosts, invalidatedHostIds }, savedLastHostId]) => {
      if (disposed) return;
      hostsRef.current = savedHosts;
      setHosts(savedHosts);
      rememberedHostId.current = savedLastHostId;
      persistedLastHostId.current = savedLastHostId;
      dispatch({ type: "host.remembered", hostId: savedLastHostId });
      rememberedHostStatus.current = savedLastHostId && savedHosts.some((host) => host.hostId === savedLastHostId)
        ? "pending"
        : "none";
      if (invalidatedHostIds.length > 0) {
        for (const hostId of invalidatedHostIds) {
          addDiagnostic(hostId, "error", "本地凭证缺失", "Host 已自动移除");
        }
        Alert.alert(
          "需要重新配对",
          `${invalidatedHostIds.length} 个 Host 的安全凭证已不存在，旧记录已自动移除。`,
        );
      }
      if (savedHosts.length === 0) autoSelectDone.current = true;
      if (appActive.current) {
        for (const host of savedHosts) void connectHost(host, { silent: true, select: false });
      }
    });
    const subscription = AppState.addEventListener("change", (nextState) => {
      const active = nextState === "active";
      if (active === appActive.current) return;
      appActive.current = active;
      if (!active) {
        // Keep sockets alive while a run is in flight so events keep flowing.
        if (runningSessionIdRef.current) {
          addDiagnostic("app", "info", "进入后台", "保留运行中任务的连接");
          return;
        }
        for (const host of hostsRef.current) {
          closeHost(host.hostId);
          addDiagnostic(host.hostId, "info", "进入后台", "连接已受控关闭");
        }
      } else {
        for (const host of hostsRef.current) {
          addDiagnostic(host.hostId, "info", "回到前台", "立即恢复连接");
          if (connectingHosts.current.has(host.hostId)) {
            pendingReconnectHostIds.current.add(host.hostId);
          } else {
            void connectHost(host, { silent: true, select: false });
          }
        }
        dispatch({ type: "connection.reconnected" });
      }
    });
    return () => {
      disposed = true;
      connectionGenerations.current.dispose();
      subscription.remove();
      for (const timer of retryTimers.current.values()) clearTimeout(timer);
      for (const timer of probeTimers.current.values()) clearTimeout(timer);
      retryTimers.current.clear();
      probeTimers.current.clear();
      for (const hostId of [...clients.current.keys()]) closeHost(hostId);
    };
  }, []);

  const selectHost = (hostId: string) => {
    autoSelectDone.current = true;
    pendingExplicitHostId.current = hostId;
    const host = hosts.find((item) => item.hostId === hostId);
    if (!host) return;
    dispatch({ type: "host.selected", hostId });
    const live = clients.current.has(hostId) && connections[hostId] === "authenticated";
    if (live) {
      pendingExplicitHostId.current = null;
      return;
    }
    void connectHost(host, { select: true });
  };

  const removeHostAndForget = (hostId: string) => {
    removedHostIds.current.add(hostId);
    pendingReconnectHostIds.current.delete(hostId);
    if (pendingExplicitHostId.current === hostId) {
      pendingExplicitHostId.current = null;
    }
    autoSelectDone.current = true;
    closeHost(hostId);
    retryAttempts.current.delete(hostId);
    clearConnectionState(hostId);
    dispatch({ type: "host.forgotten", hostId });
    void removeHost(hostId).then(refresh);
  };

  const renameHostDisplay = (hostId: string, displayName: string) => {
    void renameHost(hostId, displayName).then((updated) => {
      if (!updated) {
        Alert.alert("重命名失败", "名称无效或主机不存在");
        return;
      }
      refresh();
    });
  };

  const selectedHost = hosts.find((host) => host.hostId === state.selectedHostId);
  const selectedConnection = selectedHost ? connections[selectedHost.hostId] : undefined;
  const selectedClient = state.selectedHostId ? clients.current.get(state.selectedHostId) : undefined;
  const hostReady = Boolean(
    selectedHost
    && selectedClient
    && selectedConnection === "authenticated",
  );
  const api = useMemo(
    () => (hostReady && selectedClient ? createForgeMobileApi(selectedClient) : null),
    [hostReady, selectedClient, state.selectedHostId, selectedConnection],
  );
  const navTop = navStack[navStack.length - 1];

  useEffect(() => {
    if (!selectedHost) return;
    if (hostReady || connectingHosts.current.has(selectedHost.hostId)) return;
    if (selectedConnection === "connecting") return;
    void connectHost(selectedHost, { silent: true, select: true });
  }, [selectedHost?.hostId, hostReady, selectedConnection]);

  const connectionHelpMessage = (() => {
    if (!selectedHost) return "选择一台已配对电脑以进入工作台。";
    if (selectedConnection === "connecting" || connectingHosts.current.has(selectedHost.hostId)) {
      return "正在连接电脑并建立 E2EE…\n请确认 Desktop 已开、Channel Gateway 在跑、Forge Mobile 渠道已启用。";
    }
    if (selectedConnection === "error") {
      return "连接失败。请检查 Relay / 网络后重试，或到设置查看连接诊断。";
    }
    if (selectedConnection === "closed" || selectedConnection === undefined) {
      return "电脑未连接。点击下方重试，或到设置切换/重新配对电脑。";
    }
    if (selectedConnection === "authenticated" && !selectedClient) {
      return "连接状态异常，正在重新握手…";
    }
    return "正在连接电脑，连接成功后即可使用工作台。";
  })();

  useEffect(() => {
    setNavStack([]);
    if (state.activeTab !== "sessions") setConversationOpen(false);
  }, [state.selectedHostId, state.activeTab]);

  const pushNav = (target: NavTarget) => setNavStack((current) => reduceNavStack(current, target));
  const popNav = () => setNavStack((current) => current.slice(0, -1));
  const popToRoot = () => setNavStack((current) => popNavToRoot(current));

  const openSession = (session: SessionItem) => {
    setNavStack([]);
    dispatch({ type: "workspace.selected", workspaceId: session.cwd });
    dispatch({ type: "session.active", sessionId: session.id });
    dispatch({ type: "session.read", sessionId: session.id });
    dispatch({ type: "tab.selected", tab: "sessions" });
    setConversationOpen(true);
  };

  const openNewSession = (cwd?: string) => {
    setNavStack([]);
    if (cwd) dispatch({ type: "workspace.selected", workspaceId: cwd });
    dispatch({ type: "session.active", sessionId: null });
    dispatch({ type: "tab.selected", tab: "sessions" });
    setConversationOpen(true);
  };

  const mentionPathInSession = (path: string) => {
    setNavStack([]);
    dispatch({ type: "tab.selected", tab: "sessions" });
    setConversationOpen(true);
    setPendingMention(path);
  };

  if (showDiagnostics) {
    return (
      <SafeAreaView style={styles.page}>
        <StatusBar style={themeMode === "dark" ? "light" : "dark"} />
        <DiagnosticsScreen
          entries={diagnostics}
          onBack={() => setShowDiagnostics(false)}
          onClear={() => setDiagnostics([])}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar style={themeMode === "dark" ? "light" : "dark"} />
      <MobileShell
        hideHeader={
          state.activeTab === "workbench"
          || state.activeTab === "settings"
          || state.activeTab === "sessions"
          || Boolean(navTop)
        }
        hideTabs={Boolean(conversationOpen && state.activeTab === "sessions") || Boolean(navTop)}
        title={
          state.activeTab === "workspaces" ? "工作空间"
            : "Forge"
        }
        activeTab={state.activeTab}
        onTabChange={(tab) => dispatch({ type: "tab.selected", tab })}
      >
        {navTop && api ? (
          navTop.kind === "file" ? (
            <FilePreviewScreen
              api={api}
              cwd={navTop.cwd}
              path={navTop.path}
              onBack={popNav}
              onBackToRoot={popToRoot}
              onMentionInSession={mentionPathInSession}
              onOpenDiff={(path) => pushNav({ kind: "diff", cwd: navTop.cwd, path })}
            />
          ) : navTop.kind === "diff" ? (
            <DiffScreen
              api={api}
              cwd={navTop.cwd}
              path={navTop.path}
              onBack={popNav}
              onBackToRoot={popToRoot}
              onMentionInSession={mentionPathInSession}
              onOpenFile={(path) => pushNav({ kind: "file", cwd: navTop.cwd, path })}
            />
          ) : (
            <WorkspaceDetailScreen
              api={api}
              cwd={navTop.cwd}
              runningSessionId={state.runningSessionId}
              liveText={state.liveText}
              onBack={popNav}
              onOpenFile={(path) => pushNav({ kind: "file", cwd: navTop.cwd, path })}
              onOpenDiff={(path) => pushNav({ kind: "diff", cwd: navTop.cwd, path })}
              onOpenSession={openSession}
              onNewSession={() => openNewSession(navTop.cwd)}
              onCancelRun={(sessionId) => {
                void api.cancelRun(sessionId).catch((cause) => {
                  Alert.alert("停止失败", cause instanceof Error ? cause.message : "无法停止运行");
                });
              }}
            />
          )
        ) : state.activeTab === "settings" ? (
          <SettingsScreen
            hosts={hosts}
            connections={connections}
            selectedHostId={state.selectedHostId}
            notificationsEnabled={props.notificationsEnabled}
            onSelectHost={selectHost}
            onRemoveHost={removeHostAndForget}
            onRenameHost={renameHostDisplay}
            onNotificationsEnabledChange={props.onNotificationsEnabledChange}
            onAddHost={() => setPairing(true)}
            onOpenDiagnostics={() => setShowDiagnostics(true)}
          />
        ) : state.activeTab === "sessions" ? (
          selectedHost && api && hostReady ? (
            conversationOpen ? (
              <ConversationScreen
                api={api}
                hostId={selectedHost.hostId}
                hostName={selectedHost.displayName}
                connectionState={connections[selectedHost.hostId]}
                sessionId={state.activeSessionId}
                cwd={state.workspaceId}
                runningSessionId={state.runningSessionId}
                notificationsEnabled={props.notificationsEnabled}
                pendingMention={pendingMention}
                onConsumeMention={() => setPendingMention(null)}
                needsHistoryRefresh={state.needsHistoryRefresh}
                initialMessages={
                  state.activeSessionId
                    ? state.messagesBySession[state.activeSessionId]
                    : undefined
                }
                dispatch={dispatch}
                onBack={() => {
                  setConversationOpen(false);
                  dispatch({ type: "session.active", sessionId: null });
                }}
                onOpenDiff={(cwd, path) => pushNav({ kind: "diff", cwd, path })}
                onOpenFile={(cwd, path) => pushNav({ kind: "file", cwd, path })}
              />
            ) : (
              <SessionsScreen
                api={api}
                hosts={hosts}
                connections={connections}
                selectedHostId={state.selectedHostId}
                runningSessionId={state.runningSessionId}
                unreadSessionIds={state.unreadSessionIds}
                workspaceFilter={state.workspaceId}
                onSelectHost={selectHost}
                onOpenSession={openSession}
                onNewSession={openNewSession}
              />
            )
          ) : (
            <View style={styles.tabBody}>
              <HostPicker
                hosts={hosts}
                selectedHostId={state.selectedHostId}
                connections={connections}
                onSelect={selectHost}
              />
              <ConnectionBanner
                state={selectedConnection}
                onPress={() => selectedHost && void connectHost(selectedHost, { select: true })}
              />
              <EmptyState message={connectionHelpMessage} />
              {selectedHost ? (
                <PrimaryButton label="重新连接" onPress={() => void connectHost(selectedHost, { select: true })} />
              ) : null}
              <PrimaryButton label="打开连接诊断" onPress={() => setShowDiagnostics(true)} />
            </View>
          )
        ) : hosts.length === 0 ? (
          <View style={styles.tabBody}>
            <Text style={styles.emptyTitle}>连接你的第一台电脑</Text>
            <Text style={styles.emptyText}>
              在 Forge Desktop 的渠道页生成配对码，扫描配对码或粘贴配对链接即可开始。
            </Text>
            <PrimaryButton label="添加电脑" onPress={() => setPairing(true)} />
          </View>
        ) : !hostReady || !api ? (
          <View style={styles.tabBody}>
            <HostPicker
              compact
              hosts={hosts}
              selectedHostId={state.selectedHostId}
              connections={connections}
              onSelect={selectHost}
            />
            <ConnectionBanner
              state={selectedConnection}
              onPress={() => selectedHost && void connectHost(selectedHost, { select: true })}
            />
            <EmptyState message={connectionHelpMessage} />
            {selectedHost ? (
              <PrimaryButton
                label={selectedConnection === "connecting" ? "连接中…" : "重新连接"}
                disabled={selectedConnection === "connecting"}
                onPress={() => void connectHost(selectedHost, { select: true })}
              />
            ) : null}
            <PrimaryButton label="打开连接诊断" onPress={() => setShowDiagnostics(true)} />
            <PrimaryButton label="去设置管理电脑" onPress={() => dispatch({ type: "tab.selected", tab: "settings" })} />
          </View>
        ) : state.activeTab === "workspaces" ? (
          <WorkspacesScreen
            api={api}
            hosts={hosts}
            connections={connections}
            selectedHostId={state.selectedHostId}
            onSelectHost={selectHost}
            onOpenWorkspace={(cwd) => {
              dispatch({ type: "workspace.selected", workspaceId: cwd });
              pushNav({ kind: "workspace", cwd });
            }}
          />
        ) : (
          <WorkbenchScreen
            api={api}
            hosts={hosts}
            connections={connections}
            selectedHostId={state.selectedHostId}
            hostName={selectedHost?.displayName ?? "Forge"}
            runningSessionId={state.runningSessionId}
            liveText={state.liveText}
            onSelectHost={selectHost}
            onOpenWorkspace={(cwd) => {
              dispatch({ type: "workspace.selected", workspaceId: cwd });
              pushNav({ kind: "workspace", cwd });
            }}
            onOpenSession={openSession}
            onNewSession={openNewSession}
            onNewWorkspace={() => dispatch({ type: "tab.selected", tab: "workspaces" })}
            onViewAllSessions={() => dispatch({ type: "tab.selected", tab: "sessions" })}
            onViewAllWorkspaces={() => dispatch({ type: "tab.selected", tab: "workspaces" })}
            onCancelRun={(sessionId) => {
              void api.cancelRun(sessionId).catch((cause) => {
                Alert.alert("停止失败", cause instanceof Error ? cause.message : "无法停止运行");
              });
            }}
          />
        )}
      </MobileShell>

      {pairing ? (
        <PairingScreen
          manualCode={manualCode}
          onManualCodeChange={setManualCode}
          onSubmitManualCode={() => acceptCode(manualCode)}
          onScanned={acceptCode}
          onClose={closePairing}
          pendingPairing={pendingPairing}
          onCompletePairing={() => void completePairing()}
        />
      ) : null}
    </SafeAreaView>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1, backgroundColor: colors.background },
  tabBody: { flex: 1, gap: spacing.md, paddingTop: spacing.md },
  emptyTitle: { color: colors.textPrimary, fontSize: 20, fontWeight: "700", textAlign: "center", marginTop: 80 },
  emptyText: { color: colors.textSecondary, fontSize: 13, textAlign: "center", lineHeight: 20, paddingHorizontal: spacing.lg },
}));
