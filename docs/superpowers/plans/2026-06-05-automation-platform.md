# Forge Automations 平台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 forge-agent 上实现通用 Automations 平台 — Desktop UI、三模板、Create via chat、Daemon Cron 调度、CLI 等价能力。

**Architecture:** 新建 `@forge/automation` 包负责 SQLite CRUD、cron 计算与调度逻辑；daemon `automation-service` 调用现有 `handleRun`；Desktop 沿用 `resourceView` + IPC 桥模式。

**Tech Stack:** TypeScript, better-sqlite3, cron-parser, vitest, Electron (vanilla renderer), `@forge/protocol` JSON-RPC

**Spec:** `docs/superpowers/specs/2026-06-05-automation-platform-design.md`

---

## 文件地图

| 文件 | 职责 |
|------|------|
| `migrations/003_automations.sql` | `automations` + `automation_runs` 表 |
| `packages/protocol/src/automation.ts` | 类型、请求/响应、导出 |
| `packages/protocol/src/index.ts` | `DAEMON_METHODS` 扩展、`FORGE_DAEMON_BUILD` bump |
| `packages/automation/package.json` | 新 workspace 包 |
| `packages/automation/src/store.ts` | SQLite CRUD（注入 `Database`） |
| `packages/automation/src/cron.ts` | next run 计算、校验、漏跑判断 |
| `packages/automation/src/cron-human.ts` | cron → 中文展示文案 |
| `packages/automation/src/scheduler.ts` | `setTimeout` 链、reschedule/reload |
| `packages/automation/src/templates.ts` | 三内置模板 |
| `packages/automation/src/parse-draft.ts` | NL → `AutomationDraft`（LLM） |
| `packages/automation/src/index.ts` | 公共导出 |
| `packages/automation/src/*.test.ts` | store / cron / scheduler 单测 |
| `apps/daemon/src/services/automation-service.ts` | RPC handlers + `executeAutomation` |
| `apps/daemon/src/services/automation-scheduler-host.ts` | 包装 scheduler + 生命周期 |
| `apps/daemon/src/main.ts` | 注册 RPC、启动/停止 scheduler |
| `apps/cli/src/automation-cli.ts` | `forge automation` 子命令 |
| `apps/cli/src/cli.ts` | 挂载子命令 |
| `apps/desktop/src/main.ts` | IPC handlers |
| `apps/desktop/src/preload.ts` | `forgeDesktop` API |
| `apps/desktop/src/renderer/index.html` | 侧栏按钮、automations 工具栏、编辑器模态 |
| `apps/desktop/src/renderer/app.js` | `renderAutomationsView`、create-via-chat 流 |
| `apps/desktop/src/renderer/styles.css` | pill、列表、模态样式 |
| `packages/config/src/index.ts` | 可选 `automation.defaultTimezone` |
| `docs/automations-guide.md` | 用户指南 |

---

## Phase 1 — 协议与数据库

### Task 1: Migration

**Files:**
- Create: `migrations/003_automations.sql`

- [ ] **Step 1: 添加 migration**

```sql
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  cwd TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  cron_expr TEXT,
  timezone TEXT,
  prompt TEXT NOT NULL,
  model TEXT,
  memory_enabled INTEGER NOT NULL DEFAULT 0,
  session_mode TEXT NOT NULL DEFAULT 'new',
  resume_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  preview TEXT,
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

CREATE INDEX IF NOT EXISTS idx_automations_enabled_cron
  ON automations(enabled, trigger_type);
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
  ON automation_runs(automation_id, started_at DESC);
```

- [ ] **Step 2: 验证 migration 应用**

Run: `pnpm build && node -e "
const { SessionStore } = require('./packages/session/dist/index.js');
const { join } = require('node:path');
const db = join(require('node:os').tmpdir(), 'forge-auto-test.db');
const s = new SessionStore(db, join(process.cwd(), 'migrations'));
console.log('ok');
"`

Expected: 打印 `ok`，无 SQL 错误

---

### Task 2: Protocol 类型

