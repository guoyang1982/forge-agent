# Extension Hub（Skill / Plugin 跨 Agent 分发与管理）设计方案

> 状态：草案 v1 · 2026-07-08
> 目标：在 forge-agent 里统一管理 Skill 与 Plugin，实现「在 Forge 里集中查看 → 一键安装到不同 agent（Forge / Cursor / Claude Code / Codex）→ 可单独卸载 → 可同步」。
> 核心口号：**内容只存一份（SSOT），安装 = 部署到目标 agent，卸载 = 从目标移除，同步 = hash/版本对比后 push/pull/reconcile。**

---

## 0. 结论清单

### A. 要做

| 事项 | 为什么 |
|---|---|
| `packages/extension-hub`：统一 store + registry + hash | 现在逻辑散在 skill-registry / marketplace / app-service / runtime，缺集中态 |
| 四个 Agent Adapter（Forge / Cursor / Claude / Codex） | 各 agent 路径与清单格式不同，需抽象 |
| deploy / undeploy / remove / sync RPC | 现在只有 install + disable，缺卸载与同步 |
| Desktop「Agent 部署矩阵」视图 | 让用户在 Forge 里看到每个扩展在各 agent 的状态 |
| 反向发现（import from agent） | 解决「Cursor/Claude 已装、Hub 不知道」 |

### B. 关键结论（已实测确认）

| 结论 | 证据 |
|---|---|
| **插件已是「跨 agent 多清单包」标准** | 同一仓库同时带 `.cursor-plugin/`、`.claude-plugin/`、`.codex/`、`.opencode/`、`gemini-extension.json`，内容目录（`skills/ agents/ commands/ hooks/ .mcp.json`）共享 |
| **Skill 是 Plugin 的子集** | 插件清单里 `skills` 字段指向 `skills/` 目录；纯 skill = 只含 `skills/` 的最小包 |
| **Cursor 有完整插件系统** | Settings → Plugins（迁往 Customize）；`~/.cursor/plugins/cache/<marketplace>/<name>/<git-sha>/` |
| **Cursor 侧载路径为空、可用** | `~/.cursor/plugins/local/` 实测为空，官方文档支持侧载，重启 / Reload Window 生效 |
| **Cursor 启用状态在 SQLite、用数字 marketplace ID** | `state.vscdb` → `cursor.plugins.installedIds.<team>|<scope>` = `[{"id":"684","sources":["user"]}]` |

### C. 暂不做

| 事项 | 原因 |
|---|---|
| 往 Cursor 的 SQLite `installedIds` 写自制插件 ID | 需要分配 marketplace ID，属改内部状态，不稳定 → 改走 `plugins/local/` 侧载 |
| 自建团队 marketplace 服务 | Phase 4 再议；先用文件系统 + git 源 |
| 外部 runtime 的 hooks 深度桥接 | hooks 运行期语义各 agent 差异大，先只做文件分发 |
| Skill / Plugin 两套系统 | 合并为一个 Extension Hub，用 tab 区分视图 |

---

## 1. 现状与缺口

### 1.1 Forge 已有能力（仅对 Forge 原生 runtime 生效）

| 能力 | 落点 |
|---|---|
| Skill 发现 / 匹配 / 注入 | `packages/skill-registry`、`apps/daemon/src/runtime.ts` |
| Plugin 发现 / capabilities | `packages/plugin-registry`（`discover.ts` / `contributions.ts`） |
| 安装（git clone + copy） | `packages/marketplace/src/import.ts` |
| 列表 / 启用禁用 | `list_skills` / `list_plugins` / `set_skill_enabled` / `set_plugin_enabled`（`app-service.ts` / `marketplace-service.ts`） |
| MCP 桥接到 Cursor ACP | `apps/daemon/src/services/acp-mcp-bridge.ts` |

### 1.2 缺口

| 缺口 | 现状 |
|---|---|
| 无卸载 API | 只能 disable，不能 remove |
| 无跨 agent 分发 | Cursor/Claude/Codex 各自维护目录，Forge 不管 |
| 无统一 inventory | Forge 看不到别的 agent 装了什么 |
| 无同步 / 版本 / drift 检测 | 无 `skills.sync` 等价物 |
| 外部 runtime 绕过 skill 管线 | `run-service.ts` 在 `provider !== "forge"` 时短路 |

---

## 2. 各 Agent 事实对照（实测）

### 2.1 存储路径

| Agent | 用户级 | 项目级 | 插件包布局 |
|---|---|---|---|
| **Forge** | `~/.forge-agent/plugins/`、`~/.forge-agent/skills/` | `.forge/plugins/`（skill 项目级未实现） | `plugin.json`（内联 capabilities，路径数组） |
| **Cursor** | `~/.cursor/plugins/`、`~/.cursor/skills/` | `.cursor/`（项目级仅部分文档化） | `cache/<marketplace>/<name>/<git-sha>/`；侧载 `plugins/local/<id>/` |
| **Claude** | `~/.claude/plugins/`、`~/.claude/skills/` | `.claude/` | `plugins/marketplaces/<mp>/plugins/<name>/`；`known_marketplaces.json` |
| **Codex** | `~/.codex/plugins/`、`~/.codex/skills/` | 待确认 | `plugins/cache/<mp>/<name>/<ver-or-sha>/` |

### 2.2 清单格式对照

Cursor `.cursor-plugin/plugin.json`（只有 `name` 必填，字段可省略走目录自动发现）：

