import { AudioStudioModule } from "@siteed/audio-studio";
import {
  createSTT,
  detectSttModel,
  type OfflineRecognizerConfig,
  type OfflineSTTEngine,
} from "expo-sherpa-onnx";
import { LegacyEventEmitter, type EventSubscription } from "expo-modules-core";
import {
  ensureSenseVoiceModelReady,
  getSenseVoiceModelState,
  isSenseVoiceReady,
} from "./sensevoice-model";
import { toNativePath } from "./native-path";

export { toNativePath } from "./native-path";

export const SENSEVOICE_WAVE_BARS = 40;
const RECORD_SAMPLE_RATE = 16_000;
/** Cap in-memory PCM (~60s mono float) to avoid runaway growth. */
const MAX_PCM_SAMPLES = RECORD_SAMPLE_RATE * 60;

type AnalysisPoint = {
  amplitude?: number;
  rms?: number;
};

type AnalysisEvent = {
  dataPoints?: AnalysisPoint[];
};

type AudioDataEvent = {
  pcmFloat32?: Float32Array | number[];
  encoded?: string;
};

let enginePromise: Promise<OfflineSTTEngine> | null = null;
let enginePath: string | null = null;
let recordingActive = false;
let analysisSubscription: EventSubscription | null = null;
let audioDataSubscription: EventSubscription | null = null;
let pcmSamples: number[] = [];
let waveLevels = Array.from({ length: SENSEVOICE_WAVE_BARS }, () => 0.08);
const waveListeners = new Set<(levels: number[]) => void>();

const audioEmitter = new LegacyEventEmitter(AudioStudioModule);

function notifyWaveListeners(): void {
  const snapshot = waveLevels.slice();
  for (const listener of waveListeners) {
    try {
      listener(snapshot);
    } catch {
      // ignore listener errors
    }
  }
}

function resetWaveLevels(): void {
  waveLevels = Array.from({ length: SENSEVOICE_WAVE_BARS }, () => 0.08);
  notifyWaveListeners();
}

/** Map mic amplitude/rms into 0..1 bar height. */
function normalizeLevel(point: AnalysisPoint): number {
  const rms = typeof point.rms === "number" ? point.rms : 0;
  const peak = typeof point.amplitude === "number" ? point.amplitude : 0;
  const mixed = Math.max(rms * 1.35, peak * 0.85);
  const boosted = Math.sqrt(Math.min(1, Math.max(0, mixed * 4.2)));
  return Math.min(1, 0.08 + boosted * 0.92);
}

function pushAnalysisPoints(points: AnalysisPoint[]): void {
  if (!points.length) return;
  let next = waveLevels.slice();
  for (const point of points) {
    next = [...next.slice(1), normalizeLevel(point)];
  }
  waveLevels = next;
  notifyWaveListeners();
}

function stopListeners(): void {
  if (analysisSubscription) {
    analysisSubscription.remove();
    analysisSubscription = null;
  }
  if (audioDataSubscription) {
    audioDataSubscription.remove();
    audioDataSubscription = null;
  }
}

function appendPcm(chunk: Float32Array | number[]): void {
  if (!chunk || chunk.length === 0) return;
  if (pcmSamples.length >= MAX_PCM_SAMPLES) return;
  const room = MAX_PCM_SAMPLES - pcmSamples.length;
  const take = Math.min(chunk.length, room);
  for (let i = 0; i < take; i += 1) {
    pcmSamples.push(Number(chunk[i]) || 0);
  }
}

export function subscribeSenseVoiceLevels(
  listener: (levels: number[]) => void,
): () => void {
  waveListeners.add(listener);
  listener(waveLevels.slice());
  return () => {
    waveListeners.delete(listener);
  };
}

function joinModelPath(dir: string, relative: string): string {
  const base = toNativePath(dir).replace(/\/+$/, "");
  const rel = relative.replace(/^\/+/, "");
  return `${base}/${rel}`;
}

async function buildSenseVoiceConfig(modelDir: string): Promise<OfflineRecognizerConfig> {
  const dir = toNativePath(modelDir);
  const detected = await detectSttModel(dir);
  if (detected.type !== "sense_voice") {
    throw new Error(`模型类型异常：${detected.type}（期望 SenseVoice）`);
  }
  const modelRel = detected.files.model;
  if (!modelRel) throw new Error("SenseVoice 模型文件缺失");
  const tokensRel = detected.tokensPath;
  if (!tokensRel) throw new Error("SenseVoice tokens.txt 缺失");

  return {
    modelConfig: {
      senseVoice: {
        model: joinModelPath(dir, modelRel),
        language: "zh",
        useInverseTextNormalization: true,
      },
      tokens: joinModelPath(dir, tokensRel),
      numThreads: 2,
      provider: "cpu",
      modelType: "sense_voice",
    },
    decodingMethod: "greedy_search",
  };
}

