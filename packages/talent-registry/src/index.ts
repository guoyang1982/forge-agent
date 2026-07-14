import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TalentTemplate {
  id: string;
  category: string;
  role: string;
  description: string;
  vibe?: string;
  emoji?: string;
  color?: string;
  /** Deterministic SVG data URI used by the talent center instead of plain emoji. */
  avatar?: string;
  sourcePath: string;
  systemPrompt: string;
  suggestedSkills: string[];
  suggestedTools: string[];
}

export interface HiredTalent {
  instanceId: string;
  templateId: string;
  displayName: string;
  mention: string;
  enabled: boolean;
  skills: string[];
  tools: string[];
  /**
   * When true, focusing this talent (single `@mention`) restricts the skill
   * catalog to its bound `skills` — no other skills are offered or loadable for
   * that run. When false/undefined, bound skills are merely prioritized.
   */
  strictSkills?: boolean;
  permissionPreset: "advisor" | "collaborator" | "operator";
  hiredAt: string;
  stats: {
    tasksDone: number;
    lastUsed: string | null;
  };
}

export interface TalentRoster {
  hired: HiredTalent[];
}

export interface TalentTemplateListItem extends TalentTemplate {
  hired: boolean;
}

export interface TalentStorePaths {
  templatesDir: string;
  rosterPath: string;
  /** Global roster merged when rosterPath is project-scoped. */
  globalRosterPath?: string;
}

export function resolveTalentStorePaths(dataDir: string, cwd?: string): TalentStorePaths {
  const templatesDir = join(dataDir, "talents", "templates");
  const globalRosterPath = join(dataDir, "talents", "roster.json");
  if (cwd?.trim()) {
    return {
      templatesDir,
      rosterPath: join(resolve(cwd), ".forge", "talents.json"),
      globalRosterPath,
    };
  }
  return { templatesDir, rosterPath: globalRosterPath };
}

/**
 * Talent templates shipped inside this package. They are committed to the repo
 * and packaged with the build so a fresh install already has a fully localized
 * roster of hireable talents — no `talents sync` round-trip required.
 *
 * Resolved relative to the compiled module (dist/index.js → ../templates), with
 * a fallback to the source tree (src/index.ts → ../templates) for ts/dev runs.
 */
export function bundledTalentTemplatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "templates"),
    resolve(here, "..", "..", "templates"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

/**
 * Seed/update the user's templates directory from the bundled templates.
 *
 * Bundled templates are product-owned catalog data. We refresh same-name files
 * when the bundled copy changes so localization and metadata fixes reach users
 * who already seeded the market. Extra user templates are left untouched.
 * Returns the number of templates copied or refreshed.
 */
export async function ensureTalentTemplatesSeeded(
  templatesDir: string,
): Promise<{ seeded: number }> {
  const bundled = bundledTalentTemplatesDir();
  if (!existsSync(bundled)) return { seeded: 0 };
  const entries = await readdir(bundled);
  await mkdir(templatesDir, { recursive: true });
  let seeded = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const src = join(bundled, name);
    const dest = join(templatesDir, name);
    let shouldCopy = true;
    try {
      shouldCopy = (await readFile(src, "utf-8")) !== (await readFile(dest, "utf-8"));
    } catch {
      shouldCopy = true;
    }
    if (!shouldCopy) continue;
    await copyFile(src, dest);
    seeded++;
  }
  return { seeded };
}

const DEFAULT_SOURCE_REPO = "https://api.github.com/repos/msitarzewski/agency-agents/git/trees/main?recursive=1";
const RAW_BASE = "https://raw.githubusercontent.com/msitarzewski/agency-agents/main";
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const LOCAL_SYNC_TIP =
  "Tip: clone https://github.com/msitarzewski/agency-agents and run:\n" +
  "  forge talents sync --source /path/to/agency-agents [--categories product]\n" +
  "Or set FORGE_TALENTS_SOURCE_DIR to that path.";

/**
 * GitHub's REST API rejects requests without a User-Agent header (HTTP 403),
 * and rate-limits unauthenticated requests to 60/hour per IP. We always send a
 * User-Agent, and attach a token when one is configured to lift the limit to
 * 5000/hour.
 */
const GITHUB_USER_AGENT = "forge-agent-talent-sync";

function resolveGithubToken(): string | undefined {
  const raw =
    process.env.FORGE_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim();
  return raw || undefined;
}

function buildGithubHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": GITHUB_USER_AGENT };
  if (url.startsWith("https://api.github.com/")) {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }
  const token = resolveGithubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function rateLimitHint(res: Response): string {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  const limited = remaining === "0";
  const lines: string[] = [];
  if (limited) {
    const resetAt = reset ? new Date(Number(reset) * 1000) : null;
    lines.push(
      `GitHub API rate limit reached${resetAt ? ` (resets at ${resetAt.toLocaleTimeString()})` : ""}.`,
    );
  } else {
    lines.push("GitHub API rejected the request (403).");
  }
  if (!resolveGithubToken()) {
    lines.push(
      "Set a token to raise the limit from 60 to 5000 requests/hour: export GITHUB_TOKEN=ghp_xxx (or FORGE_GITHUB_TOKEN).",
    );
  }
  lines.push(LOCAL_SYNC_TIP);
  return lines.join("\n");
}

const REMOTE_FALLBACK_LOCAL_DIRS = ["/tmp/agency-agents"];

const NAME_POOLS: Record<string, string[]> = {
  engineering: ["Nova", "Kit", "Ash", "阿杰", "老周", "程砚", "林澈"],
  design: ["Lumi", "Coco", "小满", "沈柚", "洛宁"],
  marketing: ["Coco", "周野", "苏棠", "Mika", "小满"],
  security: ["Ash", "韩序", "Grey", "石青"],
  product: ["方夏", "Mira", "岑远", "Nina"],
  finance: ["Han", "老钱", "许衡"],
  default: ["Nova", "Lumi", "Ash", "Coco", "Mika", "阿杰", "老周"],
};

