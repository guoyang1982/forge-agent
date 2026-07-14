// One-time generator: build localized talent templates from the agency-agents
// source repo, translating each agent's real markdown body into Chinese via the
// configured LLM instead of replacing it with a generic boilerplate persona.
//
// Usage:
//   node scripts/generate-templates.mjs --sample            # 2 files, preview only
//   node scripts/generate-templates.mjs --sample <file.md>  # specific file, preview
//   node scripts/generate-templates.mjs --all               # full run, writes JSON
//
// Source dir defaults to /tmp/agency-agents (override with FORGE_TALENTS_SOURCE_DIR).
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config/dist/index.js";
import { LlmClient } from "../../llm/dist/index.js";
import { parseAgencyAgentMarkdown } from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const OUT_DIR = join(PKG_ROOT, "templates");
const SOURCE_DIR = resolve(
  process.env.FORGE_TALENTS_SOURCE_DIR || "/tmp/agency-agents",
);
const NON_AGENT_ROOTS = new Set([
  "scripts",
  "docs",
  "assets",
  ".github",
  "node_modules",
  "examples",
  "integrations",
]);
const DESC = "===DESC===";
const BODY = "===BODY===";

function isAgentPath(rel) {
  const parts = rel.split("/").filter(Boolean);
  if (parts.length < 2) return false;
  if (NON_AGENT_ROOTS.has(parts[0])) return false;
  const file = parts[parts.length - 1] || "";
  if (!file.endsWith(".md")) return false;
  return !/^README(?:\.[a-z-]+)?\.md$/iu.test(file);
}

async function listAgentFiles(root) {
  const out = [];
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!NON_AGENT_ROOTS.has(entry.name)) await walk(join(dir, entry.name), childRel);
      } else if (isAgentPath(childRel)) {
        out.push(childRel);
      }
    }
  }
  await walk(root, "");
  return out.sort();
}

function splitFrontmatter(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: raw };
  const frontmatter = {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) frontmatter[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  if (end < 0) return { frontmatter: {}, body: raw };
  return { frontmatter, body: lines.slice(end + 1).join("\n") };
}

const SYS_PROMPT = `你是专业的技术本地化译者，把英文 AI agent 的人设/指令忠实翻译成简体中文。

严格规则：
- 忠实翻译，不增删内容、不改写结构、不做总结。
- 代码块（\`\`\`...\`\`\`）、行内代码（\`...\`）、命令、CLI 参数、文件路径、URL、API/标识符名、conventional-commit 前缀（feat:/fix: 等）一律原样保留，不翻译。
- Markdown 结构（标题层级、列表、表格、emoji）保持不变。
- 关键英文技术术语翻译后可在首次出现处括注英文，如 变基（rebase）。
- 输出只含翻译结果，不要任何前言、解释或额外标记。`;

function buildUserPrompt(description, body) {
  return `把下面两段翻译成简体中文，按原样的两个分隔标记分块输出（标记行单独成行，原样保留）：

${DESC}
${description || "(无)"}
${BODY}
${body}`;
}

function parseTranslation(text) {
  const descIdx = text.indexOf(DESC);
  const bodyIdx = text.indexOf(BODY);
  if (descIdx < 0 || bodyIdx < 0 || bodyIdx < descIdx) {
    // Fall back: whole output is the body translation.
    return { description: "", systemPrompt: text.trim() };
  }
  const description = text.slice(descIdx + DESC.length, bodyIdx).trim();
  const systemPrompt = text.slice(bodyIdx + BODY.length).trim();
  return { description, systemPrompt };
}

const SAFETY_FOOTER = [
  "",
  "---",
  "## Forge 运行约束（优先级高于以上人设）",
  "- 始终用中文回复；保留专业术语的英文缩写。",
  "- Forge 的安全规则、工具权限、项目规则与用户指令，优先于本角色人设。",
  "- 涉及安全、合规、成本、不可逆操作或重大方向选择时，先提醒并征求确认。",
].join("\n");

