import { MAX_EXTRACTED_TEXT } from "./limits.js";

export { MAX_ATTACHMENT_BYTES, MAX_EXTRACTED_TEXT } from "./limits.js";

export function decodeBufferAsText(buf: Buffer): string {
  if (!buf.length) return "";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le").slice(0, MAX_EXTRACTED_TEXT);
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf-8").slice(0, MAX_EXTRACTED_TEXT);
  }
  const utf8 = buf.toString("utf-8");
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  if (!utf8.length || bad <= Math.max(2, Math.floor(utf8.length / 100))) {
    return utf8.slice(0, MAX_EXTRACTED_TEXT);
  }
  return buf.toString("latin1").slice(0, MAX_EXTRACTED_TEXT);
}

export function isProbablyUtf8Text(buf: Buffer): boolean {
  if (!buf.length) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) {
    if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return true;
    return false;
  }
  try {
    const s = sample.toString("utf8");
    const bad = (s.match(/\uFFFD/g) ?? []).length;
    return bad < sample.length / 200;
  } catch {
    return false;
  }
}
