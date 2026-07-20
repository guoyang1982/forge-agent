import { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { parseMarkdownBlocks } from "./markdown-parse";
import { colors, radii, spacing } from "./theme";

/** Lightweight markdown renderer for agent answers (headers, bold, lists, fences). */
export function MarkdownBody(props: { text: string }) {
  const blocks = parseMarkdownBlocks(props.text);
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => {
        const key = `${block.kind}:${index}`;
        if (block.kind === "heading") {
          const headingStyle = block.level === 1
            ? styles.h1
            : block.level === 2
              ? styles.h2
              : styles.h3;
          return (
            <Text key={key} style={headingStyle}>
              {renderInline(block.text)}
            </Text>
          );
        }
        if (block.kind === "list") {
          return (
            <View key={key} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={`${key}:${itemIndex}`} style={styles.listItem}>
                  <Text style={styles.listBullet}>
                    {block.ordered ? `${itemIndex + 1}.` : "•"}
                  </Text>
                  <Text style={styles.listText}>{renderInline(item)}</Text>
                </View>
              ))}
            </View>
          );
        }
        if (block.kind === "code") {
          return (
            <View key={key} style={styles.codeBlock}>
              {block.language ? (
                <Text style={styles.codeLang}>{block.language}</Text>
              ) : null}
              <Text style={styles.codeText}>{block.code}</Text>
            </View>
          );
        }
        return (
          <Text key={key} style={styles.paragraph}>
            {renderInline(block.text)}
          </Text>
        );
      })}
    </View>
  );
}

export { parseMarkdownBlocks } from "./markdown-parse";

function renderInline(text: string): Array<string | ReactNode> {
  const nodes: Array<string | ReactNode> = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <Text key={`b${key++}`} style={styles.bold}>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <Text key={`c${key++}`} style={styles.inlineCode}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(
        <Text key={`i${key++}`} style={styles.italic}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else {
      nodes.push(token);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : [text];
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm },
  paragraph: { color: colors.textPrimary, fontSize: 14, lineHeight: 21 },
  h1: { color: colors.textPrimary, fontSize: 18, fontWeight: "800", lineHeight: 26 },
  h2: { color: colors.textPrimary, fontSize: 16, fontWeight: "700", lineHeight: 24 },
  h3: { color: colors.textPrimary, fontSize: 15, fontWeight: "700", lineHeight: 22 },
  bold: { fontWeight: "700", color: colors.textPrimary },
  italic: { fontStyle: "italic", color: colors.textPrimary },
  inlineCode: {
    fontFamily: "Menlo",
    fontSize: 12,
    color: colors.brandActive,
    backgroundColor: colors.brandSoft,
  },
  list: { gap: 4 },
  listItem: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  listBullet: { color: colors.textSecondary, fontSize: 14, lineHeight: 21, minWidth: 16 },
  listText: { flex: 1, color: colors.textPrimary, fontSize: 14, lineHeight: 21 },
  codeBlock: {
    backgroundColor: "#0A0E14",
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  codeLang: { color: colors.textMuted, fontSize: 11, fontWeight: "600" },
  codeText: {
    color: colors.textPrimary,
    fontFamily: "Menlo",
    fontSize: 12,
    lineHeight: 18,
  },
});
