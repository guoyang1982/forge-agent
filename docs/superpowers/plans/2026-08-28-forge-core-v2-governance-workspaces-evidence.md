# Forge Core v2 Governance, Workspaces, and Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Durable Execution 增加跨工作区安全协作、统一策略审批、预算账本、可信产物证据和不可变 AgentProfile 能力快照。

**Architecture:** 扩展现有 `@forge/workspace`，新增 `@forge/policy`、`@forge/usage-ledger`、`@forge/evidence` 和 `@forge/agent-profile`。DurableExecutor 在 Step 开始前依次解析能力快照、申请工作区租约、评估策略、预留预算；结束后提交用量、保存产物/证据、运行验证并释放租约。

**Tech Stack:** TypeScript 5.8.3、Vitest 3.0.9、better-sqlite3 13.0.2、SQLite WAL、现有 Git/WorkspaceGuard。

**Spec:** `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

## Global Constraints

- 不同工作区可并行；同一工作区同一时刻只有一个有效写入租约。
- Policy 唯一决策结果为 `allow | deny | require_approval`，必须记录策略版本和解释。
- 审批绑定不可变动作摘要、风险、参数 hash、预计成本和有效期。
- 预算使用 reserve/commit/release，所有写入使用整数最小货币单位。
- 关键交付验证失败时，Run 不能进入 succeeded。
- AgentProfile 历史版本和运行能力快照不可变。
- 代码片段中的 `*Fixture`、`fake*` 等名称均是在同一测试文件中创建的确定性测试夹具；写失败测试步骤必须同时实现这些夹具的最小定义。

---

## File Structure Map

| Path | Responsibility |
|---|---|
| `migrations/011_core_workspaces.sql` | workspace、group、binding、lease、checkpoint |
| `migrations/012_core_policy_approvals.sql` | subjects、grants、policy versions、approvals |
| `migrations/013_core_usage_budget.sql` | usage ledger、budget accounts/reservations |
| `migrations/014_core_evidence.sql` | artifacts、evidence、validations |
| `migrations/015_core_agent_profiles.sql` | profile、version、snapshot |
| `packages/workspace/src/groups.ts` | WorkspaceGroup 和 binding |
| `packages/workspace/src/leases.ts` | single-writer lease |
| `packages/workspace/src/composite-checkpoint.ts` | 跨工作区检查点 |
| `packages/policy/src/engine.ts` | PolicyEngine |
| `packages/policy/src/approvals.ts` | ApprovalService |
| `packages/usage-ledger/src/ledger.ts` | 用量和预算预留 |
| `packages/evidence/src/artifacts.ts` | Artifact metadata/store refs |
| `packages/evidence/src/evidence.ts` | Evidence claims and sources |
| `packages/evidence/src/validation.ts` | 三层验证编排 |
| `packages/agent-profile/src/store.ts` | profile/version/snapshot |
| `packages/execution/src/governed-executor.ts` | 治理前置和结束处理 |
| `apps/daemon/src/modules/governance-module.ts` | policy/approval/budget RPC |
| `apps/daemon/src/modules/workspace-module.ts` | workspace group/lease RPC |
| `apps/daemon/src/modules/evidence-module.ts` | artifact/evidence/validation/profile RPC |

## Public Interfaces Locked by This Plan

```ts
export type PolicyDecision =
  | { outcome: "allow"; policyVersionId: string; reason: string }
  | { outcome: "deny"; policyVersionId: string; reason: string }
  | { outcome: "require_approval"; policyVersionId: string; reason: string; approvalClass: string };

export interface ResourceRef { kind: string; id: string }
export interface ResourceScope { resourceKind: string; resourceIds?: string[]; pathPrefixes?: string[] }

export interface BudgetLedger {
  reserve(input: ReserveBudgetInput): BudgetReservation;
  commit(reservationId: string, actualMinor: bigint): void;
  release(reservationId: string, reason: string): void;
}