async function translateOne(client, rel, raw) {
  const { frontmatter, body } = splitFrontmatter(raw);
  const res = await client.chat({
    messages: [
      { role: "system", content: SYS_PROMPT },
      { role: "user", content: buildUserPrompt(frontmatter.description || frontmatter.vibe || "", body.trim()) },
    ],
    tools: [],
  });
  const text = res.text ?? "";
  const { description, systemPrompt } = parseTranslation(text);
  return {
    description: description || undefined,
    systemPrompt: `${systemPrompt}\n${SAFETY_FOOTER}`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const sample = args.includes("--sample");
  const all = args.includes("--all");
  const explicitFiles = args.filter((a) => a.endsWith(".md"));

  if (!existsSync(SOURCE_DIR)) {
    throw new Error(`source dir not found: ${SOURCE_DIR}`);
  }
  const config = loadConfig();
  if (!config.model?.apiKey) throw new Error("model.apiKey not configured");
  const client = new LlmClient(config.model);

  let localizationMap = {};
  try {
    localizationMap = JSON.parse(
      await readFile(join(SOURCE_DIR, "scripts", "i18n", "agent-names-zh.json"), "utf-8"),
    );
  } catch { /* optional */ }

  let files;
  if (explicitFiles.length) {
    files = explicitFiles.map((f) => f.replace(`${SOURCE_DIR}/`, ""));
  } else {
    files = await listAgentFiles(SOURCE_DIR);
    if (sample && !all) files = files.filter((f) => f.includes("git-workflow") || f.includes("ai-engineer")).slice(0, 2);
  }

  // Resume-safe: skip files whose output JSON is already translated (carries the
  // Forge safety footer). Pass --force to retranslate everything.
  const force = args.includes("--force");
  if (all && !force && !explicitFiles.length) {
    const before = files.length;
    const kept = [];
    for (const rel of files) {
      const id = basename(rel).replace(/\.md$/, "");
      const out = join(OUT_DIR, `${id}.json`);
      let translated = false;
      if (existsSync(out)) {
        try {
          const cur = JSON.parse(await readFile(out, "utf-8"));
          translated = (cur.systemPrompt || "").includes("## Forge 运行约束（优先级高于以上人设）");
        } catch { /* treat as not translated */ }
      }
      if (!translated) kept.push(rel);
    }
    console.log(`[gen] resume: ${before - kept.length} already translated, ${kept.length} remaining`);
    files = kept;
  }

  const concurrency = all ? Number(process.env.GEN_CONCURRENCY || 6) : 1;
  console.log(`[gen] source=${SOURCE_DIR} model=${config.model.name} files=${files.length} mode=${all ? "WRITE" : "PREVIEW"} concurrency=${concurrency}`);
  if (!all) await mkdir(join(PKG_ROOT, "templates-preview"), { recursive: true });
  if (all) await mkdir(OUT_DIR, { recursive: true });

  let ok = 0, failed = 0, done = 0;
  async function processOne(rel) {
    try {
      const raw = await readFile(join(SOURCE_DIR, rel), "utf-8");
      const base = parseAgencyAgentMarkdown(rel, raw, localizationMap);
      const { description, systemPrompt } = await translateOne(client, rel, raw);
      const template = {
        ...base,
        description: description || base.description,
        systemPrompt,
      };
      if (all) {
        await writeFile(join(OUT_DIR, `${base.id}.json`), `${JSON.stringify(template, null, 2)}\n`, "utf-8");
      } else {
        await writeFile(join(PKG_ROOT, "templates-preview", `${base.id}.json`), `${JSON.stringify(template, null, 2)}\n`, "utf-8");
        console.log(`\n${"=".repeat(70)}\n${base.id}  (${base.role})\n${"=".repeat(70)}`);
        console.log("description:", template.description);
        console.log("systemPrompt (head 1200 chars):\n" + systemPrompt.slice(0, 1200));
      }
      ok++;
    } catch (e) {
      failed++;
      console.error(`[gen] FAILED ${rel}: ${String(e)}`);
    } finally {
      done++;
      if (all && done % 10 === 0) console.log(`[gen] progress ${done}/${files.length} (ok=${ok} failed=${failed})`);
    }
  }

  // Simple fixed-size worker pool.
  const queue = [...files];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const rel = queue.shift();
        if (rel === undefined) break;
        await processOne(rel);
      }
    }),
  );
  console.log(`\n[gen] done ok=${ok} failed=${failed}${all ? "" : " (preview only — nothing committed)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
