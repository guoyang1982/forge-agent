export type FileIconKind =
  | "folder"
  | "typescript"
  | "javascript"
  | "css"
  | "json"
  | "markdown"
  | "gitignore"
  | "python"
  | "shell"
  | "html"
  | "binary"
  | "file";

export function resolveFileIconKind(name: string, kind: "file" | "directory" | "binary"): FileIconKind {
  if (kind === "directory") return "folder";
  if (kind === "binary") return "binary";
  const lower = name.toLowerCase();
  if (lower === ".gitignore" || lower.endsWith(".gitignore")) return "gitignore";
  if (lower === "package.json" || lower.endsWith(".json")) return "json";
  if (/\.tsx?$/.test(lower)) return "typescript";
  if (/\.jsx?$/.test(lower) || /\.mjs$/.test(lower) || /\.cjs$/.test(lower)) return "javascript";
  if (/\.css$/.test(lower) || /\.scss$/.test(lower)) return "css";
  if (/\.md$/.test(lower) || /\.markdown$/.test(lower)) return "markdown";
  if (/\.py$/.test(lower)) return "python";
  if (/\.(sh|bash|zsh)$/.test(lower)) return "shell";
  if (/\.html?$/.test(lower)) return "html";
  return "file";
}
