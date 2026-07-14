# Forge Automations 平台设计（方案 B）

**日期:** 2026-06-05  
**范围:** 通用自动化平台 — UI、模板、Create via chat、Cron 调度  
**状态:** 已批准（2026-06-05）  
**非目标（本阶段）:** Morning Brief 端到端集成（日历/邮件 MCP）、Webhook/Git/Slack 事件触发、Cloud 执行

## 目标

在 forge-agent 上实现对标 Cursor Automations 的**通用自动化平台**：

- 用户可在 Desktop 创建、管理、启用/禁用定时自动化
- 提供模板（Daily brief / Weekly review / Project monitor）快速起步
- 支持「Create via chat」：自然语言描述 → 结构化草稿 → 编辑器确认
- Daemon 内置调度器，到点自动调用现有 `handleRun`
- CLI 提供等价能力，便于脚本与调试

**成功标准：** 用户无需写 crontab，即可创建「每个工作日 9:00 在项目 X 跑某 prompt」的自动化，并在 Desktop 查看运行历史与下次执行时间。

## 与方案 C 的边界

| 本设计（B） | 后续（C） |
|-------------|-----------|
| Automations 列表/详情/模板 UI | 日历、邮件 MCP 接入 |
| Cron + 手动触发 | 漏跑补执行策略细化 |
| 通用 prompt + cwd + model | Morning Brief 专用 prompt 调优 |
| 结果写入新 session | 系统通知投递 |

模板可引用「读日历、读邮件」等**占位说明**，但 v1 不保证这些集成可用。

## 现状与复用

```text
Desktop (side-nav: Chat/Plugins/MCP/Skills/Hooks)
  → IPC → main.ts → JSON-RPC
Daemon
  → handleRun (run-service.ts)     ← 执行核心
  → SessionStore (SQLite)            ← 扩展新表
  → permissions.automation           ← 已预留，默认 disabled
```

复用点：

- **执行：** `handleRun`，`autoApply: false`，每次运行创建新 `sessionId`
- **存储：** `migrations/` + `SessionStore` 同库（`data.db`）
- **协议：** 沿用 `DAEMON_METHODS` + IPC 桥模式（参考 `LIST_MCP`）
- **Desktop 导航：** 参考 `navHooksBtn` / `resourceView` 模式新增 Automations 页

## 架构

```text
┌─────────────────────────────────────────────────────────┐
│  Desktop UI                                              │
│  · Automations 列表 / 空状态 / 模板 pill                 │
│  · 详情：触发器、prompt、运行历史                         │
│  · Create via chat → composer 预填 + NL 解析草稿          │
└───────────────────────┬─────────────────────────────────┘
                        │ IPC (forge:list-automations, …)
┌───────────────────────▼─────────────────────────────────┐
│  apps/daemon                                             │
│  · automation-service (CRUD + run + listRuns)            │
│  · AutomationScheduler (cron 注册、触发、防重入)          │
│  · handleRun (已有)                                      │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  packages/automation (新)                                │
│  · 类型、模板、cron 解析、Store                          │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  SQLite: automations, automation_runs                    │
└─────────────────────────────────────────────────────────┘
```

## 数据模型

### `automations` 表

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | TEXT PK | UUID |
| `name` | TEXT | 显示名 |
| `description` | TEXT | 可选 |
| `enabled` | INTEGER | 0/1 |
| `cwd` | TEXT | 执行工作目录（绝对路径） |
| `trigger_type` | TEXT | `cron` \| `manual`（v1 仅这两种） |
| `cron_expr` | TEXT | 标准 5 段 cron；`manual` 时为 NULL |
| `timezone` | TEXT | IANA，默认 `Intl` 或 config |
| `prompt` | TEXT | Agent 指令 |
| `model` | TEXT | 可选覆盖；空则用 config |
| `memory_enabled` | INTEGER | 0/1，v1 默认 0 |
| `session_mode` | TEXT | `new`（默认）\| `resume` |
| `resume_session_id` | TEXT | `session_mode=resume` 时使用 |
| `created_at` | TEXT | ISO |
| `updated_at` | TEXT | ISO |
| `last_run_at` | TEXT | 可选 |
| `next_run_at` | TEXT | 调度器计算写入，便于 UI 展示 |

### `automation_runs` 表

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | TEXT PK | UUID |
| `automation_id` | TEXT FK | |
| `session_id` | TEXT | 本次运行 session |
| `status` | TEXT | `pending` \| `running` \| `success` \| `failed` \| `skipped` |
| `trigger` | TEXT | `schedule` \| `manual` \| `cli` |
| `started_at` | TEXT | |
| `finished_at` | TEXT | 可选 |
| `error` | TEXT | 可选 |
| `preview` | TEXT | 结果摘要前 200 字 |

