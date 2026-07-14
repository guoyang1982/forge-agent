import { DEFAULT_PERMISSIONS } from "@forge/protocol";
import type { NetworkPermissions } from "@forge/protocol";
import { extractHtmlTitle, htmlToText } from "./html-text.js";
import { readBodyLimitedText } from "./read-body-limited.js";

const DEFAULT_MAX_BYTES = DEFAULT_PERMISSIONS.network.fetchMaxBytes ?? 2_000_000;
const DEFAULT_TIMEOUT_MS = DEFAULT_PERMISSIONS.network.fetchTimeoutMs ?? 15_000;
const MAX_REDIRECTS = 5;

export interface WebFetchResult {
  ok: boolean;
  url: string;
  finalUrl?: string;
  title?: string;
  content?: string;
  truncated?: boolean;
  contentType?: string;
  fetchedAt: string;
  error?: string;
  hint?: string;
}

function extractTextFromBody(
  body: string,
  contentType: string | null,
): { title?: string; content: string } {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("text/html") || body.trimStart().startsWith("<!")) {
    return {
      title: extractHtmlTitle(body),
      content: htmlToText(body),
    };
  }
  return { content: body.trim() };
}

export async function webFetch(
  url: string,
  options: {
    network?: NetworkPermissions;
    maxChars?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<WebFetchResult> {
  const network = options.network ?? DEFAULT_PERMISSIONS.network;
  const maxBytes = network.fetchMaxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = network.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchImpl ?? fetch;
  const fetchedAt = new Date().toISOString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
        "User-Agent": "forge-agent/0.2 (+https://github.com/forge-agent)",
      },
    });

    if (res.redirected) {
      const hops = res.url !== url ? 1 : 0;
      if (hops > MAX_REDIRECTS) {
        return {
          ok: false,
          url,
          fetchedAt,
          error: "Too many redirects",
        };
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        url,
        finalUrl: res.url,
        fetchedAt,
        error: `HTTP ${res.status} ${res.statusText}`,
        hint: "Try another URL or check if the page requires authentication",
      };
    }

    const contentType = res.headers.get("content-type");
    const { text, truncated: bytesTruncated } = await readBodyLimitedText(
      res,
      maxBytes,
      controller.signal,
    );
    const { title, content: rawContent } = extractTextFromBody(text, contentType);
    const maxChars = options.maxChars ?? 12_000;
    const charTruncated = rawContent.length > maxChars;
    const content = charTruncated ? rawContent.slice(0, maxChars) : rawContent;

    return {
      ok: true,
      url,
      finalUrl: res.url,
      title,
      content,
      truncated: bytesTruncated || charTruncated,
      contentType: contentType ?? undefined,
      fetchedAt,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      url,
      fetchedAt,
      error: message,
      hint:
        message.includes("abort") || message.includes("Abort")
          ? "Request timed out or was cancelled"
          : "Check URL, network connectivity, and permissions",
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
