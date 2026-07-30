import {
  attachmentTextFromExtract,
  extractDocumentText,
  IMAGE_EXTENSIONS,
} from "@forge/document-extract";
import type { RunAttachment } from "@forge/protocol";

const MAX_ATTACHMENTS = 5;
const MAX_DATA_URL_CHARS = 2_000_000; // ~1.5MB binary
const MAX_RAW_BASE64_CHARS = 2_800_000;
const MAX_TOTAL_PAYLOAD_CHARS = 5_500_000;

export type MobileRunAttachmentInput = {
  kind: "image" | "file";
  name: string;
  mimeType: string;
  dataUrl?: string;
  text?: string;
  rawBase64?: string;
};

export async function normalizeMobileAttachments(
  items: MobileRunAttachmentInput[] | undefined,
): Promise<RunAttachment[]> {
  if (!items?.length) return [];
  if (items.length > MAX_ATTACHMENTS) {
    throw new Error(`最多附带 ${MAX_ATTACHMENTS} 个文件`);
  }

  let totalChars = 0;
  const out: RunAttachment[] = [];

  for (const item of items) {
    const name = sanitizeName(item.name);
    const mimeType = (item.mimeType || "application/octet-stream").slice(0, 120);
    const ext = extensionOf(name);

    if (item.kind === "image") {
      const dataUrl = item.dataUrl?.trim();
      if (!dataUrl || !dataUrl.startsWith("data:")) {
        throw new Error(`图片附件无效：${name}`);
      }
      if (dataUrl.length > MAX_DATA_URL_CHARS) {
        throw new Error(`图片过大：${name}`);
      }
      totalChars += dataUrl.length;
      out.push({ kind: "image", name, mimeType: mimeType || "image/jpeg", dataUrl });
      continue;
    }

    if (typeof item.text === "string" && item.text.length > 0) {
      const text = item.text.slice(0, 500_000);
      totalChars += text.length;
      out.push({ kind: "file", name, mimeType, text });
      continue;
    }

    if (typeof item.rawBase64 === "string" && item.rawBase64.length > 0) {
      if (item.rawBase64.length > MAX_RAW_BASE64_CHARS) {
        throw new Error(`文件过大：${name}`);
      }
      totalChars += item.rawBase64.length;
      if (IMAGE_EXTENSIONS.has(ext)) {
        const imageMime = mimeType.startsWith("image/") ? mimeType : mimeFromExt(ext);
        out.push({
          kind: "image",
          name,
          mimeType: imageMime,
          dataUrl: `data:${imageMime};base64,${item.rawBase64}`,
        });
        continue;
      }
      let buf: Buffer;
      try {
        buf = Buffer.from(item.rawBase64, "base64");
      } catch {
        throw new Error(`文件解码失败：${name}`);
      }
      if (!buf.length) throw new Error(`文件为空：${name}`);
      const extracted = await extractDocumentText(name, buf);
      out.push({
        kind: "file",
        name,
        mimeType,
        text: attachmentTextFromExtract(name, extracted),
      });
      continue;
    }

    throw new Error(`附件缺少内容：${name}`);
  }

  if (totalChars > MAX_TOTAL_PAYLOAD_CHARS) {
    throw new Error("附件总大小超限，请减少数量或压缩图片后再试");
  }
  return out;
}

function sanitizeName(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() || "file";
  return base.slice(0, 180) || "file";
}

function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx >= 0 ? base.slice(idx + 1).toLowerCase() : "";
}

function mimeFromExt(ext: string): string {
  switch (ext) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "jpg":
    case "jpeg":
    default:
      return "image/jpeg";
  }
}
