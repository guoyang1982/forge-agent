// Merge agent-authored translations into final template JSONs, using the same
// structure as scripts/generate-templates.mjs. Translations live as plain files
// in a directory (default /tmp/translations):
//   <id>.body.md   — translated systemPrompt body (no safety footer; appended here)
//   <id>.desc.txt  — translated card description (optional)
// Only ids that have a <id>.body.md are merged.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgencyAgentMarkdown } from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const OUT_DIR = join(PKG_ROOT, "templates");
const SOURCE_DIR = resolve(process.env.FORGE_TALENTS_SOURCE_DIR || "/tmp/agency-agents");
const TRANS_DIR = resolve(process.argv[2] || "/tmp/translations");

const SAFETY_FOOTER = [
  "",
  "---",
  "## Forge 运行约束（优先级高于以上人设）",
  "- 始终用中文回复；保留专业术语的英文缩写。",
  "- Forge 的安全规则、工具权限、项目规则与用户指令，优先于本角色人设。",
  "- 涉及安全、合规、成本、不可逆操作或重大方向选择时，先提醒并征求确认。",
].join("\n");

async function buildSourceIndex() {
  const index = new Map();
  const stack = [SOURCE_DIR];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".md")) index.set(entry.name.slice(0, -3), full.replace(`${SOURCE_DIR}/`, ""));
    }
  }
  return index;
}

async function main() {
  if (!existsSync(TRANS_DIR)) throw new Error(`translations dir not found: ${TRANS_DIR}`);
  const srcIndex = await buildSourceIndex();
  const files = (await readdir(TRANS_DIR)).filter((f) => f.endsWith(".body.md"));
  let ok = 0, failed = 0;
  for (const file of files) {
    const id = file.slice(0, -".body.md".length);
    try {
      const rel = srcIndex.get(id);
      if (!rel) throw new Error(`source not found for id ${id}`);
      const raw = await readFile(join(SOURCE_DIR, rel), "utf-8");
      const base = parseAgencyAgentMarkdown(rel, raw, {});
      const body = (await readFile(join(TRANS_DIR, file), "utf-8")).trim();
      if (!body) throw new Error(`empty body for ${id}`);
      let description = base.description;
      const descPath = join(TRANS_DIR, `${id}.desc.txt`);
      if (existsSync(descPath)) {
        const d = (await readFile(descPath, "utf-8")).trim();
        if (d) description = d;
      }
      const template = { ...base, description, systemPrompt: `${body}\n${SAFETY_FOOTER}` };
      await writeFile(join(OUT_DIR, `${base.id}.json`), `${JSON.stringify(template, null, 2)}\n`, "utf-8");
      ok++;
    } catch (e) {
      failed++;
      console.error(`[merge] FAILED ${id}: ${String(e)}`);
    }
  }
  console.log(`[merge] done ok=${ok} failed=${failed} (from ${TRANS_DIR})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