async function getEngine(modelDir: string): Promise<OfflineSTTEngine> {
  const normalized = toNativePath(modelDir);
  if (enginePromise && enginePath === normalized) return enginePromise;
  if (enginePromise && enginePath !== normalized) {
    try {
      const old = await enginePromise;
      await old.destroy();
    } catch {
      // ignore
    }
    enginePromise = null;
  }
  enginePath = normalized;
  enginePromise = (async () => {
    const config = await buildSenseVoiceConfig(normalized);
    return createSTT(config);
  })();
  try {
    return await enginePromise;
  } catch (cause) {
    enginePromise = null;
    enginePath = null;
    throw cause;
  }
}

export async function prepareSenseVoiceEngine(
  onProgress?: (percent: number, status: string) => void,
): Promise<string> {
  const localPath = await ensureSenseVoiceModelReady(onProgress);
  onProgress?.(100, "加载识别引擎…");
  await getEngine(localPath);
  return localPath;
}

async function ensureMicPermission(): Promise<void> {
  const permissions = AudioStudioModule.getPermissionsAsync
    ? await AudioStudioModule.getPermissionsAsync()
    : null;
  if (permissions?.granted) return;
  const asked = AudioStudioModule.requestPermissionsAsync
    ? await AudioStudioModule.requestPermissionsAsync()
    : { granted: true };
  if (!asked?.granted) throw new Error("需要麦克风权限才能语音输入");
}

export async function startSenseVoiceRecording(): Promise<void> {
  const ready = await isSenseVoiceReady();
  if (!ready) throw new Error("语音模型尚未就绪，请先下载");
  const state = getSenseVoiceModelState();
  if (!state.localPath) throw new Error("语音模型路径无效");

  await ensureMicPermission();

  if (recordingActive) {
    stopListeners();
    try {
      await AudioStudioModule.stopRecording();
    } catch {
      // ignore
    }
    recordingActive = false;
  }

  pcmSamples = [];
  resetWaveLevels();
  stopListeners();

  analysisSubscription = audioEmitter.addListener(
    "AudioAnalysis",
    (event: AnalysisEvent) => {
      if (!recordingActive) return;
      pushAnalysisPoints(event?.dataPoints ?? []);
    },
  );

  audioDataSubscription = audioEmitter.addListener(
    "AudioData",
    (event: AudioDataEvent) => {
      if (!recordingActive) return;
      if (event?.pcmFloat32) appendPcm(event.pcmFloat32);
    },
  );

  await AudioStudioModule.startRecording({
    sampleRate: RECORD_SAMPLE_RATE,
    channels: 1,
    encoding: "pcm_16bit",
    enableProcessing: true,
    intervalAnalysis: 80,
    segmentDurationMs: 50,
    interval: 100,
    streamFormat: "float32",
  });
  recordingActive = true;
  void getEngine(state.localPath).catch(() => undefined);
}

async function transcribeCapturedAudio(
  engine: OfflineSTTEngine,
  fileUri?: string | null,
): Promise<string> {
  // Prefer in-memory PCM — avoids Android file:/ URI + WaveReader mismatches.
  if (pcmSamples.length > 800) {
    const result = await engine.transcribeSamples(pcmSamples, RECORD_SAMPLE_RATE);
    return (result.text || "").trim();
  }

  if (fileUri) {
    const path = toNativePath(fileUri);
    const result = await engine.transcribeFile(path);
    return (result.text || "").trim();
  }

  return "";
}

export async function stopSenseVoiceRecordingAndTranscribe(): Promise<string> {
  if (!recordingActive) return "";
  recordingActive = false;
  stopListeners();
  resetWaveLevels();

  const recorded = await AudioStudioModule.stopRecording();
  const samples = pcmSamples;
  pcmSamples = [];

  const state = getSenseVoiceModelState();
  if (!state.localPath) throw new Error("语音模型路径无效");
  const engine = await getEngine(state.localPath);

  // Restore samples for this call only (cleared above for next session).
  pcmSamples = samples;
  try {
    const text = await transcribeCapturedAudio(engine, recorded?.fileUri);
    return text;
  } finally {
    pcmSamples = [];
  }
}

export async function cancelSenseVoiceRecording(): Promise<void> {
  if (!recordingActive) return;
  recordingActive = false;
  stopListeners();
  resetWaveLevels();
  pcmSamples = [];
  try {
    await AudioStudioModule.stopRecording();
  } catch {
    // ignore
  }
}

export function isSenseVoiceRecording(): boolean {
  return recordingActive;
}
