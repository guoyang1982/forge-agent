# Forge Company + Forge Core v2 Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不长期保留 v1/v2 双架构的前提下，将现有 Forge 直升为统一 Core v2，并分阶段交付 Forge Company 的经营、产品交付、增长收入和受控自治闭环。

**Architecture:** 一个模块化 Forge Daemon 承载 Core v2，Workbench、Company、CLI、Mobile 和 Channel Gateway 通过 `@forge/protocol` v2 类型化契约接入。实施被拆为九个可独立验收的子计划；每个子计划结束时都必须产生可运行软件和明确回归门，Company 不复制 Runtime、数据库或连接器治理。

**Tech Stack:** Node.js >=22、TypeScript 5.8.3、pnpm workspace、Vitest 3.0.9、Electron 39.8.5、React 19.2.3（Company renderer）、better-sqlite3 13.0.2、SQLite WAL、esbuild 0.25.0。

**Spec:** `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

## Global Constraints

- 当前任务只生成和维护计划；只有用户另行授权后才执行开发。
- 目标架构只有一套 Daemon、数据库 Schema、Runtime 和工具生态，不建立长期 v1/v2 双服务。
- 现有数据默认保留；任何 Schema 变更必须有迁移测试、备份恢复验证和重复启动验证。
- Desktop、CLI、Mobile、Channel Gateway 是必须同步迁移的内部消费者。
- 同一工作区同一时刻只允许一个有效写入租约；不同工作区可以并行。
- WorkItem 是业务权威任务载体；Run 是执行事实；LLM 对话和 Memory 不得覆盖业务状态。
- 外部发布、客户触达、生产部署、付款、删除和权限扩大默认需要持久审批。
- 凭证只通过 `CredentialRef` 使用，不进入 Prompt、Memory、Event 或业务表明文字段。
- 关键交付必须有 Artifact、Evidence 和三层 Validation，验证失败不得标记完成。
- MVP 自治等级为 L2；L3/L4 必须通过评测、模拟、Shadow、Canary 和逐场景晋级。
- 每个代码任务使用 TDD：先写失败测试，再写最小实现，再运行定向测试与受影响包测试。
- 每个任务独立提交；不得混入当前工作区已有的无关修改。

---

## 1. 计划套件与交付边界

| 顺序 | 子计划 | 对应范围 | 独立交付结果 |
|---:|---|---|---|
| 1 | `2026-08-28-forge-core-v2-platform-foundation.md` | F0-A、F0-B、F1、F3、F4 | 类型化协议、模块化 Daemon、可靠迁移与恢复基线 |
| 2 | `2026-08-28-forge-core-v2-durable-execution-events.md` | F0-C、F2、F5、Trace | 可重启恢复的 Run/Step/Attempt 和 Cursor 事件平台 |
| 3 | `2026-08-28-forge-core-v2-governance-workspaces-evidence.md` | F0-D、F6-F10 | 多工作区、策略审批、预算、证据和 AgentProfile |
| 4 | `2026-08-28-forge-core-v2-assets-connectors-clients.md` | F0-E、F11-F13 | Workflow、Knowledge/Memory、Connector、多端迁移和 Legacy 删除 |
| 5 | `2026-08-28-forge-company-p0-operating-system.md` | Company P0 | Company 应用、组织员工、目标项目、工作审批、首页和 CEO 抽屉 |
| 6 | `2026-08-28-forge-company-p1-delivery-loop.md` | Company P1 | 纯调研与需求到产品交付闭环 |
| 7 | `2026-08-28-forge-company-p2-growth-revenue.md` | Company P2 | GTM、内容、渠道、线索、销售、成交和客户反馈 |
| 8 | `2026-08-28-forge-company-p3-goal-autonomy.md` | Company P3 | 目标/事件驱动的 L3 受控自治 |
| 9 | `2026-08-28-forge-company-p4-simulation-autonomy.md` | Company P4 | 模拟、Shadow、Canary 和有限 L4 晋级 |

## 2. 依赖关系

```text
Core Foundation
  └── Durable Execution + Events
        └── Governance + Workspaces + Evidence
              ├── Assets + Connectors + Client Migration
              │      └── Legacy deletion gate
              └── Company P0
                     └── Company P1
                            └── Company P2
                                   └── Company P3
                                          └── Company P4