export interface ValidationResult {
  status: "passed" | "failed" | "inconclusive";
  layer: "result" | "process" | "answer";
  severity: "info" | "warning" | "blocking";
  evidenceIds: string[];
  summary: string;
}
```

### Task 1: 添加治理相关 migrations

**Files:**
- Create: `migrations/011_core_workspaces.sql`
- Create: `migrations/012_core_policy_approvals.sql`
- Create: `migrations/013_core_usage_budget.sql`
- Create: `migrations/014_core_evidence.sql`
- Create: `migrations/015_core_agent_profiles.sql`
- Create: `packages/store/src/governance-migrations.test.ts`

**Interfaces:**
- Consumes: `ForgeStore`。
- Produces: F6-F10 的持久化表和约束。

- [ ] **Step 1: 写表、外键、唯一约束和金额类型测试**

```ts
it("creates governance tables and single active lease constraint", () => {
  const db = openMigratedFixture().db;
  expect(tableNames(db)).toEqual(expect.arrayContaining([
    "core_workspace_groups", "core_workspace_leases", "core_policy_versions",
    "core_approvals", "core_budget_reservations", "core_artifacts",
    "core_validations", "core_agent_profile_versions",
  ]));
  expect(indexSql(db, "uq_core_workspace_active_write_lease"))
    .toContain("WHERE released_at IS NULL");
});
```

- [ ] **Step 2: 运行 migration 测试确认表不存在**

Run: `pnpm exec vitest run packages/store/src/governance-migrations.test.ts`

Expected: FAIL listing missing governance tables.

- [ ] **Step 3: 创建 migrations 与必要索引**

```sql
CREATE UNIQUE INDEX uq_core_workspace_active_write_lease
ON core_workspace_leases(workspace_id)
WHERE mode = 'write' AND released_at IS NULL;

CREATE TABLE core_budget_reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES core_budget_accounts(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  state TEXT NOT NULL CHECK (state IN ('reserved','committed','released')),
  created_at TEXT NOT NULL,
  settled_at TEXT
);
```

Add JSON checks at application boundary; SQLite stores immutable snapshots and hashes.

- [ ] **Step 4: 运行 Store 全测和重复迁移测试**

Run: `pnpm --filter @forge/store test`

Expected: PASS; migrations 011-015 are journaled once.

- [ ] **Step 5: 提交治理 Schema**

```bash
git add migrations/011_core_workspaces.sql migrations/012_core_policy_approvals.sql migrations/013_core_usage_budget.sql migrations/014_core_evidence.sql migrations/015_core_agent_profiles.sql packages/store/src/governance-migrations.test.ts
git commit -m "feat(core): add governance and evidence schema"
```

### Task 2: 实现 WorkspaceGroup、Binding 和 write lease

**Files:**
- Create: `packages/workspace/src/groups.ts`
- Create: `packages/workspace/src/groups.test.ts`
- Create: `packages/workspace/src/leases.ts`
- Create: `packages/workspace/src/leases.test.ts`
- Modify: `packages/workspace/src/index.ts`
- Modify: `packages/workspace/package.json`

**Interfaces:**
- Consumes: `ForgeStore.db` 和现有 `WorkspaceGuard`。
- Produces: `WorkspaceGroupService`、`WorkspaceLeaseService.acquire()`、`renew()`、`release()`。

- [ ] **Step 1: 写跨工作区并行和同工作区冲突测试**

```ts
it("allows write leases for different workspaces", () => {
  const leases = leaseFixture();
  expect(leases.acquire(writeLease("frontend", "run-a"))).toBeTruthy();
  expect(leases.acquire(writeLease("backend", "run-b"))).toBeTruthy();
});

it("rejects a second active writer for the same workspace", () => {
  const leases = leaseFixture();
  leases.acquire(writeLease("frontend", "run-a"));
  expect(() => leases.acquire(writeLease("frontend", "run-b")))
    .toThrow("WORKSPACE_CONFLICT");
});
```

- [ ] **Step 2: 运行 workspace 测试确认新 API 不存在**

Run: `pnpm --filter @forge/workspace test`

Expected: FAIL because group/lease modules are absent.

- [ ] **Step 3: 实现 canonical path、scope 和 lease expiry**

```ts
export interface WorkspaceBinding {
  id: string;
  groupId: string;
  workspaceId: string;
  rootPath: string;
  mode: "read" | "write";
  pathScopes: string[];
}