const CATEGORY_SKILLS: Record<string, string[]> = {
  engineering: ["patch-edit", "add-unit-test", "run-ci-local"],
  design: ["frontend-design"],
  marketing: ["document-generate"],
  product: ["spec", "brainstorming"],
  security: ["code-review"],
  testing: ["add-unit-test", "run-ci-local"],
};

const CATEGORY_TOOLS: Record<string, string[]> = {
  engineering: ["read_file", "list_dir", "grep", "write_patch", "run_command"],
  design: ["read_file", "list_dir", "grep"],
  marketing: ["read_file", "list_dir", "grep"],
  product: ["read_file", "list_dir", "grep"],
  security: ["read_file", "list_dir", "grep"],
  testing: ["read_file", "list_dir", "grep", "run_command"],
};

interface TalentLocalizationEntry {
  name: string;
  description?: string;
}

type TalentLocalizationMap = Record<string, TalentLocalizationEntry>;

const NON_AGENT_ROOTS = new Set([
  ".github",
  "examples",
  "integrations",
  "scripts",
]);

const CATEGORY_ZH: Record<string, string> = {
  academic: "学术研究",
  design: "设计",
  engineering: "工程",
  finance: "财务",
  "game-development": "游戏开发",
  gis: "地理空间",
  marketing: "市场营销",
  "paid-media": "付费媒体",
  product: "产品",
  "project-management": "项目管理",
  sales: "销售",
  security: "安全",
  "spatial-computing": "空间计算",
  specialized: "专业服务",
  strategy: "战略",
  support: "运营支持",
  testing: "测试",
};

const CATEGORY_AVATARS: Record<string, { color: string; icon: string }> = {
  academic: { color: "#7c3aed", icon: "研" },
  design: { color: "#db2777", icon: "设" },
  engineering: { color: "#2563eb", icon: "工" },
  finance: { color: "#059669", icon: "财" },
  "game-development": { color: "#ea580c", icon: "游" },
  gis: { color: "#0891b2", icon: "图" },
  marketing: { color: "#dc2626", icon: "营" },
  "paid-media": { color: "#ca8a04", icon: "投" },
  product: { color: "#4f46e5", icon: "产" },
  "project-management": { color: "#9333ea", icon: "项" },
  sales: { color: "#16a34a", icon: "销" },
  security: { color: "#475569", icon: "安" },
  "spatial-computing": { color: "#0d9488", icon: "空" },
  specialized: { color: "#64748b", icon: "专" },
  strategy: { color: "#be123c", icon: "策" },
  support: { color: "#0284c7", icon: "服" },
  testing: { color: "#65a30d", icon: "测" },
};

const ROLE_WORD_ZH: Array<[RegExp, string]> = [
  [/Agentic Search/gi, "智能体搜索"],
  [/Agent Activation Prompts/gi, "智能体激活提示词"],
  [/Application Security/gi, "应用安全"],
  [/Chief Financial Officer/gi, "首席财务官"],
  [/Customer Success/gi, "客户成功"],
  [/Retail Customer Returns/gi, "零售客户退货"],
  [/Customer/gi, "客户"],
  [/Data Privacy/gi, "数据隐私"],
  [/Email Intelligence/gi, "邮件智能"],
  [/Filament Optimization/gi, "耗材优化"],
  [/Multi-Agent Systems/gi, "多智能体系统"],
  [/Product Manager/gi, "产品经理"],
  [/Software Architect/gi, "软件架构师"],
  [/Backend Architect/gi, "后端架构师"],
  [/Frontend Developer/gi, "前端开发工程师"],
  [/AEO Foundations/gi, "AEO 基础"],
  [/Add-on/gi, "插件"],
  [/Business/gi, "商业"],
  [/Cartography/gi, "制图"],
  [/Change Management/gi, "变革管理"],
  [/China Market Localization/gi, "中国市场本地化"],
  [/Cloud Security/gi, "云安全"],
  [/Codebase Onboarding/gi, "代码库上手"],
  [/Communications/gi, "传播"],
  [/Drone\/Reality Mapping/gi, "无人机实景建图"],
  [/Email Marketing/gi, "邮件营销"],
  [/ESG & Sustainability/gi, "ESG 与可持续发展"],
  [/Experience/gi, "体验"],
  [/Financial/gi, "财务"],
  [/GeoAI/gi, "地理 AI"],
  [/Geoprocessing/gi, "地理处理"],
  [/Global Podcast/gi, "全球播客"],
  [/Guest Services/gi, "宾客服务"],
  [/Gameplay/gi, "玩法"],
  [/Grant/gi, "资助申请"],
  [/Incident/gi, "安全事件"],
  [/Integration/gi, "集成"],
  [/Intelligence/gi, "情报"],
  [/Investment/gi, "投资"],
  [/Language/gi, "语言"],
  [/Lead Gen/gi, "线索生成"],
  [/Loan/gi, "贷款"],
  [/Medical Billing & Coding/gi, "医疗计费与编码"],
  [/Meeting Notes/gi, "会议纪要"],
  [/Minimal Change/gi, "最小变更"],
  [/Operations/gi, "运营"],
  [/Penetration/gi, "渗透"],
  [/Persona Walkthrough/gi, "用户画像走查"],
  [/Pricing/gi, "定价"],
  [/Prompt/gi, "提示词"],
  [/Scene/gi, "场景"],
  [/Security/gi, "安全"],
  [/Senior SecOps/gi, "高级安全运营"],
  [/Service/gi, "服务"],
  [/Shader/gi, "着色器"],
  [/Shopping Cart/gi, "购物车"],
  [/Solution/gi, "解决方案"],
  [/Spatial Data/gi, "空间数据"],
  [/Technical/gi, "技术"],
  [/Threat/gi, "威胁"],
  [/Video Optimization/gi, "视频优化"],
  [/Voice AI Integration/gi, "语音 AI 集成"],
  [/Voice/gi, "语音"],
  [/World/gi, "世界"],
  [/3D & Scene/gi, "3D 场景"],
  [/Foundations/gi, "基础"],
  [/Marketing/gi, "营销"],
  [/Multiplayer/gi, "多人网络"],
  [/Optimizer/gi, "优化师"],
  [/Response/gi, "响应"],
  [/Scenario/gi, "场景"],
  [/Scientist/gi, "科学家"],
  [/Scripter/gi, "脚本工程师"],
  [/Services/gi, "服务"],
  [/Sprint/gi, "迭代"],
  [/Enterprise Feature/gi, "企业功能"],
  [/Startup Mvp/gi, "创业 MVP"],
  [/Strategy Duel/gi, "战略辩论"],
  [/Systems/gi, "系统"],
  [/Artist/gi, "艺术家"],
  [/Campaign/gi, "活动"],
  [/Civil/gi, "土木"],
  [/Graph/gi, "图形"],
  [/Healthcare/gi, "医疗"],
  [/Hospitality/gi, "酒店"],
  [/Offer/gi, "报价"],
  [/Tax/gi, "税务"],
  [/Developer/gi, "开发工程师"],
  [/Engineer/gi, "工程师"],
  [/Architect/gi, "架构师"],
  [/Designer/gi, "设计师"],
  [/Researcher/gi, "研究员"],
  [/Strategist/gi, "策略师"],
  [/Specialist/gi, "专家"],
  [/Analyst/gi, "分析师"],
  [/Manager/gi, "经理"],
  [/Producer/gi, "制作人"],
  [/Coach/gi, "教练"],
  [/Auditor/gi, "审计师"],
  [/Tester/gi, "测试工程师"],
  [/Writer/gi, "撰写专家"],
  [/Operator/gi, "运营专家"],
  [/Consultant/gi, "顾问"],
  [/Responder/gi, "响应专员"],
  [/Coordinator/gi, "协调员"],
  [/Builder/gi, "构建专家"],
  [/Guardian/gi, "守护者"],
  [/Translator/gi, "翻译专家"],
  [/Officer/gi, "负责人"],
  [/Agent/gi, "智能体"],
  [/Assistant/gi, "助手"],
];

