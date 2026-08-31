# Forge Core v2 Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Core v2 的可恢复基线、类型化 RPC、可靠迁移和模块化 Daemon Host，同时保持现有运行行为可回归。

**Architecture:** 保留 `@forge/protocol` 作为仓库唯一公开契约包，在其下新增 v2 contract map；`@forge/daemon-client` 和 `@forge/bus` 变为泛型客户端与路由器。新增 `@forge/store` 统一 SQLite 打开、迁移日志、WAL、备份和 Owner 规则，Daemon 通过模块注册替代 `main.ts` 的业务 if-chain。

**Tech Stack:** Node.js >=22、TypeScript 5.8.3、pnpm、Vitest 3.0.9、better-sqlite3 13.0.2、SQLite WAL、Unix Domain Socket/Named Pipe JSON-RPC。

**Spec:** `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

## Global Constraints

- 不建立长期 v1/v2 双服务；兼容 Adapter 只服务内部迁移并有删除任务。
- 现有 `data.db`、Session、Event、Checkpoint、Talent、Automation 和 Channel 数据默认保留。
- Daemon 是迁移 Owner；其他进程不得竞争应用 Schema migration。
- 每个迁移有 checksum、事务、重复启动和旧数据夹具测试。
- 每个任务 TDD、定向测试、受影响包测试、独立提交。
- 不改动当前工作区无关文件。
- 代码片段中的 `*Fixture`、`fake*`、`ids.fixed()` 等名称均是在同一测试文件中创建的确定性测试夹具；写失败测试步骤必须同时实现这些夹具的最小定义。

---

## File Structure Map

### New files

| Path | Responsibility |
|---|---|
| `scripts/core-v2/backup-data.ts` | 安全创建数据目录备份与 manifest |
| `scripts/core-v2/backup-data.test.ts` | 备份、恢复和危险路径拒绝测试 |
| `scripts/core-v2/capture-baseline.ts` | 记录构建、Schema 和能力基线 |
| `packages/protocol/src/v2/rpc.ts` | RpcContractMap、Envelope、错误和能力类型 |
| `packages/protocol/src/v2/rpc.test.ts` | v2 协议运行时守卫测试 |
| `packages/protocol/src/v2/index.ts` | v2 协议统一导出 |
| `packages/store/package.json` | `@forge/store` 包定义 |
| `packages/store/tsconfig.json` | Store TypeScript 配置 |
| `packages/store/src/index.ts` | ForgeStore 公共入口 |
| `packages/store/src/migrations.ts` | migration journal、checksum 和事务执行 |
| `packages/store/src/backup.ts` | 在线安全备份和恢复验证 |
| `packages/store/src/migrations.test.ts` | 新库、旧库、重复、checksum 和失败测试 |
| `apps/daemon/src/host/types.ts` | DaemonModule、DaemonContext 和生命周期接口 |
| `apps/daemon/src/host/router.ts` | TypedRouter 注册与分发 |
| `apps/daemon/src/host/daemon-host.ts` | 模块启动、健康检查、停止和 RPC 接入 |
| `apps/daemon/src/host/router.test.ts` | 重复路由、类型化错误和未知方法测试 |
| `apps/daemon/src/modules/system-module.ts` | ping、status、capabilities |
| `apps/daemon/src/modules/session-module.ts` | session/project 查询命令 |
| `apps/daemon/src/modules/runtime-module.ts` | runtime/run/plan/review/compact 命令 |
| `apps/daemon/src/modules/assets-module.ts` | skill/plugin/hub/talent 命令 |
| `apps/daemon/src/modules/automation-module.ts` | automation 命令与 scheduler lifecycle |
| `apps/daemon/src/modules/channel-module.ts` | channel/mobile 命令与 gateway lifecycle |

### Modified files

| Path | Change |
|---|---|
| `package.json` | Core v2 基线与恢复脚本 |
| `packages/protocol/package.json` | Vitest test script |
| `packages/protocol/src/index.ts` | 导出 v2 contracts；旧导出迁入 compat 区 |
| `packages/daemon-client/src/index.ts` | 泛型 request、timeout、cancel、结构化错误 |
| `packages/bus/src/index.ts` | 使用 TypedRouter 与通用 notification envelope |
| `packages/session/src/index.ts` | 接收共享 ForgeStore，不再自行拥有迁移逻辑 |
| `apps/daemon/src/main.ts` | 只做配置、Context 组装、模块注册和 Host 启停 |
| `apps/channel-gateway/src/gateway.ts` | 禁止成为 migration owner |
| `pnpm-workspace.yaml` | 自动包含新 workspace，无规则变更 |

## Public Interfaces Locked by This Plan

```ts
export interface RpcContractMap {
  "system.capabilities": {
    params: Record<string, never>;
    result: CapabilityManifest;
  };
  "system.ping": {
    params: Record<string, never>;
    result: { ok: true; version: string; build: string };
  };
}

