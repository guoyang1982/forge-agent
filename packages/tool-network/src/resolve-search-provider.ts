import {
  DEFAULT_NETWORK_SERVICE,
  type NetworkSearchMode,
  type NetworkSearchProviderId,
  type NetworkServiceConfig,
} from "@forge/protocol";
import { createBraveProvider } from "./providers/brave.js";
import { createCachedSearchProvider } from "./providers/cached-search.js";
import { createDuckDuckGoProvider } from "./providers/duckduckgo.js";
import type { SearchProvider } from "./providers/search-types.js";
import { createTavilyProvider } from "./providers/tavily.js";

export interface ResolveSearchProviderOptions {
  service?: NetworkServiceConfig;
  searchMode?: NetworkSearchMode;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

export function resolveSearchApiKeys(
  service?: NetworkServiceConfig,
): Partial<Record<NetworkSearchProviderId, string>> {
  const svc = { ...DEFAULT_NETWORK_SERVICE, ...service };
  const generic =
    process.env.FORGE_SEARCH_API_KEY?.trim() ||
    svc.searchApiKey?.trim() ||
    "";
  return {
    tavily:
      process.env.TAVILY_API_KEY?.trim() ||
      (svc.searchProvider === "tavily" ? generic : "") ||
      "",
    brave:
      process.env.BRAVE_SEARCH_API_KEY?.trim() ||
      (svc.searchProvider === "brave" ? generic : "") ||
      "",
  };
}

export function pickSearchProviderId(
  service?: NetworkServiceConfig,
): NetworkSearchProviderId {
  const svc = { ...DEFAULT_NETWORK_SERVICE, ...service };
  if (svc.searchProvider) return svc.searchProvider;

  const keys = resolveSearchApiKeys(service);
  if (keys.tavily) return "tavily";
  if (keys.brave) return "brave";
  return "duckduckgo";
}

export function createSearchProvider(
  options: ResolveSearchProviderOptions = {},
): SearchProvider {
  const svc = { ...DEFAULT_NETWORK_SERVICE, ...options.service };
  const fetchImpl = options.fetchImpl ?? fetch;
  const providerId = pickSearchProviderId(svc);
  const keys = resolveSearchApiKeys(svc);

  let inner: SearchProvider;
  switch (providerId) {
    case "tavily": {
      const key = keys.tavily;
      if (!key) {
        throw new Error(
          "Tavily search requires TAVILY_API_KEY, FORGE_SEARCH_API_KEY, or network.searchApiKey in config",
        );
      }
      inner = createTavilyProvider(key, fetchImpl);
      break;
    }
    case "brave": {
      const key = keys.brave;
      if (!key) {
        throw new Error(
          "Brave search requires BRAVE_SEARCH_API_KEY, FORGE_SEARCH_API_KEY, or network.searchApiKey in config",
        );
      }
      inner = createBraveProvider(key, fetchImpl);
      break;
    }
    case "duckduckgo":
    default:
      inner = createDuckDuckGoProvider(fetchImpl);
      break;
  }

  const mode = options.searchMode ?? "live";
  if (mode === "cached" && options.cacheDir) {
    return createCachedSearchProvider(inner, {
      cacheDir: options.cacheDir,
      ttlHours: svc.searchCacheTtlHours ?? 24,
    });
  }
  return inner;
}