export function parseAgencyAgentMarkdown(
  sourcePath: string,
  raw: string,
  localizationMap: TalentLocalizationMap = {},
): TalentTemplate {
  const category = sourcePath.split("/")[0] || "general";
  const id = basename(sourcePath).replace(/\.md$/, "");
  const { frontmatter } = splitFrontmatter(raw);
  const originalRole = frontmatter.name || titleFromId(id, category);
  const localization = localizationMap[originalRole];
  const role = polishRoleName(
    localization?.name || localizeRoleName(originalRole, id, category),
  );
  const description = localization?.description || localizeDescription({
    category,
    role,
    originalDescription: frontmatter.description || frontmatter.vibe || "",
  });
  const vibe = localizeVibe(frontmatter.vibe, role);
  const color = normalizeColor(frontmatter.color, category);
  return {
    id,
    category,
    role,
    description,
    vibe,
    emoji: frontmatter.emoji,
    color,
    avatar: buildTalentAvatar({ category, role, color }),
    sourcePath,
    systemPrompt: buildLocalizedSystemPrompt({
      role,
      description,
      vibe,
      category,
    }),
    suggestedSkills: inferSkills(category, id),
    suggestedTools: inferTools(category),
  };
}

export async function syncTalentTemplates(options: {
  templatesDir: string;
  sourceDir?: string;
  sourceRepoUrl?: string;
  limitCategories?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  fallbackLocalDirs?: string[];
}): Promise<{ count: number; skipped: number; source: "remote" | "local"; notice?: string }> {
  const explicitLocal = options.sourceDir ? resolve(options.sourceDir) : undefined;
  const envLocal = resolveDefaultTalentSourceDir();
  const localSource = explicitLocal ?? envLocal;
  if (localSource) {
    return syncTalentTemplatesFromLocal({
      ...options,
      sourceDir: localSource,
    });
  }
  try {
    return await syncTalentTemplatesFromRemote(options);
  } catch (error) {
    const fallback = findRemoteFallbackLocalDir(options.fallbackLocalDirs);
    if (!fallback) throw error;
    const result = await syncTalentTemplatesFromLocal({
      ...options,
      sourceDir: fallback,
    });
    // Keep the notice short: only the first line of the error (not the full
    // multi-line clone tip), since the fallback already succeeded.
    const reason = (error instanceof Error ? error.message : String(error))
      .split("\n")[0]
      .trim();
    return {
      ...result,
      notice: `GitHub sync failed; loaded ${result.count} templates from local source (${fallback}). Reason: ${reason}`,
    };
  }
}

export function resolveDefaultTalentSourceDir(): string | undefined {
  const raw = process.env.FORGE_TALENTS_SOURCE_DIR?.trim();
  if (!raw) return undefined;
  const dir = resolve(raw);
  return existsSync(dir) ? dir : undefined;
}

export function createTalentToolAllowance(
  hired: HiredTalent,
  mode: "foreground" | "background",
): (name: string) => boolean {
  const readOnly = new Set(["read_file", "list_dir", "grep", "echo"]);
  const configured = new Set(hired.tools);
  configured.add("echo");
  return (name: string) => {
    if (!configured.has(name)) return false;
    if (mode === "background") return readOnly.has(name);
    return true;
  };
}

export async function renameTalent(options: {
  rosterPath: string;
  instanceIdOrMention: string;
  displayName?: string;
  mention?: string;
}): Promise<HiredTalent> {
  const roster = await readTalentRoster(options.rosterPath);
  const hired = findHiredInRoster(roster, options.instanceIdOrMention);
  if (!hired) throw new Error(`Hired talent not found: ${options.instanceIdOrMention}`);
  if (options.displayName?.trim()) hired.displayName = options.displayName.trim();
  if (options.mention?.trim()) {
    const used = new Set(
      roster.hired
        .filter((item) => item.instanceId !== hired.instanceId)
        .map((item) => item.mention),
    );
    hired.mention = uniqueMention(options.mention, used);
  }
  await writeTalentRoster(options.rosterPath, roster);
  return hired;
}

