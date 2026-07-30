import { useEffect, useRef, useState } from "react";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { Pressable, Text, TextInput, View } from "react-native";
import { ForgeMark } from "../ui/components";
import { makeStyles } from "../ui/make-styles";
import { radii, spacing } from "../ui/theme";

type PairingMode = "scan" | "manual";

export function PairingScreen(props: {
  manualCode: string;
  onManualCodeChange: (value: string) => void;
  onSubmitManualCode: () => void;
  onScanned: (data: string) => void;
  onClose: () => void;
  pendingPairing: { hostId: string; relayOrigin: string } | null;
  onCompletePairing: () => void;
}) {
  const styles = useStyles();
  const [mode, setMode] = useState<PairingMode>("scan");
  const [permission, requestPermission] = useCameraPermissions();
  const scannedLock = useRef(false);

  useEffect(() => {
    if (!props.pendingPairing) scannedLock.current = false;
  }, [props.pendingPairing]);

  useEffect(() => {
    if (mode === "manual") scannedLock.current = false;
  }, [mode]);

  const scan = (result: BarcodeScanningResult) => {
    if (scannedLock.current) return;
    if (!result.data.startsWith("forge://pair")) return;
    scannedLock.current = true;
    props.onScanned(result.data);
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHead}>
        <ForgeMark size="md" />
        <View style={styles.sheetHeadCopy}>
          <Text style={styles.sheetTitle}>添加电脑</Text>
          <Text style={styles.sheetSubtitle}>配对并建立端到端加密连接</Text>
        </View>
      </View>
      <Text style={styles.copy}>
        配对码一次性使用且短时有效。完成端到端加密（E2EE）握手后，设备凭证只会写入系统安全存储，绝不进入普通存储。
      </Text>

      {props.pendingPairing ? (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>等待安全握手</Text>
          <Text style={styles.noticeText}>{props.pendingPairing.relayOrigin} · {props.pendingPairing.hostId}</Text>
          <View style={styles.sheetActions}>
            <Pressable style={styles.secondaryButton} onPress={props.onClose}>
              <Text style={styles.secondaryButtonText}>取消</Text>
            </Pressable>
            <Pressable style={styles.primaryButton} onPress={props.onCompletePairing}>
              <Text style={styles.primaryButtonText}>连接并完成配对</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modeButton, mode === "scan" ? styles.modeButtonActive : null]}
              onPress={() => setMode("scan")}
            >
              <Text style={[styles.modeButtonText, mode === "scan" ? styles.modeButtonTextActive : null]}>扫描配对码</Text>
            </Pressable>
            <Pressable
              style={[styles.modeButton, mode === "manual" ? styles.modeButtonActive : null]}
              onPress={() => setMode("manual")}
            >
              <Text style={[styles.modeButtonText, mode === "manual" ? styles.modeButtonTextActive : null]}>粘贴配对链接</Text>
            </Pressable>
          </View>

          {mode === "scan" ? (
            permission?.granted ? (
              <CameraView style={styles.camera} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scan} />
            ) : (
              <Pressable style={styles.secondaryButton} onPress={() => void requestPermission()}>
                <Text style={styles.secondaryButtonText}>允许相机权限</Text>
              </Pressable>
            )
          ) : (
            <TextInput
              value={props.manualCode}
              onChangeText={props.onManualCodeChange}
              placeholder="forge://pair?..."
              placeholderTextColor="#697386"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
          )}

          <View style={styles.sheetActions}>
            <Pressable style={styles.secondaryButton} onPress={props.onClose}>
              <Text style={styles.secondaryButtonText}>取消</Text>
            </Pressable>
            {mode === "manual" ? (
              <Pressable style={styles.primaryButton} onPress={props.onSubmitManualCode}>
                <Text style={styles.primaryButtonText}>校验配对码</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  sheet: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 16,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderAlt,
    borderWidth: 1,
    borderRadius: radii.sheet,
    padding: spacing.lg + spacing.xs,
    gap: spacing.md,
  },
  sheetHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  sheetHeadCopy: { flex: 1, gap: 2 },
  sheetTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: "700" },
  sheetSubtitle: { color: colors.textSecondary, fontSize: 12 },
  copy: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  modeRow: { flexDirection: "row", gap: spacing.sm },
  modeButton: {
    flex: 1,
    borderColor: colors.borderAlt,
    borderWidth: 1,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  modeButtonActive: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  modeButtonText: { color: "#c5ceda", fontWeight: "600", fontSize: 13 },
  modeButtonTextActive: { color: colors.brandActive },
  camera: { height: 250, borderRadius: radii.md + 2, overflow: "hidden" },
  input: {
    color: colors.textPrimary,
    backgroundColor: "#0a0e14",
    borderColor: colors.borderAlt,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + spacing.xs,
    minHeight: 44,
  },
  sheetActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm + spacing.xs },
  notice: {
    backgroundColor: colors.brandSoft,
    borderColor: colors.brand,
    borderWidth: 1,
    padding: spacing.md + spacing.xs,
    borderRadius: radii.md + 2,
    gap: spacing.sm,
  },
  noticeTitle: { color: colors.brandActive, fontWeight: "700" },
  noticeText: { color: "#918aa3", fontSize: 12 },
  primaryButton: {
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  primaryButtonText: { color: "white", fontWeight: "700" },
  secondaryButton: {
    borderColor: colors.borderAlt,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  secondaryButtonText: { color: "#c5ceda", fontWeight: "600" },
}));
