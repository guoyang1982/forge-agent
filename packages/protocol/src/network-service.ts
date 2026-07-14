export type NetworkSearchProviderId = "tavily" | "brave" | "duckduckgo";

export interface NetworkServiceConfig {
  /** Default tavily when API key present, else brave, else duckduckgo. */
  searchProvider?: NetworkSearchProviderId;
  /** Provider API key (overridden by env FORGE_SEARCH_API_KEY / TAVILY_API_KEY / BRAVE_SEARCH_API_KEY). */
  searchApiKey?: string;
  /** Local cache TTL for searchMode cached (hours). Default 24. */
  searchCacheTtlHours?: number;
}

export const DEFAULT_NETWORK_SERVICE: NetworkServiceConfig = {
  searchCacheTtlHours: 24,
};
