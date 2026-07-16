import {
  MOBILE_PAIRING_MAX_TTL_MS,
  forgeMobilePairingOfferV1Schema,
  type ForgeMobilePairingOfferV1,
} from "@forge/mobile-protocol";

const PAIRING_SCHEME = "forge://pair";

export function parsePairingUri(input: string, now = Date.now()): ForgeMobilePairingOfferV1 {
  const value = input.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("配对内容不是有效的 Forge URI");
  }
  if (`${url.protocol}//${url.host}` !== PAIRING_SCHEME || url.pathname !== "") {
    throw new Error("仅支持 forge://pair 配对链接");
  }
  const code = url.searchParams.get("code");
  if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("配对码缺失或格式错误");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(code)));
  } catch {
    throw new Error("配对码无法解码");
  }
  const parsed = forgeMobilePairingOfferV1Schema.safeParse(payload);
  if (!parsed.success) throw new Error("配对码字段无效，请在 Desktop 重新生成");
  const offer = parsed.data;
  if (offer.expiresAt <= now) throw new Error("配对码已过期，请在 Desktop 重新生成");
  if (offer.expiresAt - now > MOBILE_PAIRING_MAX_TTL_MS) {
    throw new Error("配对码有效期异常，请在 Desktop 重新生成");
  }
  return offer;
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = globalThis.atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