acquire(input: AcquireLeaseInput): WorkspaceLease {
  const root = realpathSync.native(input.rootPath);
  return this.db.transaction(() => this.insertActiveLease({ ...input, rootPath: root }))();
}
```

Expired leases are not silently stolen: recovery records `workspace.lease.expired`, checks the owning Attempt state, then releases or escalates.

- [ ] **Step 4: 运行 workspace 定向和全包测试**

Run: `pnpm exec vitest run packages/workspace/src/groups.test.ts packages/workspace/src/leases.test.ts && pnpm --filter @forge/workspace test`

Expected: PASS for path escape, symlink, lease conflict, renewal and audited release.

- [ ] **Step 5: 提交 WorkspaceGroup 和租约**

```bash
git add packages/workspace
git commit -m "feat(workspace): add groups bindings and write leases"
```

### Task 3: 实现跨工作区组合检查点

**Files:**
- Create: `packages/workspace/src/composite-checkpoint.ts`
- Create: `packages/workspace/src/composite-checkpoint.test.ts`
- Modify: `packages/workspace/src/index.ts`

**Interfaces:**
- Consumes: WorkspaceGroup bindings 和现有 Git helpers。
- Produces: `captureCompositeCheckpoint()`、`verifyCompositeCheckpoint()`。

- [ ] **Step 1: 写多仓库 snapshot 和 dirty 状态测试**

```ts
it("captures commit, branch, dirty diff hash and validation refs per workspace", async () => {
  const result = await captureCompositeCheckpoint(groupFixture());
  expect(result.entries).toEqual([
    expect.objectContaining({ workspaceId: "frontend", headSha: expect.any(String), dirty: true }),
    expect.objectContaining({ workspaceId: "backend", headSha: expect.any(String), dirty: false }),
  ]);
});
```

- [ ] **Step 2: 运行检查点测试确认实现缺失**

Run: `pnpm exec vitest run packages/workspace/src/composite-checkpoint.test.ts`

Expected: FAIL because composite checkpoint functions are absent.

- [ ] **Step 3: 实现只读采集和 hash 验证**

```ts
export interface CompositeCheckpoint {
  id: string;
  groupId: string;
  entries: Array<{
    workspaceId: string; headSha: string | null; branch: string | null;
    dirty: boolean; diffHash: string | null; validationRefs: string[];
  }>;
  capturedAt: string;
}
```

Do not auto-reset workspaces; restoration remains an explicit approved action.

- [ ] **Step 4: 运行 workspace 全测**

Run: `pnpm --filter @forge/workspace test`

Expected: PASS on clean, dirty, non-git and missing workspace fixtures.

- [ ] **Step 5: 提交组合检查点**

```bash
git add packages/workspace/src/composite-checkpoint.ts packages/workspace/src/composite-checkpoint.test.ts packages/workspace/src/index.ts
git commit -m "feat(workspace): add composite checkpoints"
```

### Task 4: 实现 Subject、Grant 和 PolicyEngine

**Files:**
- Create: `packages/policy/package.json`
- Create: `packages/policy/tsconfig.json`
- Create: `packages/policy/src/types.ts`
- Create: `packages/policy/src/engine.ts`
- Create: `packages/policy/src/engine.test.ts`
- Create: `packages/policy/src/index.ts`

**Interfaces:**
- Consumes: subject、action、resource、scope、risk、context。
- Produces: `PolicyEngine.authorize(input): PolicyDecision`。

- [ ] **Step 1: 写默认拒绝、显式允许和审批测试**

```ts
it("denies an action with no matching grant", () => {
  expect(engine.authorize(action("connector.publish", "account:xhs")))
    .toMatchObject({ outcome: "deny", reason: "no matching grant" });
});