```

允许的工程并行：

- Core Foundation 的协议与 Store 边界稳定后，可以并行搭建 Company 静态 Shell 和领域单元测试。
- Durable Execution 稳定后，可以并行开发 Company WorkItem 映射，但 Company 集成门必须等待 Governance 通过。
- Company P2 的纯领域模型可以在 P1 后期开发，真实外部动作必须等待 Connector Gateway 验收。
- P3/P4 的场景与评测数据可以提前设计，但运行能力必须按阶段门开放。

不允许的并行：

- Reliable Store 生效前，不新增另一套直接打开 `data.db` 的进程。
- Policy、Approval、Budget 未通过前，不接入 Company 外部副作用。
- v2 客户端回归未通过前，不删除 v1 RPC 或事件兼容 Adapter。
- P3 评测和停止机制未通过前，不启用任何 L3 生产运行。

## 3. 规格覆盖矩阵

| 设计规格范围 | 实施计划与任务 |
|---|---|
| 一个 Core、Company/Workbench 两应用 | Foundation Tasks 2-8；Client Migration Tasks 7-10；Company P0 Task 1 |
| 十模块 IA、A/B/C 布局 | Company P0 Tasks 10-15 |
| 组织、岗位模板、员工、招聘和汇报 | Company P0 Tasks 2-4、11 |
| Goal、Project、WorkItem、Decision、Handoff | Company P0 Tasks 5-8、12 |
| CEO 全局助手 | Company P0 Task 13 |
| 纯需求调研 | Company P1 Tasks 1-5、9-10 |
| 多工作区产品交付 | Governance Tasks 2-3、10-11；Company P1 Tasks 6-10 |
| 三层验证、Artifact 和 Evidence | Governance Tasks 7、10-11；Company P1 Task 8 |
| 增长、内容、小红书/抖音、线索、销售和收入 | Company P2 Tasks 1-12 |
| L0-L3 受控自治 | Company P3 Tasks 1-8 |
| Simulation、Replay、Shadow、Canary、有限 L4 | Company P4 Tasks 1-8 |
| Contracts v2 和能力协商 | Foundation Tasks 2-3、6-8 |
| Event Platform、Trace、Evals | Durable Execution Tasks 1、4-5、8-11 |
| Modular Daemon Host | Foundation Tasks 6-8 |
| Reliable Store、迁移、备份和恢复 | Foundation Tasks 1、4-5、9 |
| Durable Execution | Durable Execution Tasks 1-3、5-8、10 |
| WorkspaceGroup 和 single-writer | Governance Tasks 2-3、9-10 |
| Identity、Policy、Approval | Governance Tasks 4-5、10-11 |
| Usage/Budget Ledger 和模型路由 | Governance Tasks 6、9-11 |
| AgentProfile 2.0 | Governance Task 8 |
| AI 资产统一生命周期 | Assets/Connectors Tasks 1-2；Company P0 Task 15 |
| Workflow/Automation 2.0 | Assets/Connectors Tasks 3-4 |
| Knowledge/Memory 2.0 | Assets/Connectors Tasks 5-6 |
| 动态状态与自适应压缩 | Assets/Connectors Task 7 |
| Connector Gateway/CredentialRef | Assets/Connectors Task 8；Company P2 Task 5 |
| Desktop/CLI/Mobile/Channel 迁移和 Legacy 删除 | Assets/Connectors Tasks 9-12 |
| 经营指标、ROI 和归因 | Company P0 Tasks 7、15；Company P2 Tasks 9、11-12 |

矩阵中的每一项均有明确文件、测试、命令和提交步骤；条件型的外部 A2A 与多模态实时工作台不属于本项目必交范围，继续保留在长期 `docs/roadmap.md` 中按真实需求立项。

## 4. 里程碑与发布门

### Milestone M0：可恢复基线

- [ ] 当前 Git 基线、Schema、数据备份和恢复演练记录已保存。
- [ ] `pnpm build`、`pnpm test`、`pnpm smoke` 的基线结果已归档。
- [ ] Desktop、CLI、Mobile、Channel Gateway 最小冒烟用例均有自动化入口。
- [ ] 旧数据夹具覆盖 Session、Event、Checkpoint、Talent、Automation 和 Channel。

### Milestone M1：Core v2 Foundation

- [ ] `@forge/protocol` 的公开调用全部由 `RpcContractMap` 类型约束。
- [ ] Daemon 使用模块注册路由，`main.ts` 不再包含业务 if-chain。
- [ ] `schema_migrations` 能识别、校验并只应用一次迁移。
- [ ] 只有 Daemon 拥有迁移权；其他进程不竞争应用迁移。
- [ ] 备份文件可以恢复并重新启动 Daemon。

Gate commands:

```bash
pnpm --filter @forge/protocol test
pnpm --filter @forge/store test
pnpm --filter @forge/bus test
pnpm --filter @forge/daemon test
pnpm --filter @forge/daemon build
```

### Milestone M2：Durable Core

- [ ] Run/Step/Attempt 在 Daemon 重启后恢复到确定状态。
- [ ] 等待输入、等待审批、重试、取消和恢复均有状态机测试。
- [ ] 事件支持 eventId、sequence、Cursor、补发和去重。
- [ ] Outbox 与状态变更同事务落库。
- [ ] 旧 `RunRequest` 通过临时 Adapter 进入 RunSpec v2。

Gate commands:

```bash
pnpm --filter @forge/execution test
pnpm --filter @forge/event-store test
pnpm --filter @forge/run-orchestrator test
pnpm --filter @forge/daemon test
```

### Milestone M3：Trusted Core

- [ ] WorkspaceGroup 和 single-writer 租约通过并发与恢复测试。
- [ ] Policy 统一返回 `allow | deny | require_approval` 并保存解释。
- [ ] 审批、预算预留和释放均持久化。
- [ ] Artifact/Evidence/Validation 能阻止未验证完成声明。
- [ ] AgentProfile 每次运行保存不可变能力快照。

Gate commands:

```bash
pnpm --filter @forge/workspace test
pnpm --filter @forge/policy test
pnpm --filter @forge/usage-ledger test
pnpm --filter @forge/evidence test
pnpm --filter @forge/agent-profile test
```

### Milestone M4：单一 Core v2 完成

- [ ] Workflow、Knowledge/Memory 和 Connector 使用 v2 原语。
- [ ] Workbench、CLI、Mobile、Channel Gateway 全部使用 v2 client SDK。
- [ ] v1 RPC、事件特判和临时 Adapter 已删除。
- [ ] 现有数据升级、运行、回退和再升级通过。
- [ ] 根级构建、测试与冒烟通过。

Gate commands:

```bash
pnpm build
pnpm test
pnpm smoke
```

### Milestone M5：Forge Company MVP

- [ ] Company P0 和 P1 通过。
- [ ] 用户可以创建公司、招聘员工、创建目标和 WorkItem。
- [ ] 纯调研项目可以独立完成并输出引用式证据。
- [ ] 完整需求可以进入多工作区研发、三层验证和发布审批。
- [ ] Company 可深链 Workbench 查看或接管 Run。
- [ ] 经营首页显示真实投影，不使用硬编码演示数据。

Gate commands:

```bash
pnpm --filter @forge/company-domain test
pnpm --filter @forge/company-desktop test
pnpm --filter @forge/company-desktop build
pnpm test
```

### Milestone M6：增长与收入闭环

- [ ] Campaign、Content、Publication、Lead、Opportunity、Deal 和 Customer 串联。
- [ ] 外部动作经过 Connector、Policy、Approval 和幂等检查。
- [ ] 首次、最后和多触点归因均可查询。
- [ ] 经营分析能显示渠道成本、线索、成交和可归因收入。

### Milestone M7：受控自治

- [ ] L3 仅对通过评测的 Workflow/Employee/Connector 场景开放。
- [ ] 异常、成本、权限和指标偏差能自动暂停或升级。
- [ ] P4 支持 Simulation、Replay、Shadow、Canary、Promote 和 Rollback。
- [ ] 极高风险动作不能通过自治晋级绕过治理。

## 5. 计划执行顺序

### Task 1: 执行 Core Platform Foundation 计划

**Files:**
- Read: `docs/superpowers/plans/2026-08-28-forge-core-v2-platform-foundation.md`
- Verify: `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

