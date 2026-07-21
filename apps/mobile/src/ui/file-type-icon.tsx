import { StyleSheet, Text, View } from "react-native";
import { resolveFileIconKind } from "./file-type";
import { colors, radii } from "./theme";

export { resolveFileIconKind } from "./file-type";
export type { FileIconKind } from "./file-type";

export function FileTypeIcon(props: { name: string; kind: "file" | "directory" | "binary" }) {
  const icon = resolveFileIconKind(props.name, props.kind);
  if (icon === "folder") {
    return (
      <View style={styles.folder}>
        <View style={styles.folderTab} />
        <View style={styles.folderBody} />
      </View>
    );
  }
  if (icon === "json") {
    return (
      <View style={[styles.badge, styles.jsonBadge]}>
        <Text style={styles.jsonText}>{"{}"}</Text>
      </View>
    );
  }
  if (icon === "gitignore") {
    return (
      <View style={styles.gitBadge}>
        <Text style={styles.gitText}>G</Text>
      </View>
    );
  }
  if (icon === "binary") {
    return (
      <View style={[styles.badge, styles.binaryBadge]}>
        <Text style={styles.badgeText}>BIN</Text>
      </View>
    );
  }

  const label =
    icon === "typescript" ? "TS"
      : icon === "javascript" ? "JS"
        : icon === "css" ? "CS"
          : icon === "markdown" ? "MD"
            : icon === "python" ? "PY"
              : icon === "shell" ? "SH"
                : icon === "html" ? "HT"
                  : "•";

  const tone =
    icon === "typescript" || icon === "css" || icon === "markdown" || icon === "html"
      ? styles.blueBadge
      : icon === "javascript"
        ? styles.yellowBadge
        : icon === "python"
          ? styles.greenBadge
          : styles.grayBadge;

  return (
    <View style={[styles.badge, tone]}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  folder: {
    width: 22,
    height: 18,
    justifyContent: "flex-end",
  },
  folderTab: {
    position: "absolute",
    top: 0,
    left: 1,
    width: 8,
    height: 4,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
    backgroundColor: "#5B6B82",
  },
  folderBody: {
    width: 22,
    height: 14,
    borderRadius: 3,
    backgroundColor: "#6B7C94",
  },
  badge: {
    width: 22,
    height: 18,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  blueBadge: { backgroundColor: "#3178C6" },
  yellowBadge: { backgroundColor: "#CA8A04" },
  greenBadge: { backgroundColor: "#16A34A" },
  grayBadge: { backgroundColor: "#475569" },
  binaryBadge: { backgroundColor: "#7C3AED" },
  jsonBadge: {
    backgroundColor: "#15803D",
    borderRadius: radii.sm,
  },
  badgeText: {
    color: "#F8FAFC",
    fontSize: 8,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  jsonText: {
    color: "#ECFDF5",
    fontSize: 9,
    fontWeight: "800",
  },
  gitBadge: {
    width: 18,
    height: 18,
    borderRadius: 4,
    backgroundColor: "#334155",
    borderWidth: 1,
    borderColor: colors.borderAlt,
    transform: [{ rotate: "45deg" }],
    alignItems: "center",
    justifyContent: "center",
  },
  gitText: {
    color: colors.textSecondary,
    fontSize: 8,
    fontWeight: "800",
    transform: [{ rotate: "-45deg" }],
  },
});
