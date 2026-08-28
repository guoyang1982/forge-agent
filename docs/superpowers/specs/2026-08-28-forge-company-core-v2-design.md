# Forge Company 与 Forge Core v2 正式设计方案

> 状态：待产品确认
>
> 日期：2026-08-28
>
> 范围：产品规划、功能设计、技术架构、迁移策略、阶段路线与验收边界
>
> 本文不授权或启动开发。详细实施任务将在本文确认后单独拆分。

## 1. 执行摘要

Forge 的下一阶段不是继续把所有能力堆进现有工作台，而是形成“一个可信执行底座、两个独立产品入口”：

```text
Forge Company（虚拟公司经营与数字员工协作）
                         ┐
                         ├── Forge Core v2（统一执行、治理与资产底座）
Forge Workbench（现有研发与通用 Agent 工作台）
                         ┘
```

本方案确认以下核心决策：

1. **Forge Company 作为独立应用建设**，面向公司经营、组织协作、产品交付、增长与收入闭环；不继续把公司功能塞进现有 Workbench 单页界面。
2. **Forge Workbench 继续承担专业执行工作台角色**，保留现有编码、会话、工具、人才、自动化等能力，并可从 Company 深链打开具体运行和工作区。
3. **两者共用 Forge Core v2**，共用 Runtime、Run、Workspace、Skill、Connector、Evidence、Policy、Budget 和 Trace 等基础能力，不复制 Agent 引擎。
4. **当前没有需要长期兼容的 Forge Agent 外部用户**，因此采用“单目标架构、分阶段直升 Core v2”，不长期维护 v1/v2 双运行时或双服务。
5. **直升不等于破坏式重写**。迁移期间必须保留 Git 基线、数据库备份、最小回归集、可重复迁移与阶段回滚；Desktop、CLI、Mobile、Channel Gateway 随 Core 一起迁移。
6. **Forge Company 的核心不是聊天和数字人形象，而是可验证的经营闭环**：目标进入系统后，经数字员工协作产生任务、运行、产物、证据、审批和业务指标。
7. **MVP 以“需求调研到产品交付”作为旗舰闭环**；第二阶段补齐营销、获客、销售、成交和客户反馈，形成增长与收入闭环。
8. **自治能力分级建设**。MVP 默认 L2：内部低风险工作可自动执行，外部发布、客户触达、付款、部署、删除等有副作用动作必须审批。L3/L4 只在数据、评测和治理成熟后开放。

最终产品价值可以概括为：

> 用户提出一个公司目标，Forge Company 组建合适的虚拟团队，在多个工作区和业务系统中完成研究、规划、研发、验证、推广和销售协作；用户始终看得见进度、成本、证据、风险和收益，并能在关键节点批准、接管或回滚。

## 2. 背景、问题与机会

### 2.1 已有能力

当前 Forge 已具备可复用的强基础：

- 自研 Agent Runtime、ReAct、计划、Reflection、检查点和工具调用。
- Desktop、CLI、Mobile、Channel Gateway 等多端入口。
- Skills、插件、MCP、Hooks、Extension Hub 与多 Runtime 分发。
- Talent Package、专家模板、团队派活和基础波次编排。
- 会话、事件、工具状态、文件变更、检查点和部分 Trace 数据。
- 自动化、长期记忆、项目记忆、人才运行记忆和文档提取能力。
- 本地优先的工作区与数据控制模式。

### 2.2 当前缺口

这些能力目前更像“能调用很多专家和工具的工作台”，尚不足以支撑一家虚拟公司的持续经营：

- 运行请求仍以单一 `cwd + message` 为中心，缺少跨工作区、分步骤、可恢复的业务执行模型。
- 现有 DAG 只覆盖轻量编排，缺少 Attempt、幂等、等待、恢复、补偿和持久化重试。
- 审批、权限和预算未形成统一、可审计、可按主体和动作判断的治理平台。
- 专家模板与“受雇的数字员工”尚未分层，无法稳定表达经理、岗位、KPI、授权和试用评估。
- 运行结果、业务产物、证据、验证和业务指标之间没有统一契约。
- 公司目标、项目、客户、活动、线索、商机和收入尚无业务域。
- 当前 Desktop renderer 体量过大，不适合作为公司产品继续扩张的主要容器。
- Daemon RPC、事件分发、模块组织和数据库迁移机制不足以支撑多个产品持续演进。

### 2.3 产品机会

多数 AI Agent 产品停留在“聊天—调用—返回文本”。Forge 可以形成差异化的三层产品：

1. **公司层**：目标、组织、项目、客户、增长、收入和经营指标。
2. **工作层**：任务、审批、产物、证据、跨工作区协作和自动化。
3. **执行层**：Runtime、工具、模型、连接器、权限、预算、Trace 和恢复。

三层打通后，数字员工不再只是角色 Prompt，而是能够在明确职责、权限、成本和验收标准下持续工作的可治理执行主体。

## 3. 产品目标、成功标准与非目标

### 3.1 MVP 目标

MVP 面向“一位人类创始人运营一家软件或 AI 产品公司”，做到：

- 创建公司、组织、岗位和数字员工。
- 设定公司目标并启动项目。
- 由 CEO 助手拆解、组队和协调工作。
- 支持纯需求调研，也支持从调研进入产品研发与发布。
- 不同专家在不同工作区并行工作，同一工作区保持单写者约束。
- 每个关键结论和交付都有产物、证据、验证和责任主体。
- 高风险动作进入统一审批，预算可见、可限制。
- 从 Company 可以打开 Workbench 查看和接管专业执行。

### 3.2 长期目标

- 完成产品交付、增长、销售、成交、客户成功和产品反馈的经营闭环。
- 从目标驱动逐步升级为事件驱动和指标驱动的 L3 自治。
- 建立模拟、影子运行和受控晋级机制，为部分低风险场景开放 L4。
- 让数字员工的收益可量化，而不是只统计消息数、模型调用数和模板数。

### 3.3 产品成功指标

核心北极星指标是：**有证据的闭环目标完成率**。

配套指标：

| 维度 | 指标 | 含义 |
|---|---|---|
| 结果 | 闭环成功率 | 目标按验收标准完成，并形成可验证结果的比例 |
| 效率 | 目标到结果周期 | 从目标创建到通过验收的耗时 |
| 人效 | 人工干预率 | 需要用户手动推进、补信息或接管的步骤占比 |
| 成本 | 单位有效结果成本 | 完成一个通过验收结果的模型、工具和人工成本 |
| 质量 | 首次验收通过率 | 首次提交即通过业务与技术验收的比例 |
| 可信 | 结果可追溯率 | 能追溯到 Run、证据、产物、责任人和版本的结果比例 |
| 管理 | 管理杠杆 | 每小时人工管理投入带来的已验证工作产出 |
| 增长 | 获客与转化效率 | 内容到线索、线索到商机、商机到成交的转化与成本 |
| 收入 | 可归因收入 | 能归因到活动、渠道、内容和销售动作的收入 |
| 风险 | 越权与事故率 | 未授权副作用、预算超限、数据泄漏和错误发布事件 |

### 3.4 非目标

首批版本明确不做：

- 云端多租户和复杂企业级组织管理。
- 全套 ERP、财务记账、HR 薪酬或法律合同系统。
- 以 3D 数字人、语音形象或社交装扮作为核心价值。
- 无审批的自动发帖、客户群发、付款、生产部署或破坏性操作。
- 在同一工作区允许多个 Agent 无约束并发写入。
- 一次性覆盖所有内容和销售渠道。
- 以 LLM 自评代替环境验证和业务证据。
- 完整 Event Sourcing；采用当前状态表加不可变事件与 Outbox。
- MVP 阶段开放 L4 全自治。
- 长期维护 Core v1/v2 两套服务、运行时和数据库。

## 4. 产品边界与应用形态

### 4.1 Forge Company

Forge Company 是经营管理与数字员工协作应用，回答：

- 公司要实现什么目标？
- 哪些人或数字员工负责？
- 当前工作、风险、预算和审批在哪里？
- 已产生什么产物和证据？
- 产品、增长、销售和收入产生了什么结果？
- 哪些工作适合继续自动化，哪些需要人接管？

