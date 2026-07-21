export type SyntaxTokenKind =
  | "plain"
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "punct"
  | "type";

export type SyntaxToken = {
  kind: SyntaxTokenKind;
  text: string;
};

const KEYWORDS: Record<string, string[]> = {
  typescript: [
    "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
    "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally",
    "for", "from", "function", "get", "if", "implements", "import", "in", "instanceof", "interface",
    "let", "new", "null", "of", "package", "private", "protected", "public", "return", "set",
    "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof", "undefined",
    "var", "void", "while", "with", "yield",
  ],
  javascript: [
    "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
    "delete", "do", "else", "export", "extends", "false", "finally", "for", "from", "function",
    "if", "import", "in", "instanceof", "let", "new", "null", "of", "return", "super", "switch",
    "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "with", "yield",
  ],
  python: [
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
    "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while",
    "with", "yield",
  ],
  shell: [
    "case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "select",
    "then", "until", "while", "export", "local", "return", "source",
  ],
  css: [
    "important", "from", "to", "and", "or", "not", "only",
  ],
  html: [
    "DOCTYPE", "html", "head", "body", "script", "style", "div", "span", "meta", "link", "title",
  ],
  json: ["true", "false", "null"],
};

const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  md: "markdown",
  markdown: "markdown",
  htm: "html",
  scss: "css",
};

export function resolveHighlightLanguage(language: string, path: string): string {
  const fromLang = language.trim().toLowerCase();
  if (fromLang && fromLang !== "plaintext" && fromLang !== "text") {
    return ALIASES[fromLang] || fromLang;
  }
  const base = path.split(/[/\\]/).pop() || path;
  const lower = base.toLowerCase();
  if (lower === "package.json" || lower.endsWith(".json")) return "json";
  const match = /\.([a-z0-9]+)$/i.exec(lower);
  const ext = match?.[1]?.toLowerCase();
  if (!ext) return "plaintext";
  return ALIASES[ext] || ext;
}

export function tokenizeCode(source: string, language: string): SyntaxToken[] {
  const lang = ALIASES[language] || language;
  if (lang === "markdown") return tokenizeMarkdown(source);

  const supported = Boolean(KEYWORDS[lang]) || lang === "json" || lang === "css" || lang === "html";
  if (!supported) return [{ kind: "plain", text: source }];

  const keywords = new Set(KEYWORDS[lang] || []);
  const tokens: SyntaxToken[] = [];
  let i = 0;
  const at = (index: number) => source.charAt(index);
  const push = (kind: SyntaxTokenKind, text: string) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ kind, text });
  };

  const isIdentStart = (ch: string) => Boolean(ch) && /[A-Za-z_$]/.test(ch);
  const isIdent = (ch: string) => Boolean(ch) && /[A-Za-z0-9_$]/.test(ch);

  while (i < source.length) {
    const ch = at(i);
    const next = at(i + 1);

    // Comments
    if (lang === "python" && ch === "#") {
      let end = i + 1;
      while (end < source.length && at(end) !== "\n") end += 1;
      push("comment", source.slice(i, end));
      i = end;
      continue;
    }
    if (lang === "shell" && ch === "#") {
      let end = i + 1;
      while (end < source.length && at(end) !== "\n") end += 1;
      push("comment", source.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "/" && next === "/" && lang !== "json") {
      let end = i + 2;
      while (end < source.length && at(end) !== "\n") end += 1;
      push("comment", source.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "/" && next === "*" && lang !== "json" && lang !== "shell" && lang !== "python") {
      let end = i + 2;
      while (end + 1 < source.length && !(at(end) === "*" && at(end + 1) === "/")) end += 1;
      end = Math.min(source.length, end + 2);
      push("comment", source.slice(i, end));
      i = end;
      continue;
    }

    // Strings
    if (ch === "'" || ch === '"' || (ch === "`" && lang !== "json" && lang !== "css")) {
      const quote = ch;
      let end = i + 1;
      while (end < source.length) {
        if (at(end) === "\\" && end + 1 < source.length) {
          end += 2;
          continue;
        }
        if (at(end) === quote) {
          end += 1;
          break;
        }
        if (quote !== "`" && at(end) === "\n") break;
        end += 1;
      }
      push("string", source.slice(i, end));
      i = end;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next))) {
      let end = i + 1;
      while (end < source.length && /[0-9.xXa-fA-F_]/.test(at(end))) end += 1;
      push("number", source.slice(i, end));
      i = end;
      continue;
    }

    // Identifiers / keywords / types
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < source.length && isIdent(at(end))) end += 1;
      const word = source.slice(i, end);
      if (keywords.has(word)) push("keyword", word);
      else if (/^[A-Z]/.test(word) && lang !== "json") push("type", word);
      else push("plain", word);
      i = end;
      continue;
    }

    // Punctuation
    if (/[{}[\]();,.:=<>!&|?+\-*/%~^@#]/.test(ch)) {
      push("punct", ch);
      i += 1;
      continue;
    }

    // Whitespace / other
    let end = i + 1;
    while (end < source.length) {
      const cur = at(end);
      if (
        isIdentStart(cur)
        || /[0-9"'`#/]/.test(cur)
        || /[{}[\]();,.:=<>!&|?+\-*/%~^@]/.test(cur)
      ) {
        break;
      }
      end += 1;
    }
    push("plain", source.slice(i, end));
    i = end;
  }

  return tokens.length ? tokens : [{ kind: "plain", text: source }];
}

function tokenizeMarkdown(source: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const lines = source.split(/(\n)/);
  for (const line of lines) {
    if (line === "\n") {
      tokens.push({ kind: "plain", text: "\n" });
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      tokens.push({ kind: "keyword", text: line });
    } else if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      tokens.push({ kind: "punct", text: line });
    } else if (/^```/.test(line)) {
      tokens.push({ kind: "string", text: line });
    } else if (/^\s*>/.test(line)) {
      tokens.push({ kind: "comment", text: line });
    } else {
      tokens.push({ kind: "plain", text: line });
    }
  }
  return tokens;
}
