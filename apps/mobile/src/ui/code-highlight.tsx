import { StyleSheet, Text } from "react-native";
import { colors } from "./theme";
import {
  resolveHighlightLanguage,
  tokenizeCode,
  type SyntaxTokenKind,
} from "./syntax-highlight";

const TOKEN_COLORS: Record<SyntaxTokenKind, string> = {
  plain: colors.textPrimary,
  keyword: "#C792EA",
  string: "#C3E88D",
  comment: "#546E7A",
  number: "#F78C6C",
  punct: "#89DDFF",
  type: "#FFCB6B",
};

export function CodeHighlight(props: {
  code: string;
  language?: string;
  path?: string;
}) {
  const language = resolveHighlightLanguage(props.language || "", props.path || "");
  const tokens = tokenizeCode(props.code, language);

  return (
    <Text style={styles.code} selectable>
      {tokens.map((token, index) => (
        <Text
          key={`${index}:${token.kind}:${token.text.slice(0, 12)}`}
          style={{ color: TOKEN_COLORS[token.kind] }}
        >
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  code: {
    fontFamily: "Menlo",
    fontSize: 12,
    lineHeight: 18,
    color: colors.textPrimary,
  },
});
