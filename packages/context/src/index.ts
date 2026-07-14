import type { WorkspaceGuard } from "@forge/workspace";
import { readProjectRules } from "@forge/project-rules";
import {
  gitStatusLine,
  readFileLimited,
  grepWorkspace,
  gitDiffSummary,
  isGitRepository,
} from "@forge/workspace";

export interface AgentContextInput {
  guard: WorkspaceGuard;
  userMessage: string;
  explicitFiles?: string[];
  maxContextChars?: number;
}

export interface AgentContextBlock {
  agentsMd: string;
  gitStatus: string;
  gitDiff: string;
  atFiles: string;
  retrieval: string;
  atPaths: string[];
}

/** Parse @file or @"path with spaces" from user message */
export function parseAtMentions(message: string): string[] {
  const paths = new Set<string>();
  const re = /@(?:"([^"]+)"|([^\s@]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const p = (m[1] ?? m[2]).trim();
    if (p) paths.add(p);
  }
  return [...paths];
}

function extractSearchTerms(message: string): string[] {
  const cleaned = message
    .replace(/@[^\s]+/g, " ")
    .replace(/[^\p{L}\p{N}_./-]+/gu, " ");
  const words = cleaned
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^(the|and|for|with|this|that|请|帮我)$/i.test(w));
  return [...new Set(words)].slice(0, 5);
}

export async function buildAgentContext(
  input: AgentContextInput,
): Promise<AgentContextBlock> {
  const { guard, userMessage, explicitFiles = [] } = input;
  const maxChars = input.maxContextChars ?? 14_000;

  const atPaths = [
    ...new Set([...parseAtMentions(userMessage), ...explicitFiles]),
  ];

  const inGit = await isGitRepository(guard);
  const notGit = "(not a git repository)";
  const [rules, gitStatus, gitDiff] = await Promise.all([
    Promise.resolve(readProjectRules(guard.cwdPath)),
    inGit ? gitStatusLine(guard, { inGit: true }) : Promise.resolve(notGit),
    inGit ? gitDiffSummary(guard, 120, { inGit: true }) : Promise.resolve(notGit),
  ]);
  const agentsMd = rules.merged;

  let atFiles = "";
  for (const p of atPaths.slice(0, 8)) {
    try {
      const content = await readFileLimited(guard, p, 1, 120);
      atFiles += `\n### @${p}\n${content}\n`;
    } catch {
      atFiles += `\n### @${p}\n(file not found or unreadable)\n`;
    }
  }

  let retrieval = "";
  const terms = extractSearchTerms(userMessage);
  const grepHits = await Promise.all(
    terms.slice(0, 3).map(async (term) => ({ term, hits: await grepWorkspace(guard, term) })),
  );
  for (const { term, hits } of grepHits) {
    if (typeof hits === "string") {
      if (!hits.startsWith('{"ok":false')) {
        retrieval += `\n### grep "${term}"\n${hits.slice(0, 2500)}\n`;
      }
    } else if (hits.matchCount > 0) {
      retrieval += `\n### grep "${term}" (${hits.matchCount})\n${hits.preview.slice(0, 2500)}\n`;
    }
  }

  const combined = agentsMd + gitStatus + gitDiff + atFiles + retrieval;
  if (combined.length > maxChars) {
    const ratio = maxChars / combined.length;
    retrieval = retrieval.slice(0, Math.floor(retrieval.length * ratio));
    atFiles = atFiles.slice(0, Math.floor(atFiles.length * ratio));
  }

  return { agentsMd, gitStatus, gitDiff, atFiles, retrieval, atPaths };
}

export function formatContextForPrompt(block: AgentContextBlock): {
  agentsMd: string;
  gitStatus: string;
  extraFiles: string;
} {
  const parts: string[] = [];
  if (
    block.gitDiff &&
    block.gitDiff !== "(no git diff)" &&
    block.gitDiff !== "(not a git repository)"
  ) {
    parts.push(`## Git diff (recent changes)\n${block.gitDiff}`);
  }
  if (block.atFiles) parts.push(`## @ Referenced files${block.atFiles}`);
  if (block.retrieval) parts.push(`## Code search (auto)${block.retrieval}`);

  return {
    agentsMd: block.agentsMd,
    gitStatus: block.gitStatus,
    extraFiles: parts.join("\n\n"),
  };
}
