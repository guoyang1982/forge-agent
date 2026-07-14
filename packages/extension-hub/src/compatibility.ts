import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  ALL_AGENTS,
  type AgentCompatibility,
  type AgentId,
  type ExtensionCompatibility,
} from "./types.js";

const MAX_SCAN_FILE_BYTES = 256 * 1024;
const TEXT_EXTENSIONS = new Set(["", ".json", ".md", ".mdx", ".txt", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".sh"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build"]);

interface HostRequirement {
  label: string;
  agents: AgentId[];
}

const HOST_PATTERNS: Array<{ pattern: RegExp; requirement: HostRequirement }> = [
  {
    pattern: /mcp__node_repl__(?:js|js_reset|js_add_node_module_dir)\b|\bagent\.browsers\./i,
    requirement: { label: "Codex Node REPL / browser runtime", agents: ["codex"] },
  },
  {
    pattern: /\bvscode\.commands\.|\bcursor\.(?:composer|workspace|ide)\b|\bcomposer\.selection\b/i,
    requirement: { label: "Cursor IDE runtime", agents: ["cursor"] },
  },
  {
    pattern: /\$ARGUMENTS\b|\bclaude\.hooks\b|\bclaude_code\.(?:session|tool)\b/i,
    requirement: { label: "Claude Code command or hook runtime", agents: ["claude-code"] },
  },
];

/**
 * Classify an extension by the runtime facilities it actually references. The
 * scan is deliberately conservative: only explicit host APIs make a target
 * incompatible; unrecognised text remains compatible or unknown.
 */
export async function analyzeCompatibilityFromDir(
  dir: string,
): Promise<ExtensionCompatibility> {
  const text = await readPackageText(dir);
  const requirements = HOST_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ requirement }) => requirement);
  const hasStandardMcp = await hasMcpDeclaration(dir);
  const inspected = text.length > 0;

  return Object.fromEntries(
    ALL_AGENTS.map((agent) => [agent, compatibilityFor(agent, requirements, hasStandardMcp, inspected)]),
  ) as ExtensionCompatibility;
}

function compatibilityFor(
  agent: AgentId,
  requirements: HostRequirement[],
  hasStandardMcp: boolean,
  inspected: boolean,
): AgentCompatibility {
  const unmet = requirements.filter((requirement) => !requirement.agents.includes(agent));
  if (unmet.length) {
    return {
      status: "incompatible",
      requirements: unmet.map((requirement) => requirement.label),
      reason: `需要 ${unmet.map((requirement) => requirement.label).join("；")}`,
    };
  }
  if (requirements.length) {
    return {
      status: "compatible",
      requirements: requirements.map((requirement) => requirement.label),
      reason: "检测到该 Agent 提供的专有运行时",
    };
  }
  if (hasStandardMcp) {
    return {
      status: "adaptable",
      requirements: ["标准 MCP 声明"],
      reason: "包含标准 MCP 声明，部署时需由目标 Agent 加载",
    };
  }
  if (!inspected) {
    return { status: "unknown", requirements: [], reason: "未找到可分析的说明或配置文件" };
  }
  return { status: "compatible", requirements: [], reason: "未检测到宿主专有依赖" };
}

async function hasMcpDeclaration(dir: string): Promise<boolean> {
  for (const name of [".mcp.json", "mcp.json"]) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf-8")) as Record<string, unknown>;
      if (parsed.mcpServers || parsed.servers) return true;
    } catch {
      // A malformed declaration is still picked up by the text scan, but is not adaptable.
    }
  }
  return false;
}

async function readPackageText(dir: string): Promise<string> {
  const chunks: string[] = [];
  await visit(dir, chunks);
  return chunks.join("\n");
}

async function visit(dir: string, chunks: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) await visit(join(dir, entry.name), chunks);
      continue;
    }
    if (!entry.isFile() || !TEXT_EXTENSIONS.has(extname(entry.name))) continue;
    try {
      const content = await readFile(join(dir, entry.name), "utf-8");
      chunks.push(content.slice(0, MAX_SCAN_FILE_BYTES));
    } catch {
      // Ignore binary and unreadable package files.
    }
  }
}
