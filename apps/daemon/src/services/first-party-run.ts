import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  isTerminalRunState,
  runRequestToRunSpec,
  type DurableExecutor,
  type ExecutionClock,
  type ExecutionStore,
} from "@forge/execution";
import { rpcFault, type AgentEvent, type RunRequest, type RunResult } from "@forge/protocol";
import type { SessionStore } from "@forge/session";
import type { Database } from "@forge/store";
import { RpcFaultError } from "../host/router.js";
import type { CancelService } from "./cancel-service.js";
import { readLegacyRunResult } from "./legacy-run-results.js";

export const FIRST_PARTY_RUN_ORIGIN = "first-party-chat";

export interface FirstPartyRunDeps {
  executionStore: ExecutionStore;
  executor: DurableExecutor;
  clock: ExecutionClock;
  sessions: SessionStore;
  cancelService: CancelService;
  bindEmit: (runId: string, emit: (event: AgentEvent) => void) => () => void;
  db: Database;
}

/**
 * First-party chat entry: keep the product RPC as `run` / `cancel_run`,
 * and open a durable execution run inside the daemon.
 */
export class FirstPartyRunCoordinator {
  private readonly sessionToRun = new Map<string, string>();
  private readonly runToSession = new Map<string, string>();

  constructor(private readonly deps: FirstPartyRunDeps) {}

  async start(
    params: unknown,
    emit: (event: AgentEvent) => void,
  ): Promise<RunResult> {
    const req = params as RunRequest;
    if (!req || typeof req.cwd !== "string" || typeof req.message !== "string") {
      throw new Error("run requires cwd and message");
    }
    const absCwd = resolve(req.cwd || process.cwd());
    const sessionId = req.sessionId ?? this.deps.sessions.createSession(absCwd);
    const request: RunRequest = { ...req, cwd: absCwd, sessionId };
    const spec = runRequestToRunSpec(request, {
      runId: () => randomUUID(),
      correlationId: () => randomUUID(),
    });
    spec.policyContext = {
      ...spec.policyContext,
      origin: FIRST_PARTY_RUN_ORIGIN,
    };
    for (const step of spec.steps) {
      // Chat turns reuse a sessionId; never use that as the durable idempotency key.
      step.idempotencyKey = request.clientRunId ?? spec.id;
    }

    const created = this.deps.executionStore.createRun(
      spec,
      this.deps.clock.now(),
    );
    this.sessionToRun.set(sessionId, created.id);
    this.runToSession.set(created.id, sessionId);
    const unbind = this.deps.bindEmit(created.id, emit);
    try {
      await this.waitUntilTerminal(created.id);
      return this.readOutcome(created.id, sessionId);
    } finally {
      unbind();
      this.sessionToRun.delete(sessionId);
      this.runToSession.delete(created.id);
    }
  }

  cancel(sessionId?: string): { ok: true; canceled: boolean } {
    const legacy = this.deps.cancelService.cancel(sessionId);
    let canceled = legacy.canceled;
    for (const runId of this.findRunIds(sessionId)) {
      this.deps.executor.cancelRun(runId, "cancelled by client");
      canceled = true;
    }
    return { ok: true, canceled };
  }

  private findRunIds(sessionId?: string): string[] {
    const ids = new Set<string>();
    if (sessionId) {
      const mapped = this.sessionToRun.get(sessionId);
      if (mapped) ids.add(mapped);
    } else {
      for (const runId of this.runToSession.keys()) ids.add(runId);
    }
    for (const run of this.deps.executionStore.loadRecoverableRuns()) {
      if (isTerminalRunState(run.state)) continue;
      if (run.spec.policyContext.origin !== FIRST_PARTY_RUN_ORIGIN) continue;
      const input = run.spec.steps[0]?.input as
        | { sessionId?: string | null }
        | undefined;
      if (!sessionId || input?.sessionId === sessionId) {
        ids.add(run.id);
      }
    }
    return [...ids];
  }

  private async waitUntilTerminal(runId: string): Promise<void> {
    for (;;) {
      const run = this.deps.executionStore.getRun(runId);
      if (!run) throw new Error(`run not found: ${runId}`);
      if (isTerminalRunState(run.state)) return;
      const processed = await this.deps.executor.tick(1);
      const after = this.deps.executionStore.getRun(runId);
      if (after && isTerminalRunState(after.state)) return;
      if (processed === 0) {
        await sleep(20);
      }
    }
  }

  private readOutcome(runId: string, sessionId: string): RunResult {
    const run = this.deps.executionStore.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (run.state === "cancelled") {
      throw new RpcFaultError(rpcFault("CORE_CANCELLED", "任务已取消"));
    }
    if (run.state === "succeeded") {
      const step = run.spec.steps[0];
      const attempts = step
        ? this.deps.executionStore.listAttempts(run.id, step.id)
        : [];
      const outputRef = [...attempts]
        .reverse()
        .find((item) => item.outputRef)?.outputRef;
      return (
        readLegacyRunResult(this.deps.db, outputRef) ?? {
          sessionId,
          finalText: "",
        }
      );
    }
    throw new RpcFaultError(
      rpcFault("INTERNAL_ERROR", this.readFailureMessage(runId)),
    );
  }

  private readFailureMessage(runId: string): string {
    const row = this.deps.db
      .prepare(
        `SELECT error_json AS errorJson
         FROM core_attempts
         WHERE run_id = ?
         ORDER BY attempt_number DESC
         LIMIT 1`,
      )
      .get(runId) as { errorJson?: string | null } | undefined;
    return messageFromStoredError(row?.errorJson)
      ?? "Forge run failed without a response";
  }
}

function messageFromStoredError(errorJson?: string | null): string | undefined {
  if (!errorJson) return undefined;
  try {
    const value = JSON.parse(errorJson) as {
      message?: unknown;
      name?: unknown;
      status?: unknown;
    };
    if (typeof value.message === "string" && value.message.trim()) {
      return value.message;
    }
    if (value.name === "LlmError" && value.status != null) {
      return `LLM 请求失败 (${String(value.status)})`;
    }
  } catch {
    return errorJson;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
