# Forge Company P3 Goal-Driven L3 Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让通过评测的低风险 Company Workflow 和数字员工在目标、预算、策略和停止条件内持续运行，并在异常时自动暂停或升级人工。

**Architecture:** L3 不是 Run 参数，而是版本化 `AutonomyGrant`，绑定 Subject、WorkflowVersion、Connector actions、预算、指标、时间和有效期。`AutonomySupervisor` 消费领域事件，创建受治理 Workflow Run，监测 Trace/成本/指标/失败并执行 pause、degrade、escalate；现有 Policy/Approval 永远是最终执行边界。

**Tech Stack:** Company/Core v2、Workflow 2.0、EventStore、Policy、Budget、Trace/Evals、Electron/React、Vitest、SQLite。

**Spec:** `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

## Global Constraints

- P3 最高开放 L3，不实现 L4。
- 自治授权逐场景、逐版本、带有效期，不提供全局“完全自治”开关。
- 高风险/极高风险动作仍按 Policy 进入审批或拒绝。
- 系统不得修改自己的评测、策略、预算上限或审计记录。
- 人工可以随时暂停、接管、降级和撤销授权。
- 成功率之外必须评测停止、求助、预算、权限和副作用幂等。
- 数据层允许存储等级 0-4，但本计划的 service/capability gate 只允许激活到 L3；L4 只能由 P4 PromotionService 激活。
- 代码片段中的 `*Fixture`、`fake*` 等名称均是在同一测试文件中创建的确定性测试夹具；写失败测试步骤必须同时实现这些夹具的最小定义。

---

## File Structure Map

| Path | Responsibility |
|---|---|
| `migrations/022_company_autonomy.sql` | grants、evaluations、supervision、incidents |
| `packages/company-domain/src/autonomy/grants.ts` | L0-L3 grant lifecycle |
| `packages/company-domain/src/autonomy/evaluation.ts` | 晋级资格计算 |
| `packages/company-domain/src/autonomy/supervisor.ts` | 事件/目标触发和运行监督 |
| `packages/company-domain/src/autonomy/anomaly.ts` | 异常与停止规则 |
| `packages/workflows/src/autonomy/event-trigger.ts` | 授权事件触发 adapter |
| `apps/daemon/src/modules/autonomy-module.ts` | autonomy RPC/lifecycle |
| `apps/company-desktop/src/renderer/features/autonomy/*` | 授权、监控、接管 UI |
| `scripts/eval-cases/autonomy-l3/*` | L3 评测集 |

## Public Interfaces Locked by This Plan

```ts
export interface AutonomyGrant {
  id: string; companyId: string; subject: SubjectRef;
  level: 0 | 1 | 2 | 3 | 4; workflowVersionId: string;
  allowedActions: string[]; allowedResourceScopes: ResourceScope[];
  budgetAccountId: string; maxRunCostMinor: bigint; maxDailyCostMinor: bigint;
  successMetricIds: string[]; stopConditions: StopCondition[];
  validFrom: string; expiresAt: string; state: "draft" | "active" | "suspended" | "revoked" | "expired";
}
```

### Task 1: 添加 Autonomy Schema 和事件类型

**Files:**
- Create: `migrations/022_company_autonomy.sql`
- Create: `packages/store/src/company-autonomy-migration.test.ts`
- Create: `packages/company-domain/src/autonomy/types.ts`
- Modify: `packages/protocol/src/v2/company.ts`

**Interfaces:**
- Consumes: Company/Core identity、workflow、eval refs。
- Produces: grants/evaluations/supervision/incidents storage。

- [ ] **Step 1: 写表族、等级范围和有效期索引测试**

```ts
it("creates autonomy tables and stores the complete zero through four domain", () => {
  const db = openMigratedFixture().db;
  expect(tableNames(db)).toEqual(expect.arrayContaining([
    "company_autonomy_grants", "company_autonomy_evaluations",
    "company_autonomy_supervisions", "company_autonomy_incidents",
  ]));
  expect(tableSql(db, "company_autonomy_grants")).toContain("level BETWEEN 0 AND 4");
});
```

- [ ] **Step 2: 运行 migration test 确认表缺失**

Run: `pnpm exec vitest run packages/store/src/company-autonomy-migration.test.ts`

Expected: FAIL listing autonomy tables.

- [ ] **Step 3: 创建 migration、types 和稳定事件名**

Events: `company.autonomy.grant.activated|suspended|revoked|expired`、`company.autonomy.run.started|paused|escalated`、`company.autonomy.incident.opened|resolved`.

- [ ] **Step 4: 运行 Store/protocol/domain build**

Run: `pnpm --filter @forge/store test && pnpm --filter @forge/protocol test && pnpm --filter @forge/company-domain build`

Expected: PASS.

- [ ] **Step 5: 提交 autonomy schema/types**

```bash
git add migrations/022_company_autonomy.sql packages/store/src/company-autonomy-migration.test.ts packages/company-domain/src/autonomy/types.ts packages/protocol/src/v2/company.ts
git commit -m "feat(autonomy): add l3 autonomy schema"
```

### Task 2: 实现 AutonomyGrant 生命周期和范围约束

**Files:**
- Create: `packages/company-domain/src/autonomy/grants.ts`
- Create: `packages/company-domain/src/autonomy/grants.test.ts`
- Modify: `packages/company-domain/src/index.ts`

**Interfaces:**
- Consumes: subject/workflow/policy/budget/evaluation refs。
- Produces: `AutonomyGrantService.create()`、`activate()`、`suspend()`、`revoke()`、`expire()`。

- [ ] **Step 1: 写无评测激活、超范围动作和过期测试**

```ts
it("rejects L3 activation without a passing evaluation", () => {
  const grant = grants.create(l3GrantDraft());
  expect(() => grants.activate(grant.id, "missing-evaluation")).toThrow("passing evaluation required");
});

it("does not expand allowed actions after activation", () => {
  const grant = activeGrant();
  expect(() => grants.update(grant.id, { allowedActions: [...grant.allowedActions, "payment.execute"] }))
    .toThrow("create a new grant version");
});
```

- [ ] **Step 2: 运行 grant tests 确认服务缺失**

Run: `pnpm exec vitest run packages/company-domain/src/autonomy/grants.test.ts`

Expected: FAIL because `AutonomyGrantService` is absent.

- [ ] **Step 3: 实现不可扩大版本、有效期和紧急暂停**

```ts
export class AutonomyGrantService {
  create(input: CreateAutonomyGrant): AutonomyGrant;
  activate(id: string, evaluationId: string, approvedBy: SubjectRef): AutonomyGrant;
  suspend(id: string, reason: string, actor: SubjectRef): AutonomyGrant;
  revoke(id: string, reason: string, actor: SubjectRef): AutonomyGrant;
}
```

Any change to workflow version, actions, scopes, budget or stop conditions creates a new draft grant requiring evaluation and approval.

- [ ] **Step 4: 运行 autonomy/domain tests**

Run: `pnpm --filter @forge/company-domain test`

Expected: PASS for L0-L3, expiry, suspend, revoke, version and cross-company scope.

- [ ] **Step 5: 提交 autonomy grants**

```bash
git add packages/company-domain/src/autonomy packages/company-domain/src/index.ts
git commit -m "feat(autonomy): add scoped autonomy grants"
```

### Task 3: 实现 L3 评测门和晋级资格

**Files:**
- Create: `packages/company-domain/src/autonomy/evaluation.ts`
- Create: `packages/company-domain/src/autonomy/evaluation.test.ts`
- Create: `scripts/eval-cases/autonomy-l3/manifest.json`
- Create: `scripts/eval-cases/autonomy-l3/stop-and-escalate.json`
- Create: `scripts/eval-cases/autonomy-l3/budget-and-policy.json`
- Modify: `scripts/eval.mjs`

**Interfaces:**
- Consumes: versioned eval runs、thresholds、incident history。
- Produces: `AutonomyEvaluationService.assess()`。

- [ ] **Step 1: 写样本量、成功率、事故和求助指标测试**

```ts
it("fails promotion when sample size is below the scenario threshold", () => {
  expect(evaluations.assess(evaluationInput({ sampleSize: 19, requiredSampleSize: 20 })).eligible)
    .toBe(false);
});

it("requires zero critical policy incidents", () => {
  expect(evaluations.assess(evaluationInput({ criticalIncidents: 1 })).reasons)
    .toContain("critical_policy_incident");
});
```

- [ ] **Step 2: 运行 evaluation tests 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/autonomy/evaluation.test.ts`

Expected: FAIL because evaluation service is absent.

- [ ] **Step 3: 实现版本化 threshold 和不可篡改 result refs**

```ts
export interface AutonomyEvaluationResult {
  id: string; workflowVersionId: string; profileVersionId: string;
  evalSetVersion: string; sampleSize: number; successRate: number;
  correctStopRate: number; correctEscalationRate: number;
  policyIncidents: number; duplicateSideEffects: number;
  p95CostMinor: bigint; eligible: boolean; reasons: string[];
}
```

- [ ] **Step 4: 运行 evaluation/domain/eval tests**

Run: `pnpm --filter @forge/company-domain test && pnpm eval`

Expected: PASS; promotion fixture fails when a metric falls below its explicit threshold.

- [ ] **Step 5: 提交 L3 evaluation gate**

```bash
git add packages/company-domain/src/autonomy/evaluation.ts packages/company-domain/src/autonomy/evaluation.test.ts scripts/eval-cases/autonomy-l3 scripts/eval.mjs
git commit -m "feat(autonomy): add l3 promotion evaluations"
```

### Task 4: 实现授权事件与目标触发

**Files:**
- Create: `packages/workflows/src/autonomy/event-trigger.ts`
- Create: `packages/workflows/src/autonomy/event-trigger.test.ts`
- Modify: `packages/workflows/src/index.ts`

**Interfaces:**
- Consumes: EventEnvelope、active grant、WorkflowDefinition。
- Produces: `AutonomyTriggerService.handle(event)`。

- [ ] **Step 1: 写范围匹配、重复事件和并发上限测试**

```ts
it("starts an authorized workflow once for a matching event", async () => {
  const fx = triggerFixture(activeGrantFor("lead.qualified"));
  await fx.service.handle(event("lead.qualified", "event-1"));
  await fx.service.handle(event("lead.qualified", "event-1"));
  expect(fx.createdRuns()).toHaveLength(1);
});

it("ignores a matching event outside the company resource scope", async () => {
  const fx = triggerFixture(activeGrantFor("lead.qualified", "company-a"));
  await fx.service.handle(companyEvent("company-b"));
  expect(fx.createdRuns()).toEqual([]);
});
```

- [ ] **Step 2: 运行 trigger tests 确认实现缺失**

Run: `pnpm exec vitest run packages/workflows/src/autonomy/event-trigger.test.ts`

Expected: FAIL because trigger service is absent.

- [ ] **Step 3: 实现 grant-filtered event trigger 和 correlation key**

```ts
export interface AutonomyTriggerDecision {
  accepted: boolean; grantId?: string; workflowVersionId?: string;
  correlationKey?: string; reason: string;
}
```

Trigger creates a Run only after checking grant state/time, event/resource scope, daily budget availability and workflow concurrency.

- [ ] **Step 4: 运行 workflow/event/policy tests**

Run: `pnpm --filter @forge/workflows test && pnpm --filter @forge/event-store test && pnpm --filter @forge/policy test`

Expected: PASS for duplicate, out-of-scope, expired, suspended and concurrency cases.

- [ ] **Step 5: 提交 autonomy event triggers**

```bash
git add packages/workflows/src/autonomy packages/workflows/src/index.ts
git commit -m "feat(autonomy): add goal and event triggers"
```

### Task 5: 实现 AutonomySupervisor 和停止条件

**Files:**
- Create: `packages/company-domain/src/autonomy/supervisor.ts`
- Create: `packages/company-domain/src/autonomy/supervisor.test.ts`
- Create: `packages/company-domain/src/autonomy/stop-conditions.ts`
- Create: `packages/company-domain/src/autonomy/stop-conditions.test.ts`

**Interfaces:**
- Consumes: Run events、metrics、budget、grant stop conditions。
- Produces: `AutonomySupervisor.observe()`、pause/degrade/escalate decisions。

- [ ] **Step 1: 写连续失败、成本、无进展和人工暂停测试**

```ts
it("pauses after the configured consecutive failure limit", async () => {
  const fx = supervisorFixture(stopAfterConsecutiveFailures(3));
  await fx.observe(failedAttempt(1)); await fx.observe(failedAttempt(2)); await fx.observe(failedAttempt(3));
  expect(fx.actions()).toContainEqual({ kind: "pause_run", runId: "r1" });
});

it("honors human pause before processing a later success event", async () => {
  const fx = supervisorFixture();
  fx.humanPause("grant-1");
  await fx.observe(stepSucceeded());
  expect(fx.startedFollowups()).toEqual([]);
});
```

- [ ] **Step 2: 运行 supervisor tests 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/autonomy/supervisor.test.ts packages/company-domain/src/autonomy/stop-conditions.test.ts`

Expected: FAIL because services are absent.

- [ ] **Step 3: 实现确定性 stop condition evaluators**

```ts
export type SupervisorAction =
  | { kind: "continue" }
  | { kind: "pause_run"; runId: string; reason: string }
  | { kind: "suspend_grant"; grantId: string; reason: string }
  | { kind: "escalate"; workItemId: string; severity: "warning" | "critical"; reason: string };
```

LLM can summarize the escalation, but deterministic evaluators choose the action for cost, failures, permission, duplicate side effect, stale metric and no-progress rules.

- [ ] **Step 4: 运行 supervisor/domain/execution tests**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/execution test`

Expected: PASS for all stop conditions and recovery after an authorized resume.

- [ ] **Step 5: 提交 autonomy supervisor**

```bash
git add packages/company-domain/src/autonomy
git commit -m "feat(autonomy): add run supervision and stop conditions"
```

### Task 6: 实现异常、接管和治理不可绕过测试

**Files:**
- Create: `packages/company-domain/src/autonomy/anomaly.ts`
- Create: `packages/company-domain/src/autonomy/anomaly.test.ts`
- Create: `apps/daemon/src/autonomy-governance.e2e.test.ts`

**Interfaces:**
- Consumes: SupervisorAction、WorkItem takeover、Policy decisions。
- Produces: `AutonomyIncidentService` 和安全 E2E。

- [ ] **Step 1: 写权限扩大、策略修改和副作用重复攻击 tests**

```ts
it.each(["policy.update", "budget.limit.increase", "audit.delete", "autonomy.grant.activate"])(
  "does not include self-governance action %s in an L3 grant",
  (action) => expect(() => validateGrantActions([...safeActions, action])).toThrow("self-governance action"),
);

it("opens a critical incident and suspends the grant on duplicate side effect", async () => {
  const fx = anomalyFixture();
  await fx.report(duplicateSideEffect());
  expect(fx.grantState()).toBe("suspended");
  expect(fx.incidentSeverity()).toBe("critical");
});
```

- [ ] **Step 2: 运行 anomaly/E2E 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/autonomy/anomaly.test.ts apps/daemon/src/autonomy-governance.e2e.test.ts`

Expected: FAIL before anomaly handling and hard governance blocks.

- [ ] **Step 3: 实现 incident lifecycle、takeover 和 resume token**

Human takeover records actor/reason/context snapshot, cancels conflicting Attempt, releases write lease, and creates a single-use resume token bound to the WorkItem/version.

- [ ] **Step 4: 运行 autonomy/policy/connector E2E**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/policy test && pnpm --filter @forge/connectors test && pnpm exec vitest run apps/daemon/src/autonomy-governance.e2e.test.ts`

Expected: PASS; prohibited actions never reach adapters.

- [ ] **Step 5: 提交 incidents/takeover**

```bash
git add packages/company-domain/src/autonomy apps/daemon/src/autonomy-governance.e2e.test.ts
git commit -m "feat(autonomy): add incidents and human takeover"
```

### Task 7: 注册 Autonomy module 与监控 UI

**Files:**
- Create: `apps/daemon/src/modules/autonomy-module.ts`
- Create: `apps/daemon/src/modules/autonomy-module.test.ts`
- Create: `apps/company-desktop/src/renderer/features/autonomy/autonomy-center.tsx`
- Create: `apps/company-desktop/src/renderer/features/autonomy/grant-detail.tsx`
- Create: `apps/company-desktop/src/renderer/features/autonomy/autonomy-center.test.tsx`
- Modify: `apps/daemon/src/modules/index.ts`
- Modify: `apps/company-desktop/src/renderer/app.tsx`

**Interfaces:**
- Consumes: Grant/Evaluation/Supervisor/Incident services。
- Produces: autonomy RPC、授权/暂停/接管/事故 UI。

- [ ] **Step 1: 写未通过评测 UI 阻断和紧急暂停 tests**

```tsx
it("disables activation and shows failed evaluation reasons", () => {
  render(<GrantDetail grant={draftGrant()} evaluation={failedEvaluation()} />);
  expect(screen.getByRole("button", { name: "启用 L3" })).toBeDisabled();
  expect(screen.getByText("正确求助率未达标")).toBeVisible();
});

it("sends an immediate suspend command", async () => {
  render(<AutonomyCenter model={activeAutonomy()} api={api} />);
  await user.click(screen.getByRole("button", { name: "全部暂停" }));
  expect(api.command).toHaveBeenCalledWith("company.autonomy.suspendAll", expect.any(Object));
});
```

- [ ] **Step 2: 运行 module/UI tests 确认实现缺失**

Run: `pnpm exec vitest run apps/daemon/src/modules/autonomy-module.test.ts apps/company-desktop/src/renderer/features/autonomy/autonomy-center.test.tsx`

Expected: FAIL because module/UI are absent.

- [ ] **Step 3: 注册 typed RPC 和 Autonomy Center**

UI shows grant scope, version, actions, budget, metrics, stop conditions, evaluation, expiry, active runs, incidents and audit. Activation and scope expansion require explicit human confirmation.

- [ ] **Step 4: 运行 Company/Daemon tests/build**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/daemon test && pnpm --filter @forge/company-desktop test && pnpm --filter @forge/company-desktop build`

Expected: PASS; capabilities list `company.autonomy.l3`.

- [ ] **Step 5: 提交 Autonomy center**

```bash
git add apps/daemon/src/modules/autonomy-module.ts apps/daemon/src/modules/autonomy-module.test.ts apps/daemon/src/modules/index.ts apps/company-desktop/src/renderer/features/autonomy apps/company-desktop/src/renderer/app.tsx
git commit -m "feat(company): add l3 autonomy control center"
```

### Task 8: 建立 L3 连续运行 E2E 和 P3 门禁

**Files:**
- Create: `apps/daemon/src/company-autonomy-l3.e2e.test.ts`
- Create: `scripts/eval-cases/autonomy-l3/continuous-operation.json`
- Modify: `scripts/eval.mjs`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: P3 全部服务。
- Produces: 正常运行、异常暂停、人工接管三条验收路径。

- [ ] **Step 1: 写连续运行与成本停止 E2E**

```ts
it("runs an authorized low-risk loop and pauses at the daily budget", async () => {
  const fx = await l3Fixture({ dailyBudgetMinor: 1000n, runCostMinor: 400n });
  await fx.emitEligibleEvents(4);
  expect(fx.completedRuns()).toBe(2);
  expect(fx.grantState()).toBe("suspended");
  expect(fx.escalations()).toContainEqual(expect.objectContaining({ reason: "daily_budget" }));
});
```

- [ ] **Step 2: 运行 L3 E2E 确认 integration 缺口**

Run: `pnpm exec vitest run apps/daemon/src/company-autonomy-l3.e2e.test.ts`

Expected: FAIL before full event/supervisor wiring.

- [ ] **Step 3: 补齐 module lifecycle、event subscriptions 和 eval report**

The fixture uses a fake clock and deterministic connectors; assert actual Run, Budget, Incident, Grant and WorkItem states.

- [ ] **Step 4: 运行 P3 全门禁**

Run:

```bash
pnpm --filter @forge/company-domain test
pnpm --filter @forge/workflows test
pnpm --filter @forge/policy test
pnpm --filter @forge/connectors test
pnpm --filter @forge/company-desktop test
pnpm --filter @forge/daemon test
pnpm test
pnpm eval
```

Expected: all PASS; no L4 grant can be created and critical actions remain governed.

- [ ] **Step 5: 提交 Company P3 gate**

```bash
git add apps/daemon/src/company-autonomy-l3.e2e.test.ts scripts/eval-cases/autonomy-l3 scripts/eval.mjs docs/roadmap.md
git commit -m "feat(company): complete governed l3 autonomy"
```
