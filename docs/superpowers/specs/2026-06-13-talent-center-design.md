# 人才中心（Talent Center）设计方案

> 状态：修订 v2 · 2026-06-15
> 目标：在 forge-agent 上构建一个「可雇佣的 AI 同事」体验——左侧栏展示人才，基于
> [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) 的 254 个角色技能，
> 包装成有名字、有人设的「人物」；用户可以雇佣他们，在对话框里 `@某人` 调用其技能，
> 也可以一次给多个不同的人分配工作。真正写盘始终由 Coordinator 统一收口。

## 0. 结论清单

这份文档不再作为复杂功能路线图使用。现阶段只保留已经存在的基础能力说明；后续只考虑两个体验点：

### A. 可以考虑

| 事项 | 为什么值得做 |
|---|---|
| 7.2 对话框 `@mention` 体验 | 让点名、补全、多人切段更清楚，减少误触发 |
| 7.3 派活可视化 | 让用户看懂谁在做什么、谁完成了、Coordinator 何时汇总 |

### B. 已有能力，保持即可

| 事项 | 当前判断 |
|---|---|
| 人才同步/雇佣/Roster | 已有，不继续扩复杂模型 |
| 单人/多人 `@mention` 路由 | 已有，后续只优化交互表达 |
| 多人后台只读执行 + Coordinator 统一写盘 | 保持 single-writer 架构 |
| `intent_plan` / `dispatch_plan` 展示 | 已有，先不扩 schema |

### C. 暂不做 / 从规格里剔除

| 事项 | 不做原因 |
|---|---|
| `personaBrief` | 会引入 prompt 注入策略复杂度，先不做 |
| 扩展 `dispatch_plan` schema | `targetFiles/contract/risk` 会把系统变成复杂调度器，先不做 |
| 高风险 plan gate | 确认流程会增加状态机复杂度，先不做 |
| `maxParallelTalents` 配额系统 | 暂不引入新的配置和排队逻辑 |
| 无 `@` 时自动从 Roster 选人 | 容易误派，用户不容易判断为什么叫了某个人 |
| 后台 talent 直接写盘 | 破坏 single-writer，一致性和冲突处理会复杂很多 |
| `tier` 字段 | 和现有 `permissionPreset` 重复，用 UI 派生标签即可 |
| `outputLocale` 字段 | 语言跟随用户/项目设置，不应该落到每个人才模板里 |
| 复杂 prompt 档位调度 | 会增加注入策略复杂度，先不做 |
| per-talent worktree 自治写手 | 是 Phase 3，只有真实需要“多人各自写盘并合并”时再做 |
| 团队/阵容模板 | 暂无刚需，等用户高频手动组合后再设计 |

---

## 1. 核心概念

| 概念 | 定义 | 在 forge-agent 中的落点 |
|---|---|---|
| **Talent（人才/人物）** | 一个有名字、头像、人设、专长的 AI 角色。本质 = persona + 绑定技能/工具 + 元数据 | 前台由主循环注入 persona；后台由只读子代理执行 |
| **Roster（人才名册）** | 当前工作区已「雇佣」的人才集合，展示在左侧栏 | 新增 `~/.forge-agent/talents/` + 项目 `.forge/talents.json` |
| **Hire（雇佣）** | 把一个 talent 模板加入当前 Roster，可用 | 类似 `forge skills import`，落库 + RELOAD_RUNTIME |
| **@mention（点名）** | 在对话框 `@人物名` 把这一轮（或这条子任务）路由给该 talent | 主循环换 persona / 或 spawn 对应子代理 |
| **Assignment（派活）** | 一次把多条子任务分给不同 talent，按依赖波次执行 | LLM 先产出 `intent_plan` / `dispatch_plan`，再执行 |
| **Coordinator（调度/团队负责人）** | 默认主代理，负责拆活、派活、汇总、统一写盘 | 现有主代理角色，叠加「团队负责人」职责 |

**一句话隐喻**：forge-agent 从「一个全能 agent」升级为「一个团队负责人 + 一队可雇佣的专家」。
团队负责人（主代理）始终是唯一写盘人，专家（talents）是有人设的「专业视角/产物生产者」。

---

## 2. 人才来源：agency-agents → Talent

agency-agents 仓库结构正好就是一个「人才库」：

