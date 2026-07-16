import { useEffect, useRef, useState } from "react";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import {
  Alert,
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { ForgeMobilePairingOfferV1 } from "@forge/mobile-protocol";
import { parsePairingUri } from "./src/pairing/parse-pairing";
import {
  listHosts,
  loadHostSecret,
  reconcileHostsWithSecrets,
  removeHost,
  saveHost,
  assertSecureStoreAvailable,
  type MobileHostSummary,
} from "./src/storage/host-store";
import {
  MobileRelayClient,
  type MobileConnectionState,
} from "./src/transport/mobile-relay-client";
import { SessionScreen } from "./src/screens/SessionScreen";
import { DiagnosticsScreen } from "./src/screens/DiagnosticsScreen";
import {
  diagnosticEntry,
  retryDelayMs,
  shouldRetryConnection,
  type ConnectionDiagnostic,
} from "./src/diagnostics/connection-diagnostics";

export default function App() {
  return (
    <SafeAreaProvider>
      <MobileApp />
    </SafeAreaProvider>
  );
}

function MobileApp() {
  const [hosts, setHosts] = useState<MobileHostSummary[]>([]);
  const [pairing, setPairing] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [pendingPairing, setPendingPairing] = useState<{ hostId: string; relayOrigin: string } | null>(null);
  const [connections, setConnections] = useState<Record<string, MobileConnectionState>>({});
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnostic[]>([]);
  const [permission, requestPermission] = useCameraPermissions();
  const clients = useRef(new Map<string, MobileRelayClient>());
  const pendingOffer = useRef<ForgeMobilePairingOfferV1 | null>(null);
  const hostsRef = useRef<MobileHostSummary[]>([]);
  const appActive = useRef(AppState.currentState === "active");
  const connectingHosts = useRef(new Set<string>());
  const intentionalCloses = useRef(new Set<string>());
  const retryAttempts = useRef(new Map<string, number>());
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const probeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const refresh = () => void listHosts().then(setHosts);
  useEffect(() => {
    hostsRef.current = hosts;
  }, [hosts]);

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
    clearHostTimers(hostId);
    const client = clients.current.get(hostId);
    if (!client) return;
    intentionalCloses.current.add(hostId);
    client.close();
    intentionalCloses.current.delete(hostId);
    clients.current.delete(hostId);
  };

  const onConnectionState = (hostId: string) => (state: MobileConnectionState, error?: string) => {
    setConnections((current) => ({ ...current, [hostId]: state }));
    if (state === "authenticated") {
      retryAttempts.current.set(hostId, 0);
      addDiagnostic(hostId, "info", "E2EE 已连接");
    } else if (state === "error") {
      addDiagnostic(hostId, "error", "连接失败", error);
      if (!intentionalCloses.current.has(hostId)) scheduleReconnect(hostId, error ?? "连接失败");
    } else if (state === "closed") {
      addDiagnostic(hostId, "info", "连接已关闭");
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

  const startProbe = (host: MobileHostSummary, client: MobileRelayClient) => {
    const previous = probeTimers.current.get(host.hostId);
    if (previous) clearTimeout(previous);
    const probe = async () => {
      if (!appActive.current || clients.current.get(host.hostId) !== client) return;
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
      setPairing(false);
      setManualCode("");
      Alert.alert("配对码有效", "下一步将连接 Relay 并完成端到端握手。凭证尚未写入普通存储。");
    } catch (error) {
      Alert.alert("无法配对", error instanceof Error ? error.message : "配对码无效");
    }
  };

  const scan = (result: BarcodeScanningResult) => {
    if (result.data.startsWith("forge://pair")) acceptCode(result.data);
  };

  const completePairing = async () => {
    const offer = pendingOffer.current;
    if (!offer) return;
    // The one-time secret leaves UI state before any network operation and is never logged.
    pendingOffer.current = null;
    setPendingPairing(null);
    let client: MobileRelayClient | null = null;
    try {
      await assertSecureStoreAvailable();
      client = await MobileRelayClient.pair(offer, onConnectionState(offer.hostId));
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
      clients.current.set(offer.hostId, client);
      const nextHosts = await listHosts();
      hostsRef.current = nextHosts;
      setHosts(nextHosts);
      startProbe(summary, client);
      setSelectedHostId(offer.hostId);
      Alert.alert("配对成功", "设备凭证已写入系统安全存储，E2EE 连接已建立。");
    } catch (error) {
      if (client) {
        intentionalCloses.current.add(offer.hostId);
        client.close();
        intentionalCloses.current.delete(offer.hostId);
      }
      Alert.alert("配对失败", error instanceof Error ? error.message : "无法建立安全连接");
    }
  };

  const connectHost = async (
    host: MobileHostSummary,
    options: { silent?: boolean; select?: boolean } = {},
  ) => {
    if (connectingHosts.current.has(host.hostId)) return;
    connectingHosts.current.add(host.hostId);
    const retry = retryTimers.current.get(host.hostId);
    if (retry) clearTimeout(retry);
    retryTimers.current.delete(host.hostId);
    closeHost(host.hostId);
    try {
      const secret = await loadHostSecret(host.hostId);
      if (!secret) {
        await removeHost(host.hostId);
        const nextHosts = await listHosts();
        hostsRef.current = nextHosts;
        setHosts(nextHosts);
        setSelectedHostId((current) => current === host.hostId ? null : current);
        setConnections((current) => {
          const next = { ...current };
          delete next[host.hostId];
          return next;
        });
        addDiagnostic(host.hostId, "error", "本地凭证缺失", "Host 已移除，请重新配对");
        Alert.alert("需要重新配对", `${host.displayName} 的安全凭证已不存在，旧 Host 记录已自动移除。`);
        return;
      }
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
        onConnectionState(host.hostId),
      );
      clients.current.set(host.hostId, client);
      startProbe(host, client);
      if (options.select !== false) setSelectedHostId(host.hostId);
    } catch (error) {
      if (!options.silent) {
        Alert.alert("连接失败", error instanceof Error ? error.message : "无法连接电脑");
      }
    } finally {
      connectingHosts.current.delete(host.hostId);
    }
  };

  useEffect(() => {
    let disposed = false;
    void reconcileHostsWithSecrets().then(({ hosts: savedHosts, invalidatedHostIds }) => {
      if (disposed) return;
      hostsRef.current = savedHosts;
      setHosts(savedHosts);
      if (invalidatedHostIds.length > 0) {
        for (const hostId of invalidatedHostIds) {
          addDiagnostic(hostId, "error", "本地凭证缺失", "Host 已自动移除");
        }
        Alert.alert(
          "需要重新配对",
          `${invalidatedHostIds.length} 个 Host 的安全凭证已不存在，旧记录已自动移除。`,
        );
      }
      if (appActive.current) {
        for (const host of savedHosts) void connectHost(host, { silent: true, select: false });
      }
    });
    const subscription = AppState.addEventListener("change", (nextState) => {
      const active = nextState === "active";
      if (active === appActive.current) return;
      appActive.current = active;
      if (!active) {
        for (const host of hostsRef.current) {
          closeHost(host.hostId);
          addDiagnostic(host.hostId, "info", "进入后台", "连接已受控关闭");
        }
      } else {
        for (const host of hostsRef.current) {
          addDiagnostic(host.hostId, "info", "回到前台", "立即恢复连接");
          void connectHost(host, { silent: true, select: false });
        }
      }
    });
    return () => {
      disposed = true;
      subscription.remove();
      for (const timer of retryTimers.current.values()) clearTimeout(timer);
      for (const timer of probeTimers.current.values()) clearTimeout(timer);
      retryTimers.current.clear();
      probeTimers.current.clear();
      for (const hostId of [...clients.current.keys()]) closeHost(hostId);
    };
  }, []);

  const selectedHost = hosts.find((host) => host.hostId === selectedHostId);
  const selectedClient = selectedHostId ? clients.current.get(selectedHostId) : undefined;
  if (showDiagnostics) {
    return (
      <SafeAreaView style={styles.page}>
        <StatusBar style="light" />
        <DiagnosticsScreen
          entries={diagnostics}
          onBack={() => setShowDiagnostics(false)}
          onClear={() => setDiagnostics([])}
        />
      </SafeAreaView>
    );
  }
  if (selectedHost && selectedClient) {
    return (
      <SafeAreaView style={styles.page}>
        <StatusBar style="light" />
        <SessionScreen
          client={selectedClient}
          hostName={selectedHost.displayName}
          onBack={() => setSelectedHostId(null)}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>FORGE MOBILE</Text>
          <Text style={styles.title}>远程工作台</Text>
          <Text style={styles.subtitle}>Relay 只传输端到端密文</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable style={styles.secondaryButton} onPress={() => setShowDiagnostics(true)}>
            <Text style={styles.secondaryButtonText}>诊断</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={() => setPairing(true)}>
            <Text style={styles.primaryButtonText}>添加电脑</Text>
          </Pressable>
        </View>
      </View>

      {pendingPairing ? (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>等待安全握手</Text>
          <Text style={styles.noticeText}>{pendingPairing.relayOrigin} · {pendingPairing.hostId}</Text>
          <Pressable style={[styles.primaryButton, styles.noticeButton]} onPress={() => void completePairing()}>
            <Text style={styles.primaryButtonText}>连接并完成配对</Text>
          </Pressable>
        </View>
      ) : null}

      <FlatList
        data={hosts}
        keyExtractor={(item) => item.hostId}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>还没有配对电脑。请在 Forge Desktop 的渠道页生成二维码。</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Pressable style={styles.cardBody} onPress={() => void connectHost(item)}>
              <Text style={styles.cardTitle}>{item.displayName}</Text>
              <Text style={styles.cardMeta}>{item.relayOrigin}</Text>
              <Text style={styles.cardMeta}>配对于 {new Date(item.pairedAt).toLocaleString()}</Text>
              <Text style={styles.connectionState}>{connectionLabel(connections[item.hostId])}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                closeHost(item.hostId);
                retryAttempts.current.delete(item.hostId);
                if (selectedHostId === item.hostId) setSelectedHostId(null);
                void removeHost(item.hostId).then(refresh);
              }}
            >
              <Text style={styles.remove}>移除</Text>
            </Pressable>
          </View>
        )}
      />

      {pairing ? (
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>扫描一次性配对码</Text>
          {permission?.granted ? (
            <CameraView style={styles.camera} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scan} />
          ) : (
            <Pressable style={styles.secondaryButton} onPress={() => void requestPermission()}>
              <Text style={styles.secondaryButtonText}>允许相机权限</Text>
            </Pressable>
          )}
          <TextInput
            value={manualCode}
            onChangeText={setManualCode}
            placeholder="或粘贴 forge://pair?..."
            placeholderTextColor="#697386"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <View style={styles.sheetActions}>
            <Pressable style={styles.secondaryButton} onPress={() => setPairing(false)}>
              <Text style={styles.secondaryButtonText}>取消</Text>
            </Pressable>
            <Pressable style={styles.primaryButton} onPress={() => acceptCode(manualCode)}>
              <Text style={styles.primaryButtonText}>校验配对码</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#080b10", paddingHorizontal: 20 },
  header: { paddingTop: 24, paddingBottom: 20, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerActions: { flexDirection: "row", gap: 8, alignItems: "center" },
  eyebrow: { color: "#8b5cf6", fontSize: 11, fontWeight: "800", letterSpacing: 1.8 },
  title: { color: "#f8fafc", fontSize: 28, fontWeight: "700", marginTop: 4 },
  subtitle: { color: "#8b95a7", fontSize: 12, marginTop: 4 },
  primaryButton: { backgroundColor: "#7c3aed", paddingHorizontal: 16, paddingVertical: 11, borderRadius: 12 },
  primaryButtonText: { color: "white", fontWeight: "700" },
  notice: { backgroundColor: "#151124", borderColor: "#6d4bc3", borderWidth: 1, padding: 14, borderRadius: 14, marginBottom: 12 },
  noticeTitle: { color: "#c4b5fd", fontWeight: "700" },
  noticeText: { color: "#918aa3", fontSize: 12, marginTop: 4 },
  noticeButton: { alignSelf: "flex-start", marginTop: 12 },
  list: { gap: 10, paddingBottom: 28 },
  empty: { color: "#697386", textAlign: "center", lineHeight: 22, marginTop: 80, paddingHorizontal: 28 },
  card: { flexDirection: "row", alignItems: "center", backgroundColor: "#10151e", borderColor: "#202936", borderWidth: 1, borderRadius: 16, padding: 16 },
  cardBody: { flex: 1 },
  cardTitle: { color: "#eef2f7", fontSize: 16, fontWeight: "700" },
  cardMeta: { color: "#788397", fontSize: 12, marginTop: 4 },
  connectionState: { color: "#a78bfa", fontSize: 12, fontWeight: "700", marginTop: 8 },
  remove: { color: "#f87171", padding: 8 },
  sheet: { position: "absolute", left: 12, right: 12, bottom: 16, backgroundColor: "#111720", borderColor: "#293242", borderWidth: 1, borderRadius: 22, padding: 18, gap: 14 },
  sheetTitle: { color: "#f8fafc", fontSize: 18, fontWeight: "700" },
  camera: { height: 250, borderRadius: 14, overflow: "hidden" },
  input: { color: "#f8fafc", backgroundColor: "#0a0e14", borderColor: "#2b3545", borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11 },
  sheetActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  secondaryButton: { borderColor: "#344054", borderWidth: 1, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 12 },
  secondaryButtonText: { color: "#c5ceda", fontWeight: "600" },
});

function connectionLabel(state: MobileConnectionState | undefined): string {
  if (state === "connecting") return "连接中…";
  if (state === "authenticated") return "端到端连接已建立";
  if (state === "error") return "连接错误 · 点击重试";
  if (state === "closed") return "已断开 · 点击重连";
  return "点击连接";
}
