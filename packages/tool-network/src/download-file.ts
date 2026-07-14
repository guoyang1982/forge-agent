import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_PERMISSIONS } from "@forge/protocol";
import type { NetworkPermissions } from "@forge/protocol";
import { validateHttpUrl } from "./host-policy.js";
import { readBodyLimited } from "./read-body-limited.js";

const DEFAULT_MAX_BYTES = DEFAULT_PERMISSIONS.network.fetchMaxBytes ?? 2_000_000;
const DEFAULT_TIMEOUT_MS = DEFAULT_PERMISSIONS.network.fetchTimeoutMs ?? 15_000;

export interface DownloadFileResult {
  ok: boolean;
  url: string;
  finalUrl?: string;
  path: string;
  bytes?: number;
  truncated?: boolean;
  contentType?: string;
  fetchedAt: string;
  error?: string;
  hint?: string;
}

export async function downloadFile(
  url: string,
  destPath: string,
  options: {
    network?: NetworkPermissions;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DownloadFileResult> {
  const network = options.network ?? DEFAULT_PERMISSIONS.network;
  const maxBytes = network.fetchMaxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = network.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchImpl ?? fetch;
  const fetchedAt = new Date().toISOString();
  const trimmedUrl = url.trim();

  if (!trimmedUrl) {
    return {
      ok: false,
      url: trimmedUrl,
      path: destPath,
      fetchedAt,
      error: "url is required",
    };
  }

  if (!destPath.trim()) {
    return {
      ok: false,
      url: trimmedUrl,
      path: destPath,
      fetchedAt,
      error: "path is required",
    };
  }

  const urlCheck = validateHttpUrl(trimmedUrl);
  if (!urlCheck.ok) {
    return {
      ok: false,
      url: trimmedUrl,
      path: destPath,
      fetchedAt,
      error: urlCheck.reason,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const res = await fetchFn(trimmedUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "*/*",
        "User-Agent": "forge-agent/0.2 (+https://github.com/forge-agent)",
      },
    });

    if (!res.ok) {
      return {
        ok: false,
        url: trimmedUrl,
        finalUrl: res.url,
        path: destPath,
        fetchedAt,
        error: `HTTP ${res.status} ${res.statusText}`,
        hint: "Check URL or authentication requirements",
      };
    }

    const { bytes, truncated } = await readBodyLimited(
      res,
      maxBytes,
      controller.signal,
    );

    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, bytes);

    return {
      ok: true,
      url: trimmedUrl,
      finalUrl: res.url,
      path: destPath,
      bytes: bytes.byteLength,
      truncated,
      contentType: res.headers.get("content-type") ?? undefined,
      fetchedAt,
      ...(truncated
        ? {
            hint: `Download truncated at ${maxBytes} bytes (fetchMaxBytes limit)`,
          }
        : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      url: trimmedUrl,
      path: destPath,
      fetchedAt,
      error: message,
      hint:
        message.includes("abort") || message.includes("Abort")
          ? "Request timed out or was cancelled"
          : "Check URL, destination path, and permissions",
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
