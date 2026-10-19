/**
 * Bundled as markdown-preview.bundle.js — ForgeMarkdownPreview global.
 * Same stack as Workbench file preview: marked + DOMPurify.
 */
import { marked } from "marked";
import createDOMPurify from "dompurify";

marked.setOptions({
  gfm: true,
  breaks: false,
});

const PURIFY_OPTIONS = {
  ADD_TAGS: ["input"],
  ADD_ATTR: ["target", "rel", "type", "checked", "disabled"],
};

function sanitizeHtml(html) {
  if (typeof createDOMPurify?.sanitize === "function") {
    return createDOMPurify.sanitize(html, PURIFY_OPTIONS);
  }
  if (typeof window !== "undefined" && typeof createDOMPurify === "function") {
    return createDOMPurify(window).sanitize(html, PURIFY_OPTIONS);
  }
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

export function renderMarkdown(text) {
  const raw = String(text ?? "");
  return `<div class="md-preview">${sanitizeHtml(marked.parse(raw))}</div>`;
}

function mountMarkdown(container, text) {
  if (!container) return;
  container.innerHTML = renderMarkdown(text);
  container.querySelectorAll('a[href^="http"]').forEach((anchor) => {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  });
}

const ForgeMarkdownPreview = {
  renderMarkdown,
  mountMarkdown,
};

if (typeof globalThis !== "undefined") {
  globalThis.ForgeMarkdownPreview = ForgeMarkdownPreview;
}
if (typeof window !== "undefined") {
  window.ForgeMarkdownPreview = ForgeMarkdownPreview;
}
