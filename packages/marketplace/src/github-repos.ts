export interface GitHubRepoHit {
  fullName: string;
  description: string;
  stars: number;
  htmlUrl: string;
}

/** Public GitHub repository search (rate-limited without token). */
export async function searchGitHubRepositories(
  query: string,
  limit = 20,
): Promise<GitHubRepoHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const searchQ = `${q} agent plugin in:name,description`;
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", searchQ);
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(Math.min(limit, 30)));

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "forge-agent-marketplace",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub search failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    items?: Array<{
      full_name?: string;
      description?: string | null;
      stargazers_count?: number;
      html_url?: string;
    }>;
  };
  return (data.items ?? [])
    .filter((i) => i.full_name)
    .map((i) => ({
      fullName: i.full_name!,
      description: i.description?.trim() ?? "",
      stars: i.stargazers_count ?? 0,
      htmlUrl: i.html_url ?? `https://github.com/${i.full_name}`,
    }));
}
