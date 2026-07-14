import type { RunRequest } from "@forge/protocol";

export type AcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

const FORGE_TURN_RULES = [
  "Forge run rules:",
  "- Always reply in Chinese unless the user explicitly asks otherwise.",
  "- When the user asks to generate/create an image, create a real image file in the workspace (for example .svg, .png, .jpg, or .webp) and include its relative path in the final answer.",
  "- Do not say an image was generated unless a concrete image file exists and its path is returned.",
  "- Computer Use compatibility: when direct Computer Use MCP tools (such as list_apps, get_app_state, click, type_text, or press_key) are available, use them directly even if the loaded skill describes a node_repl transport. The direct MCP tools are the supported Forge external-runtime transport; do not refuse merely because node_repl is absent.",
].join("\n");

export function buildAcpPromptBlocks(
  request: RunRequest,
  options?: { priorHistory?: string },
): AcpPromptBlock[] {
  const sections: string[] = [];

  sections.push(FORGE_TURN_RULES);

  if (options?.priorHistory) {
    sections.push(options.priorHistory);
  }

  const files = [...(request.files ?? [])];
  if (files.length) {
    sections.push(
      [
        "Referenced files (relative to workspace when possible):",
        ...files.map((file) => `- ${file}`),
      ].join("\n"),
    );
  }

  for (const attachment of request.attachments ?? []) {
    if (attachment.kind === "file") {
      if (attachment.text) {
        sections.push(
          [`--- Attachment: ${attachment.name} ---`, attachment.text].join("\n"),
        );
      } else {
        sections.push(`[File attached: ${attachment.name}]`);
      }
      continue;
    }
    if (attachment.kind === "image") {
      sections.push(
        `[Image attached: ${attachment.name}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}]`,
      );
    }
  }

  const message = request.message.trim();
  if (message) sections.push(message);

  const blocks: AcpPromptBlock[] = [];
  const text = sections.join("\n\n").trim();
  if (text) blocks.push({ type: "text", text });

  for (const attachment of request.attachments ?? []) {
    if (attachment.kind !== "image" || !attachment.dataUrl) continue;
    const match = /^data:([^;]+);base64,(.+)$/i.exec(attachment.dataUrl);
    if (!match) continue;
    blocks.push({
      type: "image",
      mimeType: match[1] || attachment.mimeType || "image/png",
      data: match[2],
    });
  }

  if (!blocks.length) {
    blocks.push({ type: "text", text: request.message || "" });
  }

  return blocks;
}

export function expandRunPromptText(
  request: RunRequest,
  options?: { priorHistory?: string },
): string {
  return buildAcpPromptBlocks(request, options)
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}