### TypeScript 类型（`@forge/protocol`）

```typescript
export type AutomationTriggerType = "cron" | "manual";

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
  status: "pending" | "running" | "success" | "failed" | "skipped";
  trigger: "schedule" | "manual" | "cli";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  preview?: string;
}
```

## 调度器（Daemon 内置）

### 行为

1. Daemon 启动时 `AutomationScheduler.start()`：
   - 加载 `enabled = 1 AND trigger_type = 'cron'` 的记录
   - 用 `cron-parser` 计算 `next_run_at`，注册 `setTimeout` 链
2. 到点触发 `executeAutomation(id, { trigger: 'schedule' })`
3. 执行完毕重新计算并注册下次
4. CRUD 变更（enable/disable/update cron）时 `reschedule(id)` 或全量 `reload()`

### 防重入

- 同一 `automation_id` 若存在 `status = 'running'` 的 run → 本次 **skip**，写 `automation_runs.status = skipped`，原因 `concurrent_run`
- 不排队（v1 YAGNI）

### 漏跑

- Daemon 重启后：对每个 enabled cron，若 `now > next_run_at` 且距上次 `last_run_at` 超过一个周期 → **补跑一次**（`missedRunPolicy: run_once`）
- 仅补一次，避免堆积

### 时区

- 存储 IANA timezone；解析 cron 时用 `cron-parser` 的 `tz` 选项
- 默认：`config.automation?.timezone ?? 系统本地`

### Daemon 未运行

- 平台不保证触发；Desktop 空状态/列表顶部提示「需保持 Daemon 运行」
- 可选后续：`launchd` plist 指南（非 v1 代码）

## 执行路径

```typescript
async function executeAutomation(automationId, opts): Promise<AutomationRunRecord> {
  // 1. permissions.automation.enabled + run level
  // 2. insert automation_runs (running)
  // 3. sessionId = sessionMode === 'resume' ? resumeSessionId : createSession(cwd)
  // 4. handleRun({ cwd, message: prompt, sessionId, autoApply: false, hookSource: 'startup' })
  // 5. update run → success/failed, automation.last_run_at, recompute next_run_at
}
```

- **不**走 Desktop 事件流（无 `clientRunId`）；结果通过 session 列表可见
- 失败：`error` 存 run 记录；可选 v2 接 `notifications`

## 权限

启用 `permissions.automation`（用户需在 config 显式 `enabled: true`）：

| 操作 | 默认 level | 说明 |
|------|------------|------|
| `create` | confirm | Desktop 创建前弹确认；CLI `--yes` 跳过 |
| `run` | confirm | 手动「立即运行」；**定时触发**在 automation 已 enabled 且用户创建时已确认后视为 `allow` |
| `delete` | confirm | 删除前确认 |

定时静默执行规则：创建/启用 automation 时一次性确认「允许按此计划自动运行」。

## 协议与 RPC

### 新增 `DAEMON_METHODS`

```typescript
LIST_AUTOMATIONS: "list_automations",
GET_AUTOMATION: "get_automation",
CREATE_AUTOMATION: "create_automation",
UPDATE_AUTOMATION: "update_automation",
DELETE_AUTOMATION: "delete_automation",
RUN_AUTOMATION: "run_automation",
LIST_AUTOMATION_RUNS: "list_automation_runs",
PARSE_AUTOMATION_DRAFT: "parse_automation_draft",  // NL → 草稿
LIST_AUTOMATION_TEMPLATES: "list_automation_templates",
```

### 请求/响应（摘要）

- `list_automations`: `{ cwd?: string }` → 按 cwd 过滤或全局
- `create_automation`: `AutomationDraft` → `AutomationRecord`
- `parse_automation_draft`: `{ message: string, cwd?: string }` → `AutomationDraft`（LLM 结构化，不执行）
- `run_automation`: `{ id, trigger?: 'manual' }` → `AutomationRunRecord`
- `list_automation_runs`: `{ automationId, limit? }` → runs[]

`FORGE_DAEMON_BUILD` bump 以触发 Desktop 重启 daemon。

## 模板（内置 JSON）

| id | 名称 | 默认 cron | prompt 要点 |
|----|------|-----------|-------------|
| `daily-brief` | Daily brief | `0 9 * * 1-5` | 今日关注项摘要（日历/邮件占位） |
| `weekly-review` | Weekly review | `0 9 * * 1` | 上周 commit、未关闭 issue、风险 |
| `project-monitor` | Project monitor | `0 */6 * * *` | CI、依赖、TODO 增长 |

模板 API 返回可编辑草稿，**不**自动 persist。

## Create via chat 流程