```json
{
  "name": "superpowers",
  "displayName": "Superpowers",
  "version": "5.0.7",
  "skills": "./skills/",
  "agents": "./agents/",
  "commands": "./commands/",
  "hooks": "./hooks/hooks-cursor.json"
}
```

Forge `plugin.json`（`capabilities` 内联、路径为数组）：

```json
{
  "id": "forge-demo",
  "name": "Forge Demo Plugin",
  "version": "0.1.0",
  "capabilities": {
    "skills": ["skills/demo-review.md"],
    "mcpServers": [{ "name": "demo", "command": "node", "args": ["mcp/demo-server.js"] }],
    "commands": [{ "name": "demo:review", "description": "..." }],
    "workflows": ["workflows/demo-review.json"]
  }
}
```

字段名不同、语义一致：都是 skills / MCP / commands / hooks 的组合。**Hub 以「多清单包」为标准存储格式，为各 agent 生成/保留对应清单。**

### 2.3 Cursor 启用状态（决定性约束）

SQLite `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`：

```
key:   cursor.plugins.installedIds.no-team|no-workspace          # 用户全局
key:   cursor.plugins.installedIds.no-team|file:///path/to/proj  # 项目级
value: [{"id":"657","sources":["user"]},{"id":"684","sources":["user"]}]
```

- 按 **team + workspace** 分开记录 → 证实支持项目级 + 全局级
- 用 **数字 marketplace ID** 引用插件，不是名字/路径
- 无文档化的 install/uninstall CLI，官方只有 UI

**推论**：Forge 无法给自制插件分配 marketplace ID，因此**不走 marketplace，改走 `plugins/local/` 侧载**（无需 ID、卸载=删目录）。

### 2.4 Codex 启用状态与本地 marketplace（实测确认）

Codex 用 **`~/.codex/config.toml`** 声明式管理插件与市场（TOML，易程序化改写）：

```toml
[marketplaces.openai-bundled]
source_type = "local"                       # ← 原生支持本地路径市场
source = "/Users/alice/.codex/.tmp/bundled-marketplaces/openai-bundled"

[plugins."superpowers@openai-curated"]      # <plugin>@<marketplace>
enabled = true
```

- **本地 marketplace 就是一个目录**：`<mp>/plugins/<name>/.codex-plugin/plugin.json`，**无需索引文件**（实测市场根目录无 json/toml 索引）。
- 插件清单 `.codex-plugin/plugin.json` 与 Cursor/Claude 同构（`name / version / skills:"./skills/"` + 更丰富的 `interface` 块）。
- 启用状态在 config.toml 的 `[plugins."x@mp"] enabled=true`；**无项目级插件段**（`[projects."/path"]` 只有 `trust_level`）→ Codex 插件视为 user 全局。

**推论**：Forge 对 Codex 走**注册本地 marketplace** 最干净——把 Hub 的 codex 视图目录注册为 `[marketplaces.forge-hub] source_type="local"`，再按需 `[plugins."<id>@forge-hub"] enabled=true`。

### 2.5 Claude 启用状态与 marketplace（实测确认）

Claude 用 **`~/.claude/plugins/known_marketplaces.json`** 注册市场（当前仅见 github 源）：

```json
{ "claude-plugins-official": {
    "source": { "source": "github", "repo": "anthropics/claude-plugins-official" },
    "installLocation": "~/.claude/plugins/marketplaces/claude-plugins-official" } }
```

- 插件落在 `plugins/marketplaces/<mp>/plugins/<name>/`，清单 `.claude-plugin/plugin.json`。
- 全局配置 `~/.claude.json`：顶层 `enabledPlugins` 实测为 `null`，另有 `pluginUsage`（键形如 `anthropic-skills@inline`、`polly@inline`，暗示存在 inline/local 市场概念）。启用态的确切落点未完全确认（见 §15）。
- 存在 `officialMarketplaceAutoInstalled: true` 等自动安装标志。

**推论**：Claude 对接优先尝试 **local/inline marketplace**（若支持非 github 源）；否则直接写 `plugins/` 目录 + 清单。本地源能力待 Phase 4 实测。

### 2.6 四 Agent 部署方式归纳（实测后修正）

| Agent | 官方机制 | Forge 落地方式 | 状态存储 | 需 ID？ |
|---|---|---|---|---|
| **Forge** | 目录发现 | symlink 到 `plugins/` | 目录即状态 | 否 |
| **Cursor** | 4 类来源（claude/userLocal/userSettings/marketplace） | **`plugins/local/` 侧载**（§14 实测） | 目录（local 不进 SQLite） | 否 |
| **Codex** | config.toml 声明式 + 本地市场 | **注册本地 marketplace** + `[plugins] enabled` | `config.toml` | 否 |
| **Claude** | `known_marketplaces.json` + 市场目录 | local/inline 市场 或 直写 `plugins/` | `known_marketplaces.json` / `.claude.json`（待确认） | 否 |

**统一模式**：四家都支持「本地来源」（Cursor 侧载 / Codex 本地市场 / Claude 目录 / Forge 目录），**Forge 全程无需 marketplace ID**。

---

## 3. 目标架构

```
                     Forge Extension Hub
        ~/.forge-agent/hub/
        ├── store/
        │   ├── skills/<id>/               ← 纯 skill 包（最小）
        │   └── plugins/<id>/              ← 完整插件包（SSOT）
        │       ├── plugin.json            (Forge 清单)
        │       ├── .cursor-plugin/plugin.json   ┐ 按需生成/保留
        │       ├── .claude-plugin/plugin.json   │
        │       ├── .codex/                       ┘
        │       ├── skills/ agents/ commands/ hooks/  ← 共享内容
        │       └── .mcp.json
        └── registry.json                  ← 统一注册表（含各 agent 部署状态）
                     │
        ┌────────────┼───────────────┬───────────────┐
        ▼            ▼               ▼               ▼
   Forge Adapter  Cursor Adapter  Codex Adapter        Claude Adapter
   symlink→       local 侧载→      本地市场(config.toml)  local市场/直写→
   plugins/       plugins/local/  plugins/cache+toml    plugins/
```

