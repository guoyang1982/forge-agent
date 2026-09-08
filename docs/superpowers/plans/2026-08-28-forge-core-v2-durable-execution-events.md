# Forge Core v2 Durable Execution and Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把一次性 `cwd + message` 运行升级为可持久、可等待、可恢复的 Run/Step/Attempt 执行引擎，并提供断线可补发的统一事件平台。

**Architecture:** 新增 `@forge/execution` 管理执行状态机和调度，新增 `@forge/event-store` 管理 append-only event、outbox 和 cursor。现有 Forge Runtime 通过 `LegacyRunAdapter` 成为一种 StepExecutor；Daemon v2 暴露 run create/get/cancel/resume 和 events read/subscribe，旧 RunRequest 在内部迁移期映射到单步骤 RunSpec。

**Tech Stack:** TypeScript 5.8.3、Vitest 3.0.9、better-sqlite3 13.0.2、SQLite WAL、现有 `@forge/agent-core` 与外部 Runtime adapters。

**Spec:** `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

## Global Constraints

- Run 是执行事实，不能直接替代 WorkItem 业务状态。
- 状态变更和 Outbox event 必须在同一 SQLite transaction 中提交。
- 每个有外部副作用的 Step 必须有 idempotency key；重复 Attempt 不得重复副作用。
- Daemon 重启后，`running` Attempt 必须被确定性恢复为 `retry_scheduled`、`waiting` 或 `failed`，不能保持幽灵运行。
- 事件大对象只保存摘要、hash 和 ArtifactRef。
- 旧 Run Adapter 在全部内部客户端迁移后删除。
- `SubjectRef`、`RiskLevel` 和 `EventEnvelope` 使用 Foundation 计划在 `@forge/protocol` 中定义的同名类型，不创建第二份结构。
- 代码片段中的 `*Fixture`、`fake*`、`ids.fixed()` 等名称均是在同一测试文件中创建的确定性测试夹具；写失败测试步骤必须同时实现这些夹具的最小定义。

---

## File Structure Map

| Path | Responsibility |
|---|---|
| `migrations/009_core_execution.sql` | runs、steps、attempts、dependencies、waits |
| `migrations/010_core_events.sql` | events、outbox、consumer cursors、eval suites/runs/results |
| `packages/execution/src/types.ts` | RunSpec、StepSpec、状态和执行结果 |
| `packages/execution/src/state-machine.ts` | 合法状态转换 |
| `packages/execution/src/store.ts` | Run/Step/Attempt 持久化 |
| `packages/execution/src/executor.ts` | DurableExecutor 调度循环 |
| `packages/execution/src/recovery.ts` | 启动恢复和过期 Attempt 处理 |
| `packages/execution/src/legacy-run-adapter.ts` | 旧 RunRequest/Runtime 临时适配 |
| `packages/event-store/src/types.ts` | EventEnvelope、Cursor、SubscriptionFilter |
| `packages/event-store/src/store.ts` | append/read/outbox/cursor |
| `packages/event-store/src/publisher.ts` | Outbox publisher 与重试 |
| `apps/daemon/src/modules/execution-module.ts` | v2 run RPC 与执行生命周期 |
| `apps/daemon/src/modules/event-module.ts` | 事件读取与订阅 |
| `packages/daemon-client/src/subscription.ts` | 自动重连、cursor 补发和去重 |
| `packages/evals/src/*` | 版本化评测集、运行、比较和失败转回归 |

## Public Interfaces Locked by This Plan

```ts
export interface RunSpec {
  id: string;
  requestedBy: SubjectRef;
  actingSubject: SubjectRef;
  objective: string;
  steps: StepSpec[];
  budgetAccountId?: string;
  policyContext: Record<string, unknown>;
  correlationId: string;
}

export interface StepSpec {
  id: string;
  kind: string;
  dependsOn: string[];
  input: unknown;
  workspaceBindingId?: string;
  idempotencyKey?: string;
  retry: { maxAttempts: number; backoffMs: number; maxBackoffMs: number };
  timeoutMs: number;
}

// EventEnvelope<T> is imported from @forge/protocol and persisted without shape changes.
```

### Task 1: 创建 execution/event Schema migrations

**Files:**
- Create: `migrations/009_core_execution.sql`
- Create: `migrations/010_core_events.sql`
- Create: `packages/store/src/core-execution-migrations.test.ts`

**Interfaces:**
- Consumes: `ForgeStore` migration journal。
- Produces: Core execution 与 event 表、索引和约束。

- [ ] **Step 1: 写 Schema 失败测试**

```ts
it("creates execution and event tables with required indexes", () => {
  const store = openMigratedFixture();
  expect(tableNames(store.db)).toEqual(expect.arrayContaining([
    "core_runs", "core_steps", "core_attempts", "core_events",
    "core_outbox", "core_event_cursors", "core_eval_suites",
    "core_eval_runs", "core_eval_case_results",
  ]));
  expect(indexNames(store.db)).toContain("idx_core_events_sequence");
});
```

- [ ] **Step 2: 运行 migration 测试确认表不存在**

Run: `pnpm exec vitest run packages/store/src/core-execution-migrations.test.ts`

Expected: FAIL listing missing `core_runs` and `core_events`.

- [ ] **Step 3: 添加严格状态列、外键和索引**

```sql
CREATE TABLE core_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('queued','running','waiting','succeeded','failed','cancelled')),
  spec_json TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  requested_by_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE core_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
```

Add foreign keys for steps/attempts and unique `(run_id, step_id, attempt_number)` plus unique idempotency execution records.

- [ ] **Step 4: 运行迁移、重复启动和 rollback 测试**

Run: `pnpm --filter @forge/store test`

Expected: PASS; migrations 009/010 appear once in `schema_migrations`.

- [ ] **Step 5: 提交 execution Schema**

```bash
git add migrations/009_core_execution.sql migrations/010_core_events.sql packages/store/src/core-execution-migrations.test.ts
git commit -m "feat(execution): add durable run and event schema"
```

### Task 2: 定义 Run/Step/Attempt 状态机

**Files:**
- Create: `packages/execution/package.json`
- Create: `packages/execution/tsconfig.json`
- Create: `packages/execution/src/types.ts`
- Create: `packages/execution/src/state-machine.ts`
- Create: `packages/execution/src/state-machine.test.ts`
- Create: `packages/execution/src/index.ts`

**Interfaces:**
- Consumes: v2 SubjectRef 和 RpcFault。
- Produces: `RunSpec`、`StepSpec`、`transitionRun()`、`transitionStep()`、`transitionAttempt()`。

- [ ] **Step 1: 写合法与非法转换测试**

```ts
it.each([
  ["queued", "running"], ["running", "waiting"], ["waiting", "running"],
  ["running", "succeeded"], ["running", "failed"], ["queued", "cancelled"],
])("allows run transition %s -> %s", (from, to) => {
  expect(transitionRun(from as RunState, to as RunState)).toBe(to);
});

it("rejects succeeded -> running", () => {
  expect(() => transitionRun("succeeded", "running")).toThrow("terminal state");
});
```

- [ ] **Step 2: 运行测试确认 package 不存在**

Run: `pnpm --filter @forge/execution test`

Expected: FAIL because `@forge/execution` is absent.

- [ ] **Step 3: 实现明确转换表和终态判断**

```ts
const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled"],
  waiting: ["running", "failed", "cancelled"],
  succeeded: [], failed: [], cancelled: [],
};
```

Define StepState as `pending | runnable | running | waiting | succeeded | failed | skipped | cancelled`; AttemptState as `created | running | waiting | succeeded | failed | abandoned | cancelled`.

- [ ] **Step 4: 运行 execution 测试与构建**

Run: `pnpm --filter @forge/execution test && pnpm --filter @forge/execution build`

Expected: PASS with exhaustive TypeScript checks over every state.

- [ ] **Step 5: 提交状态机**

```bash
git add packages/execution
git commit -m "feat(execution): define durable run state machines"
```

### Task 3: 实现 ExecutionStore 原子状态写入

**Files:**
- Create: `packages/execution/src/store.ts`
- Create: `packages/execution/src/store.test.ts`
- Modify: `packages/execution/src/index.ts`

**Interfaces:**
- Consumes: `ForgeStore.db`、RunSpec。
- Produces: `ExecutionStore.createRun()`、`claimStep()`、`finishAttempt()`、`loadRecoverableRuns()`。

- [ ] **Step 1: 写创建 DAG、并发 claim 和重载测试**

```ts
it("claims one runnable step once", () => {
  const store = executionFixture();
  store.createRun(twoStepRunSpec());
  const first = store.claimNextStep("run-1", "worker-a", clock.now());
  const second = store.claimNextStep("run-1", "worker-b", clock.now());
  expect(first?.stepId).toBe("research");
  expect(second).toBeNull();
});

it("makes dependent step runnable after success", () => {
  const store = executionFixture();
  const attempt = startFirstAttempt(store);
  store.finishAttempt(attempt.id, { state: "succeeded", outputRef: "artifact:a1" });
  expect(store.getStep("run-1", "report")?.state).toBe("runnable");
});
```

- [ ] **Step 2: 运行 Store 测试确认 API 不存在**

Run: `pnpm exec vitest run packages/execution/src/store.test.ts`

Expected: FAIL because `ExecutionStore` is absent.

- [ ] **Step 3: 实现事务化 CRUD 和 compare-and-set claim**

```ts
claimNextStep(runId: string, workerId: string, now: string): ClaimedAttempt | null {
  return this.db.transaction(() => {
    const step = this.selectRunnable(runId);
    if (!step) return null;
    const changed = this.markRunningIfRunnable(step, workerId, now);
    return changed === 1 ? this.insertAttempt(step, workerId, now) : null;
  })();
}
```

Persist the complete immutable RunSpec JSON and normalized step/dependency rows; validate graph cycles before insert.

- [ ] **Step 4: 运行 ExecutionStore 测试**

Run: `pnpm exec vitest run packages/execution/src/store.test.ts`

Expected: PASS for DAG, claim, terminal, reload and cycle rejection.

- [ ] **Step 5: 提交 ExecutionStore**

```bash
git add packages/execution/src/store.ts packages/execution/src/store.test.ts packages/execution/src/index.ts
git commit -m "feat(execution): persist runs steps and attempts"
```

### Task 4: 实现 EventStore、Outbox 和 Cursor

**Files:**
- Create: `packages/event-store/package.json`
- Create: `packages/event-store/tsconfig.json`
- Create: `packages/event-store/src/types.ts`
- Create: `packages/event-store/src/store.ts`
- Create: `packages/event-store/src/store.test.ts`
- Create: `packages/event-store/src/index.ts`

**Interfaces:**
- Consumes: `ForgeStore.db`。
- Produces: `EventStore.appendInTransaction()`、`readAfter()`、`ackCursor()`、`claimOutbox()`。

- [ ] **Step 1: 写 sequence、过滤、cursor 和 outbox 测试**

```ts
it("reads events after an exclusive cursor in sequence order", () => {
  const events = eventFixture();
  events.append(event("run.created", "r1"));
  const second = events.append(event("step.started", "r1"));
  expect(events.readAfter({ sequence: 0, filter: { runId: "r1" }, limit: 10 }))
    .toHaveLength(2);
  expect(events.readAfter({ sequence: second.sequence, filter: {}, limit: 10 }))
    .toEqual([]);
});

it("deduplicates eventId", () => {
  const events = eventFixture();
  events.append(event("run.created", "r1", "event-fixed"));
  expect(() => events.append(event("run.created", "r1", "event-fixed")))
    .toThrow("duplicate eventId");
});
```

- [ ] **Step 2: 运行测试确认 package 不存在**

Run: `pnpm --filter @forge/event-store test`

Expected: FAIL because `@forge/event-store` is absent.

- [ ] **Step 3: 实现 append-only store 与 consumer cursor**

```ts
export class EventStore {
  append(event: NewEvent): EventEnvelope;
  readAfter(input: { sequence: number; filter: SubscriptionFilter; limit: number }): EventEnvelope[];
  ackCursor(consumerId: string, sequence: number): void;
  getCursor(consumerId: string): number;
}
```

`appendInTransaction(db, event)` inserts `core_events` and `core_outbox` using the caller transaction. Cursor updates must be monotonic (`max(existing, incoming)`).

- [ ] **Step 4: 运行 EventStore 测试和构建**

Run: `pnpm --filter @forge/event-store test && pnpm --filter @forge/event-store build`

Expected: PASS; filter coverage includes runId、subject、event type prefix.

- [ ] **Step 5: 提交 EventStore**

```bash
git add packages/event-store
git commit -m "feat(events): add durable event store and cursors"
```

### Task 5: 把 ExecutionStore 状态和事件放入同一事务

**Files:**
- Modify: `packages/execution/src/store.ts`
- Modify: `packages/execution/src/store.test.ts`
- Modify: `packages/execution/package.json`

**Interfaces:**
- Consumes: `EventStore.appendInTransaction()`。
- Produces: 每个 state transition 对应一个可靠 `EventEnvelope`。

- [ ] **Step 1: 写 rollback 和事件关联失败测试**

```ts
it("rolls back run state when event append fails", () => {
  const fixture = executionFixture({ failEventAppend: true });
  expect(() => fixture.store.createRun(singleStepRunSpec())).toThrow("event append failed");
  expect(fixture.store.getRun("run-1")).toBeNull();
});

it("writes correlation, run, step and attempt ids", () => {
  const fixture = executionFixture();
  fixture.store.createRun(singleStepRunSpec());
  expect(fixture.events.readAfter({ sequence: 0, filter: {}, limit: 10 })[0])
    .toMatchObject({ type: "run.created", runId: "run-1", correlationId: "corr-1" });
});
```

- [ ] **Step 2: 运行测试确认状态与事件尚未原子绑定**

Run: `pnpm exec vitest run packages/execution/src/store.test.ts`

Expected: FAIL on rollback or missing event fields.

- [ ] **Step 3: 在每个写事务中追加领域事件**

```ts
this.db.transaction(() => {
  this.insertRun(spec);
  this.eventStore.appendInTransaction(this.db, {
    eventId: randomUUID(), type: "run.created", runId: spec.id,
    correlationId: spec.correlationId, subject: spec.actingSubject, data: {},
  });
})();
```

Define stable event names for run/step/attempt created, started, waiting, resumed, succeeded, failed and cancelled.

- [ ] **Step 4: 运行 execution 和 event-store 测试**

Run: `pnpm --filter @forge/execution test && pnpm --filter @forge/event-store test`

Expected: PASS; every state-changing test also asserts its event.

- [ ] **Step 5: 提交原子状态事件**

```bash
git add packages/execution
git commit -m "feat(execution): emit state events transactionally"
```

### Task 6: 实现 DurableExecutor 调度、重试、等待和恢复

**Files:**
- Create: `packages/execution/src/executor.ts`
- Create: `packages/execution/src/executor.test.ts`
- Create: `packages/execution/src/recovery.ts`
- Create: `packages/execution/src/recovery.test.ts`
- Modify: `packages/execution/src/index.ts`

**Interfaces:**
- Consumes: `ExecutionStore`、`StepExecutorRegistry`、Clock。
- Produces: `DurableExecutor.tick()`、`resumeWait()`、`cancelRun()`、`recoverOnStartup()`。

- [ ] **Step 1: 写重试、等待、取消和进程重启测试**

```ts
it("retries a retryable failure with capped backoff", async () => {
  const fx = executorFixture({ outcomes: [retryable("network"), succeeded("a1")] });
  await fx.executor.tick();
  fx.clock.advanceBy(1000);
  await fx.executor.tick();
  expect(fx.store.getRun("run-1")?.state).toBe("succeeded");
  expect(fx.store.listAttempts("run-1", "step-1")).toHaveLength(2);
});

it("marks interrupted non-idempotent attempts for review", () => {
  const fx = interruptedFixture({ idempotencyKey: undefined });
  fx.recovery.recoverOnStartup();
  expect(fx.store.getStep("run-1", "publish")?.state).toBe("waiting");
});
```

- [ ] **Step 2: 运行 executor/recovery 测试确认实现缺失**

Run: `pnpm exec vitest run packages/execution/src/executor.test.ts packages/execution/src/recovery.test.ts`

Expected: FAIL because executor/recovery modules are absent.

- [ ] **Step 3: 实现单 tick 调度和确定性恢复**

```ts
export interface StepExecutor {
  kind: string;
  execute(input: StepExecutionInput, signal: AbortSignal): Promise<StepOutcome>;
  reconcile?(input: StepExecutionInput): Promise<StepOutcome | "unknown">;
}

export class DurableExecutor {
  async tick(limit = 10): Promise<number>;
  resumeWait(waitId: string, payload: unknown): void;
  cancelRun(runId: string, reason: string): void;
}
```

On startup: reconcile idempotent/external attempts when supported; retry safe internal attempts; put unknown non-idempotent attempts into a manual-review wait.

- [ ] **Step 4: 运行 execution 全测**

Run: `pnpm --filter @forge/execution test`

Expected: PASS for retry caps、timeout、cancel propagation、wait/resume and restart recovery.

- [ ] **Step 5: 提交 DurableExecutor**

```bash
git add packages/execution/src
git commit -m "feat(execution): add durable scheduler and recovery"
```

### Task 7: 将现有 Forge Runtime 适配为 StepExecutor

**Files:**
- Create: `packages/execution/src/legacy-run-adapter.ts`
- Create: `packages/execution/src/legacy-run-adapter.test.ts`
- Modify: `apps/daemon/src/services/run-service.ts`
- Modify: `packages/protocol/src/v2/rpc.ts`

**Interfaces:**
- Consumes: 旧 `RunRequest`、`ForgeRuntime`、SessionStore。
- Produces: `runRequestToRunSpec()` 和 `LegacyForgeStepExecutor`。

- [ ] **Step 1: 写请求映射和最终文本产物测试**

```ts
it("maps cwd + message to one forge.agent step", () => {
  expect(runRequestToRunSpec({ cwd: "/repo", message: "fix it" }, ids.fixed()))
    .toMatchObject({
      objective: "fix it",
      steps: [{ kind: "forge.agent", input: { cwd: "/repo", message: "fix it" } }],
    });
});

it("stores finalText as an output artifact reference", async () => {
  const outcome = await adapter.execute(stepInput(), new AbortController().signal);
  expect(outcome).toMatchObject({ state: "succeeded", outputRef: expect.stringMatching(/^artifact:/) });
});
```

- [ ] **Step 2: 运行适配测试确认模块缺失**

Run: `pnpm exec vitest run packages/execution/src/legacy-run-adapter.test.ts`

Expected: FAIL because adapter does not exist.

- [ ] **Step 3: 实现兼容映射并桥接旧 AgentEvent 到 v2 Event**

```ts
export function runRequestToRunSpec(request: RunRequest, ids: IdFactory): RunSpec {
  const runId = ids.runId();
  return {
    id: runId, objective: request.message,
    requestedBy: { kind: "human", id: "local-user" },
    actingSubject: { kind: "agent_profile", id: "forge-default" },
    correlationId: ids.correlationId(), policyContext: { compatibility: true },
    steps: [compatibilityStep(runId, request)],
  };
}
```

The adapter keeps Session ID and old AgentEvent payloads for current UI, while also emitting v2 trace/event links.

- [ ] **Step 4: 运行 run-service、execution 和 daemon 回归**

Run: `pnpm exec vitest run packages/execution/src/legacy-run-adapter.test.ts apps/daemon/src/runtime.test.ts && pnpm --filter @forge/daemon test`

Expected: PASS; current `RunResult { sessionId, finalText }` remains available through compat RPC.

- [ ] **Step 5: 提交 Runtime Adapter**

```bash
git add packages/execution/src/legacy-run-adapter.ts packages/execution/src/legacy-run-adapter.test.ts apps/daemon/src/services/run-service.ts packages/protocol/src/v2/rpc.ts
git commit -m "feat(execution): adapt forge runtime to durable runs"
```

### Task 8: 注册 v2 execution 和 event RPC modules

**Files:**
- Create: `apps/daemon/src/modules/execution-module.ts`
- Create: `apps/daemon/src/modules/execution-module.test.ts`
- Create: `apps/daemon/src/modules/event-module.ts`
- Create: `apps/daemon/src/modules/event-module.test.ts`
- Modify: `apps/daemon/src/modules/index.ts`
- Modify: `packages/protocol/src/v2/rpc.ts`

**Interfaces:**
- Consumes: `DurableExecutor`、`ExecutionStore`、`EventStore`。
- Produces: `run.create|get|cancel|resume` 和 `events.read|cursor.ack` RPC。

- [ ] **Step 1: 写 RPC 结果和授权上下文失败测试**

```ts
it("creates a run and returns its durable id", async () => {
  const result = await router.handle("run.create", validRunSpec(), rpcContext());
  expect(result).toEqual({ runId: "run-1", state: "queued" });
});

it("reads events strictly after cursor", async () => {
  const result = await router.handle("events.read", { cursor: 5, limit: 50, filter: { runId: "r1" } }, rpcContext());
  expect(result.events.every((event) => event.sequence > 5)).toBe(true);
});
```

- [ ] **Step 2: 运行模块测试确认方法尚未注册**

Run: `pnpm exec vitest run apps/daemon/src/modules/execution-module.test.ts apps/daemon/src/modules/event-module.test.ts`

Expected: FAIL with `METHOD_NOT_FOUND`.

- [ ] **Step 3: 实现模块注册和 DTO 映射**

```ts
router.register("run.create", async (spec, ctx) => {
  ctx.executionStore.createRun(spec);
  ctx.executor.wake();
  return { runId: spec.id, state: "queued" };
});
router.register("events.read", async (input) => ({
  events: ctx.eventStore.readAfter({ sequence: input.cursor, filter: input.filter, limit: Math.min(input.limit, 500) }),
}));
```

Validate all params at the module boundary and return `INVALID_REQUEST` rather than unsafe casts.

- [ ] **Step 4: 运行 module、protocol、daemon 测试**

Run: `pnpm --filter @forge/protocol test && pnpm --filter @forge/daemon test`

Expected: PASS; `system.capabilities` lists execution/events methods and versions.

- [ ] **Step 5: 提交 v2 RPC modules**

```bash
git add apps/daemon/src/modules packages/protocol/src/v2/rpc.ts
git commit -m "feat(daemon): expose durable run and event rpc"
```

### Task 9: 实现断线重连订阅、Cursor 补发和客户端去重

**Files:**
- Create: `packages/daemon-client/src/subscription.ts`
- Create: `packages/daemon-client/src/subscription.test.ts`
- Modify: `packages/daemon-client/src/index.ts`
- Modify: `packages/bus/src/index.ts`

**Interfaces:**
- Consumes: `events.read`、`EventEnvelope.sequence/eventId`。
- Produces: `client.subscribe(filter, handler, options): EventSubscription`。

- [ ] **Step 1: 写断线、补发和重复 eventId 测试**

```ts
it("replays after the last acknowledged cursor", async () => {
  const fx = reconnectingClientFixture([event(1), event(2)], [event(2), event(3)]);
  const seen: number[] = [];
  const sub = fx.client.subscribe({ runId: "r1" }, (event) => seen.push(event.sequence));
  await fx.disconnectAndReconnect();
  await sub.settledAfter(3);
  expect(seen).toEqual([1, 2, 3]);
});
```

- [ ] **Step 2: 运行订阅测试确认 API 不存在**

Run: `pnpm exec vitest run packages/daemon-client/src/subscription.test.ts`

Expected: FAIL because `subscribe` is absent.

- [ ] **Step 3: 实现 snapshot-then-live 订阅协议**

```ts
export interface EventSubscription {
  readonly id: string;
  readonly cursor: number;
  close(): Promise<void>;
}
```

On reconnect, call `events.read` after the last cursor, emit unseen eventIds in sequence, then resume live notifications. Acknowledge only after the handler resolves.

- [ ] **Step 4: 运行 client、bus 和 event tests**

Run: `pnpm --filter @forge/daemon-client test && pnpm --filter @forge/bus test && pnpm --filter @forge/event-store test`

Expected: PASS; malformed frames produce diagnostics but do not corrupt pending state.

- [ ] **Step 5: 提交 resilient subscriptions**

```bash
git add packages/daemon-client packages/bus
git commit -m "feat(events): add resumable client subscriptions"
```

### Task 10: 加入 Trace、重启恢复 E2E 和阶段门禁

**Files:**
- Create: `packages/execution/src/trace.ts`
- Create: `packages/execution/src/trace.test.ts`
- Create: `apps/daemon/src/durable-restart.e2e.test.ts`
- Modify: `scripts/eval.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: Run/Step/Attempt events。
- Produces: `TraceContext`、重启恢复夹具、失败轨迹评测输入。

- [ ] **Step 1: 写 Trace 父子关联和真实重启测试**

```ts
it("links run, step and attempt spans", () => {
  const trace = buildTrace(runEventsFixture());
  expect(trace.root.runId).toBe("run-1");
  expect(trace.steps[0]?.parentSpanId).toBe(trace.root.spanId);
  expect(trace.steps[0]?.attempts[0]?.parentSpanId).toBe(trace.steps[0]?.spanId);
});

it("resumes a waiting run after daemon restart", async () => {
  const fx = await daemonRestartFixture();
  const runId = await fx.createWaitingRun();
  await fx.restart();
  await fx.resume(runId, { approved: true });
  expect(await fx.waitForState(runId, "succeeded")).toBe("succeeded");
});
```

- [ ] **Step 2: 运行 Trace 和 E2E，确认缺少关联/恢复实现**

Run: `pnpm exec vitest run packages/execution/src/trace.test.ts apps/daemon/src/durable-restart.e2e.test.ts`

Expected: FAIL before trace builder and restart harness are complete.

- [ ] **Step 3: 实现 Trace 摘要和 eval fixture export**

Trace stores model/tool/version/cost summaries and references large raw output by ArtifactRef. Add an eval case that kills the fixture Daemon between attempts and asserts recovery without duplicate side effect.

- [ ] **Step 4: 运行阶段全门禁**

Run:

```bash
pnpm --filter @forge/store test
pnpm --filter @forge/event-store test
pnpm --filter @forge/execution test
pnpm --filter @forge/run-orchestrator test
pnpm --filter @forge/daemon-client test
pnpm --filter @forge/daemon test
pnpm --filter @forge/daemon build
```

Expected: all PASS; restart E2E produces one external-effect record.

- [ ] **Step 5: 提交 durable execution 阶段门**

```bash
git add packages/execution/src/trace.ts packages/execution/src/trace.test.ts apps/daemon/src/durable-restart.e2e.test.ts scripts/eval.mjs README.md
git commit -m "test(execution): gate durable recovery and trace"
```

### Task 11: 建立正式 Eval Runner、版本比较和失败转回归

**Files:**
- Create: `packages/evals/package.json`
- Create: `packages/evals/tsconfig.json`
- Create: `packages/evals/src/types.ts`
- Create: `packages/evals/src/runner.ts`
- Create: `packages/evals/src/runner.test.ts`
- Create: `packages/evals/src/comparison.ts`
- Create: `packages/evals/src/comparison.test.ts`
- Create: `packages/evals/src/regression-case.ts`
- Create: `packages/evals/src/regression-case.test.ts`
- Create: `packages/evals/src/index.ts`
- Modify: `scripts/eval.mjs`

**Interfaces:**
- Consumes: RunSpec、Workspace fixture、Validator、Trace 和 budget limits。
- Produces: `EvalRunner.runSuite()`、`compareEvalRuns()`、`createRegressionCandidate()`。

- [ ] **Step 1: 写重复运行、成功率/不稳定性和脱敏回归 tests**

```ts
it("reports success rate and instability across repeated cases", async () => {
  const result = await runner.runSuite(suiteFixture({ repeats: 3, outcomes: [true, false, true] }));
  expect(result.metrics.successRate).toBeCloseTo(2 / 3);
  expect(result.metrics.unstableCaseIds).toEqual(["case-1"]);
});

it("redacts a failed trace before creating a regression candidate", () => {
  const candidate = createRegressionCandidate(sensitiveFailedTrace());
  expect(JSON.stringify(candidate)).not.toContain("secret-token");
  expect(candidate.validators.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 运行 eval tests 确认 package 不存在**

Run: `pnpm --filter @forge/evals test`

Expected: FAIL because `@forge/evals` is absent.

- [ ] **Step 3: 实现 suite/case/run/result 和成对比较**

```ts
export interface EvalCase {
  id: string; workspaceFixtureRef: string; runSpec: RunSpec;
  allowedTools: string[]; validatorIds: string[];
  budget: { maxCostMinor: bigint; maxDurationMs: number };
  tags: string[];
}

export interface EvalRunMetrics {
  successRate: number; toolCorrectnessRate: number; policyComplianceRate: number;
  p50DurationMs: number; p95DurationMs: number; totalCostMinor: bigint;
  unstableCaseIds: string[];
}
```

Comparison pins model, Prompt, Skill, Profile and harness versions and reports paired deltas; critical deterministic cases can act as CI gates while experimental cases remain non-blocking.

- [ ] **Step 4: 运行 eval/execution/evidence tests**

Run: `pnpm --filter @forge/evals test && pnpm --filter @forge/execution test && pnpm eval`

Expected: PASS for repeated cases, reset isolation, budget stop, paired comparison and redaction.

- [ ] **Step 5: 提交 Eval Center core**

```bash
git add packages/evals scripts/eval.mjs
git commit -m "feat(evals): add versioned agent evaluation runner"
```