1. Automations 空状态点击模板 / 「Create via chat」
2. 跳转 Chat，`composer` 预填示例 prompt 或用户输入
3. 用户发送后调用 `parse_automation_draft`（轻量 LLM call，非完整 ReAct）
4. Desktop 打开 **Automation 编辑器**（模态或侧栏）展示：名称、cron、时区、prompt、cwd
5. 用户确认 → `create_automation` → 列表出现新项

NL 解析输出 schema：

```typescript
interface AutomationDraft {
  name: string;
  description?: string;
  cron?: string;           // 缺省则 manual
  timezone?: string;
  prompt: string;
  cwd?: string;
}
```

解析失败：返回 `questions[]` 让用户补充（如「几点？」「哪个项目？」）。

## Desktop UI

### 导航

- 侧栏新增 **Automations**（`navAutomationsBtn`），图标建议 ⏱
- `setNav('automations')` 切换 `resourceView`

### 页面状态

**空状态（无 automation）：**

- 标题：Automations
- 副标题：按计划运行对话任务
- 中央：创建第一个自动化
- 底部三个 pill：Daily brief / Weekly review / Project monitor → 填模板草稿并进入创建流

**列表状态：**

- 表头：名称 | 下次运行 | 上次状态 | 开关
- 操作：编辑、立即运行、删除
- 顶栏：「通过对话创建」、「查看模板」

**详情（点击行展开或二级页）：**

- 触发器、cron 人类可读描述（「每个工作日 09:00」）
- Prompt 预览
- 运行历史表（时间、状态、跳转 session）

### IPC（`preload.ts` / `main.ts`）

与现有 `list-mcp` 模式一致：`forge:list-automations` 等，内部 `requestDaemonMethod`。

### 样式

复用 `resourceView`、`.side-nav-item`、pill 按钮；不引入新框架。

## CLI

```bash
forge automation list [--cwd <path>]
forge automation create --name "..." --cron "0 9 * * 1-5" --prompt "..." --cwd <path> [--yes]
forge automation run <id>
forge automation enable|disable <id>
forge automation delete <id> [--yes]
forge automation runs <id> [--limit 20]
```

`forge automation init <template-id>` 从模板创建。

## 包结构

```
packages/automation/
  src/
    types.ts          # 与 protocol 对齐或 re-export
    store.ts          # SQLite CRUD
    scheduler.ts      # cron 计算 + timer 管理（纯逻辑，daemon 注入 execute fn）
    templates.ts      # 三模板
    parse-draft.ts    # LLM 结构化解析
    cron-human.ts     # 「每周一 9:00」展示文案
  package.json

apps/daemon/src/services/
  automation-service.ts
  automation-scheduler.ts   # 包装 scheduler + handleRun

migrations/003_automations.sql
```

## 错误处理

| 场景 | 处理 |
|------|------|
| cron 表达式非法 | `create/update` 返回 400，UI 标红 |
| cwd 不存在 | 拒绝创建 |
| 执行中 LLM 失败 | run.status=failed，error .message |
| permissions 拒绝 | RPC error，Desktop toast |
| 并发 skip | run.status=skipped，列表可筛 |

## 测试

- `packages/automation`: store CRUD、cron next 计算、漏跑逻辑单元测试
- `scheduler`: mock execute，验证不重复注册
- CLI smoke: create → run → list runs
- 不强制 Desktop E2E（手测清单见下）

## 实施顺序

1. **协议 + migration + store** — 数据层可测
2. **automation-service + scheduler + daemon 注册** — CLI 可 create/run
3. **CLI 子命令** — 无 UI 可验证端到端
4. **Desktop Automations 页** — 列表/空状态/模板
5. **编辑器模态 + parse_automation_draft** — Create via chat
6. **权限接线 + 文档** — config 示例、`docs/automations-guide.md`

## 手测清单

- [ ] 从模板创建 Daily brief，cron 显示正确
- [ ] 禁用后不再触发；启用后恢复
- [ ] 手动「立即运行」产生新 session，历史可查
- [ ] 修改 cron 后 `next_run_at` 更新
- [ ] Daemon 重启后 scheduler 恢复，漏跑补一次
- [ ] Create via chat：「每周一早上检查 README」→ 草稿合理
- [ ] `permissions.automation.enabled: false` 时创建被拒绝

## 后续扩展（不在本 spec）

- Webhook / Git push 触发
- `delivery: notification | file | webhook`
- MCP 工具多选（对标 Cursor actions）
- 同一 automation resume session 模式 UI
- Cloud remote executor

## 备选方案（已否决）

| 方案 | 否决原因 |
|------|----------|
| 系统 crontab 为主 | 不符合 B「平台 + UI」目标 |
| 独立 scheduler 进程 | 增加运维，daemon 已常驻 |
| automations 存 JSON 文件 | 与 session 同库不一致，难查运行历史 |

---

**请审阅本 spec。** 确认后进入 `writing-plans` 生成实现计划。