```
engineering/   33   marketing/  36   specialized/ 53
design/         9   security/   10   sales/        9
testing/        8   pm/          7   paid-media/   7
gis/           13   support/     6   spatial/      6
product/        5   finance/     5   game-dev/     5
academic/       5   strategy/    3   ...           共 254
```

每个 `*.md` 文件的格式：

```markdown
---
name: AI Engineer
description: Expert AI/ML engineer specializing in ...
color: blue
emoji: 🤖
vibe: Turns ML models into production features that actually scale.
---

# AI Engineer Agent
You are an **AI Engineer** ...
## 🧠 Your Identity & Memory ...
## 🎯 Your Core Mission ...
## 🚨 Critical Rules You Must Follow ...
```

**转换规则（导入器 `talent-importer`）**：

| agency-agents 字段 | Talent 字段 | 说明 |
|---|---|---|
| `name` | `role`（职业） | 「AI Engineer」「Brand Guardian」 |
| frontmatter `emoji` / `color` | `emoji` / `color` | 左侧栏头像与配色 |
| `vibe` | `vibe` | 卡片副标题 / 工作气质 |
| `description` | `description` | 悬停/详情 / 角色摘要 |
| 正文（Identity/Mission/Rules） | `systemPrompt` | persona 注入 |
| 目录名（`engineering/`…） | `category` | 左侧栏分组 |
| —（新增） | `displayName`（人物名） | 见 §3 命名 |
| —（推断） | `skills[]` / `tools[]` | 见 §4 技能绑定 |

导入是**一次性脚本 + 可重跑**：`forge talents sync` 拉取仓库 → 解析 → 写入本地人才模板库
`~/.forge-agent/talents/templates/<id>.json`。用户雇佣的实例放在 Roster（§6）。

---

## 3. 人物命名

用户要的不是「AI Engineer」这种岗位名，而是有名字的**人物**。两层显示：

- `displayName`：人物名（叫得出口、好 @）——如「**阿杰**」「**Nova**」
- `role`：职业标签（副标题）——「AI 工程师」

**命名策略**（导入时自动生成，可改名）：

1. **稳定映射**：用 `id` 做种子，从一个名字池里确定性取名（同一角色每次同名）。
2. **风格分区**：工程/安全类偏中性科技名（Nova、Kit、Ash、阿杰、老周），
   设计/营销类偏轻松（Lumi、Coco、小满），金融/法务偏稳重（Han、老钱）。
3. **冲突消解**：同名加后缀或换池下一个。
4. 用户可在卡片上 `重命名`，存到 Roster 实例（不影响模板）。

示例 Roster：

| 头像 | 人物名 | 职业 | 一句话 |
|---|---|---|---|
| 🤖 | Nova | AI 工程师 | 把模型变成真能扛量的线上功能 |
| 🎨 | Lumi | UI 设计师 | 像素级打磨，拒绝 AI 味的廉价感 |
| 🛡️ | Ash | 安全架构师 | 在你被打之前先把洞补上 |
| 🔍 | 老周 | 代码审查 | 见过的坑比你写过的代码多 |
| 📊 | Coco | 增长营销 | 一条文案的 A/B 能差三倍转化 |

---

## 4. 技能与工具绑定

agency-agents 只给了「人设/职责」，没给可执行工具。Talent 要真能干活，得把 persona
绑到 forge-agent 的**技能（skills）和工具（tools）白名单**上。

- **技能绑定**：把 persona 的领域映射到已装 skills（`skills/code-review.md`、
  `excalidraw-diagram`、`fix-bug` 等）。导入时给一份**建议 skill 清单**，用户可调。
  - 例：`老周（代码审查）` → `code-review`、`explain-code`
  - 例：`Nova（AI 工程师）` → `add-unit-test`、`patch-edit`、`run-ci-local`
- **工具白名单**：每个 talent 限定可用工具集，最小权限。
  - 内容生产型（设计/营销/文案）：`read_file/list_dir/grep` + `web_search`（若开）
  - 工程型：上面 + （仅前台模式）`write_patch/run_command`
- **缺省兜底**：没有匹配 skill 的 talent 仍可用——退化成「带专业视角的只读顾问」，
  产出建议/草稿，由 Coordinator 落地。

> 关键：talent ≠ 新增一类执行体，而是 **persona（提示词） + skill 子集 + tool 白名单**
> 三者的组合。完全复用现有 skills/tools 注册表，不引入并行的执行内核。

---

## 5. 两种执行模式（最关键的架构决策）

