# Forge Company P4 Simulation and Limited L4 Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Simulation、Historical Replay、Shadow、Canary、Promotion 和 Rollback，使少数经验证的低风险业务场景能够晋级有限 L4。

**Architecture:** Simulation 使用真实 Workflow/Profile/Policy 版本，但注入虚拟时钟、隔离 Store 和模拟 Connector；Replay 从脱敏历史事件构建场景。Shadow 对实时事件计算拟执行动作却禁止副作用，Canary 只对明确样本和动作范围启用；PromotionService 根据版本化证据激活 L4 grant，Supervisor 可自动降级到 L2/L3。

**Tech Stack:** Core v2 Execution/Event/Workflow/Connector/Trace/Evals、Company autonomy domain、Vitest、SQLite 隔离 fixture、Electron/React。

**Spec:** `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

## Global Constraints

- L4 只逐场景开放，不提供全公司开关。
- Shadow 永远不能调用真实 Connector execute；只生成 proposal 和 predicted result。
- Canary 必须绑定样本比例/集合、预算、动作范围、开始/结束时间和自动回退条件。
- 付款、法律承诺、批量敏感触达、权限扩大、审计修改仍不能由 L4 自主执行。
- 晋级证据绑定 Workflow/Profile/Policy/Connector/EvalSet 精确版本。
- 晋级失败或事故触发自动降级并保留全部证据。
- 代码片段中的 `*Fixture`、`fake*` 等名称均是在同一测试文件中创建的确定性测试夹具；写失败测试步骤必须同时实现这些夹具的最小定义。

---

## File Structure Map

| Path | Responsibility |
|---|---|
| `migrations/023_company_simulation_autonomy.sql` | scenario、simulation run、shadow、canary、promotion |
| `packages/simulation/package.json` | simulation engine package |
| `packages/simulation/src/scenario.ts` | ScenarioDefinition 与 fixture materialization |
| `packages/simulation/src/engine.ts` | 隔离运行、virtual clock、simulated connectors |
| `packages/simulation/src/replay.ts` | 历史 Trace/Event 脱敏回放 |
| `packages/simulation/src/shadow.ts` | 实时 Shadow evaluator |
| `packages/company-domain/src/autonomy/canary.ts` | canary cohort 和 guardrails |
| `packages/company-domain/src/autonomy/promotion.ts` | L4 promote/demote/rollback |
| `apps/daemon/src/modules/simulation-module.ts` | simulation/shadow/canary RPC |
| `apps/company-desktop/src/renderer/features/simulation/*` | 场景、对比、晋级 UI |
| `scripts/eval-cases/autonomy-l4/*` | L4 评测集 |

## Public Interfaces Locked by This Plan

```ts
export interface ScenarioDefinition {
  id: string; version: number; companyFixtureRef: string;
  workflowVersionId: string; profileVersionIds: string[];
  policyVersionId: string; inputEvents: ScenarioEvent[];
  connectorFixtures: ConnectorFixture[]; assertions: ScenarioAssertion[];
}

export interface ScenarioEvent { eventId: string; type: string; occurredAt: string; data: unknown }
export interface ConnectorFixture { connectorKind: string; action: string; response: unknown }
export interface ScenarioAssertion { id: string; kind: string; expected: unknown }

export interface PromotionEvidence {
  simulationRunIds: string[]; shadowEvaluationId: string;
  canaryEvaluationId: string; evalSetVersion: string;
  workflowVersionId: string; profileVersionIds: string[];
  policyVersionId: string; connectorAdapterVersions: string[];
}
```

### Task 1: 添加 Simulation/Shadow/Canary/Promotion Schema

**Files:**
- Create: `migrations/023_company_simulation_autonomy.sql`
- Create: `packages/store/src/company-simulation-migration.test.ts`
- Create: `packages/simulation/package.json`
- Create: `packages/simulation/tsconfig.json`
- Create: `packages/simulation/src/types.ts`
- Create: `packages/simulation/src/index.ts`

**Interfaces:**
- Consumes: P3 autonomy schema。
- Produces: simulation/shadow/canary/promotion storage and types。

- [ ] **Step 1: 写表、版本唯一性和 L4 capability 字段测试**

```ts
it("creates simulation and promotion tables", () => {
  expect(tableNames(openMigratedFixture().db)).toEqual(expect.arrayContaining([
    "company_simulation_scenarios", "company_simulation_runs",
    "company_shadow_evaluations", "company_canary_rollouts",
    "company_autonomy_promotions",
  ]));
});
```

- [ ] **Step 2: 运行 migration test 确认表缺失**

Run: `pnpm exec vitest run packages/store/src/company-simulation-migration.test.ts`

Expected: FAIL listing simulation tables.

- [ ] **Step 3: 创建 migration 和 simulation types**

```sql
CREATE UNIQUE INDEX uq_company_simulation_scenario_version
ON company_simulation_scenarios(scenario_id, version);

CREATE TABLE company_autonomy_promotions (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES company_autonomy_grants(id),
  target_level INTEGER NOT NULL CHECK (target_level = 4),
  evidence_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed','approved','active','rolled_back','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 4: 运行 Store/simulation build**

Run: `pnpm --filter @forge/store test && pnpm --filter @forge/simulation build`

Expected: PASS.

- [ ] **Step 5: 提交 simulation schema/types**

```bash
git add migrations/023_company_simulation_autonomy.sql packages/store/src/company-simulation-migration.test.ts packages/simulation
git commit -m "feat(simulation): add autonomy simulation schema"
```

### Task 2: 实现场景定义、隔离 Store 和虚拟时钟

**Files:**
- Create: `packages/simulation/src/scenario.ts`
- Create: `packages/simulation/src/scenario.test.ts`
- Create: `packages/simulation/src/virtual-clock.ts`
- Create: `packages/simulation/src/virtual-clock.test.ts`
- Create: `packages/simulation/src/fixture-store.ts`

**Interfaces:**
- Consumes: ScenarioDefinition。
- Produces: `materializeScenario()`、`VirtualClock`、隔离 ForgeStore。

- [ ] **Step 1: 写版本固定、时间推进和真实路径隔离测试**

```ts
it("materializes only the exact asset versions named by the scenario", async () => {
  const fx = await materializeScenario(scenarioFixture());
  expect(fx.versions).toEqual({ workflow: "wf-v3", profiles: ["p-v2"], policy: "policy-v4" });
});

it("never opens the configured live data path", async () => {
  const fx = await materializeScenario(scenarioFixture(), { liveDataPath: "/sensitive/live/data.db" });
  expect(fx.openedPaths).not.toContain("/sensitive/live/data.db");
});
```

- [ ] **Step 2: 运行 scenario tests 确认实现缺失**

Run: `pnpm exec vitest run packages/simulation/src/scenario.test.ts packages/simulation/src/virtual-clock.test.ts`

Expected: FAIL because scenario/clock modules are absent.

- [ ] **Step 3: 实现临时隔离 Store、deterministic IDs 和 clock**

```ts
export class VirtualClock implements Clock {
  constructor(private currentMs: number) {}
  now(): Date { return new Date(this.currentMs); }
  advanceBy(ms: number): void { this.currentMs += ms; }
}
```

Scenario materialization rejects missing versions, undeclared connectors and assertions that reference unknown object IDs.

- [ ] **Step 4: 运行 simulation tests/build**

Run: `pnpm --filter @forge/simulation test && pnpm --filter @forge/simulation build`

Expected: PASS and repeated scenario runs produce the same IDs/order.

- [ ] **Step 5: 提交 scenario runtime**

```bash
git add packages/simulation/src
git commit -m "feat(simulation): add isolated deterministic scenarios"
```

### Task 3: 实现 Simulation Engine 和模拟 Connector

**Files:**
- Create: `packages/simulation/src/engine.ts`
- Create: `packages/simulation/src/engine.test.ts`
- Create: `packages/simulation/src/simulated-connectors.ts`
- Create: `packages/simulation/src/simulated-connectors.test.ts`

**Interfaces:**
- Consumes: materialized scenario、DurableExecutor、Workflow compiler。
- Produces: `SimulationEngine.run()`、assertion report、Trace refs。

- [ ] **Step 1: 写成功、策略拒绝、预算和模拟副作用测试**

```ts
it("records a simulated side effect without calling the live adapter", async () => {
  const fx = simulationFixture();
  const result = await fx.engine.run(sideEffectScenario());
  expect(result.simulatedConnectorActions).toHaveLength(1);
  expect(fx.liveAdapter.executeCalls).toBe(0);
});

it("fails an assertion when the workflow exceeds scenario budget", async () => {
  const result = await simulationFixture().engine.run(overBudgetScenario());
  expect(result.assertions).toContainEqual(expect.objectContaining({ id: "budget", passed: false }));
});
```

- [ ] **Step 2: 运行 engine tests 确认实现缺失**

Run: `pnpm exec vitest run packages/simulation/src/engine.test.ts packages/simulation/src/simulated-connectors.test.ts`

Expected: FAIL because engine/connectors are absent.

- [ ] **Step 3: 实现 dependency-injected simulation execution**

```ts
export interface SimulationResult {
  id: string; scenarioId: string; scenarioVersion: number;
  status: "passed" | "failed"; assertions: AssertionResult[];
  runIds: string[]; traceRefs: string[]; simulatedConnectorActions: SimulatedAction[];
  metrics: { durationMs: number; costMinor: bigint; interventions: number };
}
```

All adapters in simulation resolve from scenario fixtures; attempting to resolve a live CredentialRef is a blocking failure.

- [ ] **Step 4: 运行 simulation/execution/policy tests**

Run: `pnpm --filter @forge/simulation test && pnpm --filter @forge/execution test && pnpm --filter @forge/policy test`

Expected: PASS for success, failure, retry, approval simulation, stop and assertion reports.

- [ ] **Step 5: 提交 Simulation Engine**

```bash
git add packages/simulation/src
git commit -m "feat(simulation): run workflows with simulated effects"
```

### Task 4: 实现 Historical Replay 与脱敏

**Files:**
- Create: `packages/simulation/src/replay.ts`
- Create: `packages/simulation/src/replay.test.ts`
- Create: `packages/simulation/src/redaction.ts`
- Create: `packages/simulation/src/redaction.test.ts`

**Interfaces:**
- Consumes: historical Event/Trace/Artifact metadata。
- Produces: `createReplayScenario()`、redaction report。

- [ ] **Step 1: 写敏感字段、版本缺失和事件排序测试**

```ts
it("redacts credentials personal identifiers and raw message bodies", () => {
  const replay = createReplayScenario(sensitiveHistoryFixture());
  expect(JSON.stringify(replay.scenario)).not.toMatch(/secret-token|person@example\.com|raw private chat/);
  expect(replay.redactions.length).toBeGreaterThan(0);
});

it("rejects replay when a required workflow version cannot be resolved", () => {
  expect(() => createReplayScenario(historyWithMissingVersion())).toThrow("missing immutable version");
});
```

- [ ] **Step 2: 运行 replay tests 确认实现缺失**

Run: `pnpm exec vitest run packages/simulation/src/replay.test.ts packages/simulation/src/redaction.test.ts`

Expected: FAIL because replay/redaction modules are absent.

- [ ] **Step 3: 实现 allowlist redaction 和 ordered replay inputs**

Only explicitly allowed fields enter the replay scenario; large artifacts remain refs or synthetic fixtures. The redaction report records field class and count, not removed values.

- [ ] **Step 4: 运行 simulation/event/evidence tests**

Run: `pnpm --filter @forge/simulation test && pnpm --filter @forge/event-store test && pnpm --filter @forge/evidence test`

Expected: PASS for sensitive, incomplete, out-of-order and corrupted history.

- [ ] **Step 5: 提交 Historical Replay**

```bash
git add packages/simulation/src/replay.ts packages/simulation/src/replay.test.ts packages/simulation/src/redaction.ts packages/simulation/src/redaction.test.ts
git commit -m "feat(simulation): add redacted historical replay"
```

### Task 5: 实现 Shadow mode 和结果差异评估

**Files:**
- Create: `packages/simulation/src/shadow.ts`
- Create: `packages/simulation/src/shadow.test.ts`
- Create: `packages/simulation/src/comparison.ts`
- Create: `packages/simulation/src/comparison.test.ts`

**Interfaces:**
- Consumes: live eligible events、production outcome refs。
- Produces: `ShadowRunner.observe()`、`compareShadowOutcome()`。

- [ ] **Step 1: 写零副作用、延迟和差异分类测试**

```ts
it("never executes a connector in shadow mode", async () => {
  const fx = shadowFixture();
  await fx.runner.observe(liveLeadQualifiedEvent());
  expect(fx.connector.executeCalls).toBe(0);
  expect(fx.proposals()).toHaveLength(1);
});

it("classifies action scope and business outcome differences", () => {
  expect(compareShadowOutcome(actualOutcome(), shadowOutcome())).toMatchObject({
    actionDifference: "different_parameters", outcomeDifference: "equivalent",
  });
});
```

- [ ] **Step 2: 运行 shadow tests 确认实现缺失**

Run: `pnpm exec vitest run packages/simulation/src/shadow.test.ts packages/simulation/src/comparison.test.ts`

Expected: FAIL because ShadowRunner/comparison are absent.

- [ ] **Step 3: 实现 observe-only execution and delayed comparison**

```ts
export interface ShadowEvaluation {
  id: string; grantDraftId: string; sampleSize: number;
  actionMatchRate: number; outcomeEquivalentRate: number;
  policyViolationCount: number; predictedCostMinor: bigint;
  eligibleForCanary: boolean; reasons: string[];
}
```

Shadow output cannot be reused as an approved Connector proposal; Canary must create a new governed proposal.

- [ ] **Step 4: 运行 simulation/connectors tests**

Run: `pnpm --filter @forge/simulation test && pnpm --filter @forge/connectors test`

Expected: PASS; live adapter execution count remains zero across every Shadow case.

- [ ] **Step 5: 提交 Shadow mode**

```bash
git add packages/simulation/src/shadow.ts packages/simulation/src/shadow.test.ts packages/simulation/src/comparison.ts packages/simulation/src/comparison.test.ts
git commit -m "feat(simulation): add side-effect-free shadow evaluation"
```

### Task 6: 实现 Canary cohort、guardrails 和自动回退

**Files:**
- Create: `packages/company-domain/src/autonomy/canary.ts`
- Create: `packages/company-domain/src/autonomy/canary.test.ts`
- Modify: `packages/company-domain/src/autonomy/supervisor.ts`

**Interfaces:**
- Consumes: ShadowEvaluation、candidate grant、events。
- Produces: `CanaryService.start()`、`select()`、`observe()`、`rollback()`。

- [ ] **Step 1: 写 deterministic cohort、预算和事故回退测试**

```ts
it("selects the same cohort for the same rollout seed", () => {
  const rollout = canary.start(canaryInput({ percentage: 5, seed: "stable-seed" }));
  expect(canary.select(rollout.id, "lead-123")).toBe(canary.select(rollout.id, "lead-123"));
});

it("rolls back immediately on a critical incident", () => {
  const rollout = activeCanary();
  canary.observe(rollout.id, criticalIncident());
  expect(canary.get(rollout.id).state).toBe("rolled_back");
});
```

- [ ] **Step 2: 运行 canary tests 确认服务缺失**

Run: `pnpm exec vitest run packages/company-domain/src/autonomy/canary.test.ts`

Expected: FAIL because `CanaryService` is absent.

- [ ] **Step 3: 实现 cohort、timebox、cost/action scope and rollback**

```ts
export interface CanaryRollout {
  id: string; grantDraftId: string; percentage: number; seed: string;
  allowedActions: string[]; budgetMinor: bigint; startsAt: string; endsAt: string;
  rollbackConditions: StopCondition[];
  state: "draft" | "active" | "completed" | "rolled_back" | "cancelled";
}
```

All non-selected samples continue on the existing L2/L3 path and form the control group.

- [ ] **Step 4: 运行 autonomy/policy/budget tests**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/policy test && pnpm --filter @forge/usage-ledger test`

Expected: PASS for selection, bounds, expiry, pause, cost and rollback.

- [ ] **Step 5: 提交 Canary service**

```bash
git add packages/company-domain/src/autonomy/canary.ts packages/company-domain/src/autonomy/canary.test.ts packages/company-domain/src/autonomy/supervisor.ts
git commit -m "feat(autonomy): add bounded canary rollouts"
```

### Task 7: 实现 L4 Promotion、自动降级和永久治理边界

**Files:**
- Create: `packages/company-domain/src/autonomy/promotion.ts`
- Create: `packages/company-domain/src/autonomy/promotion.test.ts`
- Modify: `packages/company-domain/src/autonomy/grants.ts`
- Create: `apps/daemon/src/autonomy-l4-boundary.e2e.test.ts`

**Interfaces:**
- Consumes: Simulation、Shadow、Canary evidence and approvals。
- Produces: `PromotionService.propose()`、`approve()`、`demote()`、`rollback()`。

- [ ] **Step 1: 写版本匹配、永久禁止动作和自动降级测试**

```ts
it("rejects promotion evidence from a different workflow version", () => {
  expect(() => promotion.propose(promotionInput({ workflowVersionId: "wf-v4", evidenceWorkflowVersionId: "wf-v3" })))
    .toThrow("promotion evidence version mismatch");
});

it.each(["payment.execute", "legal.commit", "audit.delete", "policy.update", "permission.expand"])(
  "keeps %s outside L4 autonomous actions",
  (action) => expect(() => validateL4AllowedActions([action])).toThrow("permanently governed action"),
);
```

- [ ] **Step 2: 运行 promotion/E2E 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/autonomy/promotion.test.ts apps/daemon/src/autonomy-l4-boundary.e2e.test.ts`

Expected: FAIL because PromotionService is absent.

- [ ] **Step 3: 实现 evidence-bound promotion and demotion**

```ts
export class PromotionService {
  propose(input: ProposePromotionInput): AutonomyPromotion;
  approve(id: string, approvedBy: SubjectRef): AutonomyGrant;
  demote(grantId: string, targetLevel: 2 | 3, reason: string): AutonomyGrant;
  rollback(promotionId: string, reason: string): AutonomyGrant;
}
```

Promotion approval expires if any referenced version changes before activation. Critical incidents automatically demote and suspend new autonomous runs.

- [ ] **Step 4: 运行 promotion/autonomy/policy E2E**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/policy test && pnpm exec vitest run apps/daemon/src/autonomy-l4-boundary.e2e.test.ts`

Expected: PASS; permanently governed actions return approval/deny and never auto-execute.

- [ ] **Step 5: 提交 L4 promotion**

```bash
git add packages/company-domain/src/autonomy apps/daemon/src/autonomy-l4-boundary.e2e.test.ts
git commit -m "feat(autonomy): add evidence-bound l4 promotion"
```

### Task 8: 注册 Simulation module、晋级 UI 和 P4 总门禁

**Files:**
- Create: `apps/daemon/src/modules/simulation-module.ts`
- Create: `apps/daemon/src/modules/simulation-module.test.ts`
- Create: `apps/company-desktop/src/renderer/features/simulation/scenario-library.tsx`
- Create: `apps/company-desktop/src/renderer/features/simulation/simulation-report.tsx`
- Create: `apps/company-desktop/src/renderer/features/simulation/promotion-wizard.tsx`
- Create: `apps/company-desktop/src/renderer/features/simulation/simulation-ui.test.tsx`
- Create: `scripts/eval-cases/autonomy-l4/limited-business-unit.json`
- Create: `apps/daemon/src/company-autonomy-l4.e2e.test.ts`
- Modify: `package.json`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: P4 all services。
- Produces: scenario/replay/shadow/canary/promotion RPC, UI, E2E。

- [ ] **Step 1: 写证据链 UI 和完整 L4 E2E**

```tsx
it("shows simulation shadow and canary evidence before enabling promotion", () => {
  render(<PromotionWizard evidence={completePromotionEvidence()} />);
  expect(screen.getByText("Simulation 已通过")).toBeVisible();
  expect(screen.getByText("Shadow 已通过")).toBeVisible();
  expect(screen.getByText("Canary 已通过")).toBeVisible();
});

it("runs a limited L4 scenario then auto-demotes on guardrail breach", async () => {
  const fx = await l4E2eFixture();
  const grant = await fx.promoteAfterAllStages();
  await fx.runAllowedEvents();
  await fx.injectCriticalIncident();
  expect(await fx.grantLevel(grant.id)).toBe(3);
  expect(fx.unapprovedCriticalActions()).toBe(0);
});
```

- [ ] **Step 2: 运行 module/UI/E2E 确认 integration 缺口**

Run: `pnpm exec vitest run apps/daemon/src/modules/simulation-module.test.ts apps/company-desktop/src/renderer/features/simulation/simulation-ui.test.tsx apps/daemon/src/company-autonomy-l4.e2e.test.ts`

Expected: FAIL until RPC/UI/event wiring is complete.

- [ ] **Step 3: 注册 typed RPC、UI 和 eval case**

UI requires explicit human approval at Canary start and L4 promotion; the global emergency stop remains visible in the Company shell while any L3/L4 grant is active. Add `@forge/simulation` to the root `test` filter list.

- [ ] **Step 4: 运行 P4 全门禁**

Run:

```bash
pnpm --filter @forge/simulation test
pnpm --filter @forge/company-domain test
pnpm --filter @forge/workflows test
pnpm --filter @forge/connectors test
pnpm --filter @forge/company-desktop test
pnpm --filter @forge/company-desktop build
pnpm --filter @forge/daemon test
pnpm test
pnpm eval
```

Expected: all PASS; Shadow has zero live writes, Canary stays within cohort/budget, and L4 auto-demotes on the injected incident.

- [ ] **Step 5: 提交 Company P4 gate**

```bash
git add package.json apps/daemon/src/modules/simulation-module.ts apps/daemon/src/modules/simulation-module.test.ts apps/daemon/src/company-autonomy-l4.e2e.test.ts apps/company-desktop/src/renderer/features/simulation scripts/eval-cases/autonomy-l4 docs/roadmap.md
git commit -m "feat(company): complete limited l4 autonomy pipeline"
```