it("requires approval for high-risk external writes", () => {
  const decision = engine.authorize(action("connector.publish", "account:xhs", { risk: "high" }));
  expect(decision).toMatchObject({ outcome: "require_approval", approvalClass: "external_publish" });
});
```

- [ ] **Step 2: 运行 policy 测试确认 package 不存在**

Run: `pnpm --filter @forge/policy test`

Expected: FAIL because `@forge/policy` is absent.

- [ ] **Step 3: 实现确定性匹配、deny 优先和策略版本**

```ts
export interface AuthorizationInput {
  subject: SubjectRef;
  action: string;
  resource: ResourceRef;
  scope: Record<string, string>;
  risk: "low" | "medium" | "high" | "critical";
  context: Record<string, unknown>;
}
```

Evaluation order: explicit deny → matching approval rule → matching allow → default deny. Persist the exact policyVersionId and redacted input hash with every decision.

- [ ] **Step 4: 运行 policy 测试和构建**

Run: `pnpm --filter @forge/policy test && pnpm --filter @forge/policy build`

Expected: PASS for scope, expiry, risk, conflicting rules and stable explanations.

- [ ] **Step 5: 提交 PolicyEngine**

```bash
git add packages/policy
git commit -m "feat(policy): add versioned authorization engine"
```

### Task 5: 实现持久 ApprovalService

**Files:**
- Create: `packages/policy/src/approvals.ts`
- Create: `packages/policy/src/approvals.test.ts`
- Modify: `packages/policy/src/index.ts`

**Interfaces:**
- Consumes: `PolicyDecision.require_approval`、action snapshot。
- Produces: `requestApproval()`、`decide()`、`expire()`、`listPending()`。

- [ ] **Step 1: 写不可变快照、过期和重复决策测试**

```ts
it("binds approval to action and parameter hashes", () => {
  const approval = service.requestApproval(approvalInput());
  expect(approval).toMatchObject({ action: "connector.publish", state: "pending" });
  expect(approval.parametersHash).toMatch(/^[a-f0-9]{64}$/);
});

it("rejects a second decision", () => {
  const id = pendingApproval(service).id;
  service.decide(id, approveDecision());
  expect(() => service.decide(id, denyDecision())).toThrow("already decided");
});
```

- [ ] **Step 2: 运行 approval 测试确认 API 不存在**

Run: `pnpm exec vitest run packages/policy/src/approvals.test.ts`

Expected: FAIL because `ApprovalService` is absent.

- [ ] **Step 3: 实现 request/approve/deny/expire/revoke**

```ts
export interface ApprovalRequest {
  id: string; subject: SubjectRef; action: string; resource: ResourceRef;
  parametersHash: string; parametersSummary: string; risk: RiskLevel;
  estimatedCostMinor?: bigint; policyVersionId: string; expiresAt: string;
}
```

Store decision actor, reason and timestamp. Approval resumes only the exact waiting Step whose action hash still matches.

- [ ] **Step 4: 运行 policy 全测**

Run: `pnpm --filter @forge/policy test`

Expected: PASS for approve, deny, expire, revoke, delegate and hash mismatch.

- [ ] **Step 5: 提交持久审批**

```bash
git add packages/policy/src/approvals.ts packages/policy/src/approvals.test.ts packages/policy/src/index.ts
git commit -m "feat(policy): add durable approvals"
```

### Task 6: 实现 Usage 与 Budget Ledger

**Files:**
- Create: `packages/usage-ledger/package.json`
- Create: `packages/usage-ledger/tsconfig.json`
- Create: `packages/usage-ledger/src/types.ts`
- Create: `packages/usage-ledger/src/ledger.ts`
- Create: `packages/usage-ledger/src/ledger.test.ts`
- Create: `packages/usage-ledger/src/index.ts`

**Interfaces:**
- Consumes: account hierarchy、estimated/actual minor units。
- Produces: `reserve()`、`commit()`、`release()`、`recordUsage()`、`balance()`。

- [ ] **Step 1: 写并发预留、实际提交和释放测试**

```ts
it("prevents concurrent reservations from exceeding the hard limit", () => {
  const ledger = budgetFixture({ limitMinor: 1000n });
  ledger.reserve(reservation("a", 700n));
  expect(() => ledger.reserve(reservation("b", 400n))).toThrow("BUDGET_EXCEEDED");
});

