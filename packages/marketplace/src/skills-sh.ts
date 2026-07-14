export interface SkillsShHit {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

export interface SkillsShSearchResponse {
  query: string;
  skills: SkillsShHit[];
  count: number;
}

const SEARCH_URL = "https://skills.sh/api/search";
const MIN_QUERY_LEN = 2;
const DEFAULT_LIMIT = 30;

/** Parse skills.sh id like anthropics/skills/frontend-design → repo + subdir */
export function parseSkillsShId(fullId: string): { repo: string; subdir: string } {
  const parts = fullId.split("/").filter(Boolean);
  if (parts.length < 2) {
    return { repo: fullId, subdir: "" };
  }
  const repo = `${parts[0]}/${parts[1]}`;
  if (parts.length === 2) return { repo, subdir: "" };
  const rest = parts.slice(2).join("/");
  let subdir = rest;
  if (parts.length === 3 && !rest.includes("/")) {
    if (/anthropics\/skills|agent-skills/i.test(repo)) {
      subdir = `skills/${rest}`;
    }
  }
  return { repo, subdir };
}

export async function searchSkillsSh(
  query: string,
  limit = DEFAULT_LIMIT,
): Promise<SkillsShHit[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LEN) return [];

  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(Math.min(limit, 50)));

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "forge-agent" },
  });
  if (!res.ok) {
    throw new Error(`skills.sh search failed (${res.status})`);
  }
  const data = (await res.json()) as SkillsShSearchResponse | { error?: string };
  if ("error" in data && data.error) {
    throw new Error(String(data.error));
  }
  return (data as SkillsShSearchResponse).skills ?? [];
}
