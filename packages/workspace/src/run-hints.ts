import { existsSync, readFileSync } from "node:fs";
import { join, extname, relative, resolve, sep } from "node:path";

export interface RunHint {
  label: string;
  command: string;
}

export interface RunHintsResult {
  title: string;
  hints: RunHint[];
  notes: string[];
}

/** Normalize agent paths to workspace-relative for run commands. */
export function normalizeChangedPaths(
  cwd: string,
  paths: string[],
): string[] {
  const absCwd = resolve(cwd);
  const prefix = absCwd.endsWith(sep) ? absCwd : absCwd + sep;
  return paths.map((p) => {
    const t = p.trim().replace(/\\/g, "/");
    if (!t.startsWith("/")) return t;
    const abs = resolve(t);
    if (abs === absCwd || abs.startsWith(prefix)) {
      return relative(absCwd, abs) || t;
    }
    const segs = t.split("/").filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const candidate = segs.slice(i).join("/");
      if (existsSync(join(absCwd, candidate))) return candidate;
    }
    return t.replace(/^\//, "");
  });
}

export function detectRunHints(
  cwd: string,
  changedPaths: string[] = [],
): RunHintsResult {
  const hints: RunHint[] = [];
  const notes: string[] = [];
  const normalized = normalizeChangedPaths(cwd, changedPaths);
  const py = normalized.find((p) => p.endsWith(".py"));
  const html = normalized.find((p) => p.endsWith(".html"));
  const js = normalized.find(
    (p) => p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".ts"),
  );

  if (existsSync(join(cwd, "package.json"))) {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    if (scripts.dev) hints.push({ label: "Dev server", command: "npm run dev" });
    else if (scripts.start) hints.push({ label: "Start", command: "npm start" });
    if (scripts.test) hints.push({ label: "Test", command: "npm test" });
    if (!hints.length) hints.push({ label: "Install", command: "npm install" });
  }

  if (existsSync(join(cwd, "pom.xml"))) {
    hints.push({ label: "Build", command: "mvn -q compile" });
    hints.push({ label: "Test", command: "mvn -q test" });
  }

  const reqPath = join(cwd, "requirements.txt");
  if (existsSync(reqPath)) {
    hints.unshift({
      label: "Install Python deps",
      command: "python3 -m pip install -r requirements.txt",
    });
  }

  if (py) {
    const cmd = py.includes(" ") ? `python3 "${py}"` : `python3 ${py}`;
    hints.unshift({ label: "Run Python", command: cmd });
    if (!existsSync(reqPath) && pyNeedsThirdParty(cwd, py)) {
      notes.push(
        "Missing module? python3 -m pip install <package>  (or add requirements.txt)",
      );
    }
  }

  if (html && !existsSync(join(cwd, "package.json"))) {
    hints.push({
      label: "Static server",
      command: `python3 -m http.server 8080`,
    });
    notes.push(`Open http://localhost:8080/${html}`);
  }

  if (js && existsSync(join(cwd, "package.json"))) {
    /* covered by npm scripts */
  } else if (js) {
    hints.push({ label: "Run with Node", command: `node ${js}` });
  }

  if (!hints.length && normalized.length) {
    const main = normalized[0];
    notes.push(`Main file: ${main}`);
    const ext = extname(main);
    if (ext === ".py") hints.push({ label: "Run", command: `python3 ${main}` });
  }

  const title =
    hints.length > 0
      ? "How to run"
      : normalized.length
        ? "Files changed"
        : "Next steps";

  if (!hints.length && !notes.length) {
    notes.push("Use /run to try auto-detected command, or /help");
  }

  return { title, hints, notes };
}

const THIRD_PARTY_IMPORTS = new Set([
  "pygame",
  "numpy",
  "pandas",
  "requests",
  "flask",
  "django",
  "matplotlib",
  "PIL",
  "cv2",
]);

function pyNeedsThirdParty(cwd: string, relPath: string): boolean {
  try {
    const text = readFileSync(join(cwd, relPath), "utf-8");
    for (const line of text.split("\n").slice(0, 40)) {
      const m = line.match(/^\s*(?:import|from)\s+([a-zA-Z0-9_]+)/);
      if (m && THIRD_PARTY_IMPORTS.has(m[1])) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function formatRunHintsBlock(result: RunHintsResult, cwd: string): string {
  const lines: string[] = [];
  lines.push(`\n\x1b[36m── ${result.title} ──\x1b[0m`);
  lines.push(`\x1b[2m  cd ${cwd}\x1b[0m`);
  for (const h of result.hints) {
    lines.push(`  \x1b[32m${h.command}\x1b[0m  \x1b[2m# ${h.label}\x1b[0m`);
  }
  for (const n of result.notes) {
    lines.push(`  \x1b[2m${n}\x1b[0m`);
  }
  lines.push(`\x1b[2m  /run — 运行上面命令   |   /open <文件> — 打开文件\x1b[0m\n`);
  return lines.join("\n");
}
