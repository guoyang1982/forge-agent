# Run Orchestrator（统一编排）设计方案

> 状态：草案 v1 · 2026-06-13  
> 关联：[人才中心](./2026-06-13-talent-center-design.md)、[`docs/agent-capabilities.md`](../../agent-capabilities.md)

## 1. 目标

把 forge-agent 的一次 **Run** 统一为四段流水线，适用于编程、调研、以及显式 `@` 的人才派活：

```
Intake（理解）→ Plan（规划）→ Execute（执行）→ Verify & Report（校验与收口）
```

| 阶段 | 谁负责 | 产出 |
|------|--------|------|
| Intake | 运行时 + 上下文装配 | 用户消息、Roster、工作区、附件 |
| Plan | 模型（复杂任务）或启发式（简单/多 @ 派活） | 结构化 `RunPlan` |
| Execute | 运行时按计划调度 | 工具调用、子代理、人才子代理、写盘 |
| Verify & Report | Coordinator | 测试/编译、最终回复 |

**已决边界**：无显式 `@` 时**不自动选人才**；人才 step 只来自消息里的 `@`。

---

## 2. RunPlan 数据模型

```typescript
type RunStepKind =
  | "talent_background"   // 模式 B：只读人才子代理
  | "talent_foreground"   // 模式 A：主循环换 persona
  | "coordinator"         // 汇总、写盘、校验
  | "verify";             // 显式校验 step（可选）

interface RunPlanStep {
  id: string;
  kind: RunStepKind;
  mention?: string;
  displayName?: string;
  role?: string;
  task: string;
  after: string[];        // 依赖的前序 step id
  wave: number;           // 运行时计算的波次（同波可并行）
  status: "pending" | "in_progress" | "done";
}

interface RunPlan {
  intent: string;           // 对用户意图的一句话摘要
  source: "heuristic" | "model";
  runKind: "coordinator" | "talent_foreground" | "talent_dispatch";
  steps: RunPlanStep[];
  coordinatorFollowup: boolean; // 多人才后是否进入 Coordinator 汇总回合
}
```

波次规则：`wave = max(after 的 wave) + 1`；无依赖则在 wave 0。

---

## 3. 运行分级（Tiered Planning）

| 级别 | 触发 | Plan 行为 |
|------|------|-----------|
| L0 轻量 | 单轮问答、小改 | 可跳过显式 RunPlan，直接 Execute |
| L1 标准 | 3+ 步、多文件 | 主循环 `update_plan`（Execute 内） |
| L2 派活 | 2+ `@` | **必须先** `dispatch_plan` + 波次执行，再 Coordinator 汇总 |
| L3 模型规划 | L2 + 复杂依赖句 | Plan 阶段调用模型产出 JSON（fallback 启发式） |

MVP 实现 L2 的启发式 Plan；L3 为后续迭代。

---

## 4. 与现有组件映射

| 现有 | 编排中的位置 |
|------|----------------|
| `thinking_*` | Plan 阶段展示 |
| `update_plan` / `plan_update` | L1 用户可见任务清单；L2 由 `dispatch_plan` 同步映射 |
| `spawn_agent` | `kind: subagent`（Coordinator 路径） |
| 人才 `subagent_start` | `kind: talent_background` |
| 模式 A `@Nova!` | `kind: talent_foreground` |
| single-writer | Execute 约束：仅 Coordinator step 写盘 |

---

## 5. 事件协议

新增 `dispatch_plan`（结构化，可回放）：

```typescript
{
  type: "dispatch_plan";
  intent: string;
  source: "heuristic" | "model";
  runKind: "coordinator" | "talent_foreground" | "talent_dispatch";
  waves: Array<{
    index: number;
    steps: Array<{
      id: string;
      kind: RunStepKind;
      mention?: string;
      displayName?: string;
      role?: string;
      task: string;
      status: "pending" | "in_progress" | "done";
    }>;
  }>;
}
```

执行中通过 `plan_update` 刷新 step 状态（复用任务清单卡片 UI）。

---

## 6. 多 `@` 时序（L2）

```
用户消息（含多个 @）
  → Intake：解析 Roster 命中
  → Plan：buildTalentRunPlan（启发式串/并行波次）
  → emit dispatch_plan + plan_update
  → Execute：按 wave 跑 talent_background（波内 Promise.all）
  → emit plan_update（逐步 done）
  → Coordinator ReAct：汇总 + 写盘 + 校验
  → Report
```

---

## 7. 分期

**Phase A（本迭代）**
- `@forge/run-orchestrator` 包：RunPlan 类型、启发式 build、波次计算、plan_update 映射
- daemon 多 `@` 路径改走 RunPlan
- 桌面端展示「团队负责人计划」

**Phase B**
- Plan 阶段 LLM 结构化输出 + schema 校验 + 启发式 fallback
- 会话恢复回放 `dispatch_plan`

**Phase C**
- L1 强制 plan gate（多步编程）
- 与 `update_plan` 合并为单一 RunPlan 视图

---

## 8. 非目标

- 无 `@` 时自动从 Roster 猜人
- 模式 C（worktree 真并行写）——仍属人才中心 Phase 3