**统一实体：Extension Package。** 纯 skill 是只含 `skills/` 的包；插件是全能力包。同一份 `registry.json`、同一套 deploy/undeploy/sync；UI 用 tab 区分「Skills / Plugins」。

---

## 4. registry.json Schema

```jsonc
{
  "version": 1,
  "extensions": {
    "superpowers": {
      "kind": "plugin",                    // "skill" | "plugin"
      "id": "superpowers",
      "name": "Superpowers",
      "version": "5.0.7",
      "contentHash": "sha256:...",         // store 内容指纹（SSOT）
      "source": {
        "type": "github",                  // github | catalog | local | agent-import
        "repo": "obra/superpowers",
        "ref": "main",
        "subdir": ""
      },
      "capabilities": {                    // 从包解析得到，用于 UI 与联动
        "skills": ["using-superpowers", "brainstorming", "tdd"],
        "mcpServers": [],
        "hooks": ["hooks/hooks.json"],
        "commands": ["commands/help.md"],
        "agents": ["agents/..."]
      },
      "installedAt": "2026-07-08T06:00:00Z",
      "updatedAt": "2026-07-08T06:00:00Z",
      "deployments": {
        "forge": {
          "scope": "user",                 // user | project
          "path": "~/.forge-agent/plugins/superpowers",
          "mode": "symlink",               // symlink | copy | sideload | native
          "manifestVariant": "plugin.json",
          "deployedHash": "sha256:...",
          "status": "synced",              // synced | drift | missing | error
          "deployedAt": "2026-07-08T06:00:00Z"
        },
        "cursor": {
          "scope": "user",
          "path": "~/.cursor/plugins/local/superpowers",
          "mode": "sideload",
          "manifestVariant": ".cursor-plugin/plugin.json",
          "deployedHash": "sha256:...",
          "status": "synced",
          "note": "requires Cursor reload window to take effect"
        },
        "claude-code": {
          "scope": "user",
          "path": "~/.claude/plugins/superpowers",
          "mode": "copy",
          "manifestVariant": ".claude-plugin/plugin.json",
          "deployedHash": "sha256:...",
          "status": "synced"
        },
        "codex": {
          "scope": "user",
          "path": "~/.codex/plugins/superpowers",
          "mode": "copy",
          "status": "missing"
        }
      }
    }
  }
}
```

字段要点：
- `contentHash` 是 SSOT 指纹；`deployments.*.deployedHash` 是各 agent 落地时的指纹。二者不等 → `status: "drift"`。
- `mode`：`symlink`（Forge 首选）/ `sideload`（Cursor `plugins/local/`）/ `copy`（不跟软链或需隔离时）/ `native`（未来走 agent 原生 install 命令）。
- `manifestVariant`：该 agent 使用的清单文件路径。
- `capabilities`：解析结果，供 UI 显示与「插件安装联动内部 skills」。

---

## 5. Agent Adapter 接口

`packages/extension-hub/src/adapters/types.ts`：

```typescript
export type AgentId = "forge" | "cursor" | "claude-code" | "codex";
export type Scope = "user" | "project";
export type DeployMode = "symlink" | "copy" | "sideload" | "native";

export interface DeployInput {
  extId: string;
  kind: "skill" | "plugin";
  sourcePath: string;      // hub/store/... 绝对路径
  scope: Scope;
  cwd?: string;            // project scope 时的工作区
}

export interface DeployResult {
  path: string;
  mode: DeployMode;
  manifestVariant?: string;
  deployedHash: string;
  needsAgentReload?: boolean;
}

export interface DiscoveredExt {
  id: string;
  kind: "skill" | "plugin";
  path: string;
  version?: string;
  contentHash: string;
}

export interface SkillAgentAdapter {
  id: AgentId;
  label: string;
  probe(): Promise<{ available: boolean; version?: string }>;
  resolveTargetPath(extId: string, kind: "skill" | "plugin", scope: Scope, cwd?: string): string;
  discoverInstalled(scope: Scope, cwd?: string): Promise<DiscoveredExt[]>;
  deploy(input: DeployInput): Promise<DeployResult>;
  undeploy(input: { extId: string; kind: "skill" | "plugin"; scope: Scope; cwd?: string }): Promise<void>;
}
```

### 5.1 路径映射表

```typescript
const AGENT_PATHS: Record<AgentId, { skills: { user: string; project: string }; plugins: { user: string; project: string } }> = {
  forge: {
    skills:  { user: "~/.forge-agent/skills",  project: ".forge/skills" },
    plugins: { user: "~/.forge-agent/plugins", project: ".forge/plugins" },
  },
  cursor: {
    skills:  { user: "~/.cursor/skills",         project: ".cursor/skills" },
    plugins: { user: "~/.cursor/plugins/local",  project: ".cursor/plugins/local" }, // 侧载
  },
  "claude-code": {
    skills:  { user: "~/.claude/skills",  project: ".claude/skills" },
    plugins: { user: "~/.claude/plugins", project: ".claude/plugins" },
  },
  codex: {
    skills:  { user: "~/.codex/skills",  project: ".codex/skills" },
    plugins: { user: "~/.codex/plugins", project: ".codex/plugins" },
  },
};
```

