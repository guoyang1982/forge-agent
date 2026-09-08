# Forge Company P0 Operating System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付独立 Forge Company 应用，使用户能创建公司、组织和数字员工，管理目标、项目、WorkItem、审批，并通过经营首页和 CEO 助手掌握公司运行。

**Architecture:** 新建 `apps/company-desktop`，使用 Electron main + 安全 preload + React renderer；renderer 不能访问 socket、数据库或任意 Node API。新增 `@forge/company-domain` 实现业务规则，Daemon `company-module` 是唯一业务写入口；`company_run_links` 把业务对象映射到 Core Run/Evidence，不复制执行引擎。

**Tech Stack:** Electron 39.8.5、React 19.2.3、TypeScript 5.8.3、esbuild 0.25.0、Vitest 3.0.9、Testing Library/jsdom、SQLite WAL、Core v2 typed RPC。

**Spec:** `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

## Global Constraints

- A 经营总览是默认首页；B 是“组织与员工”模块；C 是全局 CEO 助手抽屉。
- Company 是独立应用但共用一套 Daemon、数据库和 Runtime。
- Company 状态以领域表为权威，不保存在聊天或 Memory。
- renderer 只能调用 allowlisted、类型化 preload API。
- MVP 默认 L2，CEO 助手只能发起草案或受控命令，不能绕过审批。
- 所有卡片和指标必须下钻到真实 Goal、Project、WorkItem、Run、Evidence 或 Approval。
- 代码片段中的 `*Fixture`、`fake*` 等名称均是在同一测试文件中创建的确定性测试夹具；写失败测试步骤必须同时实现这些夹具的最小定义。

---

## File Structure Map

| Path | Responsibility |
|---|---|
| `apps/company-desktop/package.json` | 应用依赖、build/test/start 脚本 |
| `apps/company-desktop/src/main.ts` | Electron lifecycle、Daemon client、deep link |
| `apps/company-desktop/src/preload.ts` | allowlisted `window.forgeCompany` API |
| `apps/company-desktop/src/renderer/index.html` | renderer 入口 |
| `apps/company-desktop/src/renderer/app.tsx` | 全局 Shell、router、drawer |
| `apps/company-desktop/src/renderer/styles/tokens.css` | 设计 token |
| `apps/company-desktop/src/renderer/styles/app.css` | 布局与组件样式 |
| `apps/company-desktop/src/renderer/features/*` | 按业务功能拆分 UI/state |
| `packages/company-domain/src/*` | 公司领域 types、repositories、services、projections |
| `migrations/019_company_p0.sql` | Company P0 tables |
| `apps/daemon/src/modules/company-module.ts` | Company typed RPC |
| `packages/protocol/src/v2/company.ts` | Company DTO 与 RpcContractMap augmentation |

## Public Interfaces Locked by This Plan

```ts
export interface WorkItem {
  id: string; companyId: string; goalId?: string; projectId?: string;
  type: string; title: string; problem: string; expectedOutcome: string;
  ownerId: string; assigneeId?: string; state: WorkItemState;
  acceptanceCriteria: AcceptanceCriterion[];
  risk: RiskLevel; autonomyLevel: 0 | 1 | 2 | 3 | 4;
  budgetAccountId?: string; dueAt?: string; version: number;
}

export interface AcceptanceCriterion { id: string; text: string; validatorId?: string; blocking: boolean }
export interface KpiDefinition { id: string; name: string; unit: string; target: number; period: string }
export type CompanyQueryMethod =
  | "company.get" | "company.dashboard.get" | "company.organization.tree"
  | "company.employees.list" | "company.goals.list" | "company.projects.list"
  | "company.workItems.list" | "company.approvals.list";
export type CompanyCommandMethod =
  | "company.create" | "company.employees.hire" | "company.employees.activate"
  | "company.goals.create" | "company.projects.create" | "company.workItems.create"
  | "company.workItems.transition" | "company.approvals.decide";
export type CompanyRpcMethod = CompanyQueryMethod | CompanyCommandMethod;
export type CompanyParams<M extends CompanyRpcMethod> = RpcParams<M>;
export type CompanyResult<M extends CompanyRpcMethod> = RpcResult<M>;
export interface CompanyEventFilter { companyId: string; eventTypes?: string[] }
export type Unsubscribe = () => void;

export interface CompanyApi {
  query<M extends CompanyQueryMethod>(method: M, params: CompanyParams<M>): Promise<CompanyResult<M>>;
  command<M extends CompanyCommandMethod>(method: M, params: CompanyParams<M>): Promise<CompanyResult<M>>;
  subscribe(filter: CompanyEventFilter, handler: (event: EventEnvelope) => void): Promise<Unsubscribe>;
}
```

### Task 1: 搭建独立 Company Electron 应用与安全边界

**Files:**
- Create: `apps/company-desktop/package.json`
- Create: `apps/company-desktop/tsconfig.json`
- Create: `apps/company-desktop/tsconfig.preload.json`
- Create: `apps/company-desktop/scripts/build-renderer.mjs`
- Create: `apps/company-desktop/src/main.ts`
- Create: `apps/company-desktop/src/preload.ts`
- Create: `apps/company-desktop/src/security.test.ts`
- Create: `apps/company-desktop/src/renderer/index.html`
- Create: `apps/company-desktop/src/renderer/app.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: `@forge/daemon-client` v2。
- Produces: `window.forgeCompany` 和可启动的空 Company Shell。

- [ ] **Step 1: 写 BrowserWindow 与 preload 安全测试**

```ts
it("uses isolation and disables renderer node integration", () => {
  expect(companyWindowOptions().webPreferences).toMatchObject({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  });
});

it("exposes only invoke subscribe and openWorkbench", () => {
  expect(Object.keys(createPreloadApi(fakeIpc()))).toEqual([
    "invoke", "subscribe", "openWorkbench", "getAppInfo",
  ]);
});
```

- [ ] **Step 2: 运行测试确认应用不存在**

Run: `pnpm --filter @forge/company-desktop test`

Expected: FAIL because workspace package is absent.

- [ ] **Step 3: 实现最小 Electron main/preload/renderer build**

```ts
export const COMPANY_WINDOW_OPTIONS: Electron.BrowserWindowConstructorOptions = {
  width: 1440, height: 920, minWidth: 1180, minHeight: 720,
  webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true,
    preload: preloadPath,
  },
};
```

Add root scripts `dev:company`、`start:company`、`pack:company`; renderer bundle uses esbuild with no remote content and a restrictive CSP.

- [ ] **Step 4: 运行 app tests 与 build**

Run: `pnpm --filter @forge/company-desktop test && pnpm --filter @forge/company-desktop build`

Expected: PASS and generated renderer bundle has no Node built-in imports.

- [ ] **Step 5: 提交 Company app scaffold**

```bash
git add apps/company-desktop package.json
git commit -m "feat(company): scaffold secure desktop app"
```

### Task 2: 添加 Company P0 Schema

**Files:**
- Create: `migrations/019_company_p0.sql`
- Create: `packages/store/src/company-p0-migration.test.ts`

**Interfaces:**
- Consumes: ForgeStore。
- Produces: company、org、employee、goal、project、work item、decision、run link tables。

- [ ] **Step 1: 写表、外键和状态约束测试**

```ts
it("creates all P0 company tables", () => {
  expect(tableNames(openMigratedFixture().db)).toEqual(expect.arrayContaining([
    "company_companies", "company_departments", "company_position_templates", "company_positions",
    "company_employees", "company_employments", "company_reporting_lines",
    "company_goals", "company_projects", "company_project_teams",
    "company_work_items", "company_work_dependencies", "company_handoffs",
    "company_decisions", "company_run_links",
  ]));
});
```

- [ ] **Step 2: 运行 migration 测试确认表缺失**

Run: `pnpm exec vitest run packages/store/src/company-p0-migration.test.ts`

Expected: FAIL listing missing Company tables.

- [ ] **Step 3: 创建 migration 与 company_id 作用域索引**

```sql
CREATE TABLE company_work_items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  project_id TEXT REFERENCES company_projects(id),
  state TEXT NOT NULL CHECK (state IN (
    'draft','ready','in_progress','waiting_input','waiting_approval','blocked',
    'submitted','verifying','accepted','rejected','completed','cancelled'
  )),
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Every mutable aggregate gets `version` for optimistic concurrency and `company_id` for hard query scoping.

- [ ] **Step 4: 运行 Store migration 全测**

Run: `pnpm --filter @forge/store test`

Expected: PASS including rollback and duplicate migration.

- [ ] **Step 5: 提交 Company Schema**

```bash
git add migrations/019_company_p0.sql packages/store/src/company-p0-migration.test.ts
git commit -m "feat(company): add p0 domain schema"
```

### Task 3: 创建 company-domain 包与 Company/Department/PositionTemplate/Position 聚合

**Files:**
- Create: `packages/company-domain/package.json`
- Create: `packages/company-domain/tsconfig.json`
- Create: `packages/company-domain/src/types.ts`
- Create: `packages/company-domain/src/company-service.ts`
- Create: `packages/company-domain/src/company-service.test.ts`
- Create: `packages/company-domain/src/position-template-service.ts`
- Create: `packages/company-domain/src/position-template-service.test.ts`
- Create: `packages/company-domain/src/repositories.ts`
- Create: `packages/company-domain/src/index.ts`

**Interfaces:**
- Consumes: `ForgeStore.db`、EventStore、AssetRegistry。
- Produces: `CompanyService.createCompany()`、`PositionTemplateService.importFromTalent()`、`createPosition()`。

- [ ] **Step 1: 写创建公司、部门树和唯一岗位测试**

```ts
it("creates a company with one root department", () => {
  const result = service.createCompany({ id: "c1", name: "Acme AI", ownerSubjectId: "human:local" });
  expect(result.rootDepartment).toMatchObject({ companyId: "c1", parentId: null, name: "公司" });
});

it("rejects a parent department from another company", () => {
  expect(() => service.createDepartment({ companyId: "c1", parentId: "c2-dept", name: "研发" }))
    .toThrow("company scope mismatch");
});

it("keeps a reusable position template separate from a staffed position", () => {
  const template = positions.importFromTalent(talentTemplateFixture());
  const position = positions.createPosition({ companyId: "c1", departmentId: "d1", templateId: template.id, title: "产品经理" });
  expect(position.templateId).toBe(template.id);
  expect(position.employeeId).toBeUndefined();
  expect(template.assetVersionRef.kind).toBe("position_template");
});
```

- [ ] **Step 2: 运行 domain tests 确认 package 不存在**

Run: `pnpm --filter @forge/company-domain test`

Expected: FAIL because package is absent.

- [ ] **Step 3: 实现 repositories、optimistic version 和领域事件**

```ts
export class CompanyService {
  createCompany(input: CreateCompanyInput): { company: Company; rootDepartment: Department };
  createDepartment(input: CreateDepartmentInput): Department;
  createPosition(input: CreatePositionInput): Position;
}

export interface PositionTemplate {
  id: string; sourceTalentTemplateId?: string; mission: string; responsibilities: string[];
  requiredCapabilities: string[]; defaultKpis: KpiDefinition[];
  defaultAutonomyLevel: 0 | 1 | 2; defaultRisk: RiskLevel;
  assetVersionRef: AssetVersionRef;
}
```

All write methods use a transaction and append `company.created` / `organization.changed` events.

- [ ] **Step 4: 运行 domain tests/build**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/company-domain build`

Expected: PASS for company scope, duplicates, version conflicts and event writes.

- [ ] **Step 5: 提交基础公司领域**

```bash
git add packages/company-domain
git commit -m "feat(company): add company organization aggregates"
```

### Task 4: 实现 Employee、Employment、汇报和 AgentProfile 映射

**Files:**
- Create: `packages/company-domain/src/employee-service.ts`
- Create: `packages/company-domain/src/employee-service.test.ts`
- Create: `packages/company-domain/src/employee-evaluation.ts`
- Modify: `packages/company-domain/src/types.ts`
- Modify: `packages/company-domain/src/index.ts`

**Interfaces:**
- Consumes: Position、AgentProfileStore、Policy/Budget refs。
- Produces: `hire()`、`assignManager()`、`activateAfterTrial()`、`terminateEmployment()`。

- [ ] **Step 1: 写招聘、循环汇报和试用门测试**

```ts
it("hires an employee with a pinned profile version", () => {
  const employee = service.hire(hireInput({ profileVersionId: "profile-v1" }));
  expect(employee).toMatchObject({ state: "trial", agentProfileVersionId: "profile-v1" });
});

it("rejects a reporting cycle", () => {
  service.assignManager({ employeeId: "e2", managerId: "e1" });
  expect(() => service.assignManager({ employeeId: "e1", managerId: "e2" }))
    .toThrow("reporting cycle");
});
```

- [ ] **Step 2: 运行 employee tests 确认服务缺失**

Run: `pnpm exec vitest run packages/company-domain/src/employee-service.test.ts`

Expected: FAIL because `EmployeeService` is absent.

- [ ] **Step 3: 实现招聘、绑定、试用评测和状态转换**

```ts
export type EmployeeState = "draft" | "trial" | "active" | "suspended" | "terminated";

export interface HireEmployeeInput {
  companyId: string; employeeId: string; name: string; positionId: string;
  managerId?: string; agentProfileVersionId: string; autonomyLevel: 0 | 1 | 2;
  policyVersionId: string; budgetAccountId: string; kpis: KpiDefinition[];
}
```

Activation requires a stored trial evaluation with passed validators and an approving human subject.

- [ ] **Step 4: 运行 employee/domain/profile tests**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/agent-profile test`

Expected: PASS for hire, manager scope, cycles, trial failure, activation and termination.

- [ ] **Step 5: 提交数字员工领域**

```bash
git add packages/company-domain/src
git commit -m "feat(company): add governed digital employees"
```

### Task 5: 实现 Goal、Metric、Project、Milestone 和项目团队

**Files:**
- Create: `packages/company-domain/src/goal-service.ts`
- Create: `packages/company-domain/src/goal-service.test.ts`
- Create: `packages/company-domain/src/project-service.ts`
- Create: `packages/company-domain/src/project-service.test.ts`
- Modify: `packages/company-domain/src/types.ts`
- Modify: `packages/company-domain/src/index.ts`

**Interfaces:**
- Consumes: Company、Employee、WorkspaceGroup refs。
- Produces: `GoalService`、`ProjectService`。

- [ ] **Step 1: 写目标树、指标更新和团队范围测试**

```ts
it("rolls child progress into a weighted parent projection", () => {
  const goals = goalFixture();
  goals.create(parentGoal());
  goals.create(childGoal("g1", 0.25, 1));
  goals.create(childGoal("g2", 0.75, 0.5));
  expect(goals.projectProgress("parent")).toBeCloseTo(0.625);
});

it("rejects a project member outside the company", () => {
  expect(() => projects.addMember("p1", "employee-other-company"))
    .toThrow("company scope mismatch");
});
```

- [ ] **Step 2: 运行 goal/project tests 确认服务缺失**

Run: `pnpm exec vitest run packages/company-domain/src/goal-service.test.ts packages/company-domain/src/project-service.test.ts`

Expected: FAIL because services are absent.

- [ ] **Step 3: 实现目标、里程碑、临时团队和工作区组引用**

```ts
export interface Project {
  id: string; companyId: string; goalId: string; ownerId: string;
  state: "proposed" | "active" | "blocked" | "completed" | "cancelled";
  workspaceGroupId?: string; milestoneIds: string[];
}
```

Goal progress is a projection from versioned metric observations; do not let an LLM directly overwrite the displayed value.

- [ ] **Step 4: 运行 company-domain tests**

Run: `pnpm --filter @forge/company-domain test`

Expected: PASS for goal cycles, metric units, weighted progress, team membership and project state.

- [ ] **Step 5: 提交目标项目领域**

```bash
git add packages/company-domain/src
git commit -m "feat(company): add goals projects and project teams"
```

### Task 6: 实现 WorkItem 状态机、依赖、交接和 Run links

**Files:**
- Create: `packages/company-domain/src/work-item.ts`
- Create: `packages/company-domain/src/work-item.test.ts`
- Create: `packages/company-domain/src/handoff.ts`
- Create: `packages/company-domain/src/run-links.ts`
- Modify: `packages/company-domain/src/types.ts`
- Modify: `packages/company-domain/src/index.ts`

**Interfaces:**
- Consumes: Goal/Project/Employee、Core Run/Evidence refs。
- Produces: `WorkItemService`、`HandoffService`、`CompanyRunLinkRepository`。

- [ ] **Step 1: 写状态转换、依赖和完成证据测试**

```ts
it("rejects completed when acceptance or blocking validation is missing", () => {
  const item = workItemFixture({ state: "verifying", validationStatus: "failed" });
  expect(() => item.transition("completed", actor())).toThrow("blocking validation");
});

it("keeps failed runs without failing the business item", () => {
  const service = workItemServiceFixture();
  service.linkRun("w1", { runId: "r1", state: "failed" });
  expect(service.get("w1").state).toBe("in_progress");
});
```

- [ ] **Step 2: 运行 work item tests 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/work-item.test.ts`

Expected: FAIL because `WorkItemService` is absent.

- [ ] **Step 3: 实现正式状态机和结构化 Handoff**

```ts
export interface Handoff {
  id: string; workItemId: string; fromEmployeeId: string; toEmployeeId: string;
  conclusions: string[]; completedScope: string[]; remainingScope: string[];
  artifactIds: string[]; evidenceIds: string[]; assumptions: string[];
  uncertainties: string[]; requestedDecisions: string[]; createdAt: string;
}
```

Use optimistic version checks for every WorkItem transition and append `company.work_item.changed`.

- [ ] **Step 4: 运行 work-item 与 domain 全测**

Run: `pnpm --filter @forge/company-domain test`

Expected: PASS for every legal state path, rejection, cancel, dependency cycle and Run link.

- [ ] **Step 5: 提交 WorkItem 载体**

```bash
git add packages/company-domain/src
git commit -m "feat(company): add work items handoffs and run links"
```

### Task 7: 实现经营首页 Projection 和待决策队列

**Files:**
- Create: `packages/company-domain/src/projections/operating-dashboard.ts`
- Create: `packages/company-domain/src/projections/operating-dashboard.test.ts`
- Create: `packages/company-domain/src/projections/decision-queue.ts`
- Modify: `packages/company-domain/src/index.ts`

**Interfaces:**
- Consumes: Company domain、Core Run/Approval/Budget events。
- Produces: `OperatingDashboardProjection.query(companyId)`。

- [ ] **Step 1: 写指标来源和下钻引用测试**

```ts
it("returns dashboard cards with authoritative drill-down refs", () => {
  const dashboard = projectionFixture().query("c1");
  expect(dashboard.goals[0]).toMatchObject({ goalId: "g1", href: "company://goals/g1" });
  expect(dashboard.decisions[0]).toMatchObject({ kind: "approval", refId: "approval-1" });
});

it("does not count failed run as completed work", () => {
  const dashboard = projectionFixture({ runState: "failed", workState: "in_progress" }).query("c1");
  expect(dashboard.work.completed).toBe(0);
});
```

- [ ] **Step 2: 运行 projection tests 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/projections/operating-dashboard.test.ts`

Expected: FAIL because projection is absent.

- [ ] **Step 3: 实现目标健康、项目、工作、预算、员工和风险投影**

```ts
export interface OperatingDashboard {
  goalHealth: GoalHealthCard[]; decisions: DecisionQueueItem[];
  projects: ProjectHealthCard[]; work: WorkSummary;
  employees: EmployeeRunSummary; budget: BudgetSummary; risks: RiskCard[];
  generatedAt: string; sourceCursor: number;
}
```

Projection rebuilds from authoritative tables/events and exposes `sourceCursor` for freshness.

- [ ] **Step 4: 运行 projection/domain tests**

Run: `pnpm --filter @forge/company-domain test`

Expected: PASS for empty company, partial data, stale source and correct refs.

- [ ] **Step 5: 提交经营投影**

```bash
git add packages/company-domain/src/projections packages/company-domain/src/index.ts
git commit -m "feat(company): add operating dashboard projections"
```

### Task 8: 注册 Company typed RPC module

**Files:**
- Create: `packages/protocol/src/v2/company.ts`
- Create: `packages/protocol/src/v2/company.test.ts`
- Create: `apps/daemon/src/modules/company-module.ts`
- Create: `apps/daemon/src/modules/company-module.test.ts`
- Modify: `packages/protocol/src/v2/rpc.ts`
- Modify: `apps/daemon/src/modules/index.ts`

**Interfaces:**
- Consumes: Company services/projections、Core governance services。
- Produces: `company.*` command/query contract。

- [ ] **Step 1: 写公司范围、版本冲突和 DTO 测试**

```ts
it("returns VERSION_CONFLICT for a stale work item command", async () => {
  await expect(router.handle("company.workItems.transition", {
    companyId: "c1", workItemId: "w1", expectedVersion: 2, to: "submitted",
  }, context())).rejects.toMatchObject({ fault: { code: "VERSION_CONFLICT" } });
});

it("never returns records from another company", async () => {
  const result = await router.handle("company.dashboard.get", { companyId: "c1" }, context());
  expect(JSON.stringify(result)).not.toContain("company-c2-secret");
});
```

- [ ] **Step 2: 运行 protocol/module tests 确认方法缺失**

Run: `pnpm exec vitest run packages/protocol/src/v2/company.test.ts apps/daemon/src/modules/company-module.test.ts`

Expected: FAIL with missing company methods.

- [ ] **Step 3: 定义并注册 CRUD/command/query methods**

Methods include `company.create|get`、`organization.tree|get`、`employees.*`、`goals.*`、`projects.*`、`workItems.*`、`dashboard.get`、`approvals.list|decide`. Validate `companyId` on every call.

- [ ] **Step 4: 运行 protocol/company/daemon tests**

Run: `pnpm --filter @forge/protocol test && pnpm --filter @forge/company-domain test && pnpm --filter @forge/daemon test`

Expected: PASS; capabilities list `company.p0` version 1.

- [ ] **Step 5: 提交 Company module**

```bash
git add packages/protocol/src/v2 apps/daemon/src/modules
git commit -m "feat(company): expose p0 typed rpc"
```

### Task 9: 实现 Company preload client 和 renderer data layer

**Files:**
- Create: `apps/company-desktop/src/company-client.ts`
- Create: `apps/company-desktop/src/company-client.test.ts`
- Modify: `apps/company-desktop/src/main.ts`
- Modify: `apps/company-desktop/src/preload.ts`
- Create: `apps/company-desktop/src/renderer/api.ts`
- Create: `apps/company-desktop/src/renderer/store.ts`
- Create: `apps/company-desktop/src/renderer/store.test.ts`

**Interfaces:**
- Consumes: Company RPC、event subscription。
- Produces: renderer `CompanyApi` 和 normalized local state。

- [ ] **Step 1: 写 allowlist、unsubscribe 和 stale response 测试**

```ts
it("rejects methods outside the company allowlist", async () => {
  const api = createPreloadApi(fakeIpc());
  await expect(api.invoke("filesystem.read" as never, {})).rejects.toThrow("not allowed");
});

it("ignores a stale dashboard response after company switch", async () => {
  const store = companyUiStoreFixture();
  const old = store.loadDashboard("c1");
  await store.loadDashboard("c2");
  old.resolve(dashboard("c1"));
  expect(store.state.companyId).toBe("c2");
});
```

- [ ] **Step 2: 运行 client/store tests 确认实现缺失**

Run: `pnpm exec vitest run apps/company-desktop/src/company-client.test.ts apps/company-desktop/src/renderer/store.test.ts`

Expected: FAIL because data layer is absent.

- [ ] **Step 3: 实现 allowlisted IPC 和 event-driven invalidation**

```ts
const ALLOWED_METHODS = new Set<CompanyRpcMethod>([
  "company.get", "company.dashboard.get", "company.organization.tree",
  "company.employees.list", "company.goals.list", "company.projects.list",
  "company.workItems.list", "company.approvals.list",
]);
```

Commands are separately allowlisted; renderer never receives raw socket errors or filesystem paths.

- [ ] **Step 4: 运行 Company client tests/build**

Run: `pnpm --filter @forge/company-desktop test && pnpm --filter @forge/company-desktop build`

Expected: PASS; preload declaration matches `window.forgeCompany` exactly.

- [ ] **Step 5: 提交 Company data layer**

```bash
git add apps/company-desktop/src
git commit -m "feat(company): add typed desktop data bridge"
```

### Task 10: 实现全局 Shell、十模块导航和经营总览

**Files:**
- Create: `apps/company-desktop/src/renderer/components/app-shell.tsx`
- Create: `apps/company-desktop/src/renderer/components/app-shell.test.tsx`
- Create: `apps/company-desktop/src/renderer/features/dashboard/dashboard-page.tsx`
- Create: `apps/company-desktop/src/renderer/features/dashboard/dashboard-page.test.tsx`
- Create: `apps/company-desktop/src/renderer/styles/tokens.css`
- Create: `apps/company-desktop/src/renderer/styles/app.css`
- Modify: `apps/company-desktop/src/renderer/app.tsx`

**Interfaces:**
- Consumes: `OperatingDashboard`。
- Produces: A 默认首页和十模块路由骨架。

- [ ] **Step 1: 写默认路由、导航和下钻测试**

```tsx
it("opens operating dashboard by default", () => {
  render(<App initialPath="/" api={fakeCompanyApi()} />);
  expect(screen.getByRole("heading", { name: "经营总览" })).toBeVisible();
});

it("drills a decision card into approval detail", async () => {
  render(<DashboardPage dashboard={dashboardFixture()} navigate={navigate} />);
  await user.click(screen.getByText("发布审批"));
  expect(navigate).toHaveBeenCalledWith("/approvals/approval-1");
});
```

- [ ] **Step 2: 运行 renderer tests 确认组件缺失**

Run: `pnpm exec vitest run apps/company-desktop/src/renderer/components/app-shell.test.tsx apps/company-desktop/src/renderer/features/dashboard/dashboard-page.test.tsx`

Expected: FAIL because components are absent.

- [ ] **Step 3: 实现 Shell、tokens 和 dashboard cards**

Navigation labels are exactly: 经营总览、目标与项目、工作中心、客户与增长、审批中心、组织与员工、业务资产、自动化、经营分析、公司设置. Dashboard includes goal health、decisions、projects、growth placeholder state、employee runs、budget and risks.

- [ ] **Step 4: 运行 Company renderer tests/build**

Run: `pnpm --filter @forge/company-desktop test && pnpm --filter @forge/company-desktop build`

Expected: PASS at 1180px minimum width and keyboard navigation order.

- [ ] **Step 5: 提交经营 Shell**

```bash
git add apps/company-desktop/src/renderer
git commit -m "feat(company): add operating shell and dashboard"
```

### Task 11: 实现“组织与员工”模块

**Files:**
- Create: `apps/company-desktop/src/renderer/features/organization/organization-page.tsx`
- Create: `apps/company-desktop/src/renderer/features/organization/organization-page.test.tsx`
- Create: `apps/company-desktop/src/renderer/features/employees/employee-detail.tsx`
- Create: `apps/company-desktop/src/renderer/features/employees/hire-wizard.tsx`
- Create: `apps/company-desktop/src/renderer/features/employees/hire-wizard.test.tsx`

**Interfaces:**
- Consumes: organization tree、Position、Employee、Profile、Policy/Budget refs。
- Produces: B 模块、员工详情和招聘向导。

- [ ] **Step 1: 写组织树、招聘步骤和试用状态测试**

```tsx
it("shows stable org and project teams separately", () => {
  render(<OrganizationPage model={organizationFixture()} />);
  expect(screen.getByText("稳定组织")).toBeVisible();
  expect(screen.getByText("项目团队")).toBeVisible();
});

it("does not submit hire before policy budget and trial task are selected", async () => {
  render(<HireWizard api={fakeCompanyApi()} />);
  expect(screen.getByRole("button", { name: "开始试用" })).toBeDisabled();
});
```

- [ ] **Step 2: 运行 organization tests 确认组件缺失**

Run: `pnpm exec vitest run apps/company-desktop/src/renderer/features/organization/organization-page.test.tsx apps/company-desktop/src/renderer/features/employees/hire-wizard.test.tsx`

Expected: FAIL because components are absent.

- [ ] **Step 3: 实现组织图、员工卡、能力/授权/KPI tabs 和招聘向导**

Employee detail tabs: 概览、职责、能力、工具与知识、工作区、权限与自治、预算、KPI、运行与证据、记忆. Display profile version and employment state independently.

- [ ] **Step 4: 运行 organization renderer/domain tests**

Run: `pnpm --filter @forge/company-desktop test && pnpm --filter @forge/company-domain test`

Expected: PASS for empty state, deep org, suspended employee and trial failure.

- [ ] **Step 5: 提交组织员工 UI**

```bash
git add apps/company-desktop/src/renderer/features/organization apps/company-desktop/src/renderer/features/employees
git commit -m "feat(company): add organization and employee management"
```

### Task 12: 实现目标项目、工作中心和审批中心

**Files:**
- Create: `apps/company-desktop/src/renderer/features/goals/goals-page.tsx`
- Create: `apps/company-desktop/src/renderer/features/projects/project-detail.tsx`
- Create: `apps/company-desktop/src/renderer/features/work/work-center.tsx`
- Create: `apps/company-desktop/src/renderer/features/work/work-item-detail.tsx`
- Create: `apps/company-desktop/src/renderer/features/approvals/approval-center.tsx`
- Create: `apps/company-desktop/src/renderer/features/approvals/approval-center.test.tsx`

**Interfaces:**
- Consumes: Goal/Project/WorkItem/Approval DTOs。
- Produces: 可创建、查看、流转、审批和下钻的核心经营 UI。

- [ ] **Step 1: 写 WorkItem 证据和审批 hash tests**

```tsx
it("shows run artifact evidence and validation separately", () => {
  render(<WorkItemDetail item={workItemDetailFixture()} />);
  expect(screen.getByRole("tab", { name: "运行" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "产物与证据" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "验证" })).toBeVisible();
});

it("requires the displayed action hash when approving", async () => {
  render(<ApprovalCenter api={api} approvals={[approvalFixture()]} />);
  await user.click(screen.getByRole("button", { name: "批准" }));
  expect(api.command).toHaveBeenCalledWith("company.approvals.decide", expect.objectContaining({ parametersHash: "hash-1" }));
});
```

- [ ] **Step 2: 运行核心 UI tests 确认组件缺失**

Run: `pnpm exec vitest run apps/company-desktop/src/renderer/features/approvals/approval-center.test.tsx`

Expected: FAIL because pages are absent.

- [ ] **Step 3: 实现目标树、项目详情、WorkItem 看板和审批队列**

WorkItem views expose state, owner, assignee, acceptance, dependency, budget, runs, artifacts, evidence, validations, decisions and handoffs. Approval UI displays action, resource, parameter summary/hash, risk, cost, expiry and policy reason.

- [ ] **Step 4: 运行 Company UI 和 domain tests**

Run: `pnpm --filter @forge/company-desktop test && pnpm --filter @forge/company-domain test`

Expected: PASS; unauthorized transitions show structured reason and do not optimistically close the item.

- [ ] **Step 5: 提交核心经营页面**

```bash
git add apps/company-desktop/src/renderer/features/goals apps/company-desktop/src/renderer/features/projects apps/company-desktop/src/renderer/features/work apps/company-desktop/src/renderer/features/approvals
git commit -m "feat(company): add goals work and approval centers"
```

### Task 13: 实现全局 CEO 助手抽屉与结构化提案

**Files:**
- Create: `packages/company-domain/src/ceo-assistant.ts`
- Create: `packages/company-domain/src/ceo-assistant.test.ts`
- Create: `apps/daemon/src/services/company-ceo-assistant.ts`
- Create: `apps/company-desktop/src/renderer/features/ceo/ceo-drawer.tsx`
- Create: `apps/company-desktop/src/renderer/features/ceo/ceo-drawer.test.tsx`
- Modify: `packages/protocol/src/v2/company.ts`
- Modify: `apps/company-desktop/src/renderer/app.tsx`

**Interfaces:**
- Consumes: scoped operating context、Agent Runtime、Company commands。
- Produces: `CeoProposal` and C 全局抽屉。

- [ ] **Step 1: 写只读上下文、提案和禁止越权测试**

```ts
it("returns a structured proposal instead of executing an external action", async () => {
  const result = await assistant.respond(question("发布小红书内容"));
  expect(result.proposals[0]).toMatchObject({ kind: "work_item_draft", requiresConfirmation: true });
  expect(connector.executeCalls).toBe(0);
});

it("cites the dashboard objects used in an answer", async () => {
  const result = await assistant.respond(question("最需要我处理什么"));
  expect(result.citations).toEqual(expect.arrayContaining([{ kind: "approval", id: "a1" }]));
});
```

- [ ] **Step 2: 运行 assistant tests 确认服务/组件缺失**

Run: `pnpm exec vitest run packages/company-domain/src/ceo-assistant.test.ts apps/company-desktop/src/renderer/features/ceo/ceo-drawer.test.tsx`

Expected: FAIL because assistant is absent.

- [ ] **Step 3: 实现 scoped context builder、proposal schema 和 confirmation**

```ts
export type CeoProposal =
  | { kind: "goal_draft"; payload: CreateGoalInput; requiresConfirmation: true }
  | { kind: "project_draft"; payload: CreateProjectInput; requiresConfirmation: true }
  | { kind: "work_item_draft"; payload: CreateWorkItemInput; requiresConfirmation: true }
  | { kind: "decision_record"; payload: CreateDecisionInput; requiresConfirmation: true };
```

The context builder provides summaries and object refs only for the active company/page; proposal confirmation invokes ordinary Company commands and therefore normal policy checks.

- [ ] **Step 4: 运行 assistant、domain、Company UI tests**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/company-desktop test && pnpm --filter @forge/daemon test`

Expected: PASS; no proposal type can directly call a Connector.

- [ ] **Step 5: 提交 CEO 助手抽屉**

```bash
git add packages/company-domain/src apps/daemon/src/services/company-ceo-assistant.ts packages/protocol/src/v2/company.ts apps/company-desktop/src/renderer
git commit -m "feat(company): add governed ceo assistant drawer"
```

### Task 14: 集成搜索、通知、设置、Workbench 深链和主路径 E2E

**Files:**
- Create: `apps/company-desktop/src/renderer/features/search/global-search.tsx`
- Create: `apps/company-desktop/src/renderer/features/notifications/notification-center.tsx`
- Create: `apps/company-desktop/src/renderer/features/settings/company-settings.tsx`
- Create: `apps/company-desktop/src/deep-links.ts`
- Create: `apps/company-desktop/src/deep-links.test.ts`
- Create: `apps/company-desktop/src/company-p0.e2e.test.ts`
- Modify: `apps/company-desktop/src/main.ts`
- Modify: `apps/desktop/src/main.ts`

**Interfaces:**
- Consumes: Company search/event APIs、Workbench deep-link contract。
- Produces: `forge://workbench/run/<id>` 和 P0 端到端闭环。

- [ ] **Step 1: 写深链 allowlist 和完整 P0 E2E**

```ts
it("accepts only known workbench deep links", () => {
  expect(parseForgeDeepLink("forge://workbench/run/r1")).toEqual({ app: "workbench", kind: "run", id: "r1" });
  expect(() => parseForgeDeepLink("forge://workbench/file/../../secret")).toThrow("invalid deep link");
});

it("creates a company, hires an employee and completes an internal work item", async () => {
  const fx = await companyP0Fixture();
  const company = await fx.createCompany();
  const employee = await fx.hireAndActivate(company.id);
  const item = await fx.createAndCompleteInternalWork(company.id, employee.id);
  expect(item.state).toBe("completed");
  expect((await fx.dashboard(company.id)).work.completed).toBe(1);
});
```

- [ ] **Step 2: 运行 deep-link/E2E 确认剩余功能缺失**

Run: `pnpm exec vitest run apps/company-desktop/src/deep-links.test.ts apps/company-desktop/src/company-p0.e2e.test.ts`

Expected: FAIL before search/notifications/settings/deep-link integration.

- [ ] **Step 3: 实现搜索、通知、设置和双方深链处理**

Search returns typed refs only; notifications group approvals/failures/budget/workspace conflicts; settings writes company policy refs, budgets, notification preferences and connector account refs without secret values.

- [ ] **Step 4: 运行 P0 全门禁**

Run:

```bash
pnpm --filter @forge/company-domain test
pnpm --filter @forge/company-desktop test
pnpm --filter @forge/company-desktop build
pnpm --filter @forge/desktop test
pnpm --filter @forge/daemon test
pnpm test
```

Expected: all PASS; Company 主路径使用 fixture database projections 而不是 hardcoded data。

- [ ] **Step 5: 提交 Company P0 gate**

```bash
git add apps/company-desktop apps/desktop/src/main.ts packages/company-domain packages/protocol/src/v2/company.ts apps/daemon/src/modules/company-module.ts
git commit -m "feat(company): integrate search settings and deep links"
```

### Task 15: 实现业务资产、自动化和基础经营分析模块

**Files:**
- Create: `apps/company-desktop/src/renderer/features/assets/business-assets-page.tsx`
- Create: `apps/company-desktop/src/renderer/features/assets/business-assets-page.test.tsx`
- Create: `apps/company-desktop/src/renderer/features/automation/automation-page.tsx`
- Create: `apps/company-desktop/src/renderer/features/automation/automation-page.test.tsx`
- Create: `apps/company-desktop/src/renderer/features/analytics/baseline-analytics.tsx`
- Create: `apps/company-desktop/src/renderer/features/analytics/baseline-analytics.test.tsx`
- Create: `packages/company-domain/src/projections/baseline-analytics.ts`
- Create: `packages/company-domain/src/projections/baseline-analytics.test.ts`
- Modify: `package.json`
- Modify: `packages/protocol/src/v2/company.ts`
- Modify: `apps/daemon/src/modules/company-module.ts`

**Interfaces:**
- Consumes: AgentProfile、Skill、Knowledge、Workflow、Automation、Artifact、Run、Budget 和 WorkItem 数据。
- Produces: P0 业务资产目录、Automation 运行视图和基础经营指标。

- [ ] **Step 1: 写资产版本、自动化失败和指标口径 tests**

```tsx
it("shows owner version status and last verified result for every asset", () => {
  render(<BusinessAssetsPage model={assetCatalogFixture()} />);
  expect(screen.getByText("需求调研 Workflow")).toBeVisible();
  expect(screen.getByText("v3 · 已发布 · 验证通过")).toBeVisible();
});

it("does not count an unvalidated completed run as a successful loop", () => {
  const analytics = buildBaselineAnalytics(analyticsFixture({ validationStatus: "failed" }));
  expect(analytics.closedLoopSuccessRate).toBe(0);
});
```

- [ ] **Step 2: 运行资产/自动化/分析 tests 确认组件和投影缺失**

Run: `pnpm exec vitest run apps/company-desktop/src/renderer/features/assets/business-assets-page.test.tsx apps/company-desktop/src/renderer/features/automation/automation-page.test.tsx apps/company-desktop/src/renderer/features/analytics/baseline-analytics.test.tsx packages/company-domain/src/projections/baseline-analytics.test.ts`

Expected: FAIL because pages and projection are absent.

- [ ] **Step 3: 实现统一目录、运行状态和五项基础指标**

Business Assets groups Skill、Knowledge、AgentProfile、Workflow、Template and Artifact by owner/version/lifecycle. Automation page shows trigger, next run, active run, failures, retry and takeover. Baseline analytics computes closed-loop success rate, manual intervention rate, goal-to-result cycle, unit result cost and traceability from authoritative rows. Add `@forge/company-domain`、`@forge/company-desktop` to the root `test` filter list.

- [ ] **Step 4: 运行 P0 最终全门禁**

Run:

```bash
pnpm --filter @forge/company-domain test
pnpm --filter @forge/company-desktop test
pnpm --filter @forge/company-desktop build
pnpm --filter @forge/desktop test
pnpm --filter @forge/daemon test
pnpm test
```

Expected: PASS; every metric includes a source cursor and drill-down refs.

- [ ] **Step 5: 提交 P0 资产、自动化和分析模块**

```bash
git add package.json apps/company-desktop/src/renderer/features/assets apps/company-desktop/src/renderer/features/automation apps/company-desktop/src/renderer/features/analytics packages/company-domain/src/projections/baseline-analytics.ts packages/company-domain/src/projections/baseline-analytics.test.ts packages/protocol/src/v2/company.ts apps/daemon/src/modules/company-module.ts
git commit -m "feat(company): complete p0 operating system"
```