it("commits actual usage and releases the unused remainder", () => {
  const ledger = budgetFixture({ limitMinor: 1000n });
  const r = ledger.reserve(reservation("a", 700n));
  ledger.commit(r.id, 450n);
  expect(ledger.balance("account-1")).toMatchObject({ committedMinor: 450n, reservedMinor: 0n });
});
```

- [ ] **Step 2: 运行 ledger 测试确认 package 不存在**

Run: `pnpm --filter @forge/usage-ledger test`

Expected: FAIL because `@forge/usage-ledger` is absent.

- [ ] **Step 3: 实现事务化层级预算账本**

```ts
export interface ReserveBudgetInput {
  reservationId: string;
  accountId: string;
  runId: string;
  stepId?: string;
  amountMinor: bigint;
  currency: string;
  expiresAt: string;
}
```

Reserve locks the account transactionally, includes parent account limits, and stores integer minor units. Model token records retain provider/model/version dimensions.

- [ ] **Step 4: 运行 ledger 测试和构建**

Run: `pnpm --filter @forge/usage-ledger test && pnpm --filter @forge/usage-ledger build`

Expected: PASS for hierarchy, race, threshold, release, expiry and currency mismatch.

- [ ] **Step 5: 提交预算账本**

```bash
git add packages/usage-ledger
git commit -m "feat(budget): add hierarchical usage ledger"
```

### Task 7: 实现 Artifact、Evidence 和三层 Validation

**Files:**
- Create: `packages/evidence/package.json`
- Create: `packages/evidence/tsconfig.json`
- Create: `packages/evidence/src/artifacts.ts`
- Create: `packages/evidence/src/evidence.ts`
- Create: `packages/evidence/src/validation.ts`
- Create: `packages/evidence/src/validation.test.ts`
- Create: `packages/evidence/src/index.ts`

**Interfaces:**
- Consumes: Artifact content ref、claim/source、Validator registry。
- Produces: `ArtifactService`、`EvidenceService`、`ValidationService.validateDelivery()`。

- [ ] **Step 1: 写 hash、引用和阻断验证测试**

```ts
it("hashes artifact content and links producer run", async () => {
  const artifact = await artifacts.register({
    id: "a1", producerRunId: "r1", mediaType: "text/markdown", content: Buffer.from("report"),
  });
  expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
});

it("fails delivery when any blocking layer fails", async () => {
  const result = await validations.validateDelivery(deliveryFixture({ answerLayer: "failed" }));
  expect(result.accepted).toBe(false);
  expect(result.results).toContainEqual(expect.objectContaining({ layer: "answer", status: "failed" }));
});
```

- [ ] **Step 2: 运行 evidence 测试确认 package 不存在**

Run: `pnpm --filter @forge/evidence test`

Expected: FAIL because `@forge/evidence` is absent.

- [ ] **Step 3: 实现 metadata、受控 content refs 和 ValidatorRegistry**

```ts
export interface Validator {
  id: string;
  layer: ValidationResult["layer"];
  validate(input: ValidationInput): Promise<ValidationResult>;
}

export class ValidationService {
  async validateDelivery(input: ValidationInput): Promise<{
    accepted: boolean; results: ValidationResult[];
  }>;
}
```

Large content is written under the configured artifact root using generated IDs; database rows store path refs, hashes and access scope, never user-controlled absolute output paths.

- [ ] **Step 4: 运行 evidence 全测和构建**

Run: `pnpm --filter @forge/evidence test && pnpm --filter @forge/evidence build`

Expected: PASS for tamper detection, missing source, inconclusive, blocking and access scope.

- [ ] **Step 5: 提交可信交付契约**

```bash
git add packages/evidence
git commit -m "feat(evidence): add artifacts evidence and validation"
```

### Task 8: 实现 AgentProfile 版本与能力快照

**Files:**
- Create: `packages/agent-profile/package.json`
- Create: `packages/agent-profile/tsconfig.json`
- Create: `packages/agent-profile/src/types.ts`
- Create: `packages/agent-profile/src/store.ts`
- Create: `packages/agent-profile/src/store.test.ts`
- Create: `packages/agent-profile/src/index.ts`
- Modify: `packages/talent-registry/src/index.ts`

**Interfaces:**
- Consumes: Talent template、skills/tools/knowledge/connectors/policy refs。
- Produces: `AgentProfileStore.publishVersion()`、`resolveSnapshot()`、`createFromTalent()`。

- [ ] **Step 1: 写不可变版本、快照和 Talent 导入测试**

```ts
it("keeps a run snapshot unchanged after profile upgrade", () => {
  const profiles = profileFixture();
  const v1 = profiles.publishVersion(profileVersion({ model: "m1" }));
  const snapshot = profiles.resolveSnapshot(v1.profileId, v1.id);
  profiles.publishVersion(profileVersion({ profileId: v1.profileId, model: "m2" }));
  expect(profiles.getSnapshot(snapshot.id).modelPolicy.model).toBe("m1");
});
```

- [ ] **Step 2: 运行 profile 测试确认 package 不存在**

Run: `pnpm --filter @forge/agent-profile test`

Expected: FAIL because `@forge/agent-profile` is absent.

- [ ] **Step 3: 实现 profile/version/snapshot 和 Talent 映射**

```ts
export interface AgentCapabilitySnapshot {
  id: string; profileId: string; profileVersionId: string;
  runtime: RuntimePolicy; skills: AssetVersionRef[]; tools: ToolGrant[];
  knowledge: AssetVersionRef[]; memoryScopes: string[];
  connectors: ConnectorGrantRef[]; policyVersionId: string;
  createdAt: string;
}
```

Talent JSON remains a reusable source template; publishing creates a normalized immutable profile version rather than mutating the template.

- [ ] **Step 4: 运行 profile 和 talent-registry 回归**

Run: `pnpm --filter @forge/agent-profile test && pnpm --filter @forge/talent-registry test`

Expected: PASS; existing talent templates still load.

- [ ] **Step 5: 提交 AgentProfile 2.0**

```bash
git add packages/agent-profile packages/talent-registry/src/index.ts
git commit -m "feat(profile): add versioned agent capability snapshots"
```

### Task 9: 实现预算感知模型路由和工具渐进发现

**Files:**
- Create: `packages/agent-core/src/model-routing.ts`
- Create: `packages/agent-core/src/model-routing.test.ts`
- Create: `packages/tools/src/discovery.ts`
- Create: `packages/tools/src/discovery.test.ts`
- Modify: `packages/agent-core/src/index.ts`
- Modify: `packages/tools/src/index.ts`
- Modify: `packages/agent-profile/src/types.ts`

**Interfaces:**
- Consumes: AgentCapabilitySnapshot、task classification、Budget balance、tool catalog metadata。
- Produces: `ModelRouter.select()`、`ToolDiscovery.search()`、实际选择 Trace。

- [ ] **Step 1: 写预算降级、能力要求和渐进 Schema tests**

```ts
it("selects the cheapest eligible model within the remaining budget", () => {
  const selected = router.select(routeInput({ required: ["vision"], remainingMinor: 500n }));
  expect(selected.modelId).toBe("vision-economy");
  expect(selected.reason).toContain("budget");
});