### 5.2 各 Adapter 行为

| Adapter | deploy | undeploy | discoverInstalled | 备注 |
|---|---|---|---|---|
| **Forge** | symlink 到 `plugins/` / `skills/` | 删软链 | `discoverPlugins()` / `loadSkills()` | 复用 `plugin-registry` / `skill-registry` |
| **Cursor** | 写 `plugins/local/<id>/` + `.cursor-plugin/plugin.json`（skill 走 `skills/<id>/`） | 删目录（自动重扫，无需强制 reload） | 读 `plugins/cache/*/*/<sha>/` + `skills/` | **不碰 SQLite**；插件走侧载（§14 实测） |
| **Codex** | 注册本地市场：`config.toml [marketplaces.forge-hub] source_type="local"` + 写 `<mp>/plugins/<id>/.codex-plugin/plugin.json`，`[plugins."<id>@forge-hub"] enabled=true` | 删市场目录条目 + 置 `enabled=false`/移除段 | 读 `plugins/cache/<mp>/*` + `config.toml` | 用户全局（无项目段） |
| **Claude** | local/inline 市场 或 写 `plugins/<id>/` + `.claude-plugin/plugin.json` | 删目录（+ 更新市场/启用态） | 读 `plugins/marketplaces/*` + `known_marketplaces.json` + `skills/` | 启用态落点待确认（§15） |

### 5.3 清单转换（Manifest Codec）

Hub 内部以 Forge `plugin.json` 为规范模型，向各 agent 生成对应清单：

```
Forge capabilities.skills:  ["skills/x.md"]     →  Cursor  "skills": "./skills/"
Forge capabilities.mcpServers[]                 →  Cursor  "mcpServers": "./.mcp.json"（生成 .mcp.json）
Forge capabilities.commands[]                   →  Cursor/Claude  "commands": "./commands/"
Forge hooks（若有）                              →  hooks-cursor.json / hooks.json（variant 分文件）
```

反向（agent → Hub）同理：读 `.cursor-plugin/plugin.json` 的目录指针，归一成 Forge capabilities。

---

## 6. RPC / 协议扩展

在 `packages/protocol/src/index.ts` 的 `DAEMON_METHODS` 增加：

```typescript
HUB_LIST:          "hub.list",            // 统一视图：store + 各 agent 部署状态
HUB_INSTALL:       "hub.install",         // 入 store（+可选 deploy 到多个 agent）
HUB_DEPLOY:        "hub.deploy",          // 已在 store 的扩展 → 部署到指定 agent
HUB_UNDEPLOY:      "hub.undeploy",        // 从指定 agent 卸载
HUB_REMOVE:        "hub.remove",          // 从 store 删除（先 undeploy 全部）
HUB_SYNC:          "hub.sync",            // push / pull / reconcile
HUB_IMPORT_LOCAL:  "hub.import_local",    // 从某 agent 目录反向导入 store
HUB_AGENTS_PROBE:  "hub.agents_probe",    // 探测各 agent 可用性
```

请求/结果类型（节选）：

```typescript
export interface HubDeployRequest {
  extId: string;
  agents: AgentId[];
  scope?: "user" | "project";
  cwd?: string;
}
export interface HubListItem {
  id: string;
  kind: "skill" | "plugin";
  name: string;
  version?: string;
  capabilities?: { skills: string[]; mcpServers: string[]; commands: string[]; hooks: string[] };
  deployments: Record<AgentId, { status: "synced" | "drift" | "missing" | "error"; scope: string } | null>;
}
export interface HubListResult { items: HubListItem[] }
```

兼容策略：现有 `import_skill` / `import_plugin` 内部转调 `hub.install`（default deploy target = `forge`），`list_skills` / `list_plugins` 叠加 registry 的 deployment 信息。

---

## 7. 典型流程

### 7.1 安装并分发

```
forge ext install superpowers --to forge,cursor,claude-code
→ hub.install({ id, source, agents:[...] })
  1. git clone → hub/store/plugins/superpowers/
  2. 解析 capabilities，算 contentHash，写 registry
  3. 对每个 agent 调 adapter.deploy()（生成对应清单 + symlink/侧载）
  4. reload_runtime；Cursor 标记「需 Reload Window」
```

### 7.2 单独卸载

```
forge ext undeploy superpowers --from cursor
→ hub.undeploy({ extId, agent:"cursor" })
  → 删 ~/.cursor/plugins/local/superpowers/ + 更新 registry.deployments.cursor=missing
（Hub store 与其他 agent 不受影响）
```

### 7.3 完全删除

```
forge ext remove superpowers
→ undeploy 所有 agent → 删 store/ → 删 registry 条目
```

### 7.4 同步

```
forge ext sync [--id x] [--direction push|pull|both]
  push:     contentHash != deployedHash → 该 agent redeploy
  pull:     git fetch 源 → 更新 store → push 到所有已部署 agent
  reconcile: 扫描各 agent 目录（adapter.discoverInstalled）与 registry 对齐，
             标记 orphan（agent 有 hub 无）/ drift（hash 不一致）/ missing
```

### 7.5 反向导入

```
forge ext import-local --from claude-code --id gstack-ship
→ hub.import_local：读 agent 目录 → 归一清单 → 存入 store → 登记 registry
```

---

## 8. Desktop UI

在现有 Skills / Plugins 页增加「Agent 部署矩阵」：

