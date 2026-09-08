# Forge Company P1 Requirement-to-Delivery Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可独立结束的纯需求调研流程，以及从问题输入、并行研究、范围评审、多工作区开发、三层验证到发布复盘的完整产品交付闭环。

**Architecture:** 使用 Company WorkItem/StageGate 表达业务阶段，Workflow 2.0 编排 Core Durable Run；研究结论使用 Evidence 引用，研发使用 WorkspaceGroup 和结构化 Handoff，发布由 Validation + Approval 决定。Company 展示业务进度，Workbench 展示具体 Run/Step/Workspace 并支持授权接管。

**Tech Stack:** `@forge/company-domain`、`@forge/workflows`、`@forge/execution`、`@forge/workspace`、`@forge/evidence`、Electron/React/Vitest/SQLite。

**Spec:** `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

## Global Constraints

- 纯调研可以作为有效终点，不强制进入研发。
- 研究输出必须区分事实、来源、推断、假设和未知项。
- 阶段门必须持久化决策人、输入版本、结论、理由和影响。
- 不同工作区可以并行写，同一工作区保持 single-writer。
- 结果、过程、回答三层验证均通过后才能接受关键交付。
- 发布、部署和破坏性操作保持高风险审批。
- 代码片段中的 `*Fixture`、`fake*` 等名称均是在同一测试文件中创建的确定性测试夹具；写失败测试步骤必须同时实现这些夹具的最小定义。

---

## File Structure Map

| Path | Responsibility |
|---|---|
| `migrations/020_company_delivery.sql` | intake、research、stage gates、release、feedback |
| `packages/company-domain/src/delivery/intake.ts` | 信息完整性与研究 brief |
| `packages/company-domain/src/delivery/research.ts` | 研究问题、claim、unknown、synthesis |
| `packages/company-domain/src/delivery/stage-gate.ts` | 阶段门决策 |
| `packages/company-domain/src/delivery/delivery-project.ts` | 团队/工作区/里程碑配置 |
| `packages/company-domain/src/delivery/release.ts` | 发布候选、审批和复盘 |
| `packages/workflows/src/templates/requirement-research.ts` | 纯调研 workflow |
| `packages/workflows/src/templates/product-delivery.ts` | 完整交付 workflow |
| `packages/evidence/src/validators/delivery/*` | 三层交付 validators |
| `apps/company-desktop/src/renderer/features/delivery/*` | Intake、研究、阶段门、发布 UI |

## Public Interfaces Locked by This Plan

```ts
export interface ResearchClaim {
  id: string; briefId: string; text: string;
  classification: "fact" | "inference" | "hypothesis" | "unknown";
  evidenceIds: string[]; confidence: number;
  contradictions: string[];
}

export interface StageGateDecision {
  id: string; gate: "research" | "scope" | "technical" | "release";
  outcome: "approved" | "rejected" | "changes_requested" | "stopped";
  inputVersionRefs: string[]; decidedBy: SubjectRef; rationale: string;
  decidedAt: string;
}
```

### Task 1: 添加 Delivery Schema 和领域类型

**Files:**
- Create: `migrations/020_company_delivery.sql`
- Create: `packages/store/src/company-delivery-migration.test.ts`
- Create: `packages/company-domain/src/delivery/types.ts`
- Modify: `packages/company-domain/src/index.ts`

**Interfaces:**
- Consumes: Company P0 schema。
- Produces: brief、question、claim、gate、release、feedback 持久化。

- [ ] **Step 1: 写 Schema 与分类约束测试**

```ts
it("creates delivery loop tables with explicit claim classes", () => {
  const db = openMigratedFixture().db;
  expect(tableNames(db)).toEqual(expect.arrayContaining([
    "company_research_briefs", "company_research_questions", "company_research_claims",
    "company_stage_gates", "company_release_candidates", "company_feedback_items",
  ]));
  expect(tableSql(db, "company_research_claims")).toContain("'fact','inference','hypothesis','unknown'");
});
```

- [ ] **Step 2: 运行 migration 测试确认表缺失**

Run: `pnpm exec vitest run packages/store/src/company-delivery-migration.test.ts`

Expected: FAIL listing delivery tables.

- [ ] **Step 3: 创建 migration 和严格领域 DTO**

```sql
CREATE TABLE company_stage_gates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  project_id TEXT REFERENCES company_projects(id),
  gate_kind TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('approved','rejected','changes_requested','stopped')),
  input_version_refs_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
```

- [ ] **Step 4: 运行 Store 和 company-domain build**

Run: `pnpm --filter @forge/store test && pnpm --filter @forge/company-domain build`

Expected: PASS.

- [ ] **Step 5: 提交 Delivery schema/types**

```bash
git add migrations/020_company_delivery.sql packages/store/src/company-delivery-migration.test.ts packages/company-domain/src/delivery packages/company-domain/src/index.ts
git commit -m "feat(company): add delivery loop schema"
```

### Task 2: 实现 Intake 完整性、问题定义和研究 Brief

**Files:**
- Create: `packages/company-domain/src/delivery/intake.ts`
- Create: `packages/company-domain/src/delivery/intake.test.ts`

**Interfaces:**
- Consumes: 原始问题、目标用户、期望结果、约束。
- Produces: `IntakeAssessment`、`ResearchBrief`、缺失问题。

- [ ] **Step 1: 写信息充分与缺失信息测试**

```ts
it("creates a ready brief when problem user and outcome are present", () => {
  expect(assessIntake(validIntake())).toMatchObject({ ready: true, missingFields: [] });
});

it("asks only for material missing fields", () => {
  expect(assessIntake({ problem: "转化低", targetUser: "", expectedOutcome: "" }))
    .toMatchObject({ ready: false, missingFields: ["targetUser", "expectedOutcome"] });
});
```

- [ ] **Step 2: 运行 intake tests 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/delivery/intake.test.ts`

Expected: FAIL because `assessIntake` is absent.

- [ ] **Step 3: 实现确定性完整性规则和 Brief 版本**

```ts
export interface IntakeAssessment {
  ready: boolean; missingFields: Array<keyof IntakeInput>;
  normalizedProblem: string; researchQuestions: string[];
  suggestedStopConditions: string[];
}
```

LLM may suggest wording and questions, but deterministic code decides required-field readiness and stores the accepted Brief version.

- [ ] **Step 4: 运行 intake/domain tests**

Run: `pnpm exec vitest run packages/company-domain/src/delivery/intake.test.ts && pnpm --filter @forge/company-domain test`

Expected: PASS for whitespace, excessive input, conflicting constraints and version updates.

- [ ] **Step 5: 提交 Intake service**

```bash
git add packages/company-domain/src/delivery/intake.ts packages/company-domain/src/delivery/intake.test.ts
git commit -m "feat(delivery): add requirement intake assessment"
```

### Task 3: 实现并行研究 Workflow 模板

**Files:**
- Create: `packages/workflows/src/templates/requirement-research.ts`
- Create: `packages/workflows/src/templates/requirement-research.test.ts`
- Modify: `packages/workflows/src/index.ts`

**Interfaces:**
- Consumes: ResearchBrief、研究员工 AgentProfile refs。
- Produces: `createRequirementResearchWorkflow()`。

- [ ] **Step 1: 写四路并行和证据要求测试**

```ts
it("creates user market code-data and risk branches in wave zero", () => {
  const workflow = createRequirementResearchWorkflow(researchTemplateInput());
  expect(workflow.steps.filter((step) => step.dependsOn.length === 0).map((step) => step.id).sort())
    .toEqual(["code-data-research", "market-research", "risk-research", "user-research"]);
  expect(workflow.steps.find((step) => step.id === "synthesis")?.dependsOn).toHaveLength(4);
});
```

- [ ] **Step 2: 运行 workflow template test 确认缺失**

Run: `pnpm exec vitest run packages/workflows/src/templates/requirement-research.test.ts`

Expected: FAIL because the template is absent.

- [ ] **Step 3: 实现版本化 WorkflowDefinition**

```ts
export function createRequirementResearchWorkflow(input: ResearchWorkflowInput): WorkflowDefinition {
  return {
    id: "forge.company.requirement-research", version: 1,
    inputSchema: RESEARCH_INPUT_SCHEMA,
    steps: [...parallelResearchSteps(input), synthesisStep(), researchGateStep()],
    triggers: [{ kind: "manual" }], concurrency: { maxRuns: 4, keyExpression: "$.briefId" },
  };
}
```

Every research Step output contract requires claims plus EvidenceRefs and unknowns.

- [ ] **Step 4: 运行 workflow/execution tests**

Run: `pnpm --filter @forge/workflows test && pnpm --filter @forge/execution test`

Expected: PASS; parallel branches bind independent read-only workspaces where configured.

- [ ] **Step 5: 提交研究 Workflow**

```bash
git add packages/workflows/src/templates packages/workflows/src/index.ts
git commit -m "feat(delivery): add parallel requirement research workflow"
```

### Task 4: 实现 Claim 归一化、矛盾检查和研究综合

**Files:**
- Create: `packages/company-domain/src/delivery/research.ts`
- Create: `packages/company-domain/src/delivery/research.test.ts`
- Create: `packages/evidence/src/validators/delivery/research-evidence.ts`
- Create: `packages/evidence/src/validators/delivery/research-evidence.test.ts`

**Interfaces:**
- Consumes: branch research artifacts/evidence。
- Produces: `synthesizeResearch()`、`ResearchEvidenceValidator`。

- [ ] **Step 1: 写无来源事实、冲突和未知项测试**

```ts
it("downgrades a fact without evidence to hypothesis", () => {
  const result = normalizeClaim({ text: "用户都需要它", classification: "fact", evidenceIds: [] });
  expect(result.classification).toBe("hypothesis");
});

it("keeps contradictory claims and links both ids", () => {
  const result = synthesizeResearch(contradictoryClaimsFixture());
  expect(result.conflicts[0]).toMatchObject({ claimIds: ["claim-a", "claim-b"] });
});
```

- [ ] **Step 2: 运行 research/evidence tests 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/delivery/research.test.ts packages/evidence/src/validators/delivery/research-evidence.test.ts`

Expected: FAIL because synthesis and validator are absent.

- [ ] **Step 3: 实现 claim 分类规则和引用完整性验证**

```ts
export interface ResearchSynthesis {
  claims: ResearchClaim[]; conflicts: ClaimConflict[]; unknowns: ResearchClaim[];
  recommendation: "stop" | "continue_research" | "enter_product_definition";
  rationaleClaimIds: string[];
}
```

Recommendation is stored as an inference with supporting claim IDs, never as a source fact.

- [ ] **Step 4: 运行 research、evidence、domain tests**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/evidence test`

Expected: PASS for missing citations, stale versions, contradictions, confidence bounds and unknowns.

- [ ] **Step 5: 提交 research synthesis**

```bash
git add packages/company-domain/src/delivery/research.ts packages/company-domain/src/delivery/research.test.ts packages/evidence/src/validators/delivery
git commit -m "feat(delivery): add evidence-backed research synthesis"
```

### Task 5: 实现 Research/Scope/Technical/Release 阶段门

**Files:**
- Create: `packages/company-domain/src/delivery/stage-gate.ts`
- Create: `packages/company-domain/src/delivery/stage-gate.test.ts`
- Modify: `packages/protocol/src/v2/company.ts`
- Modify: `apps/daemon/src/modules/company-module.ts`

**Interfaces:**
- Consumes: versioned artifacts、validation、human decision。
- Produces: `StageGateService.decide()`、`company.delivery.gates.*` RPC。

- [ ] **Step 1: 写输入版本锁定和 stop 分支测试**

```ts
it("rejects a decision when an input version changed", () => {
  expect(() => gates.decide(gateDecision({ inputVersionRefs: ["brief:v1"] }), currentRefs(["brief:v2"])))
    .toThrow("gate inputs changed");
});

it("stops after research without creating a development project", () => {
  const result = gates.decide(stopAfterResearchDecision(), currentRefs());
  expect(result.nextAction).toBe("close_research_project");
});
```

- [ ] **Step 2: 运行 stage-gate tests 确认服务缺失**

Run: `pnpm exec vitest run packages/company-domain/src/delivery/stage-gate.test.ts`

Expected: FAIL because `StageGateService` is absent.

- [ ] **Step 3: 实现四种 gate 和不可变 Decision record**

```ts
export class StageGateService {
  decide(input: DecideStageGateInput, currentInputVersionRefs: string[]): StageGateDecision;
  getLatest(projectId: string, gate: StageGateDecision["gate"]): StageGateDecision | null;
}
```

Only approved Research gate may enter product definition; only approved Scope/Technical gates may create development WorkItems; only approved Release gate may call deployment Connector.

- [ ] **Step 4: 运行 domain/protocol/daemon tests**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/protocol test && pnpm --filter @forge/daemon test`

Expected: PASS for approve, reject, changes requested, stop and stale input.

- [ ] **Step 5: 提交 stage gates**

```bash
git add packages/company-domain/src/delivery/stage-gate.ts packages/company-domain/src/delivery/stage-gate.test.ts packages/protocol/src/v2/company.ts apps/daemon/src/modules/company-module.ts
git commit -m "feat(delivery): add versioned product stage gates"
```

### Task 6: 实现交付项目团队与 WorkspaceGroup 配置

**Files:**
- Create: `packages/company-domain/src/delivery/delivery-project.ts`
- Create: `packages/company-domain/src/delivery/delivery-project.test.ts`
- Modify: `packages/company-domain/src/project-service.ts`

**Interfaces:**
- Consumes: approved scope、Employee、WorkspaceGroupService。
- Produces: `createDeliveryProject()`、team assignments、workspace bindings。

- [ ] **Step 1: 写角色覆盖、工作区绑定和冲突测试**

```ts
it("requires product engineering and independent validation owners", () => {
  expect(() => createDeliveryProject(projectInput({ validators: [] })))
    .toThrow("independent validation owner required");
});

it("binds each implementation stream to an explicit workspace", () => {
  const project = createDeliveryProject(validDeliveryProjectInput());
  expect(project.assignments.every((a) => a.workspaceBindingId)).toBe(true);
});
```

- [ ] **Step 2: 运行 delivery-project tests 确认服务缺失**

Run: `pnpm exec vitest run packages/company-domain/src/delivery/delivery-project.test.ts`

Expected: FAIL because factory is absent.

- [ ] **Step 3: 实现精简组队、binding 和 milestone**

```ts
export interface DeliveryAssignment {
  employeeId: string; responsibility: "product" | "architecture" | "implementation" | "validation";
  workItemId: string; workspaceBindingId?: string;
}
```

Research roles may remain read-only; only implementation roles receive write leases, and validation owner cannot be the same employee as the final implementation owner.

- [ ] **Step 4: 运行 company/workspace tests**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/workspace test`

Expected: PASS for missing role, cross-company employee, binding scope and validator independence.

- [ ] **Step 5: 提交交付项目配置**

```bash
git add packages/company-domain/src/delivery/delivery-project.ts packages/company-domain/src/delivery/delivery-project.test.ts packages/company-domain/src/project-service.ts
git commit -m "feat(delivery): add project teams and workspace bindings"
```

### Task 7: 实现完整 Product Delivery Workflow 和结构化交接

**Files:**
- Create: `packages/workflows/src/templates/product-delivery.ts`
- Create: `packages/workflows/src/templates/product-delivery.test.ts`
- Modify: `packages/workflows/src/index.ts`
- Modify: `packages/company-domain/src/handoff.ts`

**Interfaces:**
- Consumes: approved scope/technical gate、DeliveryProject。
- Produces: `createProductDeliveryWorkflow()`。

- [ ] **Step 1: 写依赖图、并行 streams 和 Handoff contract tests**

```ts
it("joins implementation streams before integrated validation", () => {
  const workflow = createProductDeliveryWorkflow(deliveryWorkflowInput());
  expect(step(workflow, "integrated-validation").dependsOn.sort())
    .toEqual(["backend", "docs", "frontend"]);
});

it("requires artifact evidence and uncertainties in each handoff", () => {
  expect(() => validateHandoff({ ...validHandoff(), evidenceIds: [], uncertainties: undefined as never }))
    .toThrow("invalid handoff");
});
```

- [ ] **Step 2: 运行 template/handoff tests 确认失败**

Run: `pnpm exec vitest run packages/workflows/src/templates/product-delivery.test.ts packages/company-domain/src/work-item.test.ts`

Expected: FAIL until workflow and stricter handoff validation exist.

- [ ] **Step 3: 实现 delivery DAG 与 WorkItem/Run linking hooks**

```ts
export function createProductDeliveryWorkflow(input: ProductDeliveryWorkflowInput): WorkflowDefinition {
  return {
    id: "forge.company.product-delivery", version: 1,
    inputSchema: PRODUCT_DELIVERY_INPUT_SCHEMA,
    steps: [designStep(input), ...implementationSteps(input), integratedValidationStep(), releaseGateStep(), reviewStep()],
    triggers: [{ kind: "manual" }], concurrency: { maxRuns: 1, keyExpression: "$.projectId" },
  };
}
```

- [ ] **Step 4: 运行 workflow/company/execution tests**

Run: `pnpm --filter @forge/workflows test && pnpm --filter @forge/company-domain test && pnpm --filter @forge/execution test`

Expected: PASS for success, one stream failure, retry, handoff rejection and resume.

- [ ] **Step 5: 提交 Delivery Workflow**

```bash
git add packages/workflows/src/templates packages/company-domain/src/handoff.ts
git commit -m "feat(delivery): add multi-workspace delivery workflow"
```

### Task 8: 实现三层交付验证、Release Candidate 和复盘

**Files:**
- Create: `packages/evidence/src/validators/delivery/result-validator.ts`
- Create: `packages/evidence/src/validators/delivery/process-validator.ts`
- Create: `packages/evidence/src/validators/delivery/answer-validator.ts`
- Create: `packages/evidence/src/validators/delivery/delivery-validation.test.ts`
- Create: `packages/company-domain/src/delivery/release.ts`
- Create: `packages/company-domain/src/delivery/release.test.ts`

**Interfaces:**
- Consumes: workspace checkpoint、tests/build、Trace、final claim。
- Produces: `DeliveryValidationBundle`、`ReleaseCandidate`、`DeliveryReview`。

- [ ] **Step 1: 写虚假完成、缺审批和反馈回流测试**

```ts
it("blocks a final answer that claims success after failed tests", async () => {
  const result = await validateDelivery(deliveryFixture({ testsPassed: false, finalClaim: "全部完成" }));
  expect(result.accepted).toBe(false);
  expect(result.results).toContainEqual(expect.objectContaining({ layer: "answer", status: "failed" }));
});

it("creates feedback items from release review failures", () => {
  const review = releases.recordReview(reviewInput({ escapedDefects: ["bug-1"] }));
  expect(review.feedbackItemIds).toHaveLength(1);
});
```

- [ ] **Step 2: 运行 validation/release tests 确认实现缺失**

Run: `pnpm exec vitest run packages/evidence/src/validators/delivery/delivery-validation.test.ts packages/company-domain/src/delivery/release.test.ts`

Expected: FAIL because validators/release service are absent.

- [ ] **Step 3: 实现 validator bundle、ReleaseCandidate 和 review metrics**

```ts
export interface ReleaseCandidate {
  id: string; projectId: string; checkpointId: string;
  artifactIds: string[]; validationIds: string[];
  rollbackPlanArtifactId: string; approvalId?: string;
  state: "draft" | "validating" | "waiting_approval" | "approved" | "released" | "rejected";
}
```

Release approval must bind candidate/checkpoint hashes; changed artifacts invalidate approval.

- [ ] **Step 4: 运行 evidence/company/policy tests**

Run: `pnpm --filter @forge/evidence test && pnpm --filter @forge/company-domain test && pnpm --filter @forge/policy test`

Expected: PASS for three layers, changed candidate, rollback plan, released and rejected paths.

- [ ] **Step 5: 提交验证与发布领域**

```bash
git add packages/evidence/src/validators/delivery packages/company-domain/src/delivery/release.ts packages/company-domain/src/delivery/release.test.ts
git commit -m "feat(delivery): add validation release and review"
```

### Task 9: 实现 Delivery UI 和 Workbench 深链接管

**Files:**
- Create: `apps/company-desktop/src/renderer/features/delivery/intake-page.tsx`
- Create: `apps/company-desktop/src/renderer/features/delivery/research-page.tsx`
- Create: `apps/company-desktop/src/renderer/features/delivery/stage-gate-panel.tsx`
- Create: `apps/company-desktop/src/renderer/features/delivery/delivery-timeline.tsx`
- Create: `apps/company-desktop/src/renderer/features/delivery/release-panel.tsx`
- Create: `apps/company-desktop/src/renderer/features/delivery/delivery-ui.test.tsx`
- Modify: `apps/company-desktop/src/deep-links.ts`

**Interfaces:**
- Consumes: Delivery DTOs、Run/Artifact/Evidence refs。
- Produces: 调研和交付可视化、只读/接管 Workbench deep links。

- [ ] **Step 1: 写事实分类、阶段门和接管链接 tests**

```tsx
it("renders fact inference hypothesis and unknown distinctly", () => {
  render(<ResearchPage model={researchFixture()} />);
  for (const label of ["事实", "推断", "假设", "未知"]) expect(screen.getByText(label)).toBeVisible();
});

it("opens a failed step in workbench takeover mode", async () => {
  render(<DeliveryTimeline model={failedStepFixture()} openWorkbench={openWorkbench} />);
  await user.click(screen.getByRole("button", { name: "在 Workbench 接管" }));
  expect(openWorkbench).toHaveBeenCalledWith({ kind: "run", id: "r1", stepId: "s1", mode: "takeover" });
});
```

- [ ] **Step 2: 运行 Delivery UI tests 确认组件缺失**

Run: `pnpm exec vitest run apps/company-desktop/src/renderer/features/delivery/delivery-ui.test.tsx`

Expected: FAIL because delivery UI is absent.

- [ ] **Step 3: 实现 Intake、Research、Gate、Timeline、Release views**

Every claim opens its Evidence source/version/locator; every stage shows responsible employee, WorkItem, Run state, cost, artifacts, validations, decision and next action.

- [ ] **Step 4: 运行 Company UI tests/build**

Run: `pnpm --filter @forge/company-desktop test && pnpm --filter @forge/company-desktop build`

Expected: PASS with keyboard-accessible gates and no action hidden behind hover only.

- [ ] **Step 5: 提交 Delivery UI**

```bash
git add apps/company-desktop/src/renderer/features/delivery apps/company-desktop/src/deep-links.ts
git commit -m "feat(delivery): add research and delivery experience"
```

### Task 10: 建立纯调研与完整交付 E2E 门

**Files:**
- Create: `apps/daemon/src/company-research.e2e.test.ts`
- Create: `apps/daemon/src/company-delivery.e2e.test.ts`
- Create: `scripts/eval-cases/company-research.json`
- Create: `scripts/eval-cases/company-delivery.json`
- Modify: `scripts/eval.mjs`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: P1 全部服务和 UI contracts。
- Produces: 两条旗舰路径的自动化验收。

- [ ] **Step 1: 写两个完整 E2E**

```ts
it("finishes a research-only project after a stop decision", async () => {
  const fx = await deliveryE2eFixture();
  const result = await fx.runResearchOnly(validIntake());
  expect(result.project.state).toBe("completed");
  expect(result.developmentWorkItems).toEqual([]);
  expect(result.synthesis.claims.every((claim) => claim.classification !== "fact" || claim.evidenceIds.length > 0)).toBe(true);
});

it("delivers across workspaces and blocks release until validation and approval", async () => {
  const fx = await deliveryE2eFixture();
  const result = await fx.runFullDelivery(validIntake());
  expect(result.workspaceWrites).toMatchObject({ frontend: 1, backend: 1 });
  expect(result.validation.accepted).toBe(true);
  expect(result.release.state).toBe("released");
});
```

- [ ] **Step 2: 运行 E2E 并确认未集成路径失败**

Run: `pnpm exec vitest run apps/daemon/src/company-research.e2e.test.ts apps/daemon/src/company-delivery.e2e.test.ts`

Expected: FAIL until end-to-end module wiring is complete.

- [ ] **Step 3: 补齐事件投影、RPC wiring 和 eval fixtures**

The full fixture injects deterministic research/implementation executors, two temporary Git workspaces and a mock release connector; assertions use environment state, not generated prose.

- [ ] **Step 4: 运行 P1 全门禁**

Run:

```bash
pnpm --filter @forge/company-domain test
pnpm --filter @forge/workflows test
pnpm --filter @forge/evidence test
pnpm --filter @forge/company-desktop test
pnpm --filter @forge/company-desktop build
pnpm --filter @forge/daemon test
pnpm test
pnpm eval
```

Expected: all PASS; both E2E cases report traceable artifacts/evidence.

- [ ] **Step 5: 提交 Company P1 gate**

```bash
git add apps/daemon/src/company-research.e2e.test.ts apps/daemon/src/company-delivery.e2e.test.ts scripts/eval-cases scripts/eval.mjs docs/roadmap.md
git commit -m "feat(company): complete requirement delivery loop"
```
