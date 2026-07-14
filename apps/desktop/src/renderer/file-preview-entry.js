/**
 * Bundled as file-preview.bundle.js — ForgeFilePreview global.
 * Markdown: marked + DOMPurify
 * Code: highlight.js with line numbers + symbol jump
 */
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import cpp from "highlight.js/lib/languages/cpp";
import sql from "highlight.js/lib/languages/sql";
import plaintext from "highlight.js/lib/languages/plaintext";

const LANG_BY_EXT = {
  java: "java",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  py: "python",
  json: "json",
  html: "xml",
  htm: "xml",
  xml: "xml",
  css: "css",
  scss: "css",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  go: "go",
  rs: "rust",
  cpp: "cpp",
  cc: "cpp",
  c: "cpp",
  h: "cpp",
  hpp: "cpp",
  sql: "sql",
};

const DEF_PATTERNS_BY_LANG = {
  python: [
    { kind: "def", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/ },
  ],
  javascript: [
    {
      kind: "fn",
      re: /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\())/,
    },
    { kind: "class", re: /^\s*class\s+([A-Za-z_$][\w$]*)/ },
  ],
  typescript: [
    {
      kind: "fn",
      re: /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\())/,
    },
    { kind: "class", re: /^\s*class\s+([A-Za-z_$][\w$]*)/ },
  ],
  java: [
    { kind: "class", re: /^\s*(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/ },
    {
      kind: "method",
      re: /^\s*(?:public|private|protected|static|\s)+[\w<>,\[\]\s]+\s+(\w+)\s*\([^;]*\)\s*(?:\{|throws)/,
    },
  ],
  go: [
    { kind: "func", re: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/ },
    { kind: "type", re: /^\s*type\s+([A-Za-z_]\w*)\s+/ },
  ],
  rust: [
    { kind: "fn", re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: "struct", re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: "enum", re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/ },
  ],
  cpp: [
    { kind: "class", re: /^\s*(?:class|struct)\s+([A-Za-z_]\w*)/ },
    {
      kind: "method",
      re: /^\s*(?:virtual\s+)?[\w:<>,*&\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const)?\s*\{?/,
    },
  ],
};

for (const [name, mod] of [
  ["java", java],
  ["javascript", javascript],
  ["typescript", typescript],
  ["python", python],
  ["json", json],
  ["xml", xml],
  ["css", css],
  ["bash", bash],
  ["yaml", yaml],
  ["markdown", markdown],
  ["go", go],
  ["rust", rust],
  ["cpp", cpp],
  ["sql", sql],
  ["plaintext", plaintext],
]) {
  hljs.registerLanguage(name, mod);
}

marked.setOptions({
  gfm: true,
  breaks: false,
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : undefined;
    if (language) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  },
});

function extname(path) {
  const base = String(path || "").split(/[/\\]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getFileKind(path) {
  const ext = extname(path);
  if (ext === "md" || ext === "markdown") return "markdown";
  return "code";
}

function resolveLanguage(path) {
  return LANG_BY_EXT[extname(path)] || null;
}

function indexSymbols(text, lang) {
  const patterns = DEF_PATTERNS_BY_LANG[lang] || [];
  const lines = String(text ?? "").split("\n");
  const defs = [];
  const byName = new Map();

  lines.forEach((line, i) => {
    for (const { kind, re } of patterns) {
      const m = line.match(re);
      const name = m && (m[1] || m[2]);
      if (!name) continue;
      const entry = { name, line: i + 1, kind };
      defs.push(entry);
      if (!byName.has(name)) byName.set(name, entry);
    }
  });

  return { defs, byName };
}

function highlightLine(line, lang) {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(line);
}

function scrollToCodeLine(container, lineNum) {
  const root = container.querySelector(".code-preview-scroller") || container;
  const row = root.querySelector(`#code-line-${lineNum}`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("code-line-flash");
  setTimeout(() => row.classList.remove("code-line-flash"), 1400);
}

function getIdentFromClick(e, contentEl) {
  const range =
    document.caretRangeFromPoint?.(e.clientX, e.clientY) ||
    (() => {
      const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
      if (!pos) return null;
      const r = document.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      r.setEnd(pos.offsetNode, pos.offset);
      return r;
    })();
  if (!range || !contentEl.contains(range.startContainer)) return "";

  let node = range.startContainer;
  let offset = range.startOffset;
  if (node.nodeType !== Node.TEXT_NODE) {
    const t = node.textContent || "";
    const before = t.slice(0, offset);
    const m = before.match(/[A-Za-z_$]\w*$/);
    return m?.[0] || "";
  }

  const text = node.textContent || "";
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  const left = before.match(/[A-Za-z_$]\w*$/)?.[0] || "";
  const right = after.match(/^\w*/)?.[0] || "";
  return left + right;
}

function renderMarkdown(container, content) {
  const raw = String(content ?? "");
  const html = DOMPurify.sanitize(marked.parse(raw), {
    ADD_TAGS: ["input"],
    ADD_ATTR: ["target", "rel", "type", "checked", "disabled"],
  });
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "md-preview";
  wrap.innerHTML = html;
  wrap.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
  container.appendChild(wrap);
}

function renderCode(container, content, path) {
  const lang = resolveLanguage(path);
  const text = String(content ?? "");
  const lines = text.split("\n");
  const { defs, byName } = indexSymbols(text, lang);

  container.innerHTML = "";
  const outer = document.createElement("div");
  outer.className = "code-preview-outer";

  if (defs.length) {
    const nav = document.createElement("div");
    nav.className = "code-symbol-nav";
    nav.innerHTML = defs
      .slice(0, 60)
      .map(
        (d) =>
          `<button type="button" class="code-symbol-chip" data-line="${d.line}" title="第 ${d.line} 行">${escapeHtml(d.kind)} ${escapeHtml(d.name)}</button>`,
      )
      .join("");
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-line]");
      if (btn) scrollToCodeLine(outer, Number(btn.dataset.line));
    });
    outer.appendChild(nav);
  }

  const scroller = document.createElement("div");
  scroller.className = "code-preview-scroller";

  const body = document.createElement("div");
  body.className = "code-line-table";

  const defLines = new Set(defs.map((d) => d.line));

  lines.forEach((line, i) => {
    const lineNum = i + 1;
    const row = document.createElement("div");
    row.className = "code-line-row";
    row.id = `code-line-${lineNum}`;
    if (defLines.has(lineNum)) row.classList.add("code-line-def");

    const gutter = document.createElement("span");
    gutter.className = "code-line-gutter";
    gutter.textContent = String(lineNum);

    const code = document.createElement("span");
    code.className = "code-line-content hljs";
    code.innerHTML = highlightLine(line, lang);

    row.appendChild(gutter);
    row.appendChild(code);
    body.appendChild(row);
  });

  body.addEventListener("click", (e) => {
    const chip = e.target.closest(".code-symbol-chip");
    if (chip) return;
    const row = e.target.closest(".code-line-row");
    if (!row) return;
    const content = row.querySelector(".code-line-content");
    if (!content) return;
    const ident = getIdentFromClick(e, content);
    if (!ident) return;
    const target = byName.get(ident);
    if (target) scrollToCodeLine(outer, target.line);
  });

  scroller.appendChild(body);
  outer.appendChild(scroller);
  container.appendChild(outer);
}

function renderPlain(container, content) {
  renderCode(container, content, "plain.txt");
}

function mountPreview(container, content, path) {
  if (!container) return;
  const kind = getFileKind(path);
  try {
    if (kind === "markdown") {
      renderMarkdown(container, content);
    } else {
      renderCode(container, content, path);
    }
  } catch {
    renderPlain(container, content);
  }
}

const ForgeFilePreview = {
  getFileKind,
  resolveLanguage,
  renderMarkdown,
  renderCode,
  renderPlain,
  mountPreview,
  scrollToCodeLine,
};

if (typeof globalThis !== "undefined") {
  globalThis.ForgeFilePreview = ForgeFilePreview;
}
if (typeof window !== "undefined") {
  window.ForgeFilePreview = ForgeFilePreview;
}