建议建设为独立 Electron 应用 `apps/company-desktop`。它通过安全 preload 暴露的类型化 API 与本地 Daemon 通信，不允许 renderer 直接访问 Unix Domain Socket、Named Pipe、数据库或任意文件系统。

### 4.2 Forge Workbench

现有 `apps/desktop` 定位为 Forge Workbench，继续承担：

- 通用 Agent 会话与专业执行。
- 编码、调试、文件操作和命令运行。
- Run 详情、实时事件、Trace、Checkpoint 和接管。
- Skill、工具、Runtime 和开发者级配置。
- Company 深链进入后的具体任务执行视图。

Workbench 与 Company 是两个产品视角，不是两套执行引擎。

### 4.3 Forge Core v2

Core v2 提供与业务无关的可信执行原语：

- 类型化协议与能力协商。
- Agent Runtime 与持久执行。
- WorkspaceGroup、写入租约与检查点。
- 身份、权限、策略、审批和审计。
- 用量、预算和成本账本。
- 产物、证据、验证、Trace 和评测。
- Workflow、Automation、Connector、Knowledge 和 Memory。

### 4.4 Core 与 Company 的职责边界

| 归属 | 负责的概念 |
|---|---|
| Forge Core | Runtime、AgentProfile、Run、Step、Attempt、Workspace、Lease、Policy、Approval Primitive、Usage、Budget、Artifact、Evidence、Validation、Workflow、Connector、Trace |
| Forge Company | Company、Department、Position、Employee Employment、Goal、Project、WorkItem、Campaign、Content、Lead、Opportunity、Deal、Customer、KPI、经营分析 |
| 映射层 | `company_run_links` 将 Employee、WorkItem、Project 映射到 AgentProfile、Run、WorkspaceGroup、Artifact 和 Evidence |

Company 不能把业务状态藏进 LLM Memory；Core 也不理解“线索”“成交”“部门 KPI”等公司业务语义。

## 5. Forge Company 信息架构

### 5.1 全局框架

已确认的界面结构：

- **A：经营总览作为默认首页。**
- **B：组织结构作为“组织与员工”模块。**
- **C：CEO 助手作为全局右侧抽屉。**

全局框架还包含：

- 公司与环境切换。
- 全局搜索和命令入口。
- 待审批、风险、异常和预算通知。
- 当前自动化与运行状态。
- 跳转 Workbench 的深链入口。

### 5.2 十个业务模块

| 模块 | 主要功能 | 完成后的具体效果 | 直接收益 |
|---|---|---|---|
| 经营总览 | 目标、项目、收入漏斗、风险、预算、待决策、团队负载、今日动态 | 创始人打开首页即可知道公司是否朝目标前进、哪里需要决策 | 降低信息搜集和跨页面检查成本，提高管理反应速度 |
| 目标与项目 | 目标树、关键结果、项目组合、里程碑、依赖、资源和复盘 | 战略目标能够逐级落到项目、任务和结果 | 避免“做了很多事但不服务目标”，提升资源聚焦度 |
| 工作中心 | 我的工作、团队工作、WorkItem 看板、运行、阻塞、交付、接管 | 每项工作都有负责人、状态、输入、输出、证据和下一步 | 减少聊天丢任务、重复询问和责任不清 |
| 客户与增长 | ICP、活动、内容、渠道、线索、商机、成交、客户反馈 | 从内容发布到收入形成可追踪漏斗 | 判断哪些渠道和内容真正产生客户与收入 |
| 审批中心 | 权限、预算、发布、部署、外联、删除等审批；批量处理与过期 | 所有高影响动作在一个地方可看、可批、可拒、可委托 | 降低误操作和漏审批，减少等待时间 |
| 组织与员工 | 组织树、岗位、员工、汇报关系、招聘、试用、能力、绩效 | 把专家模板变成具有职责、授权和 KPI 的稳定数字员工 | 形成可复用团队，不必每次从 Prompt 临时组队 |
| 业务资产 | Skill、知识库、SOP、模板、报告、内容、代码交付和版本 | 工作结果能够沉淀、复用、升级和回滚 | 减少重复劳动，使公司能力随运行持续积累 |
| 自动化 | 定时、事件、Webhook、工作流、运行历史、失败恢复 | 重复工作按可靠流程持续运行，异常时进入处理队列 | 节省人工盯办时间，提高持续运营能力 |
| 经营分析 | 成功率、周期、成本、返工、渠道、转化、收入和员工 KPI | 将 Agent 活动转换为经营结果和单位经济性 | 能决定继续投入、优化还是停止某个流程或角色 |
| 公司设置 | 公司资料、风险偏好、预算、凭证引用、连接器、通知和数据策略 | 公司级规则统一生效，并可追溯变更 | 降低配置分散、权限漂移和凭证泄漏风险 |

### 5.3 经营总览首页

首页围绕“今天需要经营者做什么”组织，而不是简单堆指标。

推荐布局：

1. **目标健康度**：年度或季度目标、当前进度、预测、偏差与负责团队。
2. **需要你的决策**：待审批、关键分歧、范围变化、预算超限和高风险动作。
3. **核心项目**：阶段、里程碑、阻塞、最近交付和预计完成时间。
4. **增长与收入**：活动、内容、线索、商机、成交和归因收入趋势。
5. **数字员工运行状态**：正在工作、等待、失败、需要输入、成本和负载。
6. **风险与异常**：连续失败、权限拒绝、连接器异常、工作区冲突和数据陈旧。
7. **今日动态**：按重要性聚合的事件，不展示无意义的 Token 流水。

卡片必须能下钻到目标、WorkItem、Run、证据或审批，不允许成为孤立统计。

### 5.4 CEO 助手全局抽屉

CEO 助手不是普通聊天窗口，而是一个拥有全局只读经营上下文和受控执行能力的决策入口。

主要能力：

- 回答“目前最需要我处理的三件事是什么”。
- 将模糊目标转成候选目标、项目和验收标准。
- 推荐团队、负责人、工作区、预算和自治级别。
- 解释异常、目标偏差、成本变化和漏斗变化。
- 发起草案、WorkItem、审批或复盘，但不绕过相应权限。
- 将对话结论固化为结构化决策记录。
- 对外部副作用只生成提案，等待授权后交给执行层。

CEO 助手使用全局上下文时遵循最小披露原则：只获得当前问题所需的摘要、引用和授权数据，不默认拼接全公司原始对话。

## 6. 组织与数字员工设计

### 6.1 双组织模型

系统同时支持：

1. **稳定组织**：公司、部门、岗位、员工和汇报关系。
2. **临时项目团队**：围绕一个目标或项目组建，可跨部门、跨工作区，项目结束后解散或沉淀为模板。

稳定组织负责职责、授权、预算和绩效；项目团队负责交付目标和当前协作。

### 6.2 岗位模板与员工实例分离

岗位模板回答“这个岗位应该做什么”，员工实例回答“当前由谁以什么能力和权限承担”。二者不能混为一个 Prompt。

`PositionTemplate` 包含：

- 岗位使命与职责边界。
- 输入、输出和服务对象。
- 必备能力与推荐 Skills。
- 默认工具、知识库和连接器要求。
- 标准 KPI、验收器和风险等级。
- 默认自治建议和需要审批的动作。

`Employee` 包含：

- 身份、姓名、状态和所属公司。
- 当前岗位、经理和汇报关系。
- 关联的 Core `AgentProfile` 与能力快照。
- 已授予的 Skills、Tools、Knowledge、Connectors 和 Workspaces。
- 权限、自治级别、预算、KPI 和记忆作用域。
- 试用期、历史表现、失败记录、证据和版本。

### 6.3 首批公司角色

MVP 可以提供以下岗位模板，但创建时按目标精简招聘，不默认全部常驻：

