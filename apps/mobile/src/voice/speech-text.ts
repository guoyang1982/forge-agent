/** Strip markdown-ish noise for clearer TTS. */
export function textForSpeech(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, "代码块。")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#-]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