export async function updateTalentBindings(options: {
  rosterPath: string;
  instanceIdOrMention: string;
  skills?: string[];
  tools?: string[];
  enabled?: boolean;
  strictSkills?: boolean;
}): Promise<HiredTalent> {
  const roster = await readTalentRoster(options.rosterPath);
  const hired = findHiredInRoster(roster, options.instanceIdOrMention);
  if (!hired) throw new Error(`Hired talent not found: ${options.instanceIdOrMention}`);
  if (options.skills) hired.skills = [...options.skills];
  if (options.tools) {
    hired.tools = [...options.tools];
    hired.permissionPreset = inferPermissionPreset({
      suggestedTools: hired.tools,
    } as TalentTemplate);
  }
  if (typeof options.enabled === "boolean") hired.enabled = options.enabled;
  if (typeof options.strictSkills === "boolean") {
    hired.strictSkills = options.strictSkills;
  }
  await writeTalentRoster(options.rosterPath, roster);
  return hired;
}

export async function recordTalentUsage(
  rosterPath: string,
  instanceIds: string[],
  globalRosterPath?: string,
): Promise<void> {
  if (!instanceIds.length) return;
  const remaining = new Set(instanceIds);
  await recordTalentUsageInRoster(rosterPath, remaining);
  if (
    globalRosterPath &&
    globalRosterPath !== rosterPath &&
    remaining.size > 0
  ) {
    await recordTalentUsageInRoster(globalRosterPath, remaining);
  }
}

async function recordTalentUsageInRoster(
  rosterPath: string,
  remaining: Set<string>,
): Promise<void> {
  if (!remaining.size) return;
  const roster = await readTalentRoster(rosterPath);
  const now = new Date().toISOString();
  let changed = false;
  for (const hired of roster.hired) {
    if (!remaining.has(hired.instanceId)) continue;
    hired.stats.tasksDone += 1;
    hired.stats.lastUsed = now;
    remaining.delete(hired.instanceId);
    changed = true;
  }
  if (changed) await writeTalentRoster(rosterPath, roster);
}

async function syncTalentTemplatesFromRemote(options: {
  templatesDir: string;
  sourceRepoUrl?: string;
  limitCategories?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ count: number; skipped: number; source: "remote" | "local"; notice?: string }> {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const treeUrl = options.sourceRepoUrl ?? DEFAULT_SOURCE_REPO;
  const res = await fetchWithTimeout(treeUrl, { timeoutMs }, fetchFn);
  if (!res.ok) {
    const hint =
      res.status === 403 || res.status === 429
        ? rateLimitHint(res)
        : LOCAL_SYNC_TIP;
    throw new Error(
      `talent sync: GitHub API returned HTTP ${res.status} for ${treeUrl}\n${hint}`,
    );
  }
  const data = await res.json() as {
    tree?: Array<{ path: string; type: string }>;
  };
  const paths = filterAgentPaths(
    (data.tree ?? [])
      .filter((item) => item.type === "blob" && item.path.endsWith(".md"))
      .map((item) => item.path),
    options.limitCategories,
  );
  const localizationMap = await fetchRemoteLocalizationMap({
    fetchFn,
    timeoutMs,
  });

  await mkdir(options.templatesDir, { recursive: true });
  let count = 0;
  let skipped = 0;
  for (const path of paths) {
    const fileUrl = `${RAW_BASE}/${path}`;
    let md: Response;
    try {
      md = await fetchWithTimeout(fileUrl, { timeoutMs }, fetchFn);
    } catch {
      skipped++;
      continue;
    }
    if (!md.ok) {
      skipped++;
      continue;
    }
    try {
      const template = parseAgencyAgentMarkdown(path, await md.text(), localizationMap);
      await writeTalentTemplate(options.templatesDir, template);
      count++;
    } catch {
      skipped++;
    }
  }
  return { count, skipped, source: "remote" };
}

async function syncTalentTemplatesFromLocal(options: {
  templatesDir: string;
  sourceDir: string;
  limitCategories?: string[];
}): Promise<{ count: number; skipped: number; source: "remote" | "local" }> {
  const sourceDir = resolve(options.sourceDir);
  if (!existsSync(sourceDir)) {
    throw new Error(`talent sync: local source directory not found: ${sourceDir}`);
  }
  const paths = filterAgentPaths(
    await listLocalAgentPaths(sourceDir),
    options.limitCategories,
  );
  const localizationMap = await readLocalLocalizationMap(sourceDir);
  if (!paths.length) {
    throw new Error(
      `talent sync: no agency-agents markdown files found under ${sourceDir}\n` +
      "Expected paths like product/product-manager.md (category/*.md).",
    );
  }

  await mkdir(options.templatesDir, { recursive: true });
  let count = 0;
  let skipped = 0;
  for (const path of paths) {
    try {
      const raw = await readFile(join(sourceDir, path), "utf-8");
      const template = parseAgencyAgentMarkdown(path, raw, localizationMap);
      await writeTalentTemplate(options.templatesDir, template);
      count++;
    } catch {
      skipped++;
    }
  }
  return { count, skipped, source: "local" };
}

export async function writeTalentTemplate(
  templatesDir: string,
  template: TalentTemplate,
): Promise<void> {
  await mkdir(templatesDir, { recursive: true });
  await writeFile(
    join(templatesDir, `${template.id}.json`),
    `${JSON.stringify(template, null, 2)}\n`,
    "utf-8",
  );
}

export async function listTalentTemplates(
  templatesDir: string,
  rosterPath?: string,
  options?: { category?: string; query?: string; globalRosterPath?: string },
): Promise<TalentTemplateListItem[]> {
  const templates = await readAllTemplates(templatesDir);
  const roster = rosterPath
    ? await readMergedTalentRoster({
        templatesDir,
        rosterPath,
        globalRosterPath: options?.globalRosterPath,
      })
    : { hired: [] };
  const hiredIds = new Set(roster.hired.map((item) => item.templateId));
  const query = options?.query?.trim().toLowerCase();
  return templates
    .filter((item) => !options?.category || item.category === options.category)
    .filter((item) => {
      if (!query) return true;
      return [item.id, item.role, item.description, item.vibe, item.category]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query));
    })
    .map((item) => ({ ...item, hired: hiredIds.has(item.id) }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.role.localeCompare(b.role));
}