```
Extension Hub                                   [Sync All] [+ Install]
──────────────────────────────────────────────────────────────────
🔍 Search           Tab: [ Skills | Plugins ]   Filter: [All Agents ▾]
──────────────────────────────────────────────────────────────────
superpowers        plugin  v5.0.7   sha:b7a8…   (12 skills, 0 MCP)
  Forge ✅   Cursor ✅(需reload)   Claude ✅   Codex —
  [Deploy ▾] [Sync] [Uninstall ▾] [View]
──────────────────────────────────────────────────────────────────
figma              plugin  v2.2.68             (11 skills, 1 MCP)
  Forge —    Cursor ✅   Claude —    Codex —
  [Deploy to Forge] [Import to Hub]
──────────────────────────────────────────────────────────────────
gstack-ship        skill                        📥 仅存在于 Claude
  Forge —    Cursor —   Claude ✅   Codex —
  [Import to Hub]
```

图标：✅ 已部署且 hash 一致 · ⚠️ drift · — 未部署 · 📥 仅 agent 本地（可反向导入）。

---

## 9. 与外部 Runtime 的运行期生效

| 阶段 | 方案 |
|---|---|
| **Phase 1（首选）** | 纯文件部署：把扩展落到各 agent 原生目录，靠它们自己的发现机制加载。Cursor 插件走 `plugins/local/`，重启/Reload 生效 |
| ~~Phase 3（补强）Prompt 注入~~ | **实测确认不需要**（见 §9.1），故不实现 |
| ~~可选：MCP 桥接（`acp-mcp-bridge.ts`）~~ | **实测确认不需要**（见 §9.2）：三家无头都原生加载插件级 MCP/command |

### 9.1 实测结论（2026-07-08）：三家外部 runtime 无头模式都会自动加载 skill

放了一个带随机 token（`SKILL-OK-9QX7P`）的探针 skill 到各自 `skills/` 目录，再无头调用：

| Runtime | 调用方式 | 结果 | 证据 |
|---|---|---|---|
| **Claude Code** | `claude -p …` | ✅ 自动发现并执行 | 先「launched the zorptest-probe skill」，直读后原样输出 token |
| **Cursor** | `cursor-agent -p … -f` | ✅ 自动加载并执行 | 输出 `SKILL-OK-9QX7P`（token 只存在于 `~/.cursor/skills/…`，cwd 在 /tmp，不可能靠 grep cwd 拿到） |
| **Codex** | `codex exec …` | ✅ 原生加载 skill | 打印 `warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill`（token 本身因当天用量超限未跑完，但发现机制已证实） |

**推论**：Skill 只要 **deploy 文件到各 agent 的 `skills/` 目录**（Phase 1/2 已做）即可在「Forge 驱动外部 runtime」时生效，**无需在 Forge 侧做 prompt 注入**。因此不实现原 Phase 3 的 skill 注入。
（注：Cursor CLI `--help` 无 `skill` 字样、只暴露 `rule`，但实测 headless 确实吃 `~/.cursor/skills/*/SKILL.md`。）

### 9.2 实测结论（2026-07-08）：插件级 **MCP server + command** 三家无头也原生加载

造了一个探针插件 `zorp-plugin`（多 agent 清单 `.cursor-plugin` / `.claude-plugin` / `.codex-plugin` + 根 `.mcp.json` + `commands/zorpcmd.md`），内含：
- 一个手写的最小 stdio MCP server（`node mcp-probe.mjs`），暴露工具 `zorp_probe` 返回随机 token `MCP-OK-7K2Q`，并把每次「进程启动 / initialize / tools/call」写日志；
- 一个 command `zorpcmd`，只输出 `CMD-OK-3H8W`。

| Runtime | 部署方式 | MCP | command | 证据 |
|---|---|---|---|---|
| **Cursor** | 放 `~/.cursor/plugins/local/zorp-plugin/`（无 `--plugin-dir`） | ✅ | ✅ | `cursor-agent -p --approve-mcps` 调 `zorp_probe` 直返 `MCP-OK-7K2Q`；`cursor-agent -p "/zorpcmd"` 返 `CMD-OK-3H8W` |
| **Claude** | ① `--plugin-dir` ② 本地 marketplace + `plugin enable`（user 级持久） | ✅ | ✅ | 两种方式都跑通：MCP 返 `MCP-OK-7K2Q`、command `/zorp-plugin:zorpcmd` 返 `CMD-OK-3H8W`；日志有 LAUNCH+INITIALIZE+CALL |
| **Codex** | 本地 marketplace + `plugin add`（写 `config.toml` `[plugins."…@…"] enabled=true`） | ✅（启动即连） | ⚠️未测 | 会话启动时**自动 spawn 插件 MCP 并完成 `initialize` 握手**（日志有 LAUNCH+INITIALIZE）；token 因当天 OpenAI 用量超限没跑完模型回合，但加载已证实。command 因 `codex exec` 非交互 + 用量超限未验 |

**关键细节 / 踩坑**：
- **Cursor**：`plugins/local/` 侧载的插件，其 `.mcp.json` / `commands/` **无头自动加载**，与 §14 侧载结论一致；需 `--approve-mcps`（或配置信任）放行 MCP。
- **Claude**：协商的是 **MCP 协议 `2025-11-25`**。探针最初只返 `content:[{type:text,...}]` 时 Claude 报「工具无输出」，补上 `structuredContent` 后才正确读出 token → **给 Claude 用的 MCP 响应建议同时带 `structuredContent`**。Claude 命令按 `/<plugin>:<command>` 命名空间。Claude 本地目录 marketplace（`.claude-plugin/marketplace.json` + `plugin enable`）**支持**（回答 §15-3）。
- **Codex**：多 agent 清单同构（`.codex-plugin/plugin.json` 用 `mcpServers:"./.mcp.json"`），本地 marketplace 需 `authentication` ∈ `ON_INSTALL|ON_USE`（无 `NONE`）；`codex exec` 会阻塞读 stdin，需 `</dev/null`。