| 角色 | 核心职责 | 主要产物 | 关键 KPI |
|---|---|---|---|
| CEO / 总经理 | 目标、优先级、资源、决策与跨部门协调 | 目标、决策、资源方案、经营复盘 | 目标达成、周期、预算、重大风险 |
| 产品总监 | 用户问题、产品方向、组合和范围治理 | 机会评估、路线、范围决策 | 需求命中率、交付价值、返工率 |
| 产品经理 | 调研、需求、规格、验收和反馈闭环 | 访谈、PRD、验收标准、反馈分析 | 首次验收率、需求周期、采纳率 |
| 研发总监 | 架构、工程质量、资源与发布策略 | 技术方案、风险、发布决策 | 交付周期、故障率、技术债 |
| 开发工程师 | 实现、测试、修复和技术文档 | 代码、测试、迁移、说明 | 验收通过率、缺陷率、周期 |
| QA / 验证专家 | 独立验证结果、过程和回答一致性 | 验证报告、缺陷、回归用例 | 漏测率、逃逸缺陷、复现率 |
| 运营总监 | GTM、渠道、内容节奏和活动复盘 | GTM 方案、活动计划、运营复盘 | 线索成本、转化率、内容效率 |
| 内容运营 | 内容选题、生产、适配和素材管理 | 小红书、抖音、公众号等渠道素材 | 合格发布量、互动、线索贡献 |
| 销售总监 | 线索规则、漏斗、预测和销售复盘 | 销售策略、预测、复盘 | 商机转化、周期、可归因收入 |
| 销售 / SDR | 线索研究、触达草案、跟进和 CRM 更新 | 账户画像、触达稿、跟进记录 | 合格线索、回复、预约、成交 |
| 客户成功 | 上手、健康度、反馈、续费和扩展 | 上手计划、健康报告、反馈单 | 激活、留存、续费、满意度 |

### 6.4 招聘与上岗流程

```text
选择岗位模板
  → 绑定 AgentProfile / 创建能力快照
  → 分配 Skills、知识、工具、连接器和工作区
  → 配置权限、自治、预算、KPI 和经理
  → 运行试用任务与评测
  → 人工确认上岗
  → 持续绩效与能力版本管理
```

试用必须使用可验证任务，不能仅由模型面试或自我介绍决定。岗位权限默认最小化，连接器只保存 `CredentialRef`，不把密钥写入员工 Prompt、Memory 或业务表。

### 6.5 结构化协作与交接

员工之间通过 `Handoff` 交接，至少包含：

- 结论和推荐动作。
- 已完成范围与未完成范围。
- 产物和证据引用。
- 假设、不确定项和风险。
- 需要下游确认的问题。
- 版本、责任人和时间。

默认不传递完整思考轨迹和原始上下文，以控制噪声、隐私和成本。

## 7. 核心业务对象与状态模型

### 7.1 业务对象

| 对象 | 作用 | 关键关系 |
|---|---|---|
| Company | 公司级数据与治理边界 | Departments、Employees、Goals、Policies |
| Goal | 可度量的经营目标 | Projects、Metrics、Owner、Review |
| Project | 为目标服务的阶段性容器 | WorkItems、Team、Milestones、WorkspaceGroup |
| WorkItem | 最小可指派、可验收工作单元 | Employee、Run、Artifacts、Evidence、Approval |
| Decision | 结构化经营或产品决策 | Context、Options、Rationale、Approver、Impact |
| Campaign | 一次增长活动 | Contents、Channels、Leads、Spend、Revenue |
| Lead | 可识别潜在客户 | Source、Score、Owner、Activities、Opportunity |
| Opportunity | 可管理销售机会 | Stage、Value、Probability、Activities、Deal |
| Deal | 成交记录 | Customer、Amount、Attribution、Evidence |
| Customer | 客户与使用反馈主体 | Deals、Health、Feedback、SuccessPlan |

### 7.2 WorkItem 作为统一工作载体

所有跨角色、跨模块、需要运行或验收的工作都落为 WorkItem。聊天消息、通知或卡片不是权威任务状态。

WorkItem 至少包含：

- `id`、`companyId`、`goalId`、`projectId`。
- 类型、标题、问题陈述和预期结果。
- Owner、Assignee、Reviewers 和参与者。
- 输入引用、工作区组和允许能力快照。
- 验收标准、验证策略和完成定义。
- 优先级、截止时间、风险等级和自治级别。
- 预算、实际用量、Run 链接和依赖。
- 产物、证据、审批、决策和交接。

建议状态机：

```text
draft → ready → in_progress → waiting_input / waiting_approval / blocked
                    ↓                    ↓
                 verifying ← submitted ─┘
                    ↓
               accepted → completed
                    ↘ rejected → in_progress

任意非终态可在授权后进入 cancelled；失败运行不会自动等于 WorkItem 失败。
```

### 7.3 运行状态与业务状态分离

`Run` 表示一次实际执行，`WorkItem` 表示业务承诺。一个 WorkItem 可以因重试、接管、模型切换或分步执行关联多个 Run。

```text
WorkItem
  ├── Run #1 → failed（保留证据）
  ├── Run #2 → waiting_approval
  └── Run #3 → succeeded
          └── Validation → passed
                  └── WorkItem → accepted/completed
```

因此不能用“最后一次模型返回成功”直接关闭业务任务。

## 8. 旗舰闭环一：需求调研到产品交付

### 8.1 支持纯需求调研

用户可以只创建“研究型项目”，无需承诺进入开发。流程如下：

```text
问题/想法输入
  → Intake 信息完整性检查
  → 用户研究、市场研究、现有数据/代码研究、风险研究并行
  → 证据聚合与矛盾检查
  → 机会判断与建议
  → 人工决策：结束、继续调研、进入产品定义
```

研究结果必须区分：事实、来源、推断、假设和未知项。没有来源的结论不能伪装成事实。

具体效果与收益：

- 研究过程可复用，避免不同专家重复搜集同一资料。
- 每个结论能回到原始证据，降低“看似合理但无法核实”的风险。
- 用户可以在投入研发前以较低成本停止低价值方向。
- 调研产物可直接成为后续产品规格的输入，无需重新整理聊天记录。

### 8.2 完整产品交付流程

```text
需求进入
  → CEO/产品负责人分诊
  → 多源并行研究
  → 范围、价值、验收和风险评审门
  → 组建产品/研发/验证项目团队
  → 跨工作区开发与结构化交接
  → 结果层、过程层、回答层三层验证
  → 发布审批
  → 发布、观察和复盘
  → 反馈回流目标与需求池
```

### 8.3 关键阶段与产物

| 阶段 | 主要负责人 | 必备产物 | 完成标准 |
|---|---|---|---|
| Intake | CEO 助手 / 产品经理 | 问题定义、目标用户、约束、缺失信息 | 问题可被研究或拆分 |
| 研究 | 用户、市场、代码、风险专家 | 引用式研究报告、冲突和未知项 | 主要结论有证据，未知项明确 |
| 产品定义 | 产品总监 / 产品经理 | 范围、用户故事、验收、优先级 | 价值、范围、验收和非目标获批 |
| 技术设计 | 研发总监 | 架构、接口、数据、迁移、风险 | 可实施、可验证、可回滚 |
| 开发 | 开发团队 | 代码、测试、迁移、文档 | 定向测试和构建通过 |
| 验证 | QA / 独立验证者 | 三层验证报告、缺陷、证据 | 环境结果、过程和回答均通过 |
| 发布 | 负责人 / 审批人 | 发布计划、回滚、观察指标 | 高风险审批通过且可回滚 |
| 复盘 | CEO / 产品 / 研发 | 目标结果、成本、问题和改进 | 结果回写指标与回归集 |

### 8.4 跨工作区协作

一个项目绑定 `WorkspaceGroup`：

```text
product-delivery
├── requirements      产品规格与验收
├── web-frontend      Web 前端仓库
├── backend-api       后端仓库
├── mobile            移动端仓库
├── docs              用户与开发文档
└── validation        集成验证与测试数据
```

规则：