forge-agent 现有约束（见 `docs/agent-capabilities.md`）：**子代理只读，single-writer 架构**——
只有主代理写盘，子代理只能返回内容。用户要「多人并行干活」，必须和这条约束对齐。
方案是区分两种模式：

### 模式 A：前台单人（@一个人，完整读写）

`@Nova 把登录页接上新接口`

- 不 spawn 子代理。**主循环本回合换上 Nova 的 persona + 技能 + 工具白名单**，
  Coordinator 临时「变身」成 Nova 来干。
- 拥有完整 `write_patch/run_command` 权限（仍走命令确认/检查点）。
- 适合：需要边写边验证、连续多步、单点深入的活。

### 模式 B：后台多人派活（@多个人，只读生产 + 统一落盘）

`@Nova 写后端接口 @Lumi 出登录页样式 @老周 审一遍现有支付模块`

- Coordinator 先请求模型产出派活计划：用户意图、每个人的任务、依赖关系、执行波次。
- Coordinator 按波次把任务交给对应 persona 的**只读子代理**；无依赖的同一波可以并行，有依赖的任务必须串行接收前置产出。
- 每个子代理聚焦产出**一个完整文件草案、一段独立结论，或可交给 Coordinator 落地的补丁建议**。
- Coordinator 汇总后**统一写盘**，再自己 `read_file` + 跑测试/编译校验（现有「拼装后必须校验」纪律）。

> 为什么不让多人同时写盘？现有 single-writer 架构从根上消除了并发写竞争，且代码跨文件
> 的一致性（import/类型）无法靠文件锁保证。模式 B 用「并行只读生产 + 单点汇总写入」
> 拿到并行的速度，又不牺牲一致性。这是 MVP 的推荐路径。

### 模式 C（暂不做）：真并行自治写手 —— git worktree 隔离

若要让多人**各自独立写盘并跑命令**（真正的「并行同事」），用 **per-talent git worktree**：

- 每个被派活的 talent 分到一个独立 worktree（隔离副本），可读可写可跑命令，互不干扰。
- 全部完成后由 Coordinator **合并**（自动 merge / 冲突时人介入）。
- 代价：合并冲突、资源占用、复杂度上升。列为 Phase 3，不进 MVP。

| 模式 | 并行 | 能写盘 | 一致性保证 | 阶段 |
|---|---|---|---|---|
| A 前台单人 | 否 | ✅ 直接 | 主循环顺序语义 | MVP |
| B 后台多人 | ✅ 按依赖波次并行 | ✅ 由 Coordinator 统一写 | 模型派活计划 + 拼装校验 | 保持现状 |
| C worktree 自治 | ✅ 真并行写 | merge 时解决 | 暂不做 |

---

## 6. 数据模型

```jsonc
// 人才模板（库，只读，来自 agency-agents 同步）
// ~/.forge-agent/talents/templates/<id>.json
{
  "id": "engineering-ai-engineer",
  "category": "engineering",
  "role": "AI 工程师",
  "description": "Expert AI/ML engineer specializing in ...",
  "vibe": "把模型变成真能扛量的线上功能",
  "emoji": "🤖",
  "color": "blue",
  "systemPrompt": "You are an AI Engineer ...",
  "suggestedSkills": ["add-unit-test", "patch-edit"],
  "suggestedTools": ["read_file","grep","write_patch","run_command"]
}

// 雇佣实例（Roster）—— 用户/项目级
// ~/.forge-agent/talents/roster.json  或  <repo>/.forge/talents.json
{
  "hired": [
    {
      "instanceId": "t_nova",
      "templateId": "engineering-ai-engineer",
      "displayName": "Nova",            // 可重命名
      "mention": "nova",                // @nova，唯一
      "enabled": true,
      "skills": ["add-unit-test","patch-edit"],   // 用户可裁剪
      "tools":  ["read_file","grep","write_patch","run_command"],
      "permissionPreset": "collaborator",          // advisor | collaborator | operator
      "hiredAt": "2026-06-13T...",
      "stats": { "tasksDone": 0, "lastUsed": null }
    }
  ]
}
```

- **模板 vs 实例分离**：模板可重跑同步覆盖；雇佣实例保留用户改名/裁剪，不被同步冲掉。
- **@mention 索引**：`mention` 全局唯一，做前缀补全；重名时 `@nova2`。
- **存储**：模板 = 文件；Roster = user/project JSON。派活历史/统计可继续随 session 事件持久化，除非有查询需求，不新增 SQLite 表。