it("returns summaries first and loads full tool schemas only for selected ids", () => {
  const discovery = toolDiscoveryFixture();
  const hits = discovery.search({ query: "publish content", limit: 5 });
  expect(hits[0]).not.toHaveProperty("inputSchema");
  expect(discovery.loadSchemas([hits[0]!.toolId])[0]).toHaveProperty("inputSchema");
});
```

- [ ] **Step 2: 运行 agent-core/tools tests 确认实现缺失**

Run: `pnpm exec vitest run packages/agent-core/src/model-routing.test.ts packages/tools/src/discovery.test.ts`

Expected: FAIL because routing/discovery modules are absent.

- [ ] **Step 3: 实现确定性 eligibility filter 和 versioned routing policy**

```ts
export interface ModelRoutingDecision {
  modelId: string; profileVersionId: string; routingPolicyVersion: string;
  estimatedCostMinor: bigint; requiredCapabilities: string[]; reason: string;
}

export interface ToolSummary {
  toolId: string; name: string; description: string; risk: RiskLevel;
  requiredGrantActions: string[]; schemaVersion: string;
}
```

Filter unavailable, unauthorized or capability-incompatible options first; rank remaining models by policy objective. Store the decision and full loaded tool version list in Trace.

- [ ] **Step 4: 运行 agent/profile/tools/budget tests**

Run: `pnpm --filter @forge/agent-core test && pnpm --filter @forge/tools test && pnpm --filter @forge/agent-profile test && pnpm --filter @forge/usage-ledger test`

Expected: PASS for capability, budget, unavailable model, empty tools and schema version cases.

- [ ] **Step 5: 提交 routing/discovery**

```bash
git add packages/agent-core/src/model-routing.ts packages/agent-core/src/model-routing.test.ts packages/agent-core/src/index.ts packages/tools/src/discovery.ts packages/tools/src/discovery.test.ts packages/tools/src/index.ts packages/agent-profile/src/types.ts
git commit -m "feat(runtime): add budget routing and progressive tool discovery"
```

### Task 10: 将治理链集成到 DurableExecutor

**Files:**
- Create: `packages/execution/src/governed-executor.ts`
- Create: `packages/execution/src/governed-executor.test.ts`
- Modify: `packages/execution/src/executor.ts`
- Modify: `packages/execution/package.json`

**Interfaces:**
- Consumes: Profile、Workspace lease、Policy、Approval、Budget、Evidence。
- Produces: `GovernedStepExecutor.execute()` 和正式等待原因。

- [ ] **Step 1: 写执行顺序和清理测试**

```ts
it("resolves profile, leases workspace, authorizes, reserves, executes, validates, then settles", async () => {
  const fx = governedFixture();
  await fx.executor.execute(fx.input);
  expect(fx.calls).toEqual([
    "profile.resolve", "workspace.acquire", "policy.authorize", "budget.reserve",
    "step.execute", "evidence.validate", "budget.commit", "workspace.release",
  ]);
});

