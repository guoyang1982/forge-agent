import { type ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { CodeHighlight } from "./code-highlight";
import { parseMarkdownBlocks } from "./markdown-parse";
import { makeStyles } from "./make-styles";
import { radii, spacing } from "./theme";

type MdStyles = {
  root: ViewStyle;
  paragraph: TextStyle;
  h1: TextStyle;
  h2: TextStyle;
  h3: TextStyle;
  bold: TextStyle;
  italic: TextStyle;
  link: TextStyle;
  inlineCode: TextStyle;
  list: ViewStyle;
  listItem: ViewStyle;
  listBullet: TextStyle;
  listText: TextStyle;
  quote: ViewStyle;
  quoteText: TextStyle;
  codeBlock: ViewStyle;
  codeLang: TextStyle;
  tableWrap: ViewStyle;
  table: ViewStyle;
  tableRow: ViewStyle;
  tableHeaderCell: TextStyle;
  tableCell: TextStyle;
};

/** Lightweight markdown renderer for agent answers (headers, bold, lists, fences, links, tables). */
export function MarkdownBody(props: { text: string }) {
  const styles = useStyles();
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
              {renderInline(block.text, styles)}
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
                  <Text style={styles.listText}>{renderInline(item, styles)}</Text>
                </View>
              ))}
            </View>
          );
        }
        if (block.kind === "quote") {
          return (
            <View key={key} style={styles.quote}>
              <Text style={styles.quoteText}>{renderInline(block.text, styles)}</Text>
            </View>
          );
        }
        if (block.kind === "code") {
          return (
            <View key={key} style={styles.codeBlock}>
              {block.language ? (
                <Text style={styles.codeLang}>{block.language}</Text>
              ) : null}
              <CodeHighlight code={block.code} language={block.language} />
            </View>
          );
        }
        if (block.kind === "table") {
          return (
            <ScrollView key={key} horizontal style={styles.tableWrap}>
              <View style={styles.table}>
                <View style={styles.tableRow}>
                  {block.headers.map((header, headerIndex) => (
                    <Text key={`${key}:h:${headerIndex}`} style={styles.tableHeaderCell}>
                      {header}
                    </Text>
                  ))}
                </View>
                {block.rows.map((row, rowIndex) => (
                  <View key={`${key}:r:${rowIndex}`} style={styles.tableRow}>
                    {block.headers.map((_, colIndex) => (
                      <Text key={`${key}:c:${rowIndex}:${colIndex}`} style={styles.tableCell}>
                        {row[colIndex] ?? ""}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          );
        }
        return (
          <Text key={key} style={styles.paragraph}>
            {renderInline(block.text, styles)}
          </Text>
        );
      })}
    </View>
  );
}

export { parseMarkdownBlocks } from "./markdown-parse";

function renderInline(text: string, styles: MdStyles): Array<string | ReactNode> {
  const nodes: Array<string | ReactNode> = [];
  const pattern = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const label = link[1] ?? "";
      const href = link[2] ?? "";
      nodes.push(
        <Text
          key={`l${key++}`}
          style={styles.link}
          onPress={() => {
            if (/^https?:\/\//i.test(href)) void Linking.openURL(href);
          }}
        >
          {label}
        </Text>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
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

const useStyles = makeStyles((colors): MdStyles => ({
  root: { gap: spacing.sm },
  paragraph: { color: colors.textPrimary, fontSize: 14, lineHeight: 21 },
  h1: { color: colors.textPrimary, fontSize: 18, fontWeight: "800", lineHeight: 26 },
  h2: { color: colors.textPrimary, fontSize: 16, fontWeight: "700", lineHeight: 24 },
  h3: { color: colors.textPrimary, fontSize: 15, fontWeight: "700", lineHeight: 22 },
  bold: { fontWeight: "700", color: colors.textPrimary },
  italic: { fontStyle: "italic", color: colors.textPrimary },
  link: { color: colors.brandActive, textDecorationLine: "underline" },
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
  quote: {
    borderLeftColor: colors.brand,
    borderLeftWidth: 3,
    paddingLeft: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
  },
  quoteText: { color: colors.textSecondary, fontSize: 14, lineHeight: 21, fontStyle: "italic" },
  codeBlock: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  codeLang: { color: colors.textMuted, fontSize: 11, fontWeight: "600" },
  tableWrap: { maxWidth: "100%" },
  table: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    overflow: "hidden",
    minWidth: 240,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tableHeaderCell: {
    minWidth: 88,
    maxWidth: 160,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: "700",
    backgroundColor: colors.surfaceAlt,
  },
  tableCell: {
    minWidth: 88,
    maxWidth: 160,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
}));