**推论**：三家的插件级 **MCP 与 command 都由各 runtime 原生加载**，Forge 只要把插件按各自约定 deploy 到位，**无需实现 `acp-mcp-bridge` 之类的 MCP 转发**。原「可选 MCP 桥接」降级为**不需要**。

### 9.3 落点复测（2026-07-08）：Claude/Codex 的插件"部署到位"到底要写哪些文件

在把结论固化进 adapter 前，进一步实测了两家的**确切持久化落点**（用临时 home / `CODEX_HOME` 隔离），结论纠正了原 Claude/Codex adapter 的实现：

**Codex —— 光有 config.toml 声明不够，必须有 install cache 副本**：
- `config.toml` 写了 `[plugins."x@forge-hub"] enabled=true` 但 `codex plugin list` 仍显示 **`not installed`**，MCP 也不 spawn。
- `codex plugin add` 实际只做一件事：把插件**拷进 `~/.codex/plugins/cache/<mkt>/<name>/<version>/`**（`config.toml` 不变）。手动 `cp` 出这个 cache 目录，`codex plugin list` 立刻变 **`installed, enabled`**、下次会话即 spawn 插件 MCP（`LAUNCH`+`INITIALIZE` 日志，即使模型回合因无 auth 401 也照连）。
- 另外 marketplace 源根必须有 `.agents/plugins/marketplace.json`，且每个插件 `policy.authentication ∈ {ON_INSTALL, ON_USE}`（无 `NONE`）。
- → **Codex adapter deploy 必写四样**：① marketplace 源 `plugins/forge-hub/plugins/<id>/` ② `plugins/forge-hub/.agents/plugins/marketplace.json` ③ install cache `plugins/cache/forge-hub/<id>/<version>/` ④ config.toml 两段。全部纯文件，无需 shell CLI。

**Claude —— 裸目录不认，靠 marketplace 注册 + settings 启用（且本地源就地引用不拷贝）**：
- `claude plugin marketplace add <本地目录>` + `plugin enable` 后 diff 出两处落点：
  - `~/.claude/plugins/known_marketplaces.json`：`"forge-hub": { source:{source:"directory", path}, installLocation:path, lastUpdated }`（`installLocation` = 源路径本身 → **就地引用、不拷贝**）
  - `~/.claude/settings.json`：`enabledPlugins["<id>@forge-hub"]=true` + `extraKnownMarketplaces["forge-hub"]={source:{source:"directory",path}}`
- → **Claude adapter deploy**：把插件拷进 Forge 自管的 marketplace 目录 `~/.claude/plugins/forge-hub/<id>/`，生成 `.claude-plugin/marketplace.json`，再写上述 known_marketplaces + settings 两个 JSON（保留其余键）。skill 仍走 `~/.claude/skills/<id>`（§9.1 已证）。

> 实现记录（2026-07-08，A1/A2）：Codex/Claude adapter 已按上述落点重写，全部纯文件操作、可对临时 home 单测；`@forge/extension-hub` 34 项测试全绿（新增 Claude marketplace/enable、Codex marketplace.json+cache 断言）。因两家落点都能纯文件复现，原 Phase 4「Claude/Codex native install adapter（shell 官方 CLI）」**无需再做**。

---

## 10. 复用现有代码

| 已有 | 复用为 |
|---|---|
| `packages/marketplace/src/import.ts`（clone + copy） | `hub.install` 的取源层 |
| `packages/plugin-registry`（discover / contributions） | Forge adapter + capabilities 解析 |
| `packages/skill-registry`（loadSkills / catalog） | Skill 解析 + Phase 3 注入 |
| `collectPluginSkillPaths` | 「插件安装联动内部 skills」 |
| `acp-mcp-bridge.ts` | Cursor 运行 Forge 时转发插件 MCP |
| `talents.sync_templates`（`talent-service.ts`） | `hub.sync` 的实现范式 |
| `hooks` 里 `CLAUDE_PLUGIN_ROOT` / `CURSOR_PLUGIN_ROOT` | 各 agent hooks 路径变量映射 |

---

## 11. 分阶段实施

### Phase 1 — Hub 基础（Forge + 文件分发）
- [x] `packages/extension-hub`：store + registry + hash + Manifest Codec
- [x] 四个 adapter（Forge symlink + Cursor 侧载 + Claude 本地 marketplace+enable + Codex 本地市场+install cache+config.toml）—— Claude/Codex 落点已按 §9.3 实测重写
- [x] RPC：`hub.list` / `hub.install` / `hub.deploy` / `hub.undeploy` / `hub.remove`
- [x] CLI：`forge ext list / install / deploy / undeploy / remove`（部署矩阵输出）
- [x] 兼容：`import_skill` / `import_plugin` 转调 hub（导入 → hub store SSOT + registry → deploy 到 `forge`；旧入口不变但结果自动进分发矩阵；导入后 `reloadRuntime`）

