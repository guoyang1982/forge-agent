import { Text } from "react-native";
import { makeStyles } from "./make-styles";
import { useTheme } from "./theme";
import {
  resolveHighlightLanguage,
  tokenizeCode,
  type SyntaxTokenKind,
} from "./syntax-highlight";

const DARK_TOKEN_COLORS: Record<SyntaxTokenKind, string> = {
  plain: "#F8FAFC",
  keyword: "#C792EA",
  string: "#C3E88D",
  comment: "#546E7A",
  number: "#F78C6C",
  punct: "#89DDFF",
  type: "#FFCB6B",
};

const LIGHT_TOKEN_COLORS: Record<SyntaxTokenKind, string> = {
  plain: "#0F172A",
  keyword: "#7C3AED",
  string: "#15803D",
  comment: "#64748B",
  number: "#C2410C",
  punct: "#0369A1",
  type: "#A16207",
};

export function CodeHighlight(props: {
  code: string;
  language?: string;
  path?: string;
}) {
  const styles = useStyles();
  const { mode, colors } = useTheme();
  const language = resolveHighlightLanguage(props.language || "", props.path || "");
  const tokens = tokenizeCode(props.code, language);
  const tokenColors = {
    ...(mode === "light" ? LIGHT_TOKEN_COLORS : DARK_TOKEN_COLORS),
    plain: colors.textPrimary,
  };

  return (
    <Text style={styles.code} selectable>
      {tokens.map((token, index) => (
        <Text
          key={`${index}:${token.kind}:${token.text.slice(0, 12)}`}
          style={{ color: tokenColors[token.kind] }}
        >
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

const useStyles = makeStyles((colors) => ({
  code: {
    fontFamily: "Menlo",
    fontSize: 12,
    lineHeight: 18,
    color: colors.textPrimary,
  },
}));
