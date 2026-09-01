import { OfficeParser, type SupportedFileType } from "officeparser";
import { decodeBufferAsText, isProbablyUtf8Text, MAX_ATTACHMENT_BYTES, MAX_EXTRACTED_TEXT } from "./decode.js";
import {
  BINARY_DOCUMENT_EXTENSIONS,
  extensionOf,
  IMAGE_EXTENSIONS,
  isDotConfigFilename,
  isTextLikeFilename,
  PLAIN_TEXT_EXTENSIONS,
  TEXT_FILENAMES,
  attachmentPickerExtensions,
  ATTACHMENT_SUPPORT_SUMMARY,
} from "./extensions.js";

export {
  IMAGE_EXTENSIONS,
  BINARY_DOCUMENT_EXTENSIONS,
  PLAIN_TEXT_EXTENSIONS,
  TEXT_FILENAMES,
  extensionOf,
  isTextLikeFilename,
  isDotConfigFilename,
  attachmentPickerExtensions,
  ATTACHMENT_SUPPORT_SUMMARY,
  MAX_ATTACHMENT_BYTES,
  MAX_EXTRACTED_TEXT,
};

const FILE_TYPE_MAP: Record<string, SupportedFileType> = {
  pdf: "pdf",
  docx: "docx",
  doc: "docx",
  xlsx: "xlsx",
  xls: "xlsx",
  pptx: "pptx",
  ppt: "pptx",
  odt: "odt",
  odp: "odp",
  ods: "ods",
  rtf: "rtf",
  csv: "csv",
  md: "md",
  html: "html",
  htm: "html",
};

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

function resolveFileType(ext: string): SupportedFileType | undefined {
  return FILE_TYPE_MAP[ext];
}

function shouldReadAsPlainText(fileName: string, data: Buffer): boolean {
  const base = (fileName.split(/[/\\]/).pop() ?? fileName).toLowerCase();
  if (TEXT_FILENAMES.has(base)) return true;
  if (isDotConfigFilename(fileName)) return true;
  const ext = extensionOf(fileName);
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) return true;
  if (BINARY_DOCUMENT_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)) return false;
  if (!ext) return isProbablyUtf8Text(data);
  return isProbablyUtf8Text(data);
}

/**
 * Extract plain text from an attachment buffer (office docs, PDF, or UTF-8 text / code).
 */
export async function extractDocumentText(
  fileName: string,
  data: Buffer,
): Promise<ExtractResult> {
  const ext = extensionOf(fileName);
  if (data.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `文件过大（上限 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB）`,
    };
  }

  if (shouldReadAsPlainText(fileName, data)) {
    const text = decodeBufferAsText(data).trim();
    if (!text) {
      return { ok: false, error: "文件为空或无法解码为文本" };
    }
    return { ok: true, text };
  }

  if (!BINARY_DOCUMENT_EXTENSIONS.has(ext)) {
    return { ok: false, error: `不支持的文件类型 (.${ext || "无扩展名"})` };
  }

  const fileType = resolveFileType(ext);
  if (!fileType) {
    return { ok: false, error: `不支持的文件类型 (.${ext})` };
  }

  if (ext === "doc") {
    return {
      ok: false,
      error: "旧版 .doc 格式请先另存为 .docx 后再上传",
    };
  }

  try {
    const ast = await OfficeParser.parseOffice(data, { fileType });
    const text = ast.toText().trim();
    if (!text) {
      return {
        ok: false,
        error: "未能提取到文本（扫描版 PDF 需 OCR，当前未启用）",
      };
    }
    return { ok: true, text: text.slice(0, MAX_EXTRACTED_TEXT) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || "文档解析失败" };
  }
}

export function attachmentTextFromExtract(
  fileName: string,
  result: ExtractResult,
): string {
  if (result.ok) return result.text;
  return `[附件 ${fileName} 未能解析为文本: ${result.error}]`;
}

export interface ExtractedDocumentChunk {
  locator: string;
  text: string;
}

/**
 * Split extracted document text into stable, citable chunks for KnowledgeStore.
 */
export function chunkExtractedDocument(
  sourceLocator: string,
  text: string,
  maxChunkChars = 1200,
): ExtractedDocumentChunk[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: ExtractedDocumentChunk[] = [];
  let buffer = "";
  let chunkIndex = 0;

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (!trimmed) {
      buffer = "";
      return;
    }
    chunks.push({
      locator: `${sourceLocator}:chunk:${chunkIndex}`,
      text: trimmed,
    });
    chunkIndex += 1;
    buffer = "";
  };

  for (const paragraph of paragraphs.length ? paragraphs : [normalized]) {
    if (!buffer) {
      buffer = paragraph;
    } else if (`${buffer}\n\n${paragraph}`.length <= maxChunkChars) {
      buffer = `${buffer}\n\n${paragraph}`;
    } else {
      flush();
      buffer = paragraph;
    }
    if (buffer.length >= maxChunkChars) {
      flush();
    }
  }
  flush();
  return chunks.length ? chunks : [{ locator: `${sourceLocator}:chunk:0`, text: normalized }];
}
