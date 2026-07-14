import type { SearchHit, SearchProvider } from "./search-types.js";

export function createTavilyProvider(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): SearchProvider {
  return {
    id: "tavily",
    async search(query, limit, signal) {
      const res = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: Math.min(Math.max(limit, 1), 20),
          search_depth: "basic",
          include_answer: false,
        }),
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Tavily search failed (${res.status}): ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
        }>;
      };
      return (data.results ?? [])
        .filter((r) => r.url && r.title)
        .map((r) => ({
          title: r.title!,
          url: r.url!,
          snippet: (r.content ?? "").trim(),
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
