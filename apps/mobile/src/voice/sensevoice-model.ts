import {
  ModelDownloadManager,
  type ModelState,
  type SherpaModelConfig,
} from "expo-sherpa-onnx";

/** SenseVoice Small int8 — zh/en/ja/ko/yue, offline on-device ASR. */
export const SENSEVOICE_MODEL_ID = "sensevoice-zh-int8";

/** Compressed download size shown to users (~archive). */
export const SENSEVOICE_DOWNLOAD_MB = 85;

/** Unpacked disk usage shown to users (~onnx + tokens). */
export const SENSEVOICE_DISK_MB = 230;

export const SENSEVOICE_MODEL_CONFIG: SherpaModelConfig = {
  useCase: "asr-offline",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
  archiveFormat: "tar.bz2",
  version: "2024-07-17",
  sizeBytes: SENSEVOICE_DISK_MB * 1024 * 1024,
  expectedDir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
};

let registered = false;

export function ensureSenseVoiceRegistered(): void {
  if (registered) return;
  ModelDownloadManager.registerModel(SENSEVOICE_MODEL_ID, SENSEVOICE_MODEL_CONFIG);
  registered = true;
}

export function getSenseVoiceModelState(): ModelState {
  ensureSenseVoiceRegistered();
  return ModelDownloadManager.getModelState(SENSEVOICE_MODEL_ID);
}

export function subscribeSenseVoiceModel(
  listener: (state: ModelState) => void,
): () => void {
  ensureSenseVoiceRegistered();
  return ModelDownloadManager.subscribe((id, state) => {
    if (id === SENSEVOICE_MODEL_ID) listener(state);
  });
}

export async function isSenseVoiceReady(): Promise<boolean> {
  ensureSenseVoiceRegistered();
  const state = ModelDownloadManager.getModelState(SENSEVOICE_MODEL_ID);
  if (state.status === "READY" && state.localPath) return true;
  // Hydration is async after register; wait briefly for registry load.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const next = ModelDownloadManager.getModelState(SENSEVOICE_MODEL_ID);
  return next.status === "READY" && Boolean(next.localPath);
}

export async function ensureSenseVoiceModelReady(
  onProgress?: (percent: number, status: string) => void,
): Promise<string> {
  ensureSenseVoiceRegistered();
  const unsubscribe = ModelDownloadManager.subscribe((id, state) => {
    if (id !== SENSEVOICE_MODEL_ID) return;
    if (state.status === "DOWNLOADING" || state.status === "EXTRACTING") {
      onProgress?.(
        Math.round(state.progress?.percent ?? 0),
        state.status === "EXTRACTING" ? "解压模型…" : "下载模型…",
      );
    }
  });
  try {
    const localPath = await ModelDownloadManager.ensureModelReady(SENSEVOICE_MODEL_ID);
    return localPath;
  } finally {
    unsubscribe();
  }
}

export function formatSenseVoiceSizeHint(): string {
  return `约 ${SENSEVOICE_DOWNLOAD_MB} MB 下载，解压后约 ${SENSEVOICE_DISK_MB} MB`;
}