---

## 7. 交互设计

### 7.1 左侧栏（Roster）

```
┌─ 人才中心 ───────────────┐
│ [＋ 雇佣]      [⚙ 同步库]  │
│                          │
│ ⭐ 在岗 (3)               │
│  🤖 Nova    AI 工程师  ●  │   ← ● 绿=空闲 黄=忙 灰=离线
│  🎨 Lumi    UI 设计师  ○  │
│  🛡️ Ash     安全架构  ◐  │   ← ◐ 正在执行一条派活
│                          │
│ 📁 按领域浏览人才库        │
│  ▸ 工程 (33)             │
│  ▸ 设计 (9)              │
│  ▸ 安全 (10) ...         │
└──────────────────────────┘
```

- 点人物卡 → 详情抽屉：人设、绑定技能、工具权限、最近任务、改名、解雇。
- 卡片上有状态点（空闲/执行中/有产出待汇总）。
- 「雇佣」打开人才库浏览器（按 category 分组的 254 个模板，可搜索/预览 persona）。

### 7.2 对话框 @mention

- 输入 `@` 弹出 Roster 补全（头像 + 名字 + 职业）。
- 一条消息可点多个：`@Nova 写接口 @Lumi 出样式` → 自动进入**模式 B 并行**。
- 单点且需要连续写 → **模式 A 前台**（也可显式 `@Nova!` 强制前台）。
- 没 @ 任何人 → **不自动选人才**（人选易错）；走普通 Coordinator 流程（理解 → 规划 → 执行），可用通用 `spawn_agent` 做调研/扇出，但**不会**根据任务类型自动从 Roster 里挑角色。要用人必须显式 `@`。

### 7.2.1 @mention 解析语法（已定）

把一条消息切成「(全局上下文) + 每个被点名人各自的任务段」，必须有死规则，否则中文名、邮箱、前缀重名都会出错。

**词法：什么算一个 mention token**

1. **起始边界**：`@` 只有在**行首**或**前面是空白**时才可能是 mention 起点。
   因此 `a@b.com`、`path@v1`、`老周@ddl` 里的 `@` 不触发（前面不是空白）。要在词中打字面 `@`，用 `@@` 转义，或放进反引号代码段（代码段内整体忽略解析）。
2. **名字匹配 = 必须命中 Roster**。`@` 后面的内容**只有解析到当前 Roster 的某个人才**才算 mention；
   命中不了就当**普通文本**保留（不报错、不拦截）。匹配候选 = 该人的 `mention`（ascii，如 `nova`）**或** `displayName`（可中文，如 `老周`）。
3. **最长匹配 + 词边界**：从 `@` 往后取「能命中 Roster 名字、且其后紧跟词边界」的**最长**串。
   - 词边界 = 空白 / 标点（`，。,.!?:：、` 等）/ 行尾。
   - 例：同时雇了 `nova` 和 `nova2` 时，`@nova2 改下` → 命中 `nova2`；`@nova 改下` → 命中 `nova`。
   - 例：`@老周，看下` → 命中 `老周`（逗号是边界）。
4. **大小写**：ascii `mention` 不区分大小写（`@Nova`=`@nova`）；中文 `displayName` 精确匹配。
5. **歧义消解**：若输入同时能匹配多个人（如两人 `displayName` 都叫「Nova」），
   优先用唯一的 `mention` 命中；只给了重名 `displayName` 且不唯一 → **不**当 mention，回复提示「用 @nova 或 @nova2 指定」。

**任务段切分**

```
[前导文本]  @A 任务段A   @B 任务段B   ...
└─全局上下文┘ └────每人各自任务────────┘
```

- **每个人的任务段** = 该 mention token 之后、到**下一个 mention token 之前**（或消息结尾）的文本，`trim` 后作为该人 task。
- **前导文本**（第一个 mention 之前的非空文本）= **全局上下文**，拼到每个人 task 前面（共享背景）。
- **空任务段**（`@A @B 做X`：A 后面紧跟下一个 mention）→ A 的 task 为空，按「仅点名/无具体指令」处理：把全局上下文给 A，或在 UI 上提示「@A 没有给具体任务」。
- mention token 自身（`@A`）不进入任何人的 task 文本。

**路由（与执行模式对接）**

