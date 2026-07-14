import type { SearchHit, SearchProvider } from "./search-types.js";

export function createBraveProvider(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): SearchProvider {
  return {
    id: "brave",
    async search(query, limit, signal) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(Math.max(limit, 1), 20)));

      const res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Brave search failed (${res.status}): ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        web?: {
          results?: Array<{
            title?: string;
            url?: string;
            description?: string;
          }>;
        };
      };
      return (data.web?.results ?? [])
        .filter((r) => r.url && r.title)
        .map((r) => ({
          title: r.title!,
          url: r.url!,
          snippet: (r.description ?? "").trim(),
          source: hostnameFromUrl(r.url!),
        }));
    },
  };
}

function hostnameFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