- 每个员工只看见获授权的工作区、路径和工具。
- 不同工作区可并行写入。
- 同一工作区同一时刻只有一个有效写入租约；只读研究不占写租约。
- 建议通过工作树或分支隔离具体变更。
- 跨仓库里程碑生成组合检查点，记录各工作区提交、未提交差异、测试和依赖版本。
- 下游只消费已发布的产物或结构化交接，不隐式依赖另一个 Agent 的临时文件。

## 9. 旗舰闭环二：增长与收入

此闭环在产品交付 MVP 稳定后建设。

### 9.1 全流程

```text
产品价值与目标客户
  → GTM 策略与活动计划
  → 选题和内容工厂
  → 渠道适配（小红书 / 抖音 / 公众号等）
  → 合规、品牌和发布审批
  → 人工或受控连接器发布
  → 互动、来源和线索采集
  → 去重、丰富、评分和分配
  → 销售跟进、商机和成交
  → 客户成功、留存和反馈
  → 收入归因、复盘并回流产品
```

### 9.2 内容工厂

输入是产品价值、ICP、活动目标、品牌规则和渠道限制；输出不是一篇通用文章，而是一组有版本关联的渠道资产：

- 主题母稿与证据包。
- 小红书标题、正文、封面文案、评论引导和标签建议。
- 抖音脚本、分镜、口播、字幕、封面和 CTA。
- 公众号长文、摘要和菜单或社群分发文案。
- 落地页、表单和 UTM/来源标识。
- 品牌、事实、版权、敏感词和承诺检查结果。

具体收益：一份产品洞察可以被一致地适配多个渠道，同时保留内容来源、版本、成本和后续线索归因。

### 9.3 发布与外部副作用

MVP 与 P2 默认规则：

- 系统可自动完成研究、草拟、校验、排期建议和发布预览。
- 正式发布、私信、评论回复、邮件触达和 CRM 外部写入按风险策略审批。
- 每次外部动作带幂等键，避免重试造成重复发布或重复联系。
- 连接器失败进入可恢复队列；不能静默丢失或无限重试。
- 账号凭证只通过 Core Connector Gateway 的 `CredentialRef` 使用。

### 9.4 线索、销售与收入归因

线索模型至少记录：

- 首次与最近来源、Campaign、Content、Channel 和 UTM。
- 去重身份、组织、意图信号、评分和负责人。
- 已执行和建议执行的触达活动。
- 授权、退订、隐私和保留状态。

销售漏斗：

```text
visitor/interaction → lead → MQL → SQL → opportunity → won/lost → customer
```

归因同时保留首次触点、最后触点和多触点明细，早期不强行选择唯一归因模型。成交需要金额、客户、时间、证据和 Campaign/Content 关联，才能进入“可归因收入”。

### 9.5 增长闭环收益

- 从“内容发布量”升级到“哪些内容带来有效线索和收入”。
- 从多个平台手工复制，升级为母内容驱动的渠道化生产与校验。
- 销售获得带来源、兴趣和推荐下一步的线索，而不是杂乱名单。
- 客户反馈自动关联原始产品假设，帮助产品团队决定修复、扩展或停止。
- 经营者可以按渠道、活动、内容、员工和成本查看单位经济性。

## 10. 自治等级与晋级机制

### 10.1 自治等级

| 等级 | 系统行为 | 典型场景 |
|---|---|---|
| L0 辅助 | 只提供分析和建议，所有动作由人执行 | 战略讨论、敏感决策 |
| L1 草拟 | 生成计划、内容、任务和动作草案，人工确认后执行 | 需求规格、营销稿、销售邮件 |
| L2 受控执行 | 内部低风险步骤自动执行，关键节点和外部副作用审批 | MVP 默认：调研、编码、测试、产物生成 |
| L3 目标自治 | 在预算、策略和停止条件内自行拆解、调度、恢复和优化 | 成熟的内容流水线、监控与内部运营 |
| L4 受限经营自治 | 在经验证的业务域内根据目标和事件持续运行，仅异常升级 | 远期低风险业务单元，不覆盖高风险终局决策 |

### 10.2 晋级条件

自治不是配置一个数字即可开放。某个 Workflow、Employee 或 Connector 从 L2 晋级 L3/L4，必须同时满足：

- 有稳定、版本化的验收标准和评测集。
- 达到规定样本量的成功率、成本和事故指标。
- 关键动作有明确策略、预算、幂等和停止条件。
- 失败可恢复或补偿，状态可追溯。
- 先经过模拟或历史回放，再经过 Shadow，再经过限量 Canary。
- 人工可以随时暂停、接管、降级和撤销授权。
- 每次晋级有审批、有效期和重新认证时间。

### 10.3 永久保留治理的动作

即使进入 L4，以下动作默认仍要求明确策略或人工审批：

- 付款、退款、签约、法律承诺。
- 大规模客户触达、敏感数据导出。
- 生产发布、破坏性删除、权限扩大。
- 修改自身评测、策略、预算上限或审计记录。
- 招聘能够扩大权限边界的员工或连接新凭证。

## 11. Forge Core v2 升级能力

Core v2 采用 13 个平台 Epic，观测与评测作为所有 Epic 的横切要求。

### F1. Contracts v2：类型化协议与能力协商

建设内容：

- 定义统一 RPC Envelope、错误模型、请求 ID、超时、取消和版本。
- 为 Daemon、Desktop、Company、CLI、Mobile、Channel 生成或共享类型。
- 提供 `capabilities.get`，客户端按能力而非猜版本决定功能。
- 泛化事件订阅，不再只为单一请求特判 `agent.event`。

效果与收益：协议变更可编译发现，多个客户端能同步迁移，减少运行时 `unknown`、静默字段漂移和 if-chain 扩散。

### F2. Event Platform：可恢复事件平台

建设内容：

- 统一 Event Envelope：eventId、sequence、type、subject、tenant/company、run、timestamp、schemaVersion。
- 支持按 Run、WorkItem、Company、Workflow 订阅。
- 使用全局或分区单调序列、持久 Cursor、重连补发和事件去重。
- 业务事件通过 Outbox 与状态事务一起落库，再异步投递。
- 大体积内容进入 Artifact Store，事件保存摘要、哈希和引用。

效果与收益：应用重启、网络抖动或多个客户端并存时仍能恢复真实状态，为实时看板、通知、自动化和审计提供统一基础。

### F3. Modular Daemon Host：模块化服务宿主

建设内容：

- 将 Daemon 长路由链拆为模块注册、命令处理、查询处理和订阅处理。
- 明确模块生命周期、依赖、启动顺序、健康检查和优雅关闭。
- 领域模块只通过公开契约交互，禁止跨模块直改表或访问内部单例。
- 为 Workbench 与 Company 提供同一宿主内的隔离 API surface。

效果与收益：Core 能被两个产品共同演进，模块可单独测试和替换，避免主进程成为所有功能的冲突点。

### F4. Reliable Store：数据库迁移、锁与恢复

建设内容：

- 增加迁移日志表、校验和、应用状态、失败恢复和版本查询。
- 迁移必须幂等或明确一次性事务，提供兼容性检查和备份钩子。
- 明确 Daemon 为默认数据库迁移 Owner；Channel Gateway 等进程不能竞争迁移。
- 加入 SQLite busy timeout、WAL 管理、连接规范、备份与恢复验证。
- 当前状态表配合不可变事件、审计和 Outbox，不做完整 Event Sourcing。

效果与收益：Core 直升时能保留现有数据，避免多进程抢迁移、半完成 Schema 和不可恢复升级。

### F5. Durable Execution：持久执行引擎

建设内容：

- 一等对象：Run、Step、Attempt、Dependency、Wait、Retry、Timeout、Cancel、Resume。
- 每个外部副作用步骤需要 idempotency key；支持重试策略和补偿引用。
- 运行状态落库，进程重启后恢复等待、审批和可重试步骤。
- 支持父子 Run、并行分支、Join、人工输入和审批等待。
- 将现有单次 `cwd + message` 调用变成可兼容的简化入口，最终统一到 v2 RunSpec。

效果与收益：长任务不再依赖进程常驻；公司流程可以跨小时或数天等待审批、连接器和人工输入并继续执行。

### F6. WorkspaceGroup：多工作区与安全写入

