import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface LegacyFinding {
  file: string;
  symbol: string;
  line: number;
}

export interface LegacyScanOptions {
  root: string;
  allowPaths?: string[];
}

const FORBIDDEN_SYMBOLS: Array<{
  symbol: string;
  pattern: RegExp;
  multiline?: boolean;
}> = [
  { symbol: "DAEMON_METHODS.RUN", pattern: /\bDAEMON_METHODS\.RUN\b/ },
  { symbol: "DAEMON_METHODS.CANCEL_RUN", pattern: /\bDAEMON_METHODS\.CANCEL_RUN\b/ },
  { symbol: "AGENT_EVENT_METHOD", pattern: /\bAGENT_EVENT_METHOD\b/ },
  {
    symbol: "AgentEventNotificationParams",
    pattern: /\bAgentEventNotificationParams\b/,
  },
  {
    symbol: "untyped request(method: string)",
    pattern: /request\s*\(\s*method:\s*string\s*,[\s\S]*?\):\s*Promise<unknown>/,
    multiline: true,
  },
  { symbol: "new SessionStore", pattern: /\bnew\s+SessionStore\b/ },
  { symbol: "better-sqlite3 in gateway", pattern: /\bbetter-sqlite3\b/ },
  { symbol: "data.db in gateway", pattern: /\bdata\.db\b/ },
];

const DEFAULT_ALLOW_PATHS = [
  "apps/daemon/",
  "packages/execution/src/legacy-run-adapter",
  "packages/bus/",
  "packages/daemon-client/",
  "packages/protocol/",
  "packages/channel-mobile/src/device-registry",
  "packages/session-manager/",
  "apps/cli/src/automation-cli.ts",
  "apps/daemon/src/modules/runtime-module.ts",
  "apps/daemon/src/modules/automation-module.ts",
  "apps/desktop/",
  "apps/cli/",
  "apps/channel-gateway/",
  "packages/channel-mobile/",
  "scripts/core-v2/assert-no-legacy.ts",
  "scripts/core-v2/assert-no-legacy.test.ts",
  "scripts/eval.mjs",
  "packages/tool-mcp/",
];

export function scanLegacySymbols(
  options: LegacyScanOptions,
): LegacyFinding[] {
  const findings: LegacyFinding[] = [];
  const allowPaths = options.allowPaths ?? DEFAULT_ALLOW_PATHS;

  for (const file of walk(options.root)) {
    const rel = relative(options.root, file).replaceAll("\\", "/");
    if (!shouldScan(rel)) {
      continue;
    }
    if (allowPaths.some((allowed) => rel.startsWith(allowed))) {
      continue;
    }
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (const rule of FORBIDDEN_SYMBOLS) {
      if (rel.includes("apps/channel-gateway/") && rule.symbol.includes("gateway")) {
        // gateway-specific sqlite rules only apply to gateway sources
      } else if (
        rule.symbol.includes("gateway") &&
        !rel.startsWith("apps/channel-gateway/")
      ) {
        continue;
      }

      if (rule.multiline) {
        const match = rule.pattern.exec(content);
        if (match) {
          const line = content.slice(0, match.index).split("\n").length;
          findings.push({
            file: rel,
            symbol: rule.symbol,
            line,
          });
        }
        continue;
      }

      lines.forEach((line, index) => {
        if (rule.pattern.test(line)) {
          findings.push({
            file: rel,
            symbol: rule.symbol,
            line: index + 1,
          });
        }
      });
    }
  }

  return findings;
}

function shouldScan(rel: string): boolean {
  if (
    !rel.endsWith(".ts") &&
    !rel.endsWith(".tsx") &&
    !rel.endsWith(".js") &&
    !rel.endsWith(".mjs") &&
    !rel.endsWith(".cjs")
  ) {
    return false;
  }
  if (
    rel.includes("/dist/") ||
    rel.includes("/node_modules/") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".d.ts")
  ) {
    return false;
  }
  return (
    rel.startsWith("apps/") ||
    rel.startsWith("packages/") ||
    rel.startsWith("scripts/")
  );
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") {
      continue;
    }
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const findings = scanLegacySymbols({ root });
  if (findings.length) {
    console.error("Legacy symbols found:");
    for (const finding of findings) {
      console.error(`- ${finding.file}:${finding.line} ${finding.symbol}`);
    }
    process.exit(1);
  }
  console.log("No forbidden legacy symbols found.");
}
