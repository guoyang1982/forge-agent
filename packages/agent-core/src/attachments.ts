import type { ChatContent, ChatContentPart, RunAttachment } from "@forge/protocol";

/** Heuristic: OpenAI-compatible vision / multimodal model ids. */
export function modelSupportsVision(modelName: string): boolean {
  const n = modelName.toLowerCase().trim();
  if (!n) return false;
  if (/no-vision|text-only|instruct(?!.*vl)/.test(n) && !/vl|vision|4o|multimodal/.test(n)) {
    return false;
  }
  if (/^deepseek-(chat|reasoner)$/.test(n)) {
    return false;
  }
  return /gpt-4o|gpt-4-turbo|gpt-4-o|gpt-4\.1|gpt-5|gpt-5\.|o1-|o3-|o4-|claude-3|claude-sonnet|claude-opus|claude-haiku|gemini|qwen3\.|qwen-vl|qwen-plus|qwen-max|qwen-turbo|qwen.*vl|glm-4v|deepseek-v4|deepseek-pro|vision|multimodal|grok-2-vision|internvl|pixtral|llava|doubao.*vision|kimi.*vision/i.test(
    n,
  );
}

/** User/model expects vision; native image_url may still be unavailable (see resolveSupportsNativeImageUrl). */
export function resolveSupportsVision(
  modelName: string,
  configVision?: boolean,
): boolean {
  if (configVision === true) return true;
  if (configVision === false) return false;
  return modelSupportsVision(modelName);
}

export function countParsedDocumentAttachments(
  attachments: RunAttachment[] | undefined,
): number {
  return (attachments ?? []).filter(
    (a) => a.kind === "file" && a.text && !a.text.includes("未能解析为文本"),
  ).length;
}

/** Ensure OpenAI-compatible data URL (data:image/png;base64,...). */
export function normalizeImageDataUrl(dataUrl: string, mimeType = "image/png"): string {
  const trimmed = dataUrl.trim();
  if (trimmed.startsWith("data:")) return trimmed;
  return `data:${mimeType || "image/png"};base64,${trimmed}`;
}

export function countImagesInUserContent(content: ChatContent): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((p) => p.type === "image_url").length;
}

export function buildUserMessageContent(
  message: string,
  attachments: RunAttachment[] | undefined,
  supportsVision: boolean,
): ChatContent {
  const text = message.trim();
  const images = (attachments ?? []).filter((a) => a.kind === "image" && a.dataUrl);
  const files = (attachments ?? []).filter((a) => a.kind === "file" && a.text);

  let fileBlock = "";
  for (const f of files) {
    fileBlock += `\n### Attached document: ${f.name}\n${f.text}\n`;
  }

  let lead = text;
  if (!lead && files.length && !images.length) {
    lead = "请分析以上附件文档的内容。";
  } else if (!lead && images.length) {
    lead = "请查看附件图片。";
  }
  const fullText = `${lead}${fileBlock}`.trim();

  if (!images.length) {
    return fullText;
  }

  if (!supportsVision) {
    const note = images
      .map((i) => `[图片 ${i.name} 未随消息发送：当前模型未启用视觉]`)
      .join("\n");
    return fullText ? `${fullText}\n\n${note}` : note;
  }

  const parts: ChatContentPart[] = [];
  if (fullText) parts.push({ type: "text", text: fullText });
  for (const img of images) {
    parts.push({
      type: "image_url",
      image_url: {
        url: normalizeImageDataUrl(img.dataUrl!, img.mimeType || "image/png"),
        detail: "auto",
      },
    });
  }
  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }
  return parts;
}