export type RpcMethod = keyof RpcContractMap;
export type RpcParams<M extends RpcMethod> = RpcContractMap[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcContractMap[M]["result"];

export interface SubjectRef { kind: string; id: string }
export type RiskLevel = "low" | "medium" | "high" | "critical";
export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onNotification?: (event: EventEnvelope) => void;
}

export interface EventEnvelope<T = unknown> {
  eventId: string; sequence: number; type: string; subject: SubjectRef;
  correlationId: string; runId?: string; stepId?: string; attemptId?: string;
  occurredAt: string; schemaVersion: number; data: T;
}

export interface DaemonModule {
  id: string;
  register(router: TypedRouter, context: DaemonContext): void;
  start?(context: DaemonContext): Promise<void>;
  stop?(context: DaemonContext): Promise<void>;
}

// Temporary overload retained only until the client-migration plan removes it.
export interface DaemonClient {
  request<M extends RpcMethod>(method: M, params: RpcParams<M>, options?: RequestOptions): Promise<RpcResult<M>>;
  request(method: string, params?: unknown, legacyOnEvent?: (event: AgentEvent) => void): Promise<unknown>;
}

export class ForgeStore {
  static open(options: ForgeStoreOptions): ForgeStore;
  get db(): Database.Database;
  backup(targetPath: string): Promise<BackupManifest>;
  close(): void;
}
```

### Task 1: 建立 Core v2 基线、备份与恢复脚本

**Files:**
- Create: `scripts/core-v2/backup-data.ts`
- Create: `scripts/core-v2/backup-data.test.ts`
- Create: `scripts/core-v2/capture-baseline.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Forge 数据目录路径和备份输出目录。
- Produces: `backupForgeData(input): Promise<BackupManifest>`、`verifyBackup(manifestPath): Promise<void>`。

- [x] **Step 1: 写失败测试，覆盖显式路径、manifest 和恢复校验**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { backupForgeData, verifyBackup } from "./backup-data.js";

it("backs up data.db and records a sha256 manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-backup-"));
  const dataDir = join(root, "data");
  const outputDir = join(root, "out");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "data.db"), "fixture");
  const manifest = await backupForgeData({ dataDir, outputDir });
  expect(manifest.files[0]?.relativePath).toBe("data.db");
  expect(manifest.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(verifyBackup(manifest.manifestPath)).resolves.toBeUndefined();
});

it("rejects filesystem root and home-like broad targets", async () => {
  await expect(backupForgeData({ dataDir: "/", outputDir: "/tmp/x" }))
    .rejects.toThrow("unsafe data directory");
});
```

- [x] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `pnpm core:v2:test`

Expected: FAIL with `Cannot find module './backup-data.js'`.

- [x] **Step 3: 实现安全备份、checksum、manifest 与基线输出**

```ts
export interface BackupManifest {
  createdAt: string;
  sourceDir: string;
  backupDir: string;
  manifestPath: string;
  files: Array<{ relativePath: string; bytes: number; sha256: string }>;
}