> 实现记录（2026-07-08）：
> - Codex 用受控的行级 TOML 段编辑器（`src/toml-sections.ts`）只增删 hub 自己写的 `[marketplaces.forge-hub]` / `[plugins."<id>@forge-hub"]` 段，保留其余 config.toml 原样（未引入 TOML 依赖）。
> - **修复**：`resolveAgentTargetPath` 早期未先 `expandHome` 就判 `isAbsolute`，导致 user 级 `~/...` 根被误当相对路径 join 到 cwd，在工作区生成字面量 `~/` 目录。已修复并加 `paths.test.ts` 回归。
> - 测试：extension-hub 29 项 + daemon hub-service 3 项全绿；`forge ext install/deploy(forge)/remove` 端到端手测通过。
> - 注意：Desktop（Electron）内嵌 daemon 会常驻旧内存态，改动需重启桌面端才生效。

### Phase 2 — 同步与 UI
- [x] `hub.sync`（push：把 drift/missing 重新部署回一致）
- [x] `hub.discover`（探测各 agent + 列出已装扩展）+ `hub.import`（从 agent 回收进 hub，pull）
- [x] fs 感知状态：list/sync 会检查目标是否存在 → `missing`；否则按 hash 判 `synced`/`drift`
- [x] Desktop 部署矩阵（插件页「分发」标签页）：格子点选部署/卸载、逐项/全部同步、移除；状态色点 + drift/missing 图例
- [x] `hub.import_local`（导入本地目录）在 UI 里的入口：分发页工具栏「导入本地目录」按钮 → 提示路径/类型/ID → `hubInstall({kind,id,sourceDir})`（preload `hubInstall` + main `forge:hub-install` + daemon `HUB_INSTALL`）

> 实现记录（2026-07-08，续）：
> - `DeploymentRecord` 增加 `cwd`（project 级同步需要重解析目标）。
> - RPC：`hub.sync` / `hub.discover` / `hub.import`；Desktop 经 preload `hubList/hubDeploy/hubUndeploy/hubSync/hubRemove/hubDiscover/hubImport` → main `forge:hub-*` → daemon。
> - 测试：extension-hub 32 项 + daemon hub-service 4 项全绿。`inline-diff-queue.test.js` 的 2 个失败为**既有**问题（HEAD 版 app.js 同样失败），与本次无关。

### Phase 3 — Runtime 桥接
- [x] ~~外部 runtime skill prompt 注入~~ —— **实测确认不需要**（Claude/Cursor/Codex 无头都自动加载 `skills/`，见 §9.1）
- [ ] Talent 绑定跨 agent 生效 —— **待产品决策**：talent 绑定的 skill/plugin 应部署到哪些 agent、何时触发（绑定时 vs 运行时）。见 §16。
- [ ] 项目级 `.forge/skills/` 支持 —— **需架构改动**：当前 runtime 在 daemon 启动时全局构建一次、skill 目录写死（`skillsDir`+插件+`~/.forge-agent/skills`），无项目 cwd；项目级需按 run 的 cwd 合并 `<cwd>/.forge/skills`。见 §16。
- [x] ~~插件级 MCP / commands 在外部 runtime 的加载实测~~ —— ✅ 已实测：三家无头都原生加载插件 MCP+command（见 §9.2），**无需 MCP 桥接**

### Phase 4 — 增强（可选）
- [ ] 团队共享 registry（git remote / 内网 catalog）
- [ ] 版本约束 / 依赖 / 冲突策略
- [x] ~~Claude/Codex native install adapter~~ —— 实测两家落点均可纯文件复现（§9.3），已在 A1/A2 用纯文件实现，无需 shell 官方 CLI

---

## 12. 关键决策与风险

| 决策 | 选择 | 理由 |
|---|---|---|
| SSOT 位置 | `~/.forge-agent/hub/store/` | 与 Forge 数据目录一致，不污染各 agent |
| 默认部署方式 | symlink（Forge），sideload（Cursor 插件） | 同步简单、卸载=删目录 |
| Cursor 插件落点 | `plugins/local/` 侧载，不碰 SQLite | 无 marketplace ID 依赖、可控 |
| Skill vs Plugin | 合并为 Extension Package | 插件天然含 skill，避免两套系统 |
| 卸载语义 | undeploy（离某 agent） vs remove（离 hub） | 分开，防误删 |
| 向后兼容 | 保留 `~/.forge-agent/skills`、`plugins` 作为 Forge deploy target | 不破坏现有 runtime |

| 风险 | 缓解 |
|---|---|
| Cursor 侧载生效时机 | 实测：Cursor 会自动扫描 `plugins/local/` 并加载，无需手动 Reload（见 §14）；UI 仍保留「如未生效可 Reload」提示兜底 |
| Codex 项目级路径未文档化 | Phase 1 先只做 user 级；后续实测补 |
| Cursor/Claude 手改本地文件导致 drift | `reconcile` 检测 + 「以 Hub 为准 / 导入 Hub」二选一 |
| 各 agent hooks 运行期语义差异 | Phase 1 只分发文件，不保证 hooks 全等价 |
| SQLite 状态与侧载不同步（Cursor UI 不显示 local 插件启用态） | 实测确认：侧载插件走独立 `loadUserLocalPlugins` 通道，不进 `installedIds`（见 §14）；UI 状态以 Hub registry 为准 |

---

## 14. Cursor 侧载实测验证（2026-07-08）

在 `~/.cursor/plugins/local/forge-hub-probe/` 放入最小插件（`.cursor-plugin/plugin.json` + `skills/forge-hub-probe/SKILL.md`），观察 Cursor 插件日志与 SQLite 状态。

**日志证据**（`.../logs/*/window*/exthost/anysphere.cursor-agent-exec/Cursor Plugins.*.log`）：

放入前：
```
loadUserLocalPlugins completed in 0.6ms (0 plugins loaded)
loadAllPlugins completed ... (claude=true, userLocal=true, userSettings=false, marketplace=2 sources, total=3 plugins)
```

