import type { SearchHit, SearchProvider } from "./search-types.js";

/** HTML scrape fallback — no API key; may break if DDG changes markup. */
export function createDuckDuckGoProvider(
  fetchImpl: typeof fetch = fetch,
): SearchProvider {
  return {
    id: "duckduckgo",
    async search(query, limit, signal) {
      const url = new URL("https://html.duckduckgo.com/html/");
      url.searchParams.set("q", query);

      const res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Accept: "text/html",
          "User-Agent": "forge-agent/0.2 (+https://github.com/forge-agent)",
        },
        signal,
      });
      if (!res.ok) {
        throw new Error(`DuckDuckGo search failed (${res.status})`);
      }
      const html = await res.text();
      return parseDuckDuckGoHtml(html, limit);
    },
  };
}

export function parseDuckDuckGoHtml(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && hits.length < limit) {
    const rawUrl = decodeDuckDuckGoRedirect(match[1]);
    const title = stripTags(match[2]).trim();
    if (!rawUrl || !title) continue;
    if (!rawUrl.startsWith("http")) continue;
    hits.push({
      title,
      url: rawUrl,
      snippet: "",
      source: hostnameFromUrl(rawUrl),
    });
  }

  if (hits.length === 0) {
    const snippetRe =
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let i = 0;
    while ((match = snippetRe.exec(html)) !== null && i < hits.length) {
      if (hits[i]) hits[i].snippet = stripTags(match[1]).trim();
      i++;
    }
  } else {
    const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let i = 0;
    let sm: RegExpExecArray | null;
    while ((sm = snippetRe.exec(html)) !== null && i < hits.length) {
      hits[i].snippet = stripTags(sm[1]).trim();
      i++;
    }
  }

  return hits.slice(0, limit);
}

function decodeDuckDuckGoRedirect(href: string): string {
  try {
    if (href.startsWith("//duckduckgo.com/l/?")) {
      const u = new URL(`https:${href}`);
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    if (href.startsWith("/l/?")) {
      const u = new URL(`https://duckduckgo.com${href}`);
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    return href;
  } catch {
    return href;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function hostnameFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