建设内容：

- Workspace、WorkspaceBinding、WorkspaceGroup 和 PathScope。
- 读写模式、写入租约、租约续期、冲突检测和强制释放审计。
- 工作树或分支隔离、组合检查点和跨工作区交付清单。
- RunSpec 可为不同 Step 绑定不同工作区和能力。

效果与收益：每个专家可在不同仓库实际创建和修改内容，不同工作区安全并行，同一工作区避免并发踩踏。

### F7. Identity、Policy 与 Approval：统一治理

建设内容：

- 主体模型：Human、Employee、AgentProfile、Workflow、Connector、Service。
- 资源与动作模型：workspace.write、connector.publish、deployment.release、budget.spend 等。
- Scope、Grant、Condition、Risk、Decision 和 Policy Version。
- 策略结果统一为 allow、deny、require_approval，并记录解释。
- 审批持久化，支持委托、过期、撤销、批量处理和绑定原始动作摘要。

效果与收益：从“全局开关”升级到可按员工、任务、工作区和动作判断，所有高风险行为可审计且不能通过聊天绕过。

### F8. Usage 与 Budget Ledger：用量和预算账本

建设内容：

- 统一记录模型 Token、金额、工具计费、连接器费用和人工估算时间。
- 预算层级：Company、Department、Project、Workflow、Employee、WorkItem、Run。
- 支持 reserve、commit、release，防止并发运行共同超额。
- 阈值通知、硬停止、软提醒、例外审批和成本归因。

效果与收益：经营者能在执行前控制风险，在执行后计算单位结果成本和团队 ROI；自动化不会无上限消耗。

### F9. Artifact、Evidence 与 Validation：可信交付契约

建设内容：

- Artifact 保存类型、版本、内容地址、哈希、Owner、Producer Run 和访问范围。
- Evidence 保存声明、来源、定位、采集方式、时间和完整性信息。
- Validator 统一返回 passed、failed、inconclusive，并附证据和严重度。
- 支持结果层、过程层、回答层三层验证和独立验证者。
- 交付声明必须能关联验证结果，关键验证失败时禁止标记完成。

效果与收益：把“Agent 说做完了”升级为“系统能证明做完了”，为研发交付、研究报告、发布和经营分析提供可信基础。

### F10. AgentProfile 2.0：稳定能力身份

建设内容：

- 将人才模板、运行配置和公司员工关系分层。
- AgentProfile 引用模型策略、Skills、Tools、Knowledge、Memory、Connector、Policy 和 Validator 组合。
- 每次 Run 保存不可变能力快照和资产版本。
- 支持 Profile 评测、发布、升级、回滚和兼容性检查。

效果与收益：同一员工行为可复现、可评测、可升级；公司换岗或更新能力不会篡改历史运行事实。

### F11. Workflow 与 Automation 2.0

建设内容：

- 统一手动、Cron、Webhook、领域事件和外部事件触发。
- 工作流版本、输入 Schema、步骤、条件、并行、等待、重试、失败队列和人工接管。
- 基于 Durable Execution 执行，不再使用仅依赖 `setTimeout` 的临时调度。
- 防重复触发、并发上限、错过任务策略和运行日历。

效果与收益：把可靠业务流程沉淀成可重复运行的资产，系统重启或第三方故障后仍可恢复。

### F12. Knowledge 与 Memory 2.0

建设内容：

- Knowledge 表达当前可引用事实，Memory 表达带来源和有效期的经验；二者与 Skill、Tool 明确分离。
- 支持数据源同步、版本、删除传播、作用域、引用、原文定位和检索评测。
- Memory 使用候选、判断、版本、修正、失效和召回解释。
- 默认禁止把跨用户原始对话写入共享员工记忆。

效果与收益：数字员工基于可追溯的公司知识工作，同时避免陈旧记忆、隐私泄漏和“记住了错误答案”。

### F13. Connector Gateway：受控外部系统访问

建设内容：

- 连接器清单、Owner、CredentialRef、授权范围、健康检查和速率限制。
- 统一 read、propose、execute、reconcile 操作阶段。
- 外部写入使用策略判断、审批、幂等键、结果回读和审计。
- 对发布、邮件、CRM、日历、分析等适配器提供稳定接口。
- 凭证由安全存储管理，不进入事件、Trace、Prompt 或数据库明文字段。

效果与收益：Forge 从本地工作台扩展到真实业务系统，同时把误发、重复写入、权限过大和凭证泄漏风险控制在统一边界。

### 横切能力：Trace、Observability 与 Evals

每个 Epic 必须同步接入：

- runId、stepId、attemptId、spanId、parentSpanId 和 correlationId。
- 结构化日志、指标、耗时、重试、成本和错误分类。
- 敏感字段脱敏与大对象引用化。
- 失败轨迹转回归用例。
- 关键能力的确定性验证和版本对比。

它不是最后再补的“监控模块”，而是每项 Core 能力的完成条件。

## 12. 目标技术架构

### 12.1 运行时拓扑

```text
┌─────────────────────┐        ┌─────────────────────┐
│ Forge Company       │        │ Forge Workbench     │
│ Electron Renderer   │        │ Electron Renderer   │
└─────────┬───────────┘        └─────────┬───────────┘
          │ typed preload API             │ typed preload API
┌─────────▼───────────┐        ┌─────────▼───────────┐
│ Company Main/Client │        │ Workbench Main/Client│
└─────────┬───────────┘        └─────────┬───────────┘
          └──────────────┬────────────────┘
                         │ versioned RPC + event stream
              ┌──────────▼──────────┐
              │ Forge Daemon / Core │
              │ Modular Host v2     │
              ├─────────────────────┤
              │ Contracts / Events │
              │ Durable Execution  │
              │ Workspace / Policy │
              │ Budget / Evidence  │
              │ Assets / Connector │
              └───────┬───────┬────┘
                      │       │
             ┌────────▼──┐ ┌──▼────────────────┐
             │ data.db   │ │ Artifact / Secret │
             │ WAL       │ │ controlled stores │
             └───────────┘ └───────────────────┘

CLI / Mobile / Channel Gateway 同样使用 Contracts v2 接入 Core。
```

### 12.2 建议包边界

实际命名可在实施计划中按现有 monorepo 规范调整，但边界应保持：

| 包或应用 | 职责 |
|---|---|
| `apps/company-desktop` | Company UI、Electron main、preload、深链和桌面集成 |
| `apps/desktop` | Workbench UI 与专业执行入口 |
| `apps/daemon` | Core 模块宿主、RPC、订阅、生命周期 |
| `packages/contracts` | 类型化命令、查询、事件、错误与能力协商 |
| `packages/durable-execution` | Run、Step、Attempt、等待、恢复、重试与取消 |
| `packages/workspace-runtime` | WorkspaceGroup、租约、工作树、检查点 |
| `packages/policy` | 主体、授权、策略判断与审批原语 |
| `packages/usage-ledger` | 用量、预算、预留、提交与归因 |
| `packages/evidence` | Artifact、Evidence、Validation 与交付声明 |
| `packages/agent-profile` | 能力组合、快照、版本与评测 |
| `packages/workflows` | Workflow、Trigger、Automation 和失败恢复 |
| `packages/connectors` | Connector Gateway、CredentialRef 与适配器协议 |
| `packages/company-domain` | Company 业务实体、规则、用例和事件 |
| `packages/company-analytics` | 目标、运营、漏斗、成本和收入计算 |

Company UI 不直接导入 Core 内部实现；它只依赖公开 contracts 和 Company application API。

## 13. 数据设计

### 13.1 存储原则

- 初期继续使用本地 SQLite `data.db`，避免过早引入分布式基础设施。
- Daemon 是数据库写入和迁移的主要 Owner；其他客户端通过 RPC 访问。
- 业务表保存当前权威状态；事件、审计和 Outbox 保存不可变变更事实。
- 大文件、模型原始输出和媒体进入受控 Artifact Store，数据库保存元数据和哈希。
- 凭证只保存安全存储引用。
- 所有 Company 表使用 `company_*` 前缀或独立 schema 命名规范，避免和现有表含义冲突。

