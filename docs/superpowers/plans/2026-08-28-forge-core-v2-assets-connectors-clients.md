# Forge Core v2 Assets, Connectors, and Client Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Workflow/Automation、Knowledge/Memory 和 Connector 升级到 Core v2 原语，迁移全部内部客户端，并删除已被替代的 v1 路径。

**Architecture:** 现有 `@forge/workflows`、`@forge/automation` 和 `@forge/memory` 原地升级，避免复制资产系统；新增 `@forge/connectors` 统一外部动作与凭证引用。Workbench、CLI、Mobile、Channel Gateway 统一依赖 `@forge/daemon-client` v2，最后删除兼容 RPC、request-scoped `agent.event` 特判和 Channel Gateway 直接数据库访问。

**Tech Stack:** TypeScript 5.8.3、Vitest 3.0.9、Electron 39.8.5、React Native 0.86.2、better-sqlite3 13.0.2、SQLite WAL。

**Spec:** `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

## Global Constraints

- Workflow 必须基于 Durable Execution，不使用仅依赖进程内 `setTimeout` 的等待。
- Knowledge 是带版本与引用的当前事实；Memory 是带来源、作用域和有效期的经验。
- 外部写入统一经过 Connector Gateway、Policy、Approval、Budget、幂等和 reconcile。
- 凭证值不进入数据库、Prompt、Event、Trace 或客户端响应。
- 所有内部消费者通过 v2 回归后才删除 compatibility adapter。
- 最终仓库只保留一套长期维护的调用路径。
- 代码片段中的 `*Fixture`、`fake*` 等名称均是在同一测试文件中创建的确定性测试夹具；写失败测试步骤必须同时实现这些夹具的最小定义。

---

## File Structure Map

| Path | Responsibility |
|---|---|
| `migrations/016_core_assets_workflows.sql` | 统一资产、workflow/version/trigger/instances |
| `migrations/017_core_knowledge_memory.sql` | source/document/version/citation/memory candidates |
| `migrations/018_core_connectors.sql` | connector/account/action/reconciliation |
| `packages/workflows/src/v2/*` | Workflow definition、compiler、trigger 和 durable execution adapter |
| `packages/asset-registry/src/*` | Skill/Knowledge/Profile/Workflow/Template 统一版本与生命周期 |
| `packages/automation/src/v2-adapter.ts` | 旧 Automation 到 Workflow v2 的导入 |
| `packages/memory/src/knowledge.ts` | Knowledge source/version/citation |
| `packages/memory/src/memory-v2.ts` | candidate/decision/version/expiry |
| `packages/connectors/src/gateway.ts` | propose/execute/reconcile |
| `packages/connectors/src/credentials.ts` | CredentialRef provider interface |
| `packages/connectors/src/adapters/mock.ts` | 测试用连接器 |
| `apps/desktop/src/daemon-v2.ts` | Workbench v2 client facade |
| `apps/cli/src/client-v2.ts` | CLI v2 client facade |
| `packages/mobile-protocol/src/v2.ts` | Mobile relay v2 envelopes |
| `packages/channel-mobile/src/mobile-rpc-v2.ts` | Mobile 到 Daemon v2 routing |
| `apps/channel-gateway/src/daemon-session-store.ts` | Channel 经 RPC 访问 Session |
| `scripts/core-v2/assert-no-legacy.ts` | Legacy import/method/static scan gate |

## Public Interfaces Locked by This Plan

```ts
export interface WorkflowDefinition {
  id: string; version: number; inputSchema: Record<string, unknown>;
  steps: StepSpec[]; triggers: WorkflowTrigger[];
  concurrency: { maxRuns: number; keyExpression?: string };
}

export interface ConnectorGateway {
  propose(input: ConnectorActionInput): Promise<ConnectorProposal>;
  execute(proposalId: string, approvalId?: string): Promise<ConnectorActionResult>;
  reconcile(actionId: string): Promise<ConnectorActionResult | "unknown">;
}

export interface CredentialProvider {
  resolve(ref: CredentialRef, scope: CredentialScope): Promise<ResolvedCredential>;
}

export interface CredentialRef { provider: string; key: string }
export interface CredentialScope { connectorAccountId: string; actions: string[] }
export interface ResolvedCredential { readonly kind: string; readonly value: Uint8Array; dispose(): void }
```

### Task 1: 添加 Asset、Workflow、Knowledge/Memory 和 Connector migrations

**Files:**
- Create: `migrations/016_core_assets_workflows.sql`
- Create: `migrations/017_core_knowledge_memory.sql`
- Create: `migrations/018_core_connectors.sql`
- Create: `packages/store/src/assets-connectors-migrations.test.ts`

**Interfaces:**
- Consumes: ForgeStore migration journal。
- Produces: F11-F13 持久表、约束和索引。

- [ ] **Step 1: 写 Schema 和敏感字段拒绝测试**

```ts
it("creates versioned workflow knowledge and connector tables", () => {
  const db = openMigratedFixture().db;
  expect(tableNames(db)).toEqual(expect.arrayContaining([
    "core_workflow_versions", "core_workflow_instances", "core_knowledge_sources",
    "core_memory_candidates", "core_connectors", "core_connector_actions",
    "core_assets", "core_asset_versions", "core_asset_dependencies",
  ]));
});

it("connector account schema contains credential_ref but no secret column", () => {
  const columns = tableColumns(openMigratedFixture().db, "core_connector_accounts");
  expect(columns).toContain("credential_ref");
  expect(columns.some((name) => /secret|token|password|api_key/i.test(name))).toBe(false);
});
```

- [ ] **Step 2: 运行 migration 测试确认表不存在**

Run: `pnpm exec vitest run packages/store/src/assets-connectors-migrations.test.ts`

Expected: FAIL listing missing tables.

- [ ] **Step 3: 创建 migrations 与必要唯一约束**

```sql
CREATE UNIQUE INDEX uq_core_connector_action_idempotency
ON core_connector_actions(connector_account_id, idempotency_key);

CREATE UNIQUE INDEX uq_core_workflow_version
ON core_workflow_versions(workflow_id, version);
```

Store source versions and citation locators separately; memory candidates retain source/evidence refs and decision state.

- [ ] **Step 4: 运行 Store 全测**

Run: `pnpm --filter @forge/store test`

Expected: PASS; migrations 016-018 apply once and roll back on injected failure.

- [ ] **Step 5: 提交资产与连接器 Schema**

```bash
git add migrations/016_core_assets_workflows.sql migrations/017_core_knowledge_memory.sql migrations/018_core_connectors.sql packages/store/src/assets-connectors-migrations.test.ts
git commit -m "feat(core): add workflow knowledge and connector schema"
```

### Task 2: 实现统一 Asset Registry 和发布质量门

**Files:**
- Create: `packages/asset-registry/package.json`
- Create: `packages/asset-registry/tsconfig.json`
- Create: `packages/asset-registry/src/types.ts`
- Create: `packages/asset-registry/src/registry.ts`
- Create: `packages/asset-registry/src/registry.test.ts`
- Create: `packages/asset-registry/src/quality-gate.ts`
- Create: `packages/asset-registry/src/quality-gate.test.ts`
- Create: `packages/asset-registry/src/index.ts`

**Interfaces:**
- Consumes: Skill、Knowledge、AgentProfile、Workflow、PositionTemplate 的版本引用和 validator results。
- Produces: `AssetRegistry.createDraft()`、`publish()`、`deprecate()`、`rollback()`、`resolveVersion()`。

- [ ] **Step 1: 写不可变版本、依赖和发布门测试**

```ts
it("publishes an immutable version with owner source and dependencies", () => {
  const asset = registry.createDraft(assetDraft());
  const version = registry.publish(asset.id, publishInput({ validationIds: ["validation-pass"] }));
  expect(version).toMatchObject({ version: 1, state: "published", ownerSubjectId: "human:local" });
  expect(() => registry.mutateVersion(version.id, {})).toThrow("immutable asset version");
});

it("blocks publish when security or evaluation validation fails", () => {
  const asset = registry.createDraft(assetDraft());
  expect(() => registry.publish(asset.id, publishInput({ validationIds: ["validation-failed"] })))
    .toThrow("asset quality gate failed");
});
```

- [ ] **Step 2: 运行 registry tests 确认 package 不存在**

Run: `pnpm --filter @forge/asset-registry test`

Expected: FAIL because `@forge/asset-registry` is absent.

- [ ] **Step 3: 实现统一生命周期和类型化 adapter**

```ts
export type AssetKind = "skill" | "knowledge" | "agent_profile" | "workflow" | "position_template";
export type AssetState = "draft" | "testing" | "published" | "deprecated" | "rolled_back";

export interface AssetVersion {
  id: string; assetId: string; kind: AssetKind; version: number; state: AssetState;
  ownerSubjectId: string; sourceRef: string; contentHash: string;
  dependencies: AssetVersionRef[]; validationIds: string[]; createdAt: string;
}
```

Quality gate requires description completeness, dependency resolution, permission review, security validation and kind-specific eval results. Rollback publishes a new pointer to an existing immutable version; it does not edit history.

- [ ] **Step 4: 运行 asset/profile/workflow tests**

Run: `pnpm --filter @forge/asset-registry test && pnpm --filter @forge/agent-profile test && pnpm --filter @forge/workflows test`

Expected: PASS for dependency cycles, missing owner, failed validation, publish, deprecate and rollback.

- [ ] **Step 5: 提交统一资产生命周期**

```bash
git add packages/asset-registry
git commit -m "feat(assets): add unified versioned asset lifecycle"
```

### Task 3: 实现 Workflow 2.0 definition、compiler 和 trigger 去重

**Files:**
- Create: `packages/workflows/src/v2/types.ts`
- Create: `packages/workflows/src/v2/compiler.ts`
- Create: `packages/workflows/src/v2/compiler.test.ts`
- Create: `packages/workflows/src/v2/store.ts`
- Create: `packages/workflows/src/v2/store.test.ts`
- Create: `packages/workflows/src/v2/triggers.ts`
- Create: `packages/workflows/src/v2/triggers.test.ts`
- Modify: `packages/workflows/package.json`
- Modify: `packages/workflows/src/index.ts`

**Interfaces:**
- Consumes: `StepSpec`、JSON input、`AssetRegistry`。
- Produces: `WorkflowDefinition`、`WorkflowStore.publish()`、`compileWorkflowRun()`、`TriggerStore.accept()`。

- [ ] **Step 1: 写编译、Schema、并发键和重复 trigger 测试**

```ts
it("compiles a workflow version into a RunSpec", () => {
  const run = compileWorkflowRun(workflowFixture(), { topic: "launch" }, runContext());
  expect(run.steps.map((step) => step.id)).toEqual(["research", "draft", "approve"]);
  expect(run.correlationId).toBe("workflow-instance:wf-1:1");
});

it("accepts an external trigger id once", () => {
  const store = triggerFixture();
  expect(store.accept({ source: "webhook", externalId: "evt-1" })).toBe(true);
  expect(store.accept({ source: "webhook", externalId: "evt-1" })).toBe(false);
});

it("publishes a workflow through the unified asset registry", () => {
  const version = workflowStore.publish(validWorkflowDraft(), passingQualityGate());
  expect(version.asset.kind).toBe("workflow");
  expect(version.definition.version).toBe(version.asset.version);
});
```

- [ ] **Step 2: 运行 workflows 测试确认 v2 模块缺失**

Run: `pnpm --filter @forge/workflows test`

Expected: FAIL because `src/v2` is absent.

- [ ] **Step 3: 实现不可变版本和确定性 RunSpec 编译**

```ts
export function compileWorkflowRun(
  definition: WorkflowDefinition,
  input: unknown,
  context: WorkflowRunContext,
): RunSpec;
```

Validate input before creating a Run. Trigger types are `manual | cron | webhook | domain_event | connector_event`; concurrency key prevents excess active instances. WorkflowStore uses AssetRegistry for draft/testing/published/deprecated/rollback and adds failed terminal instances to a queryable dead-letter queue with replay authorization.

- [ ] **Step 4: 运行 workflows 全测与构建**

Run: `pnpm --filter @forge/workflows test && pnpm --filter @forge/workflows build`

Expected: PASS for invalid DAG, invalid input, duplicate event, missed cron and concurrency cap.

- [ ] **Step 5: 提交 Workflow 2.0 core**

```bash
git add packages/workflows/package.json packages/workflows/src
git commit -m "feat(workflow): add versioned durable definitions"
```

### Task 4: 将旧 Automation 导入 Workflow v2

**Files:**
- Create: `packages/automation/src/v2-adapter.ts`
- Create: `packages/automation/src/v2-adapter.test.ts`
- Modify: `apps/daemon/src/services/automation-service.ts`
- Modify: `apps/daemon/src/services/automation-scheduler-host.ts`

**Interfaces:**
- Consumes: 旧 Automation row 和 `WorkflowDefinition`。
- Produces: `automationToWorkflow()`、Durable trigger execution。

- [ ] **Step 1: 写 cron/manual 映射和重启恢复测试**

```ts
it("maps a cron automation to one forge.agent workflow step", () => {
  expect(automationToWorkflow(legacyAutomationFixture())).toMatchObject({
    triggers: [{ kind: "cron" }],
    steps: [{ kind: "forge.agent" }],
  });
});

it("does not double-run the same scheduled occurrence after restart", async () => {
  const fx = automationRestartFixture("2026-08-28T10:00:00Z");
  await fx.startTwice();
  expect(fx.executionCount()).toBe(1);
});
```

- [ ] **Step 2: 运行 automation 测试确认 adapter 缺失**

Run: `pnpm --filter @forge/automation test`

Expected: FAIL because `automationToWorkflow` is absent.

- [ ] **Step 3: 实现导入和基于 Durable Execution 的 scheduler**

```ts
export function automationToWorkflow(row: AutomationRecord): WorkflowDefinition {
  return {
    id: `automation:${row.id}`, version: row.version,
    inputSchema: EMPTY_OBJECT_SCHEMA,
    triggers: row.schedule ? [{ kind: "cron", ...row.schedule }] : [{ kind: "manual" }],
    steps: [legacyAutomationStep(row)], concurrency: { maxRuns: 1 },
  };
}
```

Replace long-lived process timers with persisted next-occurrence claims; a short timer may wake the scheduler but is not state authority.

- [ ] **Step 4: 运行 automation/workflow/daemon tests**

Run: `pnpm --filter @forge/automation test && pnpm --filter @forge/workflows test && pnpm --filter @forge/daemon test`

Expected: PASS; current manual/Cron behavior remains while restart dedupe is added.

- [ ] **Step 5: 提交 Automation v2 adapter**

```bash
git add packages/automation apps/daemon/src/services/automation-service.ts apps/daemon/src/services/automation-scheduler-host.ts
git commit -m "feat(automation): execute automations as durable workflows"
```

### Task 5: 实现 Knowledge source/version/citation

**Files:**
- Create: `packages/memory/src/knowledge.ts`
- Create: `packages/memory/src/knowledge.test.ts`
- Modify: `packages/memory/package.json`
- Modify: `packages/memory/src/index.ts`
- Modify: `packages/document-extract/src/index.ts`

**Interfaces:**
- Consumes: extracted document/source content、`AssetRegistry`。
- Produces: `KnowledgeStore.syncSource()`、`search()`、`getCitation()`。

- [ ] **Step 1: 写增量同步、删除传播和引用定位测试**

```ts
it("creates a new source version only when content changes", async () => {
  const store = knowledgeFixture();
  const first = await store.syncSource(source("guide", "alpha"));
  const second = await store.syncSource(source("guide", "alpha"));
  expect(second.versionId).toBe(first.versionId);
});

it("returns source version and locator with every hit", async () => {
  const hit = (await knowledgeFixtureWithDocument().search({ query: "refund", limit: 5 }))[0];
  expect(hit).toMatchObject({ sourceVersionId: expect.any(String), locator: expect.any(String) });
});

it("publishes each accepted knowledge version as a knowledge asset", async () => {
  const result = await knowledgeFixture().syncSource(source("guide", "alpha"));
  expect(result.assetVersionRef.kind).toBe("knowledge");
});
```

- [ ] **Step 2: 运行 memory 测试确认 Knowledge API 缺失**

Run: `pnpm exec vitest run packages/memory/src/knowledge.test.ts`

Expected: FAIL because `KnowledgeStore` is absent.

- [ ] **Step 3: 实现 source/version/chunk/citation 与访问作用域**

```ts
export interface KnowledgeHit {
  chunkId: string; text: string; score: number;
  sourceId: string; sourceVersionId: string; locator: string;
  contentHash: string;
}
```

The first implementation may use deterministic FTS/keyword retrieval; it must preserve an interface for hybrid retrieval and reranking without changing citation identity. Add `@forge/asset-registry`, `"test": "vitest run"` and Vitest 3.0.9 to `packages/memory/package.json` in this task.

- [ ] **Step 4: 运行 memory 与 document-extract tests**

Run: `pnpm --filter @forge/memory test && pnpm --filter @forge/document-extract test`

Expected: PASS for version reuse, changed content, deletion, scope and locator.

- [ ] **Step 5: 提交 Knowledge 2.0**

```bash
git add packages/memory/package.json packages/memory/src/knowledge.ts packages/memory/src/knowledge.test.ts packages/memory/src/index.ts packages/document-extract/src/index.ts
git commit -m "feat(knowledge): add versioned cited sources"
```

### Task 6: 实现 Memory candidate/decision/version/expiry

**Files:**
- Create: `packages/memory/src/memory-v2.ts`
- Create: `packages/memory/src/memory-v2.test.ts`
- Modify: `packages/memory/src/index.ts`

**Interfaces:**
- Consumes: memory candidate、source/evidence refs。
- Produces: `MemoryStoreV2.propose()`、`decide()`、`recall()`、`invalidate()`。

- [ ] **Step 1: 写 ADD/UPDATE/DELETE/NOOP、过期和作用域测试**

```ts
it("does not expose a candidate before an ADD decision", () => {
  const store = memoryV2Fixture();
  store.propose(candidate("prefer concise answers"));
  expect(store.recall(recallContext())).toEqual([]);
});

it("excludes expired and cross-company memories", () => {
  const store = memoryV2FixtureWithApprovedRows();
  expect(store.recall({ companyId: "company-b", employeeId: "e1", now: futureDate() }))
    .toEqual([]);
});
```

- [ ] **Step 2: 运行 memory-v2 测试确认 API 缺失**

Run: `pnpm exec vitest run packages/memory/src/memory-v2.test.ts`

Expected: FAIL because `MemoryStoreV2` is absent.

- [ ] **Step 3: 实现可解释召回和版本修正**

```ts
export type MemoryDecision = "ADD" | "UPDATE" | "DELETE" | "NOOP";
export interface RecalledMemory {
  memoryId: string; versionId: string; content: string;
  sourceRefs: string[]; confidence: number; reasonRecalled: string;
}
```

Raw cross-user conversations are rejected for shared scopes unless marked redacted and supported by evidence.

- [ ] **Step 4: 运行 memory 全测**

Run: `pnpm --filter @forge/memory test`

Expected: PASS for candidate decisions, conflict, correction, expiry, scope and recall explanation.

- [ ] **Step 5: 提交 Memory 2.0**

```bash
git add packages/memory/src/memory-v2.ts packages/memory/src/memory-v2.test.ts packages/memory/src/index.ts
git commit -m "feat(memory): add governed versioned memory"
```

### Task 7: 实现动态运行状态和自适应上下文压缩

**Files:**
- Create: `packages/agent-core/src/dynamic-status.ts`
- Create: `packages/agent-core/src/dynamic-status.test.ts`
- Create: `packages/agent-core/src/context-compression.ts`
- Create: `packages/agent-core/src/context-compression.test.ts`
- Modify: `packages/agent-core/src/loop.ts`
- Modify: `packages/agent-core/src/prompts.ts`
- Modify: `packages/context/package.json`
- Modify: `packages/context/src/index.ts`

**Interfaces:**
- Consumes: Run/Step/Attempt、Workspace、Budget、Trace、tool results and context usage。
- Produces: `buildDynamicStatus()`、`ContextCompressor.compact()` 和压缩 Evidence。

- [ ] **Step 1: 写关键状态保留、噪声删除和熔断 tests**

```ts
it("keeps decisions paths failures validation and remaining work", () => {
  const compressed = compressor.compact(longContextFixture());
  expect(compressed.summary).toContain("architecture decision");
  expect(compressed.summary).toContain("packages/execution/src/store.ts");
  expect(compressed.summary).toContain("validation failed");
  expect(compressed.summary).toContain("remaining: release approval");
});

it("opens the compression circuit after repeated model failures", async () => {
  const fx = compressionFixture({ modelFailures: 3 });
  await fx.compressor.compactWithFallback(fx.context);
  expect(fx.modelCalls).toBe(3);
  expect(fx.circuitState()).toBe("open");
});
```

- [ ] **Step 2: 运行 Agent Context tests 确认实现缺失**

Run: `pnpm exec vitest run packages/agent-core/src/dynamic-status.test.ts packages/agent-core/src/context-compression.test.ts`

Expected: FAIL because dynamic status/compressor are absent.

- [ ] **Step 3: 实现稳定状态尾注、分层压缩和本地降级**

```ts
export interface DynamicRunStatus {
  runId: string; currentStepId?: string; workspaceBindings: string[];
  modifiedFiles: string[]; validationSummary: string;
  failures: string[]; retryCount: number; budgetRemainingMinor?: bigint;
  unresolvedDecisions: string[]; remainingWork: string[];
}

export interface CompressionResult {
  mode: "prune" | "structured" | "model" | "local_fallback";
  summary: string; retainedRefs: string[]; removedTokenEstimate: number;
  evidenceId: string;
}
```

Keep the System Prompt stable and append dynamic status at the tail. Compression thresholds, tool-result budgets and retry caps are versioned in AgentProfile runtime policy. Add `"test": "vitest run"` and Vitest 3.0.9 to `packages/context/package.json` in this task.

- [ ] **Step 4: 运行 agent/context/session tests**

Run: `pnpm --filter @forge/agent-core test && pnpm --filter @forge/context test && pnpm --filter @forge/session test`

Expected: PASS for long runs, failed model compression, repeated compression prevention and critical ref retention.

- [ ] **Step 5: 提交 context reliability**

```bash
git add packages/agent-core/src/dynamic-status.ts packages/agent-core/src/dynamic-status.test.ts packages/agent-core/src/context-compression.ts packages/agent-core/src/context-compression.test.ts packages/agent-core/src/loop.ts packages/agent-core/src/prompts.ts packages/context/package.json packages/context/src/index.ts
git commit -m "feat(runtime): add dynamic status and adaptive compression"
```

### Task 8: 实现 Connector Gateway 和 CredentialRef

**Files:**
- Create: `packages/connectors/package.json`
- Create: `packages/connectors/tsconfig.json`
- Create: `packages/connectors/src/types.ts`
- Create: `packages/connectors/src/credentials.ts`
- Create: `packages/connectors/src/gateway.ts`
- Create: `packages/connectors/src/gateway.test.ts`
- Create: `packages/connectors/src/adapters/mock.ts`
- Create: `packages/connectors/src/index.ts`

**Interfaces:**
- Consumes: PolicyEngine、ApprovalService、BudgetLedger、CredentialProvider。
- Produces: `ConnectorGateway.propose()`、`execute()`、`reconcile()`。

- [ ] **Step 1: 写审批、幂等、凭证隔离和 reconcile 测试**

```ts
it("returns one result for repeated execution with the same idempotency key", async () => {
  const fx = connectorFixture();
  const proposal = await fx.gateway.propose(publishInput("post-1"));
  const first = await fx.gateway.execute(proposal.id, "approval-1");
  const second = await fx.gateway.execute(proposal.id, "approval-1");
  expect(second.actionId).toBe(first.actionId);
  expect(fx.adapter.executeCalls).toBe(1);
});

it("never persists resolved secret material", async () => {
  const fx = connectorFixture({ secret: "super-secret" });
  await executeApprovedProposal(fx);
  expect(fx.dumpDatabase()).not.toContain("super-secret");
  expect(JSON.stringify(fx.events())).not.toContain("super-secret");
});
```

- [ ] **Step 2: 运行 connector tests 确认 package 不存在**

Run: `pnpm --filter @forge/connectors test`

Expected: FAIL because `@forge/connectors` is absent.

- [ ] **Step 3: 实现 propose/execute/reconcile 四阶段安全边界**

```ts
export interface ConnectorAdapter {
  kind: string;
  propose(input: ConnectorActionInput): Promise<ConnectorProposalPreview>;
  execute(input: ApprovedConnectorAction, credential: ResolvedCredential): Promise<AdapterResult>;
  reconcile(input: ConnectorActionRecord, credential: ResolvedCredential): Promise<AdapterResult | "unknown">;
}
```

Credential lifetime is limited to the adapter call; logs and errors pass through structural redaction before persistence.

- [ ] **Step 4: 运行 connector 和治理回归**

Run: `pnpm --filter @forge/connectors test && pnpm --filter @forge/policy test && pnpm --filter @forge/usage-ledger test`

Expected: PASS for deny, approval, idempotency, retry, reconcile, rate limit and secret redaction.

- [ ] **Step 5: 提交 Connector Gateway**

```bash
git add packages/connectors
git commit -m "feat(connectors): add governed connector gateway"
```

### Task 9: 迁移 Workbench 与 CLI 到 v2 client facade

**Files:**
- Create: `apps/desktop/src/daemon-v2.ts`
- Create: `apps/desktop/src/daemon-v2.test.ts`
- Create: `apps/cli/src/client-v2.ts`
- Create: `apps/cli/src/client-v2.test.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/cli/src/runner.ts`
- Modify: `apps/cli/src/daemon-util.ts`

**Interfaces:**
- Consumes: `DaemonClient.request<M>()`、`subscribe()`、RunSpec compat factory。
- Produces: `WorkbenchDaemonApi`、`CliDaemonApi`，无 `unknown` 强转。

- [ ] **Step 1: 写 capability gate 和 typed run tests**

```ts
it("refuses startup when required v2 capabilities are absent", async () => {
  const api = createWorkbenchDaemonApi(fakeClient({ features: {} }));
  await expect(api.assertCompatible()).rejects.toThrow("core.execution.v2");
});

it("returns a typed simple run result without casting unknown", async () => {
  const api = createCliDaemonApi(fakeClient());
  await expect(api.startSimpleRun(runInput())).resolves.toMatchObject({ runId: "r1" });
});
```

- [ ] **Step 2: 运行 Desktop/CLI 测试确认 facades 缺失**

Run: `pnpm exec vitest run apps/desktop/src/daemon-v2.test.ts apps/cli/src/client-v2.test.ts`

Expected: FAIL because v2 facades are absent.

- [ ] **Step 3: 实现 facade 并迁移 IPC/runner 调用**

```ts
export interface WorkbenchDaemonApi {
  assertCompatible(): Promise<void>;
  createRun(spec: RunSpec): Promise<{ runId: string; state: RunState }>;
  subscribeRun(runId: string, handler: (event: EventEnvelope) => void): Promise<EventSubscription>;
  cancelRun(runId: string): Promise<void>;
}
```

Keep renderer IPC names stable during this task; only main/preload switch to the typed v2 client.

- [ ] **Step 4: 运行 Desktop/CLI tests and builds**

Run: `pnpm --filter @forge/desktop test && pnpm --filter @forge/cli test && pnpm --filter @forge/desktop build && pnpm --filter @forge/cli build`

Expected: PASS; existing Workbench session and CLI run UX remain functional.

- [ ] **Step 5: 提交 Workbench/CLI migration**

```bash
git add apps/desktop/src apps/cli/src
git commit -m "refactor(clients): migrate workbench and cli to core v2"
```

### Task 10: 迁移 Mobile relay 和 Channel Gateway，移除直接 DB 访问

**Files:**
- Create: `packages/mobile-protocol/src/v2.ts`
- Create: `packages/mobile-protocol/src/v2.test.ts`
- Create: `packages/channel-mobile/src/mobile-rpc-v2.ts`
- Create: `packages/channel-mobile/src/mobile-rpc-v2.test.ts`
- Create: `apps/channel-gateway/src/daemon-session-store.ts`
- Create: `apps/channel-gateway/src/daemon-session-store.test.ts`
- Modify: `apps/channel-gateway/src/gateway.ts`
- Modify: `apps/channel-gateway/src/forge-bridge.ts`
- Modify: `apps/mobile/src/data/forge-mobile-api.ts`

**Interfaces:**
- Consumes: v2 client、event cursor、session RPC。
- Produces: Mobile v2 envelope 和 `DaemonSessionStore`。

- [ ] **Step 1: 写移动端事件补发和 Gateway 无 SQLite 测试**

```ts
it("resumes mobile events from the last sequence", async () => {
  const api = mobileV2Fixture({ cursor: 12, replay: [event(13), event(14)] });
  expect(await api.resumeRun("r1")).toEqual([13, 14]);
});

it("channel gateway source does not construct SessionStore or Database", () => {
  const source = readFileSync(join(repoRoot, "apps/channel-gateway/src/gateway.ts"), "utf8");
  expect(source).not.toMatch(/new SessionStore|better-sqlite3|data\.db/);
});
```

- [ ] **Step 2: 运行 mobile/gateway tests 确认旧路径仍存在**

Run: `pnpm --filter @forge/mobile-protocol test && pnpm --filter @forge/channel-mobile test && pnpm --filter @forge/channel-gateway test && pnpm --filter @forge/mobile test`

Expected: FAIL on direct SessionStore access and missing v2 resume behavior.

- [ ] **Step 3: 迁移 relay routing、sanitizers 和 channel session access**

```ts
export class DaemonSessionStore {
  constructor(private readonly client: DaemonClient) {}
  create(cwd: string): Promise<{ sessionId: string }>;
  appendMessage(input: AppendSessionMessageInput): Promise<void>;
  get(sessionId: string): Promise<SessionDto>;
}
```

Add matching typed session RPC to protocol/Daemon session module. Mobile parsers continue treating remote payload as untrusted and sanitize at the boundary.

- [ ] **Step 4: 运行 Mobile、Channel、Daemon 回归和 builds**

Run: `pnpm --filter @forge/mobile-protocol test && pnpm --filter @forge/channel-mobile test && pnpm --filter @forge/channel-gateway test && pnpm --filter @forge/mobile test && pnpm --filter @forge/channel-gateway build && pnpm --filter @forge/mobile build`

Expected: PASS; Channel Gateway has no direct database import or path.

- [ ] **Step 5: 提交 Mobile/Channel migration**

```bash
git add packages/mobile-protocol packages/channel-mobile apps/channel-gateway apps/mobile/src/data/forge-mobile-api.ts apps/daemon/src/modules/session-module.ts packages/protocol/src/v2/rpc.ts
git commit -m "refactor(clients): migrate mobile and channels to core v2"
```

### Task 11: 删除 v1 RPC、agent.event 特判和临时 Adapter

**Files:**
- Create: `scripts/core-v2/assert-no-legacy.ts`
- Create: `scripts/core-v2/assert-no-legacy.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/daemon-client/src/index.ts`
- Modify: `packages/bus/src/index.ts`
- Modify: `packages/execution/src/index.ts`
- Delete: `packages/execution/src/legacy-run-adapter.ts`
- Delete: `packages/execution/src/legacy-run-adapter.test.ts`
- Modify: all internal callers reported by `assert-no-legacy.ts`

**Interfaces:**
- Consumes: 已迁移的四个客户端和 v2 Run APIs。
- Produces: 单一 Core v2 public path。

- [ ] **Step 1: 写静态 Legacy gate**

```ts
it("finds forbidden legacy symbols", () => {
  const findings = scanLegacySymbols(fixtureRepo({
    "x.ts": "client.request(DAEMON_METHODS.RUN, value)",
  }));
  expect(findings[0]?.symbol).toBe("DAEMON_METHODS.RUN");
});
```

Forbidden symbols include `AGENT_EVENT_METHOD`, `AgentEventNotificationParams`, untyped `request(method: string): Promise<unknown>`, `DAEMON_METHODS.RUN`, `DAEMON_METHODS.CANCEL_RUN` compatibility calls and Channel direct DB constructors.

- [ ] **Step 2: 运行 gate 并记录所有剩余调用点**

Run: `pnpm exec vitest run scripts/core-v2/assert-no-legacy.test.ts && pnpm tsx scripts/core-v2/assert-no-legacy.ts`

Expected: FAIL with a finite path/symbol list before cleanup.

- [ ] **Step 3: 删除兼容符号并迁移最后调用者**

The final `RunRequest` convenience API may remain only as a pure client-side `simpleRunSpec()` factory; it cannot have a separate Daemon method or event protocol.

- [ ] **Step 4: 运行 Legacy gate and all client tests**

Run: `pnpm tsx scripts/core-v2/assert-no-legacy.ts && pnpm --filter @forge/desktop test && pnpm --filter @forge/cli test && pnpm --filter @forge/mobile test && pnpm --filter @forge/channel-gateway test`

Expected: PASS and zero forbidden findings.

- [ ] **Step 5: 提交 Legacy 删除**

```bash
git add packages/protocol/src/index.ts packages/daemon-client/src/index.ts packages/bus/src/index.ts packages/execution/src/index.ts packages/execution/src/legacy-run-adapter.ts packages/execution/src/legacy-run-adapter.test.ts scripts/core-v2/assert-no-legacy.ts scripts/core-v2/assert-no-legacy.test.ts
git commit -m "refactor(core): remove legacy rpc and event paths"
```

### Task 12: 执行 Core v2 根级回归、数据恢复和文档收口

**Files:**
- Create: `docs/core-v2-operations.md`
- Create: `docs/core-v2-migration-report.md`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/roadmap.md`
- Modify: `scripts/smoke-test.sh`
- Modify: `scripts/smoke-test.ps1`

**Interfaces:**
- Consumes: F0-A 至 F0-E 全部交付。
- Produces: 运行/恢复手册、迁移报告和单一 Core v2 门禁。

- [ ] **Step 1: 为 smoke 添加 v2 capability/run/event 断言**

```ts
const capabilities = await client.request("system.capabilities", {});
assert.equal(capabilities.protocolVersion, 2);
const run = await client.request("run.create", simpleRunSpec(smokeInput));
const terminal = await waitForTerminalRun(client, run.runId);
assert.equal(terminal.state, "succeeded");
```

- [ ] **Step 2: 运行根级门禁并确认任何失败都阻止收口**

Run: `pnpm build && pnpm test && pnpm smoke`

Expected: all PASS on the current platform; platform-specific smoke runs in its matching CI job.

- [ ] **Step 3: 收口根级测试清单并在复制的 v1 数据上完成升级→运行→备份→恢复→再运行**

Add `@forge/store`、`@forge/event-store`、`@forge/execution`、`@forge/evals`、`@forge/policy`、`@forge/usage-ledger`、`@forge/evidence`、`@forge/agent-profile`、`@forge/asset-registry`、`@forge/connectors` and `@forge/context` to the root `test` filter list. Record source checksum, migration versions, row counts, run IDs and restored checksum in `docs/core-v2-migration-report.md`; do not use the user's live database for the rehearsal.

- [ ] **Step 4: 再运行 Legacy gate 和 git diff 检查**

Run: `pnpm tsx scripts/core-v2/assert-no-legacy.ts && git diff --check`

Expected: PASS with no legacy symbols and no whitespace errors.

- [ ] **Step 5: 提交 Core v2 收口文档与 smoke gate**

```bash
git add package.json docs/core-v2-operations.md docs/core-v2-migration-report.md docs/roadmap.md README.md scripts/smoke-test.sh scripts/smoke-test.ps1
git commit -m "docs(core): complete core v2 migration gate"
```