**Files:**
- Create: `packages/protocol/src/automation.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: 创建 `automation.ts`**

```typescript
export type AutomationTriggerType = "cron" | "manual";
export type AutomationRunStatus = "pending" | "running" | "success" | "failed" | "skipped";
export type AutomationRunTrigger = "schedule" | "manual" | "cli";

export interface AutomationRecord {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  cwd: string;
  trigger: { type: "cron"; cron: string; timezone: string } | { type: "manual" };
  prompt: string;
  model?: string;
  memoryEnabled: boolean;
  sessionMode: "new" | "resume";
  resumeSessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  sessionId: string;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  preview?: string;
}

export interface AutomationDraft {
  name: string;
  description?: string;
  cron?: string;
  timezone?: string;
  prompt: string;
  cwd?: string;
  enabled?: boolean;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  draft: AutomationDraft;
}

export interface ListAutomationsRequest { cwd?: string; }
export interface ListAutomationsResult { automations: AutomationRecord[]; }

export interface GetAutomationRequest { id: string; }
export interface GetAutomationResult { automation: AutomationRecord; }

export interface CreateAutomationRequest { draft: AutomationDraft; skipConfirm?: boolean; }
export interface CreateAutomationResult { automation: AutomationRecord; }

export interface UpdateAutomationRequest {
  id: string;
  patch: Partial<AutomationDraft> & { enabled?: boolean };
}
export interface UpdateAutomationResult { automation: AutomationRecord; }

export interface DeleteAutomationRequest { id: string; skipConfirm?: boolean; }
export interface DeleteAutomationResult { ok: true; }

export interface RunAutomationRequest {
  id: string;
  trigger?: AutomationRunTrigger;
  skipConfirm?: boolean;
}
export interface RunAutomationResult { run: AutomationRunRecord; }

export interface ListAutomationRunsRequest { automationId: string; limit?: number; }
export interface ListAutomationRunsResult { runs: AutomationRunRecord[]; }

export interface ParseAutomationDraftRequest { message: string; cwd?: string; }
export interface ParseAutomationDraftResult {
  draft?: AutomationDraft;
  questions?: string[];
}

export interface ListAutomationTemplatesResult { templates: AutomationTemplate[]; }
```

- [ ] **Step 2: 扩展 `DAEMON_METHODS` 并 bump build**

在 `packages/protocol/src/index.ts` 追加：

```typescript
export * from "./automation.js";

export const DAEMON_METHODS = {
  // ...existing
  LIST_AUTOMATIONS: "list_automations",
  GET_AUTOMATION: "get_automation",
  CREATE_AUTOMATION: "create_automation",
  UPDATE_AUTOMATION: "update_automation",
  DELETE_AUTOMATION: "delete_automation",
  RUN_AUTOMATION: "run_automation",
  LIST_AUTOMATION_RUNS: "list_automation_runs",
  PARSE_AUTOMATION_DRAFT: "parse_automation_draft",
  LIST_AUTOMATION_TEMPLATES: "list_automation_templates",
} as const;

export const FORGE_DAEMON_BUILD = "2026-06-05-automation-v1";
```

- [ ] **Step 3: 构建验证**

Run: `pnpm --filter @forge/protocol run build`
Expected: 无 TS 错误

---

## Phase 2 — `@forge/automation` 包

### Task 3: 脚手架

**Files:**
- Create: `packages/automation/package.json`
- Create: `packages/automation/tsconfig.json`
- Create: `packages/automation/src/index.ts`

- [ ] **Step 1: package.json**

```json
{
  "name": "@forge/automation",
  "version": "0.2.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": { "build": "tsc", "test": "vitest run" },
  "dependencies": {
    "@forge/protocol": "workspace:*",
    "better-sqlite3": "^11.8.1",
    "cron-parser": "^5.0.6"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "vitest": "^3.0.9"
  }
}
```

- [ ] **Step 2: tsconfig 复制 `@forge/session` 模式，`src/index.ts` 导出子模块**

- [ ] **Step 3: 根 `package.json` test 脚本加入 `@forge/automation`**

---

### Task 4: AutomationStore

**Files:**
- Create: `packages/automation/src/store.ts`
- Create: `packages/automation/src/store.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AutomationStore } from "./store.js";

