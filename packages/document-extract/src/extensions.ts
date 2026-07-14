/** Raster images → vision API (handled in desktop/daemon, not officeparser). */
export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
]);

/** Office / PDF — parsed via officeparser. */
export const BINARY_DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xls",
  "pptx",
  "ppt",
  "odt",
  "odp",
  "ods",
  "rtf",
]);

/** Source code & plain text — read as UTF-8 (with encoding fallbacks). */
export const PLAIN_TEXT_EXTENSIONS = new Set([
  // plain / config
  "txt",
  "md",
  "markdown",
  "rst",
  "adoc",
  "csv",
  "tsv",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "config",
  "properties",
  "env",
  "sql",
  "log",
  // web
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "astro",
  // js/ts
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  // systems
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "m",
  "mm",
  "go",
  "rs",
  "zig",
  "asm",
  "s",
  "java",
  "kt",
  "kts",
  "scala",
  "sc",
  "groovy",
  "gradle",
  "clj",
  "cljs",
  "edn",
  "cs",
  "fs",
  "fsx",
  "vb",
  "swift",
  "php",
  "rb",
  "erb",
  "py",
  "pyw",
  "pyi",
  "ipynb",
  "r",
  "jl",
  "lua",
  "pl",
  "pm",
  "ex",
  "exs",
  "erl",
  "hrl",
  "hs",
  "lhs",
  "ml",
  "mli",
  "v",
  "sv",
  "vhd",
  "tcl",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "bat",
  "cmd",
  "dockerfile",
  "proto",
  "graphql",
  "gql",
  "prisma",
  "tf",
  "tfvars",
  "hcl",
  "nix",
  "patch",
  "diff",
  "cmake",
  "make",
  "mk",
  "mod",
  "sum",
  "lock",
  "wat",
]);

/** Basenames without extension (case-insensitive). */
export const TEXT_FILENAMES = new Set([
  "dockerfile",
  "makefile",
  "gnumakefile",
  "jenkinsfile",
  "vagrantfile",
  "gemfile",
  "procfile",
  "brewfile",
  "rakefile",
  "guardfile",
  "license",
  "licence",
  "readme",
  "changelog",
  "authors",
  "contributing",
  "codeowners",
]);

/** Dot-only config files: .gitignore, .editorconfig, .prettierrc, … */
export function isDotConfigFilename(fileName: string): boolean {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  return base.startsWith(".") && !base.slice(1).includes(".");
}

export function extensionOf(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  if (!base.includes(".")) return "";
  if (base.startsWith(".") && !base.slice(1).includes(".")) {
    return base.slice(1).toLowerCase();
  }
  return base.slice(base.lastIndexOf(".") + 1).toLowerCase();
}

export function isTextLikeFilename(fileName: string): boolean {
  const base = (fileName.split(/[/\\]/).pop() ?? fileName).toLowerCase();
  if (TEXT_FILENAMES.has(base)) return true;
  if (isDotConfigFilename(fileName)) return true;
  const ext = extensionOf(fileName);
  if (!ext) return false;
  return PLAIN_TEXT_EXTENSIONS.has(ext);
}

/** Extensions shown in the desktop file picker (images + text + office). */
export function attachmentPickerExtensions(): string[] {
  const all = new Set<string>([
    ...IMAGE_EXTENSIONS,
    ...PLAIN_TEXT_EXTENSIONS,
    ...BINARY_DOCUMENT_EXTENSIONS,
  ]);
  return [...all].sort();
}

export const ATTACHMENT_SUPPORT_SUMMARY = {
  images: [...IMAGE_EXTENSIONS].sort().join(", "),
  office: [...BINARY_DOCUMENT_EXTENSIONS].sort().join(", "),
  code: "js, ts, tsx, jsx, py, go, rs, java, kt, cs, php, rb, vue, svelte, …（见 PLAIN_TEXT_EXTENSIONS）",
  limits: "单文件 ≤ 20MB，提取正文最多约 5 万字",
} as const;