### 13.2 Core 关键表族

| 表族 | 主要数据 |
|---|---|
| `core_runs`, `core_steps`, `core_attempts` | 持久执行与状态 |
| `core_events`, `core_outbox`, `core_cursors` | 事件、投递和订阅进度 |
| `core_workspaces`, `core_workspace_groups`, `core_workspace_leases` | 工作区绑定和写租约 |
| `core_subjects`, `core_grants`, `core_policy_versions` | 身份和策略 |
| `core_approvals`, `core_approval_decisions` | 持久审批与结果 |
| `core_usage_entries`, `core_budget_accounts`, `core_budget_reservations` | 用量和预算账本 |
| `core_artifacts`, `core_evidence`, `core_validations` | 产物、证据和验证 |
| `core_agent_profiles`, `core_agent_profile_versions` | 能力身份和不可变版本 |
| `core_workflows`, `core_workflow_versions`, `core_triggers` | 工作流和触发器 |
| `core_connectors`, `core_connector_accounts`, `core_connector_actions` | 连接器与外部动作 |

### 13.3 Company 关键表族

| 表族 | 主要数据 |
|---|---|
| `company_companies`, `company_departments`, `company_positions` | 公司与稳定组织 |
| `company_employees`, `company_employments`, `company_reporting_lines` | 员工、任职与汇报 |
| `company_goals`, `company_metrics`, `company_reviews` | 目标、指标与复盘 |
| `company_projects`, `company_project_teams`, `company_milestones` | 项目和临时团队 |
| `company_work_items`, `company_work_dependencies`, `company_handoffs` | 工作、依赖和交接 |
| `company_decisions` | 结构化决策记录 |
| `company_campaigns`, `company_contents`, `company_channel_publications` | 活动、内容和发布 |
| `company_leads`, `company_lead_activities`, `company_opportunities` | 线索和商机 |
| `company_deals`, `company_customers`, `company_customer_feedback` | 成交、客户与反馈 |
| `company_attribution_touches` | 首次、最后和多触点归因 |
| `company_run_links` | 业务对象与 Core Run/Artifact/Evidence 映射 |

### 13.4 权威状态规则

| 信息 | 权威来源 |
|---|---|
| WorkItem 状态、Owner、验收、预算 | Company/Core 领域表 |
| 实际执行步骤、错误和重试 | Core Run、Step、Attempt、Event |
| 文件或外部系统结果 | Artifact、Evidence、Validation 与连接器回读 |
| 员工岗位、经理、KPI | Company 组织表 |
| 员工某次运行使用的能力 | Core AgentProfile Version Snapshot |
| 客户、商机、成交和归因 | Company CRM 表或经同步的外部 CRM |
| 当前公司事实 | 带来源与版本的 Knowledge Store |
| 经验和偏好 | 有作用域、来源和有效期的 Memory Store |

LLM 对话和 Memory 不能覆盖这些权威状态。

## 14. 关键契约

### 14.1 RunSpec v2

RunSpec 至少表达：

- Requester、Acting Subject 和能力快照。
- 目标、输入、验收标准和风险等级。
- WorkspaceGroup 与每个步骤的工作区绑定。
- 允许的模型、工具、Skills、Knowledge 和 Connectors。
- Policy、Budget、Deadline、Retry 和 Autonomy。
- 父 Run、WorkItem、Workflow 和 Correlation 引用。
- Artifact、Evidence 和 Validator 要求。

### 14.2 统一错误模型

错误至少包含：

- 稳定错误码、可读信息和安全的诊断摘要。
- 来源模块、run/step/attempt、可重试性和建议动作。
- 是否需要输入、审批、权限变更或人工接管。
- 原始详情的受控引用，不把敏感信息直接发给所有客户端。

错误类别包括：validation、policy、approval、budget、workspace conflict、connector、transient infrastructure、invalid input、cancelled、timeout 和 internal defect。

### 14.3 Artifact 与 Evidence

Artifact 是“产生了什么”，Evidence 是“凭什么相信某个声明”。例如：

- 代码提交是 Artifact；测试报告、构建日志和 diff 是 Evidence。
- 研究报告是 Artifact；引用网页、访谈记录和数据查询是 Evidence。
- 渠道稿件是 Artifact；事实校验、品牌检查和发布回执是 Evidence。
- 成交记录是业务状态；支付或合同回执是受控 Evidence。

### 14.4 深链契约

Company 到 Workbench 的深链应可定位：

- Run 或 Step。
- Session。
- Workspace 和允许路径。
- Artifact、Evidence 或 Validation。
- 只读查看或授权接管模式。

Workbench 返回 Company 时保留 WorkItem/Project 上下文，避免两个应用成为断裂体验。

## 15. 安全、权限、审批与预算

### 15.1 安全原则

- 默认最小权限，授权有作用域、目的和有效期。
- 读与写分离，内部写入与外部副作用分离。
- Prompt、Skill、网页和文件内容都不能直接扩大权限。
- 所有外部副作用经过策略引擎，必要时生成不可篡改审批快照。
- 审批必须绑定准确动作、参数摘要、预计成本和影响，不批准模糊意图。
- 凭证对 Agent 不可见，连接器代执行并回传脱敏结果。
- 关键事件、策略版本、审批人和证据可审计。

### 15.2 风险分层示例

| 风险 | 示例 | 默认处理 |
|---|---|---|
| 低 | 读取获授权资料、生成草稿、运行只读分析 | L2 可自动 |
| 中 | 修改隔离工作树、更新内部草稿、创建 CRM 草案 | 策略允许时自动，完整审计 |
| 高 | 正式发布、客户触达、生产部署、扩大权限 | 必须审批 |
| 极高 | 付款、法律承诺、批量删除、敏感数据导出 | 强审批或默认禁止 |

### 15.3 预算处理

- 运行开始前预留预算，完成后提交实际用量，取消或失败释放剩余预留。
- 并行 Step 的预算预留必须防止竞态超额。
- 软阈值用于提醒和降级模型，硬阈值用于暂停或请求例外审批。
- 预算既控制模型费用，也可以记录第三方调用、投放费用和人工复核成本。
- ROI 只使用实际提交的成本和已验证结果，不能用预测值冒充实际收益。

## 16. Core v2 直升迁移方案

### 16.1 迁移决策

采用：**单仓库、单 Daemon、单数据库目标 Schema、单 Runtime、分阶段直升 v2**。

不采用：

- 长期运行 v1/v2 两套 Daemon。
- 长期维护两套 Run Engine 和两份数据。
- 为不存在的外部用户保留无限期旧协议。
- 先破坏全部功能、最后再集中修复的“大爆炸”方式。

迁移期间允许短期 Adapter，但必须：

- 只服务于当前仓库内部客户端迁移。
- 有明确删除条件和归属阶段。
- 不承载新产品功能。
- 所有消费者迁移并通过回归后立即删除。

### 16.2 为什么不需要独立 v2 产品版本

当前没有外部 Forge Agent 用户依赖旧接口，维护双版本会增加协议、数据库、事件、测试和排障成本，却不能产生相应用户收益。内部 Desktop、CLI、Mobile 和 Channel Gateway 可以在同一仓库内按阶段共同迁移。

但“没有外部用户”不代表“没有兼容风险”：现有代码、现有本地数据、现有 Skills、Runtime、人才模板和多端客户端仍是宝贵资产，必须纳入回归和迁移验收。

### 16.3 迁移阶段

#### F0-A：基线、备份与回归护栏

- 固化当前可构建、可运行的 Git 基线。
- 备份并验证恢复现有 `data.db` 和关键 JSON/资产数据。
- 建立 Desktop、CLI、Mobile、Channel 的最小冒烟集。
- 为 Run、Session、Event、Checkpoint、Skill、Talent、Automation 和 Workspace 建立数据夹具。
- 记录当前协议、数据 Schema 和关键行为基线。

完成效果：后续任何阶段失败都能定位差异、恢复数据或回退代码，而不是“有问题再猜”。

#### F0-B：Contracts、Daemon Host 与 Reliable Store