export async function readTalentTemplate(
  templatesDir: string,
  templateId: string,
): Promise<TalentTemplate | null> {
  try {
    const raw = await readFile(join(templatesDir, `${templateId}.json`), "utf-8");
    return JSON.parse(raw) as TalentTemplate;
  } catch {
    return null;
  }
}

export async function readTalentRoster(rosterPath: string): Promise<TalentRoster> {
  try {
    const raw = await readFile(rosterPath, "utf-8");
    const parsed = JSON.parse(raw) as TalentRoster;
    return { hired: Array.isArray(parsed.hired) ? parsed.hired : [] };
  } catch {
    return { hired: [] };
  }
}

export async function writeTalentRoster(
  rosterPath: string,
  roster: TalentRoster,
): Promise<void> {
  await mkdir(dirname(rosterPath), { recursive: true });
  await writeFile(rosterPath, `${JSON.stringify(roster, null, 2)}\n`, "utf-8");
}

export async function hireTalent(options: {
  templatesDir: string;
  rosterPath: string;
  templateId: string;
  displayName?: string;
  mention?: string;
}): Promise<HiredTalent> {
  const template = await readTalentTemplate(options.templatesDir, options.templateId);
  if (!template) throw new Error(`Talent template not found: ${options.templateId}`);
  const roster = await readTalentRoster(options.rosterPath);
  const existing = roster.hired.find((item) => item.templateId === template.id);
  if (existing) return existing;
  const usedMentions = new Set(roster.hired.map((item) => item.mention));
  const displayName = options.displayName || generateDisplayName(template, roster);
  const mention = uniqueMention(
    options.mention || slugMention(displayName) || template.id,
    usedMentions,
  );
  const hired: HiredTalent = {
    instanceId: `t_${template.id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
    templateId: template.id,
    displayName,
    mention,
    enabled: true,
    skills: template.suggestedSkills,
    tools: template.suggestedTools,
    strictSkills: false,
    permissionPreset: inferPermissionPreset(template),
    hiredAt: new Date().toISOString(),
    stats: { tasksDone: 0, lastUsed: null },
  };
  roster.hired.push(hired);
  await writeTalentRoster(options.rosterPath, roster);
  return hired;
}

export async function fireTalent(
  rosterPath: string,
  instanceOrMention: string,
): Promise<{ removed: boolean }> {
  const roster = await readTalentRoster(rosterPath);
  const before = roster.hired.length;
  roster.hired = roster.hired.filter(
    (item) => item.instanceId !== instanceOrMention && item.mention !== instanceOrMention,
  );
  await writeTalentRoster(rosterPath, roster);
  return { removed: roster.hired.length !== before };
}

export async function readMergedTalentRoster(
  paths: TalentStorePaths,
): Promise<TalentRoster> {
  const project = await readTalentRoster(paths.rosterPath);
  if (
    !paths.globalRosterPath ||
    paths.globalRosterPath === paths.rosterPath
  ) {
    return project;
  }
  const global = await readTalentRoster(paths.globalRosterPath);
  const byMention = new Map<string, HiredTalent>();
  for (const hired of global.hired) {
    byMention.set(normalizeMention(hired.mention), hired);
  }
  for (const hired of project.hired) {
    byMention.set(normalizeMention(hired.mention), hired);
  }
  return { hired: [...byMention.values()] };
}

export async function findHiredTalentByMention(
  paths: TalentStorePaths,
  mention: string,
): Promise<{ hired: HiredTalent; template: TalentTemplate } | null> {
  const key = normalizeMention(mention);
  const roster = await readMergedTalentRoster(paths);
  const hired = roster.hired.find(
    (item) => item.enabled && normalizeMention(item.mention) === key,
  );
  if (!hired) return null;
  const template = await readTalentTemplate(paths.templatesDir, hired.templateId);
  if (!template || !isAgentPath(template.sourcePath)) return null;
  return { hired, template };
}

export function isTalentForcedForeground(
  message: string,
  mention: string,
): boolean {
  const key = normalizeMention(mention);
  if (!key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}!`, "iu").test(message);
}

export function extractTalentMentions(message: string): string[] {
  const seen = new Set<string>();
  const mentions: string[] = [];
  for (const match of message.matchAll(/@([\p{L}\p{N}_-]+)!?/gu)) {
    const mention = normalizeMention(match[1]);
    if (!mention || seen.has(mention)) continue;
    seen.add(mention);
    mentions.push(mention);
  }
  return mentions;
}

export interface ParsedTalentAssignment {
  mention: string;
  task: string;
}

/** Split a multi-@ message into per-talent task segments (mention order in text). */
export function parseTalentAssignmentsFromMessage(
  message: string,
  rosterMentions: string[],
): ParsedTalentAssignment[] {
  const byMention = new Set(rosterMentions.map(normalizeMention));
  const matches = [...message.matchAll(/@([\p{L}\p{N}_-]+)/gu)]
    .map((match) => ({
      mention: normalizeMention(match[1]),
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }))
    .filter((match) => byMention.has(match.mention));

  return matches.map((match, index) => {
    const next = matches[index + 1]?.index ?? message.length;
    const task = message.slice(match.end, next).trim() || message;
    return { mention: match.mention, task };
  });
}