it("waits without executing when approval is required", async () => {
  const fx = governedFixture({ decision: "require_approval" });
  await fx.executor.execute(fx.input);
  expect(fx.calls).not.toContain("step.execute");
  expect(fx.store.getStep("r1", "s1")?.state).toBe("waiting");
});
```

- [ ] **Step 2: 运行集成测试确认 governed executor 不存在**

Run: `pnpm exec vitest run packages/execution/src/governed-executor.test.ts`

Expected: FAIL because the module is absent.

- [ ] **Step 3: 实现 try/finally 清理和正式 wait reasons**

```ts
export type StepWaitReason =
  | { kind: "approval"; approvalId: string }
  | { kind: "input"; requestId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "manual_review"; reason: string };
```

Release workspace and unused budget on deny/fail/cancel; retain them only for short bounded retries when policy explicitly allows.

- [ ] **Step 4: 运行 execution 与全部治理包测试**

Run: `pnpm --filter @forge/execution test && pnpm --filter @forge/workspace test && pnpm --filter @forge/policy test && pnpm --filter @forge/usage-ledger test && pnpm --filter @forge/evidence test`

Expected: PASS; cleanup assertions hold for every failure path.

- [ ] **Step 5: 提交 governed execution**

```bash
git add packages/execution
git commit -m "feat(execution): enforce workspace policy budget and validation"
```

### Task 11: 暴露治理 RPC 并建立阶段 E2E 门

**Files:**
- Create: `apps/daemon/src/modules/governance-module.ts`
- Create: `apps/daemon/src/modules/workspace-module.ts`
- Create: `apps/daemon/src/modules/evidence-module.ts`
- Create: `apps/daemon/src/governed-run.e2e.test.ts`
- Modify: `packages/protocol/src/v2/rpc.ts`
- Modify: `apps/daemon/src/modules/index.ts`

**Interfaces:**
- Consumes: 本计划全部服务。
- Produces: workspace/policy/approval/budget/evidence/profile RPC 和 E2E 验证。

- [ ] **Step 1: 写完整审批运行和并发工作区 E2E**

```ts
it("pauses a high-risk step, resumes after matching approval, and stores validation", async () => {
  const fx = await governedDaemonFixture();
  const run = await fx.create(highRiskRunSpec());
  const approval = await fx.waitForApproval(run.runId);
  await fx.approve(approval.id, approval.parametersHash);
  expect(await fx.waitForRun(run.runId, "succeeded")).toBe("succeeded");
  expect(await fx.validations(run.runId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ layer: "result", status: "passed" }),
  ]));
});
```

- [ ] **Step 2: 运行 E2E 确认 RPC 尚未注册**

Run: `pnpm exec vitest run apps/daemon/src/governed-run.e2e.test.ts`

Expected: FAIL with missing governance methods.

- [ ] **Step 3: 注册类型化 RPC 和参数验证**

Expose `workspace.groups.*`、`approvals.list|decide`、`budgets.get`、`artifacts.get`、`validations.list`、`agentProfiles.*`; never expose raw credential or unrestricted artifact paths.

- [ ] **Step 4: 运行阶段全门禁**

Run:

```bash
pnpm --filter @forge/workspace test
pnpm --filter @forge/policy test
pnpm --filter @forge/usage-ledger test
pnpm --filter @forge/evidence test
pnpm --filter @forge/agent-profile test
pnpm --filter @forge/execution test
pnpm --filter @forge/daemon test
pnpm --filter @forge/daemon build
```

Expected: all PASS; denied/approval-required actions never invoke the StepExecutor.

- [ ] **Step 5: 提交 Trusted Core 阶段门**

```bash
git add apps/daemon/src/modules apps/daemon/src/governed-run.e2e.test.ts packages/protocol/src/v2/rpc.ts
git commit -m "feat(core): expose governed execution services"
```