- 先建立 v2 类型化协议和能力协商。
- 拆分 Daemon Host，但暂不改变核心执行语义。
- 引入正式迁移日志、数据库 Owner、备份钩子和 Outbox 地基。
- 迁移内部客户端到统一 client SDK。

完成效果：先把未来变化集中到稳定边界，减少后续 Core 模块升级对所有客户端的重复冲击。

#### F0-C：Durable Execution 与 Event Platform

- 将现有 Session/Run/Event 能力映射到 Run/Step/Attempt。
- 建立可恢复状态、Cursor、订阅、重试、等待和取消。
- 旧 `run(cwd, message)` 暂时通过内部 Adapter 转成简化 RunSpec。
- 逐个迁移 Workbench、CLI、Mobile、Channel 的运行与事件路径。

完成效果：现有功能继续可用，同时获得支撑公司长流程的执行底座。

#### F0-D：Workspace、Policy、Approval、Budget 与 Evidence

- 加入多工作区、写租约和组合检查点。
- 将全局权限和内存审批迁为持久策略与审批。
- 建立用量预算账本、Artifact/Evidence/Validation 契约。
- 让现有 Skill、Talent、Automation 运行接入能力快照和 Trace。

完成效果：Core 从“能执行”升级为“能安全、可控、可证明地执行”。

#### F0-E：内部客户端收口与 Legacy 删除

- 所有内部客户端只调用 Contracts v2。
- 比对数据、行为、事件和关键 UX 回归。
- 删除 v1 RPC、旧事件特判、临时 Adapter 和不可达实现。
- 生成最终迁移报告和恢复演练记录。

完成效果：仓库只剩一套长期维护架构，不把迁移债带入 Forge Company。

### 16.4 不影响现有功能的保障

“保证不会影响”不能等同于承诺零缺陷，而应落实为可验证的工程门：

1. **每阶段可构建**：受影响包和四类内部客户端都保持可构建。
2. **最小冒烟通过**：新建会话、运行工具、查看事件、取消、恢复、Checkpoint、Skill/Talent、Automation 等核心路径通过。
3. **数据迁移可重放**：同一迁移不会重复破坏数据，失败能识别并停止。
4. **旧数据可读取**：现有 Session、配置、人才和自动化数据有迁移或导入验证。
5. **事件不丢不重做副作用**：重连可补发，客户端去重，外部动作有幂等键。
6. **阶段性 Git 回退**：每阶段提交边界清晰，不混入 Company 新功能。
7. **数据库恢复演练**：不是只生成备份文件，而是实际验证可恢复。
8. **Legacy 后删**：替代路径和所有消费者通过后才删除旧实现。

### 16.5 现有资产保留策略

默认保留：

- Agent Runtime 和工具执行能力。
- Skills、插件、MCP、Hooks 与 Extension Hub 生态。
- Talent 模板与可复用能力定义。
- Session、Event、Checkpoint 和用户工作区数据。
- Desktop、CLI、Mobile、Channel Gateway 的有价值交互。
- 本地优先和用户控制数据的原则。

需要重构的是它们的契约、持久执行、治理和组织方式，不是重新实现已有价值。

## 17. 可靠性与异常处理

### 17.1 关键故障场景

| 故障 | 系统处理 |
|---|---|
| Daemon 重启 | 从持久 Step/Attempt 恢复；运行进入可判定状态，不静默丢失 |
| 客户端断线 | 通过 Cursor 补发事件；客户端按 eventId 去重 |
| LLM 或工具瞬时失败 | 按策略重试，超过上限转人工或失败队列 |
| Connector 超时 | 查询外部状态并 reconcile，避免盲目重复副作用 |
| 审批长期未处理 | 到期提醒、委托或取消；Run 保持 waiting_approval |
| 预算不足 | 运行前拒绝或请求例外；执行中到阈值安全暂停 |
| 工作区租约冲突 | 阻止第二写者，允许排队、转只读或人工解决 |
| 验证失败 | WorkItem 返回 in_progress/rejected，保留失败证据和修复任务 |
| 数据迁移失败 | 事务回滚或停止启动，输出明确恢复步骤，不继续带病运行 |
| 事件投递失败 | Outbox 重试并记录失败；消费者幂等处理 |

### 17.2 人工接管

人工接管必须是正式状态转换：

- 记录接管人、原因、时间和上下文快照。
- 暂停 Agent 的冲突步骤和写入租约。
- 保留当前产物、证据、未完成动作和预算。
- 人工完成后可关闭、重新派发或从检查点恢复。

## 18. 测试、评测与验收体系

### 18.1 测试层次

| 层次 | 重点 |
|---|---|
| Contract | RPC、事件、Schema、错误与版本兼容 |
| Domain | 状态机、权限、预算、归因和业务规则 |
| Storage | 迁移、并发、Outbox、备份和恢复 |
| Execution | 重试、等待、取消、恢复、幂等和父子 Run |
| Workspace | 租约、并行、工作树、组合检查点和冲突 |
| Connector | Mock、Sandbox、幂等、回读、限流和凭证隔离 |
| Client | Company、Workbench、CLI、Mobile、Channel 冒烟与关键流程 |
| End-to-end | 需求闭环、增长闭环和审批/失败恢复 |
| Eval | 模型、Prompt、Skill、Profile 和 Workflow 的任务成功率 |

### 18.2 三层验证

每个关键交付分别验证：

1. **结果层**：文件、测试、数据库、发布平台或 CRM 的实际状态。
2. **过程层**：是否遵守权限、预算、工具约束和必要审批。
3. **回答层**：最终结论是否与真实执行、证据和已知未知项一致。

### 18.3 关键回归场景

- 单工作区普通对话和编码任务。
- 多工作区并行、同工作区写冲突和租约恢复。
- 运行中 Daemon 重启、客户端重连和事件补发。
- 审批前暂停、批准后继续、拒绝后终止或返工。
- 预算预留、并行竞争、释放和超限。
- Connector 重试不造成重复发布或重复联系。
- 旧数据库升级、重复启动和恢复到备份。
- 研究结论引用、代码交付验证和最终声明一致性。
- Company 深链 Workbench、接管并回写 WorkItem。

### 18.4 自治评测

L3/L4 的评测除成功率外，还必须覆盖：

- 是否知道何时停止或请求帮助。
- 是否在信息不足时主动暴露未知项。
- 是否遵守预算、权限和外部副作用规则。
- 是否能从失败恢复且不重复副作用。
- 是否会修改目标、评测或策略来“优化指标”。
- 长期运行中的漂移、成本和异常升级质量。

## 19. 分阶段路线图

### 19.1 总体顺序

```text
F0 Core v2 可信执行底座与内部迁移
  → Company P0 公司、组织、工作与经营驾驶舱
  → Company P1 需求调研到产品交付 MVP
  → Company P2 增长与收入闭环
  → Company P3 事件/目标驱动 L3 自治
  → Company P4 模拟、Shadow、Canary 与有限 L4
```

对外可用的首个 Company MVP = **F0 + Company P0 + Company P1**。

### 19.2 阶段效果、收益与进入门

| 阶段 | 交付范围 | 做完后的具体效果 | 主要收益 | 进入下一阶段的门 |
|---|---|---|---|---|
| F0 | Core v2、客户端迁移、Legacy 删除 | 一套可恢复、可治理、可验证、支持多工作区的执行平台 | 降低后续重复建设和架构风险 | 核心回归、迁移恢复、事件与持久执行通过 |
| Company P0 | 公司、组织、员工、目标、项目、WorkItem、审批、首页、CEO 抽屉 | 用户可以组建虚拟公司，看到和管理结构化工作 | 管理从聊天转为目标、责任、证据和决策 | 能完成内部无外部连接器的公司工作闭环 |
| Company P1 | 调研、规格、开发、三层验证、发布门、Workbench 深链 | 一个需求可从研究流转到有证据的产品交付 | 缩短需求到交付周期，降低返工和虚假完成 | 闭环成功率、首次验收、成本和接管达到基线 |
| Company P2 | GTM、内容工厂、渠道、线索、销售、客户和归因 | 产品结果可进入获客、商机、成交和反馈 | 看到真实增长效率和可归因收入 | 连接器治理稳定，隐私、幂等和审批通过 |
| Company P3 | 目标/事件驱动工作流、异常管理、L3 授权 | 成熟流程可在预算和策略内持续运行 | 减少人工盯办，提升运营连续性 | 足够评测样本、低事故率、可暂停接管 |
| Company P4 | 模拟、历史回放、Shadow、Canary、晋级治理 | 部分低风险业务单元能有限自治 | 扩大管理杠杆，同时控制长期运行风险 | 仅逐场景授权，不以全局开关开放 L4 |