放入后（**未手动重载，Cursor 自动重扫**）：
```
loadUserLocalPlugin forge-hub-probe loaded in 2.8ms
loadUserLocalPlugins completed in 25.4ms (1 plugins loaded)
loadAllPlugins completed ... (claude=true, userLocal=true, userSettings=false, marketplace=2 sources, total=4 plugins, failures=0)
Plugins reload completed: 4 plugins loaded (0 extension), 0 failures
```

**SQLite 证据**（`state.vscdb`）：放入前后 `cursor.plugins.installedIds.no-team|no-workspace` 均为 `[{"id":"657"...},{"id":"684"...},{"id":"8006"...}]`，**未新增 probe 条目**；全表无 probe 相关 installed 状态 key。

### 确认结论

1. **侧载可用且自动生效**：`~/.cursor/plugins/local/<id>/` 放入即被 `loadUserLocalPlugins` 加载，实测无需手动 Reload Window（Cursor 会自动重扫）。
2. **不碰 marketplace 状态**：local 插件走独立通道，`marketplace listEnabledPlugins` 不含它，SQLite `installedIds` 不变 → **Forge 无需 marketplace ID 即可分发到 Cursor**。
3. **Cursor 插件有四类来源**（日志 `loadAllPlugins` 标志位）：`claude`（`~/.claude` 插件）、`userLocal`（`plugins/local/`，Forge 的落点）、`userSettings`、`marketplace`（`plugins/cache/<mp>/`）。
4. **卸载 = 删目录**：移除 `plugins/local/<id>/` 后 `loadUserLocalPlugins` 回到 0，无残留状态需清理。

→ 印证 §2.3 / §5.2 的 Cursor adapter 设计：**deploy = 写 `plugins/local/`，undeploy = 删目录，全程不触碰 SQLite。**

---

## 15. 待确认项

1. ~~Codex 项目级 skill/plugin 路径~~ —— ✅ 已实测：Codex 用 `config.toml` 声明式管理，插件为 **user 全局**（无项目级插件段，`[projects]` 仅 `trust_level`）；本地市场结构 = `<mp>/plugins/<name>/.codex-plugin/plugin.json`，无需索引文件（见 §2.4）。
2. ~~Cursor 侧载插件加载与 SQLite 关系~~ —— ✅ 已实测确认，见 §14。
3. ~~Claude 本地/inline marketplace 源是否受支持~~ —— ✅ 已实测（§9.2）：`claude plugin marketplace add <本地目录>`（目录含 `.claude-plugin/marketplace.json`）+ `claude plugin enable <plugin>@<market>` 可行，enable 落点为 user settings（`plugin enable` 输出 `scope: user`）；另有 `--plugin-dir <目录>` 单会话直接加载。
4. Codex：程序化改写 `config.toml` 后是否需重启 Codex 才生效，还是热加载——需实测（类比 Cursor 的自动重扫）。
5. ~~外部 runtime 无头模式是否自动加载 skill~~ —— ✅ 已实测：Claude / Cursor / Codex 无头调用均自动加载各自 `skills/` 目录里的 skill（见 §9.1），**无需 Forge 侧 prompt 注入**。
6. ~~插件级 **MCP server / commands** 在外部 runtime 的加载~~ —— ✅ 已实测（§9.2）：Cursor（`plugins/local` 侧载）、Claude（`--plugin-dir` 或本地 marketplace+enable）都跑通 MCP+command；Codex 启动即连插件 MCP（command 未验）。**结论：无需 MCP 桥接**。
7. Codex 插件 **command** 在无头 `codex exec` 下如何触发（`/` 命令是 TUI 特性）、以及本次因 OpenAI 用量超限未跑完的 Codex MCP token 回读——待有额度时补测（加载/握手已证实）。

---

## 16. 待产品决策（C1 / C2，实现前需拍板）

### C1 — Talent 绑定跨 agent 生效
现状：talent 绑定的是 **Forge 内部** 的 skill/tool（`updateTalentBindings` 写 roster，运行时 `resolveTalentSkillCatalog` 在 ReAct loop 里裁剪 skill 目录）。要让绑定"跨 agent 生效"需先定义语义：
- **部署到哪些 agent？** 选项：(a) 全部已探测到的 agent；(b) 该 talent 实际驱动的外部 runtime（如 talent 跑在 cursor-agent 上就只部署 Cursor）；(c) 用户在 talent 上显式选。
- **何时触发？** (a) 绑定时立即 `hub.deploy`；(b) 运行该 talent 前按需部署。
- **卸载语义？** talent 解绑 / fire 时是否连带 undeploy（可能与其他 talent 共享同一 skill，需引用计数）。
- 依赖：绑定的 skill/plugin 必须已在 hub store（否则先 `hub.install`）。

### C2 — 项目级 `.forge/skills/` 支持
现状：runtime 在 daemon 启动时**全局构建一次**，skill 来源写死为 `skillsDir` + 插件 skill + `~/.forge-agent/skills`，**不带项目 cwd**。要支持项目级需：
- 在 **run 粒度**按该 run 的 `cwd` 额外加载 `<cwd>/.forge/skills` 并并入目录（而非全局 runtime）。
- 定义**优先级/覆盖**：项目 skill 与同名 user/builtin skill 冲突时谁赢。
- 与 hub 的关系：`forge`（Forge adapter）已支持 `project` scope 部署到 `.forge/skills`；缺的是 **runtime 侧运行时发现** 这部分。