export async function backupForgeData(input: {
  dataDir: string;
  outputDir: string;
}): Promise<BackupManifest> {
  assertExplicitSafeDirectory(input.dataDir);
  assertExplicitSafeDirectory(input.outputDir);
  // Copy data.db plus -wal/-shm and JSON assets into a timestamped directory,
  // compute sha256 for every copied file, then atomically write manifest.json.
  return manifest;
}
```

Add scripts:

```json
{
  "core:v2:backup": "tsx scripts/core-v2/backup-data.ts",
  "core:v2:baseline": "tsx scripts/core-v2/capture-baseline.ts"
}
```

- [x] **Step 4: 运行定向测试并在临时数据夹具上完成恢复校验**

Run: `pnpm core:v2:test`

Expected: PASS; manifest checksum mismatch test must fail closed.

- [x] **Step 5: 提交基线工具**

```bash
git add package.json scripts/core-v2/backup-data.ts scripts/core-v2/backup-data.test.ts scripts/core-v2/capture-baseline.ts
git commit -m "chore: add core v2 backup and baseline tools"
```

### Task 2: 定义 RpcContractMap、能力协商和结构化错误

**Files:**
- Create: `packages/protocol/src/v2/rpc.ts`
- Create: `packages/protocol/src/v2/rpc.test.ts`
- Create: `packages/protocol/src/v2/index.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/package.json`

**Interfaces:**
- Consumes: 现有 `JsonRpcId` 和方法常量。
- Produces: `RpcContractMap`、`RpcMethod`、`RpcParams`、`RpcResult`、`RpcFault`、`CapabilityManifest`。

- [x] **Step 1: 写协议守卫失败测试**

```ts
import { expect, it } from "vitest";
import { isRpcRequestEnvelope, rpcFault } from "./rpc.js";

it("accepts a v2 request with protocol and request ids", () => {
  expect(isRpcRequestEnvelope({
    jsonrpc: "2.0", id: "r1", protocolVersion: 2,
    requestId: "req-1", method: "system.ping", params: {},
  })).toBe(true);
});

it("normalizes retryable structured faults", () => {
  expect(rpcFault("CORE_TIMEOUT", "timed out", { retryable: true }))
    .toMatchObject({ code: "CORE_TIMEOUT", retryable: true });
});
```

- [x] **Step 2: 运行测试确认缺少 v2 exports**

Run: `pnpm --filter @forge/protocol test`

Expected: FAIL because `rpc.ts` is absent.

- [x] **Step 3: 实现精确契约类型和运行时守卫**

```ts
export type RpcFaultCode =
  | "INVALID_REQUEST" | "METHOD_NOT_FOUND" | "CORE_TIMEOUT"
  | "CORE_CANCELLED" | "POLICY_DENIED" | "APPROVAL_REQUIRED"
  | "BUDGET_EXCEEDED" | "WORKSPACE_CONFLICT" | "VERSION_CONFLICT"
  | "VALIDATION_FAILED" | "INTERNAL_ERROR";

export interface RpcFault {
  code: RpcFaultCode;
  message: string;
  retryable: boolean;
  correlationId?: string;
  detailsRef?: string;
}

export interface CapabilityManifest {
  protocolVersion: 2;
  serverVersion: string;
  methods: string[];
  eventTypes: string[];
  features: Record<string, { version: number; enabled: boolean }>;
}
```

Move existing method DTOs behind `RpcContractMap` entries without changing their wire shapes in this task.

- [x] **Step 4: 运行协议测试和类型构建**

Run: `pnpm --filter @forge/protocol test && pnpm --filter @forge/protocol build`

Expected: PASS and emitted declarations expose `RpcResult<"system.ping">`.

- [x] **Step 5: 提交协议 v2**

```bash
git add packages/protocol
git commit -m "feat(protocol): add typed rpc v2 contracts"
```

### Task 3: 将 daemon-client 升级为泛型、可超时、可取消客户端

**Files:**
- Modify: `packages/daemon-client/src/index.ts`
- Modify: `packages/daemon-client/src/index.test.ts`
- Modify: `packages/daemon-client/package.json`

**Interfaces:**
- Consumes: `RpcMethod`、`RpcParams<M>`、`RpcResult<M>`、`RpcFault`。
- Produces: `DaemonClient.request<M>()`、`DaemonRpcError`、`RequestOptions`。

- [x] **Step 1: 写类型与行为失败测试**

```ts
it("rejects a timed out request and removes it from pending", async () => {
  const client = await connectFixtureServer({ neverReply: true });
  await expect(client.request("system.ping", {}, { timeoutMs: 10 }))
    .rejects.toMatchObject({ fault: { code: "CORE_TIMEOUT" } });
});

