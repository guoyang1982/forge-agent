export interface ParsedGitHubRepo {
  owner: string;
  repo: string;
  branch?: string;
  subdir: string;
}

/** Parse github.com URLs and owner/repo shorthand. */
export function parseGitHubSource(source: string): ParsedGitHubRepo {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("Empty GitHub source");

  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2], subdir: "" };
  }

  const short = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (short && !trimmed.includes("://")) {
    return { owner: short[1], repo: short[2], subdir: "" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid GitHub source: ${trimmed}`);
  }
  if (!/github\.com$/i.test(url.hostname)) {
    throw new Error("Only github.com repositories are supported");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("GitHub URL must include owner and repo");
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  let branch: string | undefined;
  let subdir = "";

  if (parts[2] === "tree" || parts[2] === "blob") {
    branch = parts[3];
    subdir = parts.slice(4).join("/");
  }

  return { owner, repo, branch, subdir };
}

export function gitHubCloneUrl(parsed: ParsedGitHubRepo): string {
  return `https://github.com/${parsed.owner}/${parsed.repo}.git`;
}
