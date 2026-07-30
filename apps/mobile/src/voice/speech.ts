import * as Speech from "expo-speech";
import { textForSpeech } from "./speech-text";

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
