import * as Speech from "expo-speech";
import { textForSpeech } from "./speech-text";

type SpeechRecognitionModule = {
  getPermissionsAsync: () => Promise<{ granted?: boolean }>;
  requestPermissionsAsync: () => Promise<{ granted?: boolean }>;
  start: (options: Record<string, unknown>) => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionHook = (
  event: string,
  listener: (payload: any) => void,
) => void;

function loadSpeechRecognition(): {
  module: SpeechRecognitionModule | null;
  useSpeechRecognitionEvent: SpeechRecognitionHook;
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const speech = require("expo-speech-recognition") as {
      ExpoSpeechRecognitionModule: SpeechRecognitionModule;
      useSpeechRecognitionEvent: SpeechRecognitionHook;
    };
    return {
      module: speech.ExpoSpeechRecognitionModule,
      useSpeechRecognitionEvent: speech.useSpeechRecognitionEvent,
    };
  } catch {
    return {
      module: null,
      useSpeechRecognitionEvent: () => {
        // no-op hook when native module is unavailable
      },
    };
  }
}

const speechRecognition = loadSpeechRecognition();
const ExpoSpeechRecognitionModule = speechRecognition.module;

export const useSpeechRecognitionEvent = speechRecognition.useSpeechRecognitionEvent;

export function isSpeechRecognitionAvailable(): boolean {
  return ExpoSpeechRecognitionModule != null;
}

export async function ensureSpeechPermission(): Promise<boolean> {
  if (!ExpoSpeechRecognitionModule) return false;
  try {
    const current = await ExpoSpeechRecognitionModule.getPermissionsAsync();
    if (current.granted) return true;
    const asked = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    return Boolean(asked.granted);
  } catch {
    return false;
  }
}

export async function startDictation(options?: {
  lang?: string;
  continuous?: boolean;
}): Promise<void> {
  if (!ExpoSpeechRecognitionModule) {
    throw new Error("当前安装包未启用语音识别，请更新 App");
  }
  const ok = await ensureSpeechPermission();
  if (!ok) throw new Error("需要麦克风与语音识别权限");
  ExpoSpeechRecognitionModule.start({
    lang: options?.lang || "zh-CN",
    interimResults: true,
    continuous: options?.continuous ?? false,
  });
}

export function stopDictation(): void {
  try {
    ExpoSpeechRecognitionModule?.stop();
  } catch {
    // ignore
  }
}

export function abortDictation(): void {
  try {
    ExpoSpeechRecognitionModule?.abort();
  } catch {
    // ignore
  }
}

export function speakText(
  text: string,
  options?: { language?: string; onDone?: () => void },
): void {
  const body = text.trim();
  if (!body) return;
  try {
    Speech.stop();
    Speech.speak(body.slice(0, 4_000), {
      language: options?.language || "zh-CN",
      onDone: options?.onDone,
      onStopped: options?.onDone,
      onError: options?.onDone,
    });
  } catch {
    options?.onDone?.();
  }
}

export function stopSpeaking(): void {
  try {
    Speech.stop();
  } catch {
    // ignore
  }
}

export { textForSpeech };