### 19.3 优先级原则

- 优先完成能产生独立闭环价值的能力，不先建设庞大模板市场。
- Core 先补“所有业务都会依赖且后改代价高”的基础，不提前实现 Company 业务语义。
- Company P0/P1 与 Core v2 边界确定后可在实施阶段适度并行，但不能绕过核心契约和治理。
- 小红书、抖音优先作为增长渠道；公众号、邮件、CRM 按真实需求逐步加入。
- 每个新增渠道必须复用 Connector Gateway，不能在 Company 里直接保存凭证或拼接私有 API。

## 20. 与现有 `docs/roadmap.md` 的关系

本方案不是替代长期路线图，而是把其中的能力组织成 Forge Company 的前置平台和分阶段产品闭环。

### 20.1 已覆盖或直接复用

| 现有路线图 | 本方案落点 |
|---|---|
| R1 Agent 评测中心 | 横切 Evals、自主等级晋级和 Core 回归门 |
| R2 Trace、Span 与回放 | Event Platform、Durable Execution 横切 Trace |
| R3 三层自动验证 | F9 Artifact/Evidence/Validation 与交付流程 |
| R4-R5 状态栏与上下文压缩 | AgentProfile/Run 上下文与 Workbench 执行体验 |
| R6 知识库 | F12 Knowledge 2.0、调研与公司事实 |
| R7 记忆中心 2.0 | F12 Memory 2.0、员工记忆作用域 |
| R8 AI 资产生命周期 | AgentProfile、Skill、Workflow 和业务资产模块 |
| R9 多工作区专家团队 | F6 WorkspaceGroup 与产品交付闭环 |
| R10-R13 成长、沉淀、专家包和发布门 | 组织员工、业务资产、旗舰岗位与流程模板 |
| R14 连接器治理 | F13 Connector Gateway |
| R15 Automation 2.0 | F11 Workflow/Automation 2.0 |
| R16 统一审批与通知 | F7 与 Company 审批中心 |
| R17 结构化交接 | Handoff 契约与项目团队协作 |
| R18 模型路由与预算 | F8 Usage/Budget Ledger 与 AgentProfile 策略 |
| R19 工具渐进式发现 | AgentProfile 能力解析和运行时加载 |
| R20 ROI 看板 | Company 经营分析、单位结果成本与收入归因 |
| R21 失败转回归 | 横切 Trace/Evals 和复盘流程 |
| R22 离线受控进化 | Company P4 模拟、Shadow 和晋级 |
| R23 外部 Agent/A2A | 远期作为受治理 Subject/Employee 接入 |
| R24 多模态实时工作台 | 条件型能力，不影响 Company MVP |

### 20.2 本方案新增或明确补齐

- Contracts v2 与多客户端能力协商。
- 通用、可恢复的 Event Platform 与 Cursor。
- Modular Daemon Host。
- 迁移日志、数据库 Owner、Outbox、备份恢复等 Reliable Store 能力。
- 通用 Durable Execution，而不只是某个业务 DAG。
- 主体、资源、动作和策略化审批原语。
- reserve/commit/release 的层级预算账本。
- Company 与 Core 的反腐映射层和权威状态边界。
- Forge Workbench 与 Forge Company 两应用形态。
- 直升 Core v2 的内部迁移与 Legacy 删除策略。
- 从需求交付延伸到增长、销售、收入和客户反馈的完整经营闭环。

建议在本文确认后，将 `docs/roadmap.md` 增加一个“Forge Core v2 / Forge Company”项目群入口，但不把本文全部内容重复粘贴进去。

### 20.3 交互与架构原型索引

本次设计过程已经生成以下本地 HTML 原型，用于评审页面结构、关键闭环和技术关系；本文是权威规格，原型若与本文冲突，以本文为准：

| 原型 | 用途 |
|---|---|
| `.superpowers/brainstorm/16595-1787890057/content/product-shell.html` | A 默认首页、B 组织模块、C CEO 抽屉的产品框架 |
| `.superpowers/brainstorm/16595-1787890057/content/information-architecture.html` | Company 十模块信息架构 |
| `.superpowers/brainstorm/16595-1787890057/content/organization-digital-employees.html` | 组织、岗位、员工、汇报和团队关系 |
| `.superpowers/brainstorm/16595-1787890057/content/goal-to-execution-flow.html` | 目标到 WorkItem、Run、证据和审批的主链路 |
| `.superpowers/brainstorm/16595-1787890057/content/requirement-delivery-pipeline.html` | 纯调研及需求到交付流程 |
| `.superpowers/brainstorm/16595-1787890057/content/growth-revenue-loop.html` | 内容、渠道、线索、销售和收入闭环 |
| `.superpowers/brainstorm/16595-1787890057/content/technical-architecture.html` | Company、Workbench 与 Core 的技术边界 |
| `.superpowers/brainstorm/16595-1787890057/content/forge-core-upgrade-map.html` | Core 升级能力图 |
| `.superpowers/brainstorm/16595-1787890057/content/delivery-roadmap.html` | 分阶段交付路线 |
| `.superpowers/brainstorm/16595-1787890057/content/integrated-forge-platform-plan.html` | 汇总版平台设计视图 |

这些原型是当前本地设计会话资产，不作为 Core 运行依赖，也不纳入本次设计文档提交。

## 21. 决策记录

| 决策 | 结论 | 原因 |
|---|---|---|
| 在现有 Forge 还是新应用 | 同仓库、独立 Forge Company 应用、共享 Core | 保留执行资产，同时避免现有 UI 与业务边界继续膨胀 |
| Company 首页 | 经营总览 | 用户首先需要看到目标、风险、决策和结果 |
| 组织结构位置 | 独立“组织与员工”模块 | 组织是重要业务域，但不是每天唯一入口 |
| CEO 助手形态 | 全局抽屉 | 在任意业务上下文中可用，同时不取代结构化页面 |
| 纯调研是否支持 | 支持独立结束的研究项目 | 研发前验证机会本身就是高价值结果 |
| 产品完成后是否覆盖增长销售 | 覆盖，作为 P2 完整闭环 | 公司价值最终需要连接客户和收入 |
| Core 是否做 v1/v2 双版本 | 不做长期双版本，分阶段直升 v2 | 当前无外部用户，双维护收益低、成本高 |
| 现有数据如何处理 | 默认保留并验证迁移 | 数据和资产价值独立于是否有外部用户 |
| MVP 自治级别 | L2 | 先建立证据、策略、预算和审批，再扩大自治 |
| 最终能否升级全自治模拟型 | 可以，但通过 P4 逐场景晋级 | 全局开放 L4 风险不可控，模拟与影子数据是前提 |

## 22. 设计验收标准

本文确认后，详细实施计划必须满足：

- 明确 F0、Company P0、P1、P2、P3、P4 的独立工作包和依赖。
- 任务细化到可执行、可验证、可单独提交的粒度。
- 每个 Core 迁移任务包含受影响客户端、数据、回归和回滚说明。
- 每个 Company 功能任务包含用户场景、领域对象、API、UI、权限、事件和验收。
- 不将开发任务与规格确认混在一个提交中。
- 不在对应替代路径和全部内部消费者通过回归前删除已有核心实现。
- 不在治理、幂等、评测和恢复不成熟时开放外部自动动作或 L3/L4。

正式任务拆分将在本设计确认后另存为实施计划，并继续遵守“只规划、不执行开发”的当前约束。