export type TalentExecutionMode = "parallel" | "serial";

const EXPLICIT_PARALLEL_MARKERS = [/\|\|/u, /\/\//u, /\(并行\)/u, /\(parallel\)/iu];
const EXPLICIT_SERIAL_MARKERS = [/\(串行\)/u, /\(sequential\)/iu, /→/u, /->/u];

/** Heuristic: later @ segments that reference prior work should run serially. */
const IMPLICIT_SERIAL_TASK_PATTERNS = [
  /设计完/u,
  /设计好/u,
  /设计(?:过|的|稿)/u,
  /开发设计/u,
  /完成(?:后|的)/u,
  /上面/u,
  /前述/u,
  /根据/u,
  /基于/u,
  /之后/u,
  /然后/u,
  /接着/u,
  /第一个(?:人|角色|人才)?/u,
  /第一位/u,
  /前一个(?:人|角色|人才)?/u,
  /上一个(?:人|角色|人才)?/u,
  /上一/u,
  /刚才/u,
  /之前/u,
  /其产出/u,
  /上述/u,
  /前面/u,
  /先(?:前|行)/u,
  /\bafter\b/i,
  /\bbased on\b/i,
  /\bprevious\b/i,
  /following/i,
];

/**
 * A *positive* serial signal: the user explicitly asked for sequencing, or a
 * later task references earlier work. Distinct from the ambiguous case (no
 * signal either way), so callers can force-serialize a flat model plan only
 * when there is real evidence of a dependency — never on the safe default.
 */
export function detectsSerialDependency(
  message: string,
  assignments: Array<{ task: string }>,
): boolean {
  if (EXPLICIT_PARALLEL_MARKERS.some((re) => re.test(message))) return false;
  if (EXPLICIT_SERIAL_MARKERS.some((re) => re.test(message))) return true;
  for (let i = 1; i < assignments.length; i++) {
    const task = assignments[i]?.task ?? "";
    if (IMPLICIT_SERIAL_TASK_PATTERNS.some((re) => re.test(task))) return true;
  }
  return false;
}

/**
 * Heuristic execution mode. This is a *fallback* — it runs only when model
 * dependency-planning is unavailable. With more than one talent and no explicit
 * signal we cannot tell "independent" from "dependent-but-unkeyworded", so we
 * choose the safe side: serial never drops upstream context (worst case is
 * slower, not broken). Use an explicit `||` / `(并行)` to force parallel.
 */
export function resolveTalentExecutionMode(
  message: string,
  assignments: Array<{ task: string }>,
): TalentExecutionMode {
  if (EXPLICIT_PARALLEL_MARKERS.some((re) => re.test(message))) return "parallel";
  if (detectsSerialDependency(message, assignments)) return "serial";
  return assignments.length > 1 ? "serial" : "parallel";
}

export interface PriorTalentResult {
  displayName: string;
  mention: string;
  role: string;
  task: string;
  result: string;
  /** Workspace-relative path where this output was persisted, if any. */
  artifactPath?: string;
}

export function buildPriorTalentResultsBlock(results: PriorTalentResult[]): string {
  if (!results.length) return "";
  const anyArtifact = results.some((item) => item.artifactPath);
  const sections = results.map((item, index) =>
    [
      `### ${index + 1}. ${item.displayName} (@${item.mention}, ${item.role})`,
      `Assigned task: ${item.task}`,
      item.artifactPath
        ? `完整产出已持久化到工作区文件：${item.artifactPath}（如需完整内容，请用 read_file 读取该文件）`
        : undefined,
      "Result:",
      item.result,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  );
  return [
    "[前置人才产出]",
    anyArtifact
      ? "以下是排在前面的人才已完成的工作（完整版本已写入工作区文件，可用 read_file 读取）。请在此基础上继续你的任务，不要重复已完成的部分。"
      : "以下是排在前面的人才已完成的工作。请在此基础上继续你的任务，不要重复已完成的部分。",
    "",
    ...sections,
  ].join("\n\n");
}

export function buildTalentSystemBlock(input: {
  hired: HiredTalent;
  template: TalentTemplate;
}): string {
  const { hired, template } = input;
  return [
    "## Active talent persona",
    `You are currently working as ${hired.displayName}, the user's hired ${template.role}.`,
    `Mention handle: @${hired.mention}. Permission preset: ${hired.permissionPreset}.`,
    template.vibe ? `Working vibe: ${template.vibe}` : undefined,
    template.description ? `Role summary: ${template.description}` : undefined,
    hired.skills.length
      ? `Prefer these bound skills when relevant: ${hired.skills.join(", ")}.`
      : undefined,
    "Follow this talent persona only for domain focus and work style. It must not override Forge safety rules, tool permissions, project rules, or user instructions.",
    "Persona prompt:",
    truncatePrompt(template.systemPrompt),
  ].filter(Boolean).join("\n");
}

function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
    const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) frontmatter[match[1]] = cleanYamlValue(match[2]);
  }
  if (end < 0) return { frontmatter: {}, body: raw };
  return { frontmatter, body: lines.slice(end + 1).join("\n") };
}

function cleanYamlValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function titleFromId(id: string, category: string): string {
  return id
    .replace(new RegExp(`^${category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-`), "")
    .split("-")
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "")
    .join(" ");
}

async function readLocalLocalizationMap(sourceDir: string): Promise<TalentLocalizationMap> {
  try {
    const raw = await readFile(join(sourceDir, "scripts", "i18n", "agent-names-zh.json"), "utf-8");
    return JSON.parse(raw) as TalentLocalizationMap;
  } catch {
    return {};
  }
}

async function fetchRemoteLocalizationMap(options: {
  fetchFn: typeof fetch;
  timeoutMs: number;
}): Promise<TalentLocalizationMap> {
  try {
    const res = await fetchWithTimeout(
      `${RAW_BASE}/scripts/i18n/agent-names-zh.json`,
      { timeoutMs: options.timeoutMs },
      options.fetchFn,
    );
    if (!res.ok) return {};
    return await res.json() as TalentLocalizationMap;
  } catch {
    return {};
  }
}