**Interfaces:**
- Consumes: 当前 `@forge/protocol`、`@forge/bus`、`SessionStore` 和 Daemon RPC。
- Produces: `RpcContractMap`、`TypedRouter`、`ForgeStore` 和模块化 `DaemonHost`。

- [ ] 按子计划从 Task 1 执行到最后一项，每项独立测试和提交。
- [ ] 运行 M1 全部门禁命令并保存结果摘要。
- [ ] 核对所有新 RPC 都能通过 `capabilities.get` 查询。
- [ ] 核对旧数据备份已经实际恢复，不只检查文件存在。
- [ ] 在本计划记录 M1 通过的提交 SHA。

### Task 2: 执行 Durable Execution + Events 计划

**Files:**
- Read: `docs/superpowers/plans/2026-08-28-forge-core-v2-durable-execution-events.md`

**Interfaces:**
- Consumes: `TypedRouter`、`ForgeStore`、`EventEnvelope` 基础契约。
- Produces: `RunSpec`、`ExecutionStore`、`DurableExecutor`、`EventStore`、Cursor 订阅。

- [ ] 按子计划逐项执行并独立提交。
- [ ] 使用固定夹具验证重启恢复、取消、等待和重试。
- [ ] 使用断线重连测试验证事件补发与客户端去重。
- [ ] 运行 M2 门禁命令并保存结果摘要。
- [ ] 在本计划记录 M2 通过的提交 SHA。