it("sends cancel when AbortSignal fires", async () => {
  const controller = new AbortController();
  const pending = client.request("system.ping", {}, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ fault: { code: "CORE_CANCELLED" } });
});
```

- [x] **Step 2: 运行现有和新增客户端测试确认失败**

Run: `pnpm --filter @forge/daemon-client test`

Expected: FAIL because the third `RequestOptions` argument and `DaemonRpcError` do not exist.

- [x] **Step 3: 实现泛型 request 与安全错误转换**

```ts
export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onNotification?: (event: EventEnvelope) => void;
}

export interface DaemonClient {
  request<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    options?: RequestOptions,
  ): Promise<RpcResult<M>>;
  /** Temporary internal-client bridge; deleted after Workbench/CLI/Mobile/Channel migrate. */
  request(method: string, params?: unknown, legacyOnEvent?: (event: AgentEvent) => void): Promise<unknown>;
  close(): void;
}

export class DaemonRpcError extends Error {
  constructor(readonly fault: RpcFault) { super(fault.message); }
}
```

Ensure abort/timeout deletes pending entries and ignores late responses by requestId.

- [x] **Step 4: 运行客户端与 bus 回归**

Run: `pnpm --filter @forge/daemon-client test && pnpm --filter @forge/bus test`

Expected: PASS; existing connect/close/error cases remain green.

- [x] **Step 5: 提交类型化客户端**

```bash
git add packages/daemon-client
git commit -m "feat(client): add typed cancellable rpc requests"
```

### Task 4: 新增 ForgeStore 和 migration journal

**Files:**
- Create: `packages/store/package.json`
- Create: `packages/store/tsconfig.json`
- Create: `packages/store/src/index.ts`
- Create: `packages/store/src/migrations.ts`
- Create: `packages/store/src/migrations.test.ts`
- Create: `packages/store/src/backup.ts`

**Interfaces:**
- Consumes: `dbPath`、`migrationsDir`、`owner`。
- Produces: `ForgeStore.open()`、`MigrationRunner.applyPending()`、`BackupManifest`。

- [x] **Step 1: 写新库、旧库和 checksum 失败测试**

```ts
it("records every applied migration exactly once", () => {
  const fixture = migrationFixture(["001_init.sql", "002_next.sql"]);
  const store = ForgeStore.open(fixture.options);
  expect(store.db.prepare("select version from schema_migrations order by version").all())
    .toEqual([{ version: "001_init.sql" }, { version: "002_next.sql" }]);
  store.close();
  ForgeStore.open(fixture.options).close();
  expect(fixture.effectCount()).toBe(1);
});

it("fails closed when an applied migration checksum changes", () => {
  const fixture = appliedMigrationFixture();
  fixture.replaceSql("001_init.sql", "select 2;");
  expect(() => ForgeStore.open(fixture.options)).toThrow("checksum mismatch");
});
```

- [x] **Step 2: 运行测试确认实现尚不存在**

Run: `pnpm --filter @forge/store test`

Expected: FAIL because `ForgeStore` implementation is absent.

- [x] **Step 3: 实现 Store、migration bootstrap 和事务执行**

```ts
export interface ForgeStoreOptions {
  dbPath: string;
  migrationsDir: string;
  owner: "daemon" | "test";
  busyTimeoutMs?: number;
}