| 命中 mention 数 | 行为 | 阶段 |
|---|---|---|
| 0 | 普通 Coordinator 流程（§7.2）；不自动选人才 | MVP |
| 1 | 路由给该人才（模式 A 前台） | MVP |
| ≥2 | 多人派活（模式 B）：显示模型理解和派活计划，再按依赖波次执行 | 已有，后续只优化可视化 |

> 解析器和执行层都支持多人语法；后续只考虑把切段和派活状态展示得更清楚。

### 7.3 派活可视化

并行派活时，时间线呈现「团队看板」：

```
团队负责人 已把 3 条任务派出 ▾
  🤖 Nova   写后端接口          ✓ 完成 (生成 api/auth.ts)
  🎨 Lumi   登录页样式          ◐ 进行中…
  🛡️ Ash    审计支付模块        ✓ 完成 (3 个高危发现)
———————————————————————————————
团队负责人 正在汇总并写盘 + 校验 ▾
```

复用现有子代理卡片（`🤖 子代理` / `✓ 子代理完成`），换成人物头像+名字，只透传 status。

---

## 8. 编排流程（模式 B 时序）

```
用户: @Nova 写注册接口 @Lumi 出注册页 @老周 审现有登录
   │
Coordinator（团队负责人）
   ├─ 解析 @ → 命中 Roster: [Nova, Lumi, 老周]
   ├─ 调用模型产出 intent_plan：用户真正想要什么、为什么这样执行
   ├─ 调用模型产出 dispatch_plan：谁做什么、after 依赖、执行波次
   ├─ 展示计划到 UI
   ├─ 同一波 Promise.all 跑只读子代理 ───┐
   │     🤖 Nova 返回 register.ts 全文     │
   │     🎨 Lumi 返回 Register.tsx 全文    │ 并发
   │     🔍 老周 返回审计结论（文本）       │
   ├──────────────────────────────────────┘
   ├─ 后续波次把 [前置人才产出] 注入给依赖方
   ├─ 统一写盘：write_file register.ts / Register.tsx（路径锁兜底）
   ├─ 拼装后校验：read_file + tsc/测试/lint
   └─ 汇总回复：每人产出摘要 + 校验结果 + 老周的发现清单
```

要点：**理解、派活、汇总、写盘、校验全部由 Coordinator 收口**；并行只发生在「同一依赖波次的只读生产」阶段。

---

## 9. 接口（daemon RPC / CLI）

新增 RPC（沿用现有 JSON-RPC over Unix socket 风格）：

```
talents.sync_templates       // 从 agency-agents 拉取+解析进模板库
talents.list_templates       // 浏览人才库（分页/按category/搜索）
talents.get_template         // 查看完整模板/persona
talents.hire(templateId, overrides)   // 雇佣 → 写 Roster → RELOAD_RUNTIME
talents.fire(instanceId)
talents.rename(instanceId, displayName, mention)
talents.list_roster          // 左侧栏数据
talents.update_bindings(instanceId, { skills, tools, enabled })
```

`run` 不新增外部请求体字段。用户消息仍是唯一输入，daemon 内部解析 `@mention` 并发出 `intent_plan` / `dispatch_plan` 事件，避免 CLI、Desktop、Automation 三处各自实现解析。

CLI：

```bash
forge talents sync                       # 同步人才库
forge talents catalog engineering        # 浏览某领域
forge talents hire engineering-ai-engineer --name Nova
forge talents list                       # 我的 Roster
forge talents fire t_nova
forge run "@Nova 写接口 @Lumi 出样式" --cwd .   # 一次多人并行
```

REPL slash（可选，不是 MVP 必需）：`/talents`、`/hire <id>`、`/roster`。Desktop 输入框 `@` 补全优先级更高。

### 9.1 多源 Roster、并发与同步信任（已定）

**(a) Roster 两级与优先级**

- 两级：user（`~/.forge-agent/talents/roster.json`）+ project（`<repo>/.forge/talents.json`）。
- **有效 Roster = 合并，project 覆盖 user**（同 `instanceId` 或同 `mention` 时 project 赢）。
- **mention 唯一性在合并后校验**：跨级同名 → project 生效，user 同名被遮蔽，UI 标注「被项目覆盖」。
- 雇佣默认写 user 级；`--project` 写项目级（随仓库提交、团队共享），沿用现有 plugins/skills 的 `--project` 惯例。

**(b) talent 级状态事件流（左侧栏实时性）**