function bootDb(): Database.Database {
  const db = new Database(":memory:");
  const sql = readFileSync(join(process.cwd(), "../../migrations/003_automations.sql"), "utf-8");
  db.exec(sql);
  return db;
}

describe("AutomationStore", () => {
  it("creates cron automation with next_run_at", () => {
    const store = new AutomationStore(bootDb());
    const row = store.create({
      name: "Morning",
      cwd: "/tmp/proj",
      trigger: { type: "cron", cron: "0 9 * * 1-5", timezone: "UTC" },
      prompt: "Summarize today",
      enabled: true,
    });
    expect(row.id).toBeTruthy();
    expect(row.nextRunAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `pnpm --filter @forge/automation run test`
Expected: FAIL — `AutomationStore` not found

- [ ] **Step 3: 实现 `store.ts`**

核心方法：
- `create(draft)` → `AutomationRecord`
- `get(id)` / `list({ cwd? })` / `update(id, patch)` / `delete(id)`
- `insertRun` / `updateRun` / `listRuns(automationId, limit)`
- `hasRunningRun(automationId)` → boolean
- `listEnabledCron()` → `AutomationRecord[]`
- `setNextRunAt(id, iso)` / `touchLastRun(id, iso)`

行 ↔ 记录映射：`trigger_type` + `cron_expr` + `timezone` ↔ `trigger` 联合类型。

- [ ] **Step 4: 测试 PASS**

Run: `pnpm --filter @forge/automation run test`

---

### Task 5: Cron 工具

**Files:**
- Create: `packages/automation/src/cron.ts`
- Create: `packages/automation/src/cron-human.ts`
- Create: `packages/automation/src/cron.test.ts`

- [ ] **Step 1: 测试 `computeNextRun` 与 `validateCronExpr`**

```typescript
import { computeNextRun, validateCronExpr } from "./cron.js";

it("computes next weekday 9am in timezone", () => {
  const next = computeNextRun("0 9 * * 1-5", "Asia/Shanghai", new Date("2026-06-05T00:00:00Z"));
  expect(next).toBeTruthy();
  expect(validateCronExpr("not a cron")).toBe(false);
});
```

- [ ] **Step 2: 实现**

```typescript
import parser from "cron-parser";

export function validateCronExpr(expr: string): boolean {
  try {
    parser.parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

export function computeNextRun(expr: string, tz: string, from = new Date()): string {
  const it = parser.parseExpression(expr, { tz, currentDate: from });
  return it.next().toISOString();
}

export function shouldCatchUpMissedRun(
  nextRunAt: string | undefined,
  lastRunAt: string | undefined,
  now = new Date(),
): boolean {
  if (!nextRunAt) return false;
  if (now <= new Date(nextRunAt)) return false;
  if (!lastRunAt) return true;
  return new Date(lastRunAt) < new Date(nextRunAt);
}
```

- [ ] **Step 3: `cron-human.ts` 实现常见模式映射**

至少覆盖：`0 9 * * 1-5` →「每个工作日 09:00」、`0 9 * * 1` →「每周一 09:00」、`0 */6 * * *` →「每 6 小时」；其余 fallback 显示 raw cron。

---

### Task 6: Scheduler

**Files:**
- Create: `packages/automation/src/scheduler.ts`
- Create: `packages/automation/src/scheduler.test.ts`

- [ ] **Step 1: 测试 mock execute**

```typescript
it("fires execute at scheduled time", async () => {
  vi.useFakeTimers();
  const executed: string[] = [];
  const sched = new AutomationScheduler({
    listJobs: async () => [{ id: "a1", nextRunAt: new Date(Date.now() + 1000).toISOString() }],
    onFire: async (id) => { executed.push(id); },
    reschedule: async () => {},
  });
  await sched.reload();
  await vi.advanceTimersByTimeAsync(1100);
  expect(executed).toEqual(["a1"]);
  vi.useRealTimers();
});
```

- [ ] **Step 2: 实现 `AutomationScheduler`**

- `reload()` 清除所有 timer，重新注册每个 job 的 `setTimeout(delay, onFire)`
- `reschedule(id)` 取消该 id timer 并单独注册
- `stop()` daemon shutdown 时调用
- `onFire` 由 host 注入，内部不直接调 `handleRun`

- [ ] **Step 3: 测试 PASS + build**

Run: `pnpm --filter @forge/automation run test && pnpm --filter @forge/automation run build`

---

### Task 7: 模板

**Files:**
- Create: `packages/automation/src/templates.ts`

- [ ] **Step 1: 导出 `AUTOMATION_TEMPLATES`**

三个模板 id / name / description / draft（cron + prompt）与 spec 表一致。`getTemplate(id)` 返回副本。

---

## Phase 3 — Daemon 服务

### Task 8: automation-service

**Files:**
- Create: `apps/daemon/src/services/automation-service.ts`
- Modify: `apps/daemon/package.json`（加 `@forge/automation`）
- Modify: `apps/daemon/src/main.ts`

- [ ] **Step 1: 实现 handlers**

```typescript
export interface AutomationServiceDeps {
  sessions: SessionStore;
  getStore: () => AutomationStore;
  getScheduler: () => AutomationSchedulerHost;
  runAutomation: (id: string, trigger: AutomationRunTrigger) => Promise<AutomationRunRecord>;
}

export async function handleListAutomations(params: unknown, deps): Promise<ListAutomationsResult> { /* ... */ }
export async function handleCreateAutomation(params: unknown, deps): Promise<CreateAutomationResult> { /* ... */ }
// get / update / delete / run / listRuns / listTemplates
```

- [ ] **Step 2: `executeAutomation` 核心逻辑**

```typescript
export async function executeAutomation(
  automationId: string,
  trigger: AutomationRunTrigger,
  deps: ExecuteDeps,
): Promise<AutomationRunRecord> {
  const auto = deps.store.get(automationId);
  if (!auto) throw new Error("automation not found");
  if (!deps.permissionsOk(trigger)) throw new Error("automation permission denied");
  if (deps.store.hasRunningRun(automationId)) {
    return deps.store.insertRun({ automationId, status: "skipped", trigger, error: "concurrent_run", sessionId: "" });
  }
  const sessionId = auto.sessionMode === "resume" && auto.resumeSessionId
    ? auto.resumeSessionId
    : deps.sessions.createSession(auto.cwd);
  const run = deps.store.insertRun({ automationId, sessionId, status: "running", trigger });
  try {
    const result = await handleRun(
      { cwd: auto.cwd, message: auto.prompt, sessionId, autoApply: false, hookSource: "startup" },
      () => {},
      deps.runDeps,
    );
    return deps.store.finishRun(run.id, { status: "success", preview: result.finalText.slice(0, 200) });
  } catch (e) {
    return deps.store.finishRun(run.id, { status: "failed", error: String(e) });
  } finally {
    deps.store.touchLastRun(automationId);
    if (auto.trigger.type === "cron") {
      const next = computeNextRun(auto.trigger.cron, auto.trigger.timezone);
      deps.store.setNextRunAt(automationId, next);
      deps.scheduler.reschedule(automationId);
    }
  }
}
```

- [ ] **Step 3: 权限检查**

```typescript
function assertAutomationPermission(cfg: ForgeConfig, op: "create" | "run" | "delete", opts: { scheduled?: boolean; skipConfirm?: boolean }) {
  const p = cfg.permissions?.automation;
  if (!p?.enabled) throw new RpcError(403, "automation disabled in permissions");
  if (opts.scheduled) return; // 已批准的 enabled cron 静默执行
  const level = p[op];
  if (level === "deny") throw new RpcError(403, `automation ${op} denied`);
  if (level === "confirm" && !opts.skipConfirm) throw new RpcError(409, `automation ${op} requires confirmation`);
}
```

- [ ] **Step 4: `main.ts` 注册全部 `DAEMON_METHODS`**

在 `SessionStore` 构造后创建单例 `AutomationStore(db)`（复用 `sessions` 底层 db：在 `SessionStore` 暴露 `getDatabase()` 或在 daemon 直接打开同路径 db — **推荐** 给 `SessionStore` 加 `getDb(): Database` 只读访问，避免双连接）。

- [ ] **Step 5: 手动冒烟**

```bash
pnpm build && pnpm start:daemon &
# 另一终端 — 需 config permissions.automation.enabled=true
pnpm forge automation list
```

---

### Task 9: Scheduler Host + 漏跑

**Files:**
- Create: `apps/daemon/src/services/automation-scheduler-host.ts`
- Modify: `apps/daemon/src/main.ts`

- [ ] **Step 1: 启动时 `schedulerHost.start()`**

`reload()` 流程：
1. `listEnabledCron()`
2. 对每个 automation：若 `shouldCatchUpMissedRun(nextRunAt, lastRunAt)` → `executeAutomation(id, 'schedule')`（异步，不阻塞 reload）
3. 注册下次 `setTimeout`

- [ ] **Step 2: CRUD 后 `reschedule(id)`**

`create` / `update`（cron/enabled 变更）/ `delete` 调用 scheduler。

- [ ] **Step 3: shutdown hook**

在现有 `runSessionEndHooksOnShutdown` 旁加 `schedulerHost.stop()`。

---

### Task 10: parse_automation_draft

**Files:**
- Create: `packages/automation/src/parse-draft.ts`
- Modify: `apps/daemon/src/services/automation-service.ts`

- [ ] **Step 1: 实现轻量 LLM 调用**

复用 `@forge/llm` 单次 chat completion（非 ReAct）。System prompt 要求输出 JSON：

```json
{ "draft": { "name", "cron", "timezone", "prompt", "cwd" }, "questions": [] }
```

解析失败返回 `{ questions: ["请说明每天几点运行？"] }`。

- [ ] **Step 2: `handleParseAutomationDraft` 接线**

---

## Phase 4 — CLI

### Task 11: `forge automation`

**Files:**
- Create: `apps/cli/src/automation-cli.ts`
- Modify: `apps/cli/src/cli.ts`

- [ ] **Step 1: 子命令树**

```typescript
export function registerAutomationCommands(program: Command): void {
  const auto = program.command("automation").description("Manage scheduled automations");
  auto.command("list").option("--cwd <path>").action(/* DAEMON_METHODS.LIST_AUTOMATIONS */);
  auto.command("create")
    .requiredOption("--name <name>")
    .requiredOption("--prompt <prompt>")
    .requiredOption("--cwd <path>")
    .option("--cron <expr>")
    .option("--timezone <tz>")
    .option("--yes")
    .action(/* CREATE_AUTOMATION */);
  auto.command("run <id>").option("--yes").action(/* RUN_AUTOMATION */);
  auto.command("enable <id>").action(/* UPDATE enabled:true */);
  auto.command("disable <id>").action(/* UPDATE enabled:false */);
  auto.command("delete <id>").option("--yes").action(/* DELETE */);
  auto.command("runs <id>").option("--limit <n>").action(/* LIST_AUTOMATION_RUNS */);
  auto.command("init <templateId>").option("--cwd <path>").option("--yes")
    .action(/* template draft → create */);
}
```

- [ ] **Step 2: 表格输出 `list` / `runs`**

- [ ] **Step 3: 验证**

```bash
pnpm forge automation init daily-brief --cwd $(pwd) --yes
pnpm forge automation list
pnpm forge automation run <id> --yes
pnpm forge automation runs <id>
```

---

## Phase 5 — Desktop UI

### Task 12: IPC 桥

**Files:**
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.ts`

- [ ] **Step 1: main 注册 IPC（模式同 `forge:list-mcp`）**

```typescript
ipcMain.handle("forge:list-automations", async (_e, payload) =>
  requestDaemonMethod(cfg, DAEMON_METHODS.LIST_AUTOMATIONS, payload));
// get / create / update / delete / run / listRuns / parseDraft / listTemplates
```

- [ ] **Step 2: preload 暴露**

```typescript
listAutomations: (payload?: { cwd?: string }) => ipcRenderer.invoke("forge:list-automations", payload ?? {}),
createAutomation: (payload) => ipcRenderer.invoke("forge:create-automation", payload),
// ...
```

---

### Task 13: Automations 页面

**Files:**
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/src/renderer/app.js`
- Modify: `apps/desktop/src/renderer/styles.css`

- [ ] **Step 1: `index.html` 侧栏按钮**

```html
<button id="navAutomationsBtn" class="side-nav-item">
  <span class="nav-icon">⏱</span>
  <span>Automations</span>
</button>
```

`resourceView` 上方可选 `automationsToolbar`（「通过对话创建」按钮）。

- [ ] **Step 2: `setNav` 扩展**

`activeNav === 'automations'` 时隐藏 composer，显示 `resourceView`，标题「Automations」。

- [ ] **Step 3: `renderAutomationsView`**

状态机：
- `loading` → 骨架
- `empty` → 空状态 + 三 pill（调 `listAutomationTemplates()`，点击设 `state.automationCreateDraft` 并 `startNewChat(prefill)`）
- `list` → 表格：名称、`formatNextRun(a)`、最近 run 状态 badge、toggle enabled

顶栏提示（daemon 未连接时）：「需保持 Daemon 运行，定时任务才会触发。」

- [ ] **Step 4: 行操作**

- Toggle → `updateAutomation({ enabled })`
- 「立即运行」→ `runAutomation` → toast
- 「删除」→ `confirm()` → `deleteAutomation`
- 点击行 → 展开详情（prompt、cron 人类可读、runs 表，session 链到项目会话列表）

- [ ] **Step 5: CSS**

`.automation-pill`、`.automation-row`、`.automation-status-badge`（success/failed/running/skipped 颜色）

---

### Task 14: 编辑器模态 + Create via chat

**Files:**
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/src/renderer/app.js`

- [ ] **Step 1: 模态 HTML**

字段：name、description、cron（可空）、timezone、prompt（textarea）、cwd（只读展示当前项目）、enabled checkbox、「保存」「取消」。

- [ ] **Step 2: Create via chat 流**

1. `state.pendingAutomationParse = true` 当从 Automations 页跳转 chat
2. 用户发送消息后，若 flag 为 true → 调 `parseAutomationDraft({ message, cwd })`
3. 成功 → `openAutomationEditor(draft)`；有 `questions` → 在 chat 显示追问
4. 保存 → `createAutomation({ draft })` → `setNav('automations')` → 刷新列表

- [ ] **Step 3: 模板 pill 快捷路径**

直接 `openAutomationEditor(template.draft)` 跳过 NL 解析。

- [ ] **Step 4: Desktop 手测**

按 spec 手测清单逐项勾选。

---

## Phase 6 — 文档与收尾

### Task 15: 用户文档

**Files:**
- Create: `docs/automations-guide.md`

- [ ] **Step 1: 文档内容**

- 启用 `permissions.automation.enabled`
- CLI 示例
- Desktop 创建流程
- Daemon 常驻说明
- 模板说明（日历/邮件为占位）

---

### Task 16: 全量验证

- [ ] **Step 1: 单元测试**

Run: `pnpm --filter @forge/automation run test`
Expected: 全部 PASS

- [ ] **Step 2: 相关包构建**

Run: `pnpm build`
Expected: 无错误

- [ ] **Step 3: smoke**

Run: `pnpm smoke`（若 automation 未纳入 smoke，至少跑 CLI 创建/列表/run 脚本）

- [ ] **Step 4: 更新 spec 手测清单为已完成项（可选 PR 描述）**

---

## Spec 覆盖自检

| Spec 章节 | 计划任务 |
|-----------|----------|
| 数据模型 | Task 1–2, 4 |
| 调度器 / 防重入 / 漏跑 | Task 5–6, 9 |
| 执行路径 handleRun | Task 8 |
| 权限 | Task 8 |
| RPC 全部 methods | Task 2, 8 |
| 模板 | Task 7 |
| Create via chat | Task 10, 14 |
| Desktop UI | Task 12–14 |
| CLI | Task 11 |
| 错误处理 | Task 4, 8（validate cron, cwd） |
| 测试 | Task 4–6, 16 |
| docs | Task 15 |

无遗漏。

---

## 执行选项

**Plan complete and saved to `docs/superpowers/plans/2026-06-05-automation-platform.md`.**

**1. Subagent-Driven（推荐）** — 每个 Task 派生子 agent，任务间你做 review，迭代快

**2. Inline Execution** — 本会话按 Phase 顺序直接实现，每 Phase 结束设检查点

你想用哪种方式开始实现？