export class ForgeStore {
  static open(options: ForgeStoreOptions): ForgeStore {
    const db = new Database(options.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    new MigrationRunner(db, options).applyPending();
    return new ForgeStore(db);
  }
}
```

`MigrationRunner` must bootstrap `schema_migrations(version, checksum, applied_at, duration_ms)` before reading SQL files and must wrap each migration plus journal insert in one transaction.

- [x] **Step 4: 运行 Store 测试和构建**

Run: `pnpm --filter @forge/store test && pnpm --filter @forge/store build`

Expected: PASS for fresh, adopted legacy, duplicate, checksum and rollback fixtures.

- [x] **Step 5: 提交 Reliable Store**

```bash
git add packages/store
git commit -m "feat(store): add journaled sqlite migrations"
```

### Task 5: 让 SessionStore 使用共享 ForgeStore

**Files:**
- Modify: `packages/store/src/index.ts`
- Modify: `packages/store/src/migrations.test.ts`
- Modify: `packages/session/package.json`
- Modify: `packages/session/src/index.ts`
- Modify: `packages/session/src/index.test.ts`
- Modify: `packages/session-manager/package.json`
- Modify: `packages/session-manager/src/index.ts`
- Modify: `packages/session-manager/src/index.test.ts`
- Modify: `apps/daemon/package.json`
- Modify: `apps/daemon/src/main.ts`
- Modify: `apps/channel-gateway/package.json`
- Modify: `apps/channel-gateway/src/gateway.ts`
- Modify: `apps/channel-gateway/src/gateway.test.ts`
- Modify: `apps/cli/src/repl.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `ForgeStore.db`。
- Produces: `new SessionStore(db)`；移除 SessionStore 内部 migration ownership。

- [x] **Step 1: 写共享连接与非 Owner 失败测试**

```ts
it("uses the supplied database without applying migrations", () => {
  const store = ForgeStore.open(fixtureOptions());
  const sessions = new SessionStore(store.db);
  const id = sessions.createSession("/tmp/work");
  expect(sessions.getSessionCwd(id)).toBe("/tmp/work");
});

it("rejects migration ownership outside daemon or tests", () => {
  expect(() => ForgeStore.open({ ...fixtureOptions(), owner: "channel" as never }))
    .toThrow("migration owner");
});
```

- [x] **Step 2: 运行 Session 和 Gateway 测试确认构造签名不匹配**

Run: `pnpm --filter @forge/session test && pnpm --filter @forge/channel-gateway test`

Expected: FAIL until callers provide the shared database.

- [x] **Step 3: 修改 SessionStore 构造器和进程所有权**

```ts
export class SessionStore {
  constructor(private readonly db: Database.Database) {}
  getDb(): Database.Database { return this.db; }
}
```

Daemon opens `ForgeStore` once and injects its `db`; Channel Gateway temporarily opens SQLite without migration privileges through a read/write non-migrating connection factory, which is deleted in the client migration plan.

- [x] **Step 4: 运行 Session、Daemon、Gateway 回归**

Run: `pnpm --filter @forge/session test && pnpm --filter @forge/daemon test && pnpm --filter @forge/channel-gateway test`

Expected: PASS; existing Session CRUD and channel behavior unchanged.

- [x] **Step 5: 提交统一 Store ownership**

```bash
git add packages/session apps/daemon/src/main.ts apps/channel-gateway/src/gateway.ts
git commit -m "refactor(store): make daemon own database migrations"
```

### Task 6: 实现 TypedRouter 和通用 RpcFault 映射

**Files:**
- Create: `apps/daemon/src/host/router.ts`
- Create: `apps/daemon/src/host/router.test.ts`
- Create: `apps/daemon/src/host/types.ts`
- Modify: `packages/bus/src/index.ts`
- Modify: `packages/bus/src/index.test.ts`

**Interfaces:**
- Consumes: `RpcContractMap`、`RpcFault`。
- Produces: `TypedRouter.register<M>()`、`TypedRouter.handle()`、`DaemonModule`。

- [x] **Step 1: 写重复注册、未知方法和错误映射测试**

```ts
it("rejects duplicate method registration", () => {
  const router = new TypedRouter();
  router.register("system.ping", async () => ({ ok: true, version: "2", build: "x" }));
  expect(() => router.register("system.ping", async () => ({ ok: true, version: "2", build: "y" })))
    .toThrow("already registered");
});

it("returns METHOD_NOT_FOUND without leaking a stack", async () => {
  await expect(router.handle("missing" as never, {}, requestContext()))
    .rejects.toMatchObject({ fault: { code: "METHOD_NOT_FOUND" } });
});
```

- [x] **Step 2: 运行 Daemon Host 测试确认文件不存在**

Run: `pnpm --filter @forge/daemon test -- src/host/router.test.ts`

Expected: FAIL because `TypedRouter` is absent.

- [x] **Step 3: 实现类型化注册和 bus 结构化响应**

```ts
export class TypedRouter {
  register<M extends RpcMethod>(
    method: M,
    handler: (params: RpcParams<M>, ctx: RpcContext) => Promise<RpcResult<M>>,
  ): void;

  handle<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    ctx: RpcContext,
  ): Promise<RpcResult<M>>;
}
```

`DaemonServer` must serialize `RpcFault` in `error.data.fault`, keep requestId/correlationId, and never return `String(error)` for unknown exceptions.

- [x] **Step 4: 运行 router、bus 和 client 契约测试**

Run: `pnpm --filter @forge/daemon test -- src/host/router.test.ts && pnpm --filter @forge/bus test && pnpm --filter @forge/daemon-client test`

Expected: PASS with the same fault shape at server and client.

- [x] **Step 5: 提交类型化路由**

```bash
git add apps/daemon/src/host packages/bus
git commit -m "feat(daemon): add typed modular rpc router"
```

### Task 7: 实现 DaemonHost 生命周期和健康状态

**Files:**
- Modify: `packages/protocol/src/v2/rpc.ts`
- Modify: `packages/protocol/src/v2/rpc.test.ts`
- Modify: `packages/bus/src/index.ts`
- Modify: `packages/bus/src/index.test.ts`
- Create: `apps/daemon/src/host/daemon-host.ts`
- Create: `apps/daemon/src/host/daemon-host.test.ts`
- Modify: `apps/daemon/src/host/types.ts`
- Create: `apps/daemon/src/modules/system-module.ts`
- Modify: `apps/daemon/src/services/status-service.ts`

**Interfaces:**
- Consumes: `DaemonModule[]`、`DaemonContext`、`TypedRouter`、`DaemonServer`。
- Produces: `DaemonHost.start()`、`DaemonHost.stop()`、`CapabilityManifest`。

- [x] **Step 1: 写启动顺序、失败回滚和逆序停止测试**

```ts
it("starts modules in registration order and stops in reverse", async () => {
  const calls: string[] = [];
  const host = createHost([
    lifecycleModule("store", calls), lifecycleModule("runtime", calls),
  ]);
  await host.start();
  await host.stop();
  expect(calls).toEqual(["start:store", "start:runtime", "stop:runtime", "stop:store"]);
});
```

- [x] **Step 2: 运行 Host 测试确认实现不存在**

Run: `pnpm --filter @forge/daemon test -- src/host/daemon-host.test.ts`

Expected: FAIL because `DaemonHost` is absent.

- [x] **Step 3: 实现生命周期、能力聚合和健康检查**

```ts
export class DaemonHost {
  constructor(private readonly modules: DaemonModule[], private readonly context: DaemonContext) {}
  async start(): Promise<void> { /* register, start, then listen */ }
  async stop(): Promise<void> { /* stop listener, reverse-stop modules, close store */ }
  capabilities(): CapabilityManifest { /* methods + module features */ }
}
```

System module registers `system.ping`、`system.capabilities`、`system.status`; status reports migration version and module health without sensitive paths.

- [x] **Step 4: 运行 Host 与 status 测试**

Run: `pnpm --filter @forge/daemon test -- src/host/daemon-host.test.ts src/runtime.test.ts`

Expected: PASS; module start failure closes already-started modules.

- [x] **Step 5: 提交 DaemonHost**

```bash
git add apps/daemon/src/host apps/daemon/src/modules/system-module.ts apps/daemon/src/services/status-service.ts
git commit -m "feat(daemon): add modular host lifecycle"
```

### Task 8: 将现有 RPC 分域注册到 Daemon modules

**Files:**
- Create: `apps/daemon/src/modules/session-module.ts`
- Create: `apps/daemon/src/modules/runtime-module.ts`
- Create: `apps/daemon/src/modules/assets-module.ts`
- Create: `apps/daemon/src/modules/automation-module.ts`
- Create: `apps/daemon/src/modules/channel-module.ts`
- Create: `apps/daemon/src/modules/modules.test.ts`
- Modify: `apps/daemon/src/main.ts`

**Interfaces:**
- Consumes: 现有 `handle*` service functions 和 `TypedRouter`。
- Produces: `createDaemonModules(context): DaemonModule[]`；`main.ts` 不再路由业务方法。

- [ ] **Step 1: 写方法覆盖与 main 边界失败测试**

```ts
it("registers every declared non-company method exactly once", () => {
  const router = new TypedRouter();
  for (const module of createDaemonModules(testContext())) module.register(router, testContext());
  expect(new Set(router.methods())).toEqual(new Set(coreV2MethodNames()));
});

it("keeps main as composition root", () => {
  const source = readFileSync(join(repoRoot, "apps/daemon/src/main.ts"), "utf8");
  expect(source).not.toContain("if (method ===");
});
```

- [ ] **Step 2: 运行模块测试确认 main 仍包含路由链**

Run: `pnpm exec vitest run apps/daemon/src/modules/modules.test.ts`

Expected: FAIL on the `if (method ===` assertion.

- [ ] **Step 3: 迁移方法注册但保持 handler 语义**

```ts
export const runtimeModule: DaemonModule = {
  id: "runtime",
  register(router, context) {
    router.register(DAEMON_METHODS.RUN, (params, rpc) =>
      handleRun(params, rpc.emitLegacyAgentEvent, context.runDeps));
    router.register(DAEMON_METHODS.CANCEL_RUN, (params) =>
      context.cancelService.cancel(params.sessionId));
  },
};
```

Compatibility method names remain internal and are removed in the client migration plan. `main.ts` only loads config, opens `ForgeStore`, builds context/modules, starts host, writes PID and registers process signals.

- [ ] **Step 4: 运行 Daemon 全测、构建与 ping 冒烟**

Run: `pnpm --filter @forge/daemon test && pnpm --filter @forge/daemon build && pnpm test:ping`

Expected: PASS; existing functional handlers behave unchanged.

- [ ] **Step 5: 提交模块化 Daemon**

```bash
git add apps/daemon/src/main.ts apps/daemon/src/modules
git commit -m "refactor(daemon): register services as modules"
```

### Task 9: 建立旧数据库升级、恢复和 Foundation 总门禁

**Files:**
- Create: `packages/store/src/legacy-upgrade.test.ts`
- Create: `apps/daemon/test-fixtures/core-v1-data.ts`
- Modify: `scripts/core-v2/capture-baseline.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: v1 fixture、ForgeStore、DaemonHost。
- Produces: 可重复的 v1→v2 foundation 升级报告。

- [ ] **Step 1: 写旧数据升级和恢复失败测试**

```ts
it("adopts migrations 001-008 and preserves legacy rows", async () => {
  const fixture = await createCoreV1Fixture();
  const store = ForgeStore.open(fixture.options);
  expect(store.db.prepare("select content from messages where id = 1").pluck().get())
    .toBe(fixture.messageContent);
  expect(appliedVersions(store.db)).toEqual(expect.arrayContaining(["001_init.sql", "008_mobile_devices.sql"]));
});

it("restores the backup and opens it again", async () => {
  const restored = await restoreFixtureBackup();
  expect(() => ForgeStore.open(restored.options)).not.toThrow();
});
```

- [ ] **Step 2: 运行升级测试确认 legacy adoption 尚未覆盖完整夹具**

Run: `pnpm exec vitest run packages/store/src/legacy-upgrade.test.ts`

Expected: FAIL until fixture adoption and restore verification are complete.

- [ ] **Step 3: 补齐夹具、报告和 README 恢复命令**

Document exact commands using explicit `--data-dir` and `--output-dir`; never show `$HOME`, `~` or a broad recursive target as a destructive command.

- [ ] **Step 4: 运行 Foundation 全门禁**

Run:

```bash
pnpm --filter @forge/protocol test
pnpm --filter @forge/store test
pnpm --filter @forge/session test
pnpm --filter @forge/daemon-client test
pnpm --filter @forge/bus test
pnpm --filter @forge/daemon test
pnpm --filter @forge/channel-gateway test
pnpm --filter @forge/daemon build
```

Expected: all PASS; `git diff --check` returns no errors.

- [ ] **Step 5: 提交 Foundation 门禁**

```bash
git add packages/store/src/legacy-upgrade.test.ts apps/daemon/test-fixtures/core-v1-data.ts scripts/core-v2/capture-baseline.ts README.md
git commit -m "test(core): gate core v2 foundation migration"
```
