import type { NetworkPermissions, NetworkSearchMode, NetworkServiceConfig } from "@forge/protocol";
import { DEFAULT_PERMISSIONS } from "@forge/protocol";
import { createSearchProvider } from "./resolve-search-provider.js";
import type { SearchHit } from "./providers/search-types.js";

export interface WebSearchResult {
  ok: boolean;
  query: string;
  mode: NetworkSearchMode;
  provider?: string;
  results?: SearchHit[];
  fetchedAt: string;
  error?: string;
  hint?: string;
}

export async function webSearch(
  query: string,
  options: {
    limit?: number;
    network?: NetworkPermissions;
    service?: NetworkServiceConfig;
    cacheDir?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<WebSearchResult> {
  const trimmed = query.trim();
  const fetchedAt = new Date().toISOString();
  if (!trimmed) {
    return {
      ok: false,
      query: trimmed,
      mode: options.network?.searchMode ?? "live",
      fetchedAt,
      error: "query is required",
    };
  }

  const net = options.network ?? DEFAULT_PERMISSIONS.network;
  const mode = net.searchMode ?? "live";
  const limit = Math.min(Math.max(Number(options.limit ?? 8), 1), 20);
  const timeoutMs = net.fetchTimeoutMs ?? 15_000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  const combinedSignal = controller.signal;

  try {
    const provider = createSearchProvider({
      service: options.service,
      searchMode: mode,
      cacheDir: options.cacheDir,
      fetchImpl: options.fetchImpl,
    });
    const results = await provider.search(trimmed, limit, combinedSignal);
    return {
      ok: true,
      query: trimmed,
      mode,
      provider: provider.id,
      results,
      fetchedAt,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      query: trimmed,
      mode,
      fetchedAt,
      error: message,
      hint:
        message.includes("API key") || message.includes("401")
          ? "Set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY, or configure network.searchProvider in ~/.forge-agent/config.json"
          : "Try a different query or search provider",
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