### Task 3: 执行 Governance + Workspaces + Evidence 计划

**Files:**
- Read: `docs/superpowers/plans/2026-08-28-forge-core-v2-governance-workspaces-evidence.md`

**Interfaces:**
- Consumes: `RunSpec`、`DurableExecutor`、`ForgeStore`、`EventStore`。
- Produces: `WorkspaceGroupService`、`PolicyEngine`、`ApprovalService`、`BudgetLedger`、`EvidenceService`、`AgentProfileStore`。

- [ ] 按子计划逐项执行并独立提交。
- [ ] 验证同一工作区的并发写租约只有一个成功。
- [ ] 验证高风险动作只能进入持久审批或拒绝。
- [ ] 验证预算竞态不会超额，失败或取消会释放预留。
- [ ] 运行 M3 门禁命令并记录通过的提交 SHA。

### Task 4: 执行 Assets + Connectors + Clients 计划

**Files:**
- Read: `docs/superpowers/plans/2026-08-28-forge-core-v2-assets-connectors-clients.md`

**Interfaces:**
- Consumes: M1-M3 全部 Core v2 服务。
- Produces: Workflow 2.0、Knowledge/Memory 2.0、Connector Gateway、全部 v2 客户端和单一 Core 代码路径。

- [ ] 按子计划逐项执行并独立提交。
- [ ] 迁移 Workbench、CLI、Mobile 和 Channel Gateway。
- [ ] 运行旧数据升级与恢复测试。
- [ ] 删除通过替代验证的 v1 Adapter 和事件特判。
- [ ] 运行 M4 根级门禁并记录通过的提交 SHA。

### Task 5: 执行 Company P0 Operating System 计划

**Files:**
- Read: `docs/superpowers/plans/2026-08-28-forge-company-p0-operating-system.md`

**Interfaces:**
- Consumes: Core v2 contracts、governance、execution、evidence 和 AgentProfile。
- Produces: Company app、公司/组织/员工/目标/项目/WorkItem/审批、首页、CEO 抽屉。