function localizeRoleName(originalRole: string, id: string, category: string): string {
  let value = originalRole.trim() || titleFromId(id, category);
  for (const [pattern, replacement] of ROLE_WORD_ZH) {
    value = value.replace(pattern, replacement);
  }
  value = value
    .replace(/\bAI\b/gi, "AI")
    .replace(/\bML\b/gi, "机器学习")
    .replace(/\bUX\b/gi, "UX")
    .replace(/\bUI\b/gi, "UI")
    .replace(/\bSEO\b/gi, "SEO")
    .replace(/\bAPI\b/gi, "API")
    .replace(/\bXR\b/gi, "XR")
    .replace(/\bGIS\b/gi, "GIS")
    .replace(/\bGTM\b/gi, "GTM")
    .replace(/\s+/g, " ")
    .trim();
  if (/^[A-Za-z0-9 &/+-]+$/.test(value)) {
    const cat = CATEGORY_ZH[category] || "专业";
    return `${cat}${value.includes("Agent") ? " Agent" : "专家"}`;
  }
  return value;
}

function polishRoleName(role: string): string {
  let value = role.trim();
  for (const [pattern, replacement] of ROLE_WORD_ZH) {
    value = value.replace(pattern, replacement);
  }
  return value.replace(/\s+/g, " ").trim();
}

function localizeDescription(input: {
  category: string;
  role: string;
  originalDescription: string;
}): string {
  const category = CATEGORY_ZH[input.category] || "专业领域";
  const original = input.originalDescription.trim();
  if (!original) return `${input.role}，专注${category}场景的分析、判断与交付。`;
  return `${input.role}，专注${category}场景；负责把复杂问题拆解成可执行建议、产物与验证标准。`;
}

function localizeVibe(vibe: string | undefined, role: string): string {
  if (!vibe?.trim()) return `${role}风格：清晰、务实、以结果和证据为中心。`;
  return `${role}风格：保留原角色的专业气质，同时用中文给出清晰、可执行、可验证的建议。`;
}

function normalizeColor(color: string | undefined, category: string): string {
  if (color?.startsWith("#")) return color;
  return CATEGORY_AVATARS[category]?.color || "#64748b";
}

