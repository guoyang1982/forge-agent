/** Pending composer attachment before / while encoding for run.start. */
export type PendingAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  /** Local preview URI (images). */
  localUri?: string;
  /** Encoded payload ready for RPC. */
  dataUrl?: string;
  text?: string;
  rawBase64?: string;
};

export type MobileAttachmentPayload = {
  kind: "image" | "file";
  name: string;
  mimeType: string;
  dataUrl?: string;
  text?: string;
  rawBase64?: string;
};

export const MAX_PENDING_ATTACHMENTS = 5;
export const MAX_IMAGE_EDGE = 1280;
export const MAX_DATA_URL_CHARS = 1_800_000;

export function opaqueAttachmentId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx >= 0 ? base.slice(idx + 1).toLowerCase() : "";
}

export function mimeFromName(name: string, fallback = "application/octet-stream"): string {
  const ext = extensionOf(name);
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "md":
      return "text/markdown";
    case "txt":
    case "log":
      return "text/plain";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "css":
    case "html":
    case "xml":
    case "yaml":
    case "yml":
    case "toml":
    case "py":
    case "go":
    case "rs":
    case "java":
    case "kt":
    case "swift":
    case "sh":
      return "text/plain";
    default:
      return fallback;
  }
}

export function isProbablyTextFilename(name: string): boolean {
  const ext = extensionOf(name);
  if (!ext) return false;
  return [
    "txt", "md", "markdown", "json", "csv", "tsv", "log", "yml", "yaml", "toml",
    "xml", "html", "htm", "css", "scss", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs",
    "py", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "rb", "php",
    "sh", "bash", "zsh", "fish", "ps1", "sql", "graphql", "gql", "proto", "env", "ini",
    "conf", "cfg", "dockerfile", "makefile", "gitignore", "dockerignore",
  ].includes(ext);
}

export function isImageFilename(name: string, mimeType?: string): boolean {
  if (mimeType?.startsWith("image/")) return true;
  return ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp"].includes(extensionOf(name));
}

export function toRpcAttachments(items: PendingAttachment[]): MobileAttachmentPayload[] {
  return items.map((item) => {
    const payload: MobileAttachmentPayload = {
      kind: item.kind,
      name: item.name,
      mimeType: item.mimeType,
    };
    if (item.dataUrl) payload.dataUrl = item.dataUrl;
    if (item.text != null) payload.text = item.text;
    if (item.rawBase64) payload.rawBase64 = item.rawBase64;
    return payload;
  });
}

export async function collectSettledAttachments<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
): Promise<{ items: R[]; errors: string[] }> {
  const out: R[] = [];
  const errors: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    try {
      out.push(await mapper(items[index] as T, index));
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return { items: out, errors };
}

export function estimateAttachmentChars(items: PendingAttachment[]): number {
  return items.reduce((sum, item) => {
    return sum
      + (item.dataUrl?.length ?? 0)
      + (item.text?.length ?? 0)
      + (item.rawBase64?.length ?? 0);
  }, 0);
}

/** Parse clipboard / data-url image payloads into mime + base64. */
export function stripDataUrlBase64(data: string): { mimeType: string; base64: string } | null {
  const trimmed = data.trim();
  const match = /^data:([^;]+);base64,(.+)$/i.exec(trimmed);
  if (match) {
    return { mimeType: match[1] || "image/png", base64: match[2] || "" };
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.replace(/\s/g, "").length > 32) {
    return { mimeType: "image/png", base64: trimmed.replace(/\s/g, "") };
  }
  return null;
}