- [ ] 按子计划逐项执行并独立提交。
- [ ] 验证 Company renderer 只能通过 allowlisted preload API 访问 Core。
- [ ] 验证首页所有数字都可下钻到权威业务对象。
- [ ] 验证 CEO 助手只能提案，不能绕过审批。
- [ ] 运行 P0 门禁并记录通过的提交 SHA。

### Task 6: 执行 Company P1 Delivery Loop 计划

**Files:**
- Read: `docs/superpowers/plans/2026-08-28-forge-company-p1-delivery-loop.md`

**Interfaces:**
- Consumes: Company P0、WorkspaceGroup、DurableExecutor、Evidence/Validation。
- Produces: 纯调研与完整需求交付模板、阶段门、Workbench 深链和复盘。

- [ ] 按子计划逐项执行并独立提交。
- [ ] 分别运行“调研后结束”和“调研后进入开发”两条端到端路径。
- [ ] 验证三个验证层都能阻止错误完成声明。
- [ ] 验证跨工作区并行和同工作区写冲突。
- [ ] 运行 M5 门禁并记录通过的提交 SHA。

### Task 7: 执行 Company P2 Growth + Revenue 计划

**Files:**
- Read: `docs/superpowers/plans/2026-08-28-forge-company-p2-growth-revenue.md`

**Interfaces:**
- Consumes: Company P1、Workflow、Connector、Policy、Budget 和 Evidence。
- Produces: GTM、内容工厂、发布、线索、商机、成交、客户和收入归因。

- [ ] 按子计划逐项执行并独立提交。
- [ ] 使用 Mock/Sandbox Connector 验证重复请求不会重复发布或触达。
- [ ] 验证线索去重、评分、分配和退订规则。
- [ ] 验证可归因收入有成交证据且可回到 Campaign/Content。
- [ ] 运行 M6 门禁并记录通过的提交 SHA。

### Task 8: 执行 Company P3 Goal Autonomy 计划

**Files:**
- Read: `docs/superpowers/plans/2026-08-28-forge-company-p3-goal-autonomy.md`

**Interfaces:**
- Consumes: P2 全闭环、Workflow、Policy、Budget、Trace 和 Evals。
- Produces: L0-L3 自治授权、目标/事件触发、Supervisor、停止与接管。

- [ ] 按子计划逐项执行并独立提交。
- [ ] 使用版本化评测集证明每个晋级场景满足门槛。
- [ ] 验证异常、成本和权限边界会自动暂停。
- [ ] 验证人工可以随时接管并保留执行状态。
- [ ] 记录每个获准 L3 场景及有效期。

### Task 9: 执行 Company P4 Simulation Autonomy 计划

**Files:**
- Read: `docs/superpowers/plans/2026-08-28-forge-company-p4-simulation-autonomy.md`

**Interfaces:**
- Consumes: P3 自治主体、Workflow 版本、历史 Trace 和业务指标。
- Produces: Simulation、Replay、Shadow、Canary、Promotion 和 Rollback。

- [ ] 按子计划逐项执行并独立提交。
- [ ] 验证 Shadow 不产生真实副作用。
- [ ] 验证 Canary 严格执行样本、预算、时间和动作范围。
- [ ] 验证晋级失败自动降级且保留证据。
- [ ] 运行 M7 门禁并记录通过的提交 SHA。

## 6. 全局完成定义

整个项目只有在以下条件同时满足时才算完成：

- [ ] 九份子计划的全部必须任务完成，提交与测试记录可追溯。
- [ ] 根级 `pnpm build`、`pnpm test` 和 `pnpm smoke` 通过。
- [ ] 旧数据升级、备份恢复、重复升级和回退演练通过。
- [ ] 仓库中不存在仍被内部客户端调用的 v1 RPC 或事件特判。
- [ ] Forge Company 的 P0-P2 业务数据全部来自权威表和 Core 证据，不来自 UI mock。
- [ ] L3/L4 只对明确列出的场景生效，高风险永久治理边界仍然存在。
- [ ] `docs/roadmap.md`、架构文档、用户文档和运维恢复手册与最终实现一致。
- [ ] 发布说明列出已迁移数据、已删除 Legacy、已知限制和恢复方式。