function buildLocalizedSystemPrompt(input: {
  role: string;
  description: string;
  vibe?: string;
  category: string;
}): string {
  return [
    `# ${input.role}`,
    "",
    "## 身份定位",
    `你是${input.role}。请始终用中文工作，保留专业术语的英文缩写，并把判断落到可执行产物。`,
    "",
    "## 职责摘要",
    input.description,
    input.vibe ? `工作风格：${input.vibe}` : undefined,
    `领域分类：${CATEGORY_ZH[input.category] || input.category}`,
    "",
    "## 工作规则",
    "- 先澄清目标、约束和成功标准，再给方案。",
    "- 输出必须有结构、有取舍、有下一步。",
    "- 不确定的内容标为假设，不把猜测写成事实。",
    "- 涉及安全、合规、成本、不可逆操作或重大方向选择时先提醒并询问。",
    "- 保持 Forge 的安全规则、工具权限、项目规则和用户指令优先于角色人设。",
    "",
    "## 固定工作流程",
    "1. 复述任务目标、受众、约束和成功标准。",
    "2. 识别关键风险、未知假设和需要用户决策的事项。",
    "3. 给出结构化方案，明确推荐路径、取舍和不做什么。",
    "4. 产出该角色应交付的文档、清单、评审意见、执行计划或验证标准。",
    "5. 收尾时列出下一步、负责人、验证方式和残余风险。",
    "",
    "## 交付标准",
    "- 结论先行，证据和理由随后。",
    "- 能落地到步骤、表格、验收标准或检查清单。",
    "- 重要建议必须包含收益、代价、风险和触发重评的条件。",
    "- 不输出空泛口号，不用英文原文代替中文说明。",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function buildTalentAvatar(input: {
  category: string;
  role: string;
  color?: string;
}): string {
  const base = input.color || CATEGORY_AVATARS[input.category]?.color || "#64748b";
  const accent = mixColor(base, "#ffffff", 0.22);
  const shadow = mixColor(base, "#000000", 0.2);
  const categoryIcon = CATEGORY_AVATARS[input.category]?.icon || "才";
  const initials = avatarInitials(input.role, categoryIcon);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="16" y1="12" x2="82" y2="88" gradientUnits="userSpaceOnUse"><stop stop-color="${escapeXml(accent)}"/><stop offset="1" stop-color="${escapeXml(base)}"/></linearGradient></defs><rect width="96" height="96" rx="24" fill="url(#g)"/><circle cx="70" cy="24" r="14" fill="rgba(255,255,255,.22)"/><circle cx="23" cy="75" r="18" fill="rgba(0,0,0,.12)"/><text x="48" y="54" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans CJK SC',sans-serif" font-size="28" font-weight="800" fill="#fff">${escapeXml(initials)}</text><text x="48" y="74" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans CJK SC',sans-serif" font-size="12" font-weight="700" fill="${escapeXml(mixColor(shadow, "#ffffff", 0.8))}">${escapeXml(categoryIcon)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function avatarInitials(role: string, fallback: string): string {
  const chinese = [...role].filter((ch) => /\p{Script=Han}/u.test(ch));
  if (chinese.length >= 2) return chinese.slice(0, 2).join("");
  if (chinese.length === 1) return chinese[0];
  const latin = role.match(/[A-Za-z0-9]+/g)?.map((part) => part[0]).join("") || fallback;
  return latin.slice(0, 2).toUpperCase();
}

function mixColor(hex: string, other: string, amount: number): string {
  const a = parseHexColor(hex);
  const b = parseHexColor(other);
  const channel = (x: number, y: number) => Math.round(x + (y - x) * amount);
  return `#${[channel(a[0], b[0]), channel(a[1], b[1]), channel(a[2], b[2])]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

function parseHexColor(value: string): [number, number, number] {
  const raw = value.replace(/^#/, "");
  const normalized = raw.length === 3
    ? raw.split("").map((ch) => ch + ch).join("")
    : raw.padEnd(6, "0").slice(0, 6);
  const n = Number.parseInt(normalized, 16);
  if (Number.isNaN(n)) return [100, 116, 139];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function escapeXml(value: string): string {
  return value.replace(/[&<>'"]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&apos;",
    '"': "&quot;",
  })[ch] || ch);
}

function inferSkills(category: string, id: string): string[] {
  const byCategory = CATEGORY_SKILLS[category] ?? [];
  if (id.includes("code-review")) return ["code-review", "explain-code"];
  if (id.includes("technical-writer")) return ["document-generate", "readme-update"];
  if (id.includes("frontend")) return ["frontend-design", "patch-edit", "run-ci-local"];
  return byCategory;
}

function inferTools(category: string): string[] {
  return CATEGORY_TOOLS[category] ?? ["read_file", "list_dir", "grep"];
}

function inferPermissionPreset(template: TalentTemplate): HiredTalent["permissionPreset"] {
  if (template.suggestedTools.includes("run_command")) return "operator";
  if (template.suggestedTools.includes("write_patch")) return "collaborator";
  return "advisor";
}

async function readAllTemplates(templatesDir: string): Promise<TalentTemplate[]> {
  if (!existsSync(templatesDir)) return [];
  const entries = await readdir(templatesDir, { withFileTypes: true });
  const out: TalentTemplate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const template = await readTalentTemplate(
      templatesDir,
      entry.name.replace(/\.json$/, ""),
    );
    if (template && isAgentPath(template.sourcePath)) out.push(template);
  }
  return out;
}

export async function resolveWritableRosterPath(
  paths: TalentStorePaths,
  instanceIdOrMention: string,
): Promise<string> {
  const project = await readTalentRoster(paths.rosterPath);
  if (findHiredInRoster(project, instanceIdOrMention)) return paths.rosterPath;
  if (paths.globalRosterPath && paths.globalRosterPath !== paths.rosterPath) {
    const global = await readTalentRoster(paths.globalRosterPath);
    if (findHiredInRoster(global, instanceIdOrMention)) {
      return paths.globalRosterPath;
    }
  }
  return paths.rosterPath;
}

function generateDisplayName(template: TalentTemplate, roster: TalentRoster): string {
  const pool = NAME_POOLS[template.category] ?? NAME_POOLS.default;
  const used = new Set(roster.hired.map((item) => item.displayName));
  const start = seededIndex(template.id, pool.length);
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(start + i) % pool.length];
    if (!used.has(candidate)) return candidate;
  }
  return `${pool[start]} ${roster.hired.length + 1}`;
}

function seededIndex(value: string, modulo: number): number {
  let hash = 0;
  for (const ch of value) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return modulo ? hash % modulo : 0;
}

function slugMention(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || value.replace(/\s+/g, "");
}

function uniqueMention(base: string, used: Set<string>): string {
  const clean = normalizeMention(base) || "talent";
  if (!used.has(clean)) return clean;
  let i = 2;
  while (used.has(`${clean}${i}`)) i++;
  return `${clean}${i}`;
}

function normalizeMention(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function truncatePrompt(prompt: string): string {
  const max = 12000;
  if (prompt.length <= max) return prompt;
  return `${prompt.slice(0, max)}\n\n[Prompt truncated to ${max} characters for this run.]`;
}

function findHiredInRoster(
  roster: TalentRoster,
  instanceIdOrMention: string,
): HiredTalent | undefined {
  const key = normalizeMention(instanceIdOrMention);
  return roster.hired.find(
    (item) =>
      item.instanceId === instanceIdOrMention ||
      normalizeMention(item.mention) === key,
  );
}

function findRemoteFallbackLocalDir(candidates = REMOTE_FALLBACK_LOCAL_DIRS): string | undefined {
  for (const candidate of candidates) {
    const dir = resolve(candidate);
    if (existsSync(dir)) return dir;
  }
  return resolveDefaultTalentSourceDir();
}

function isAgentPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return false;
  if (NON_AGENT_ROOTS.has(parts[0])) return false;
  const file = parts[parts.length - 1] || "";
  if (!file.endsWith(".md")) return false;
  return !/^README(?:\.[a-z-]+)?\.md$/iu.test(file);
}

function filterAgentPaths(paths: string[], limitCategories?: string[]): string[] {
  return paths
    .filter(isAgentPath)
    .filter((path) => {
      if (!limitCategories?.length) return true;
      return limitCategories.includes(path.split("/")[0] || "");
    });
}

async function listLocalAgentPaths(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await walk(join(dir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(rel);
      }
    }
  }
  await walk(rootDir, "");
  return out;
}

async function fetchWithTimeout(
  url: string,
  options: { timeoutMs: number },
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: buildGithubHeaders(url),
    });
  } catch (error) {
    throw formatFetchError(url, options.timeoutMs, error);
  }
}

function formatFetchError(url: string, timeoutMs: number, error: unknown): Error {
  const lines = [`talent sync: failed to fetch ${url}`];
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      lines.push(`(timed out after ${timeoutMs}ms — check network, proxy, or firewall)`);
    } else {
      lines.push(error.message);
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const code = "code" in cause ? String(cause.code) : cause.name;
      lines.push(`Cause: ${code}: ${cause.message}`);
    } else if (cause != null) {
      lines.push(`Cause: ${String(cause)}`);
    }
  } else {
    lines.push(String(error));
  }
  lines.push(LOCAL_SYNC_TIP);
  return new Error(lines.join("\n"));
}