- 不新增 `talent.status` 这类平行协议。沿用现有 AgentEvent，在子代理事件上附 `talent` 字段。
- 关键可视化事件：`intent_plan`、`dispatch_plan`、`dispatch_wave`、`talent_active`、`subagent_start`、`subagent_end`。
- App 左侧栏与团队看板从这些事件派生 idle/busy/done/error；CLI/REPL 退化为文本行。

**(c) 同步来源信任 / license**

- `talents sync` 拉第三方仓库（agency-agents）。**固定 pin 到某个 commit/tag**，记录来源与版本，避免上游突变。
- **校验 license 允许再分发**（agency-agents 为 MIT 则 OK）；sync 输出展示 license 与来源 commit。
- 解析失败/字段缺失/含可疑越权指令的 template **跳过并汇总报告**（呼应 §10、§4.3 清洗）。
- 多源可扩展：`talents sync --source <repo>`，模板 `id` 加来源前缀防撞。

---

## 10. 安全与边界

| 关注点 | 处理 |
|---|---|
| 子代理只读不变量 | 模式 B 严格沿用：talent 子代理只读，唯一写手是 Coordinator |
| 工具白名单 | 每个 talent 最小权限；前台模式才给写/执行 |
| 命令确认 / 检查点 | 不变，照旧走 `ui.confirmCommands` + 每轮快照回滚 |
| 深度上限 1 | talent 子代理拿不到 `spawnSubagent`，不能再派活（防递归），派活权只在 Coordinator |
| persona 注入安全 | agency-agents 正文进系统提示前做长度/越权指令清洗，不让 persona 覆盖核心安全规则 |
| 同步来源信任 | `talents sync` 显式触发；解析失败/字段缺失的模板跳过并报告 |
| 多人写竞争 | 模式 B 无竞争（单写手）；模式 C 用 worktree 隔离 + 合并 |

---

## 11. 落地顺序

**已落地，保持正确**
1. `talents sync/catalog/hire/list/fire/rename/bind`：同步模板、雇佣、Roster、绑定技能/工具。
2. 模板/实例分离：模板可重跑同步，实例保留用户改名、mention、启用状态、权限与统计。
3. `@mention` 解析、补全和多人任务切段。
4. 单人才前台注入 persona；多人才后台只读执行，Coordinator 统一汇总写盘。
5. 多人才 `intent_plan` / `dispatch_plan` / `dispatch_wave` 可视化。

**唯一可考虑**
6. 7.2 对话框 `@mention`：补全、切段、歧义提示、多人点名时的输入体验。
7. 7.3 派活可视化：团队看板、子代理状态、汇总阶段展示。

**延后，除非真实需求强烈**
8. 自定义人才（用户自建 persona）。
9. 团队/阵容模板（用户显式触发，非模型自动选人）。
10. **模式 C**：per-talent git worktree 真并行写 + 合并。

**明确不做 / 先剔除**

- 无显式 `@` 时自动从 Roster 选人：误派成本高，不做。
- `personaBrief`：暂不引入 prompt 注入策略。
- 扩展 `dispatch_plan` schema：暂不做 `targetFiles/contract/risk`。
- 高风险 plan gate：暂不增加确认状态机。
- `maxParallelTalents` 配额系统：暂不增加配置和排队逻辑。
- 新增 `tier` 字段：和 `permissionPreset` 重复，先用派生 UI 标签。
- 新增 `outputLocale` 字段：语言跟随用户/项目设置，不落到人才模板。
- 复杂 prompt 档位调度：暂不做，避免系统复杂度超过收益。
- 让后台 talent 直接写盘：违反 single-writer，除非进入 Phase 3 worktree 模式。

---

## 12. 待确认问题

1. 7.2 的 `@mention` 补全是否要更明显地区分「单人前台」和「多人派活」？
2. 7.2 的多人切段是否需要在发送前预览每个人收到的任务？
3. 7.3 的团队看板需要展示到什么粒度：只显示人才状态，还是显示每个人的关键输出摘要？
4. 7.3 的汇总阶段是否要独立显示「Coordinator 正在汇总/写盘/校验」？
5. ~~无 @ 时 Coordinator 自动选人~~ — **不做**；人才派活以用户 `@` 为唯一入口。

相关：**统一编排**见 [`2026-06-13-run-orchestrator-design.md`](./2026-06-13-run-orchestrator-design.md)。
