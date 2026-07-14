import { DEFAULT_PERMISSIONS } from "@forge/protocol";
import type { NetworkPermissions } from "@forge/protocol";
import { validateHttpUrl } from "./host-policy.js";
import { readBodyLimitedText } from "./read-body-limited.js";

const DEFAULT_MAX_BYTES = DEFAULT_PERMISSIONS.network.fetchMaxBytes ?? 2_000_000;
const DEFAULT_TIMEOUT_MS = DEFAULT_PERMISSIONS.network.fetchTimeoutMs ?? 15_000;

const ALLOWED_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export interface ApiRequestResult {
  ok: boolean;
  method: string;
  url: string;
  finalUrl?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  truncated?: boolean;
  binary?: boolean;
  contentType?: string;
  fetchedAt: string;
  error?: string;
  hint?: string;
}

function normalizeMethod(method: string): string {
  return method.trim().toUpperCase();
}

function sanitizeHeaders(
  raw: unknown,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length") continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function isLikelyBinaryContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  if (
    lower.includes("json") ||
    lower.includes("text/") ||
    lower.includes("xml") ||
    lower.includes("javascript") ||
    lower.includes("form-urlencoded")
  ) {
    return false;
  }
  if (
    lower.includes("image/") ||
    lower.includes("video/") ||
    lower.includes("audio/") ||
    lower.includes("octet-stream") ||
    lower.includes("pdf") ||
    lower.includes("zip") ||
    lower.includes("gzip")
  ) {
    return true;
  }
  return false;
}

export async function apiRequest(
  options: {
    method: string;
    url: string;
    headers?: unknown;
    body?: string;
    network?: NetworkPermissions;
    maxChars?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<ApiRequestResult> {
  const network = options.network ?? DEFAULT_PERMISSIONS.network;
  const maxBytes = network.fetchMaxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = network.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchImpl ?? fetch;
  const fetchedAt = new Date().toISOString();
  const method = normalizeMethod(options.method || "GET");
  const url = options.url.trim();

  if (!url) {
    return {
      ok: false,
      method,
      url,
      fetchedAt,
      error: "url is required",
    };
  }

  if (!ALLOWED_METHODS.has(method)) {
    return {
      ok: false,
      method,
      url,
      fetchedAt,
      error: `Unsupported method: ${method}`,
      hint: "Allowed: GET, POST, PUT, PATCH, DELETE",
    };
  }

  const urlCheck = validateHttpUrl(url);
  if (!urlCheck.ok) {
    return {
      ok: false,
      method,
      url,
      fetchedAt,
      error: urlCheck.reason,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  const headers = sanitizeHeaders(options.headers);
  const init: RequestInit = {
    method,
    redirect: "follow",
    signal: controller.signal,
    headers: {
      Accept: "application/json,text/plain,*/*;q=0.8",
      "User-Agent": "forge-agent/0.2 (+https://github.com/forge-agent)",
      ...headers,
    },
  };

  if (
    options.body !== undefined &&
    options.body !== "" &&
    method !== "GET" &&
    method !== "DELETE"
  ) {
    init.body = options.body;
    if (!headers || !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
  }

  try {
    const res = await fetchFn(url, init);
    const contentType = res.headers.get("content-type");

    if (isLikelyBinaryContentType(contentType)) {
      return {
        ok: false,
        method,
        url,
        finalUrl: res.url,
        status: res.status,
        statusText: res.statusText,
        binary: true,
        contentType: contentType ?? undefined,
        fetchedAt,
        error: "Response looks binary",
        hint: "Use download_file for large or binary payloads",
      };
    }

    const { text, truncated: bytesTruncated } = await readBodyLimitedText(
      res,
      maxBytes,
      controller.signal,
    );
    const maxChars = options.maxChars ?? 12_000;
    const charTruncated = text.length > maxChars;
    const body = charTruncated ? text.slice(0, maxChars) : text;

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      ok: res.ok,
      method,
      url,
      finalUrl: res.url,
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
      body,
      truncated: bytesTruncated || charTruncated,
      contentType: contentType ?? undefined,
      fetchedAt,
      ...(res.ok
        ? {}
        : {
            error: `HTTP ${res.status} ${res.statusText}`,
            hint: "Check URL, method, headers, and body",
          }),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      method,
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
