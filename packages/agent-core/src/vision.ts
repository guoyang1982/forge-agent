import type { ForgeConfig, RunAttachment } from "@forge/protocol";
import { modelSupportsVision, resolveSupportsVision } from "./attachments.js";

/** @deprecated Use resolveSupportsNativeImageUrl */
export type VisionMode = "auto" | "native" | "off";

export type VisionStrategy = "none" | "native" | "skipped";

export interface VisionPrepareResult {
  attachments: RunAttachment[] | undefined;
  supportsNativeImageUrl: boolean;
  strategy: VisionStrategy;
  skippedImages: number;
  /** User-facing hint when images were not sent. */
  skipReason?: string;
}

export function resolveVisionMode(
  model: Pick<ForgeConfig["model"], "visionMode" | "vision">,
): VisionMode {
  const raw = model.visionMode as string | undefined;
  if (raw === "proxy") return "auto";
  if (raw === "native" || raw === "off" || raw === "auto") return raw;
  if (model.vision === false) return "off";
  return "auto";
}

/** Whether to send OpenAI-style image_url parts for the active model config. */
export function resolveSupportsNativeImageUrl(
  modelName: string,
  _baseUrl?: string,
  modelCfg?: Pick<ForgeConfig["model"], "vision" | "visionMode">,
): boolean {
  const mode = resolveVisionMode(modelCfg ?? {});
  if (mode === "off" || modelCfg?.vision === false) return false;
  if (modelCfg?.vision === true) return true;
  return modelSupportsVision(modelName);
}

export function visionSkipReason(
  modelName: string,
  modelCfg?: Pick<ForgeConfig["model"], "vision" | "visionMode">,
): string {
  if (resolveVisionMode(modelCfg ?? {}) === "off" || modelCfg?.vision === false) {
    return `当前已关闭识图（visionMode: off 或 vision: false）。`;
  }
  return `当前模型「${modelName}」未标记为支持视觉。请换用 gpt-4o / gpt-5.5 等，或在 config 的 model 中设置 "vision": true。`;
}

/**
 * Prepare image attachments: supported models get native image_url; others are skipped (no proxy).
 */
export function prepareAttachmentsForVision(
  config: ForgeConfig,
  attachments: RunAttachment[] | undefined,
): VisionPrepareResult {
  const images = (attachments ?? []).filter((a) => a.kind === "image" && a.dataUrl);
  if (!images.length) {
    return {
      attachments,
      supportsNativeImageUrl: false,
      strategy: "none",
      skippedImages: 0,
    };
  }

  const { name: modelName } = config.model;
  const nativeOk = resolveSupportsNativeImageUrl(
    modelName,
    config.model.baseUrl,
    config.model,
  );

  if (nativeOk) {
    return {
      attachments,
      supportsNativeImageUrl: true,
      strategy: "native",
      skippedImages: 0,
    };
  }

  return {
    attachments,
    supportsNativeImageUrl: false,
    strategy: "skipped",
    skippedImages: images.length,
    skipReason: visionSkipReason(modelName, config.model),
  };
}
