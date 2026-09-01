import { randomUUID } from "node:crypto";
import type { DaemonClient, EventSubscription } from "./index.js";
import { runRequestToRunSpec } from "@forge/execution";
import type {
  AgentEvent,
  EventEnvelope,
  RunRequest,
  RunSpec,
  RunState,
} from "@forge/protocol";
import { RPC_PROTOCOL_VERSION } from "@forge/protocol";

export const REQUIRED_EXECUTION_FEATURE = "core.execution.v2";

export interface WorkbenchDaemonApi {
  assertCompatible(): Promise<void>;
  createRun(spec: RunSpec): Promise<{ runId: string; state: RunState }>;
  subscribeRun(
    runId: string,
    handler: (event: EventEnvelope) => void,
  ): Promise<EventSubscription>;
  cancelRun(runId: string, reason?: string): Promise<void>;
}

export interface SimpleRunInput {
  cwd: string;
  message: string;
  sessionId?: string | null;
  hookSource?: RunRequest["hookSource"];
  clientRunId?: string;
  runtime?: RunRequest["runtime"];
  autoApply?: boolean;
  files?: string[];
  attachments?: RunRequest["attachments"];
}

export function createWorkbenchDaemonApi(client: DaemonClient): WorkbenchDaemonApi {
  return {
    async assertCompatible() {
      const capabilities = await client.request("system.capabilities", {});
      assertExecutionFeature(capabilities);
    },
    createRun(spec) {
      return client.request("run.create", spec);
    },
    subscribeRun(runId, handler) {
      return Promise.resolve(client.subscribe({ runId }, handler));
    },
    async cancelRun(runId, reason) {
      await client.request("run.cancel", {
        runId,
        ...(reason ? { reason } : {}),
      });
    },
  };
}

export function simpleRunSpec(input: SimpleRunInput): RunSpec {
  const request: RunRequest = {
    cwd: input.cwd,
    message: input.message,
    sessionId: input.sessionId ?? null,
    hookSource: input.hookSource,
    clientRunId: input.clientRunId,
    runtime: input.runtime,
    autoApply: input.autoApply,
    files: input.files,
    attachments: input.attachments,
  };
  return runRequestToRunSpec(request, {
    runId: () => randomUUID(),
    correlationId: () => randomUUID(),
  });
}

export function agentEventFromEnvelope(event: EventEnvelope): AgentEvent | null {
  const data = event.data;
  if (!isRecord(data) || data.compatibility !== true) {
    return null;
  }
  if (typeof data.legacyEventType !== "string") {
    return null;
  }
  const legacy = { ...(data as Record<string, unknown>) };
  delete legacy.compatibility;
  delete legacy.legacyEventType;
  delete legacy.runId;
  delete legacy.stepId;
  delete legacy.attemptId;
  delete legacy.correlationId;
  return {
    type: data.legacyEventType,
    ...legacy,
  } as AgentEvent;
}

export function isTerminalRunState(state: RunState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

export async function waitForWorkbenchRun(
  client: DaemonClient,
  runId: string,
  onEvent?: (event: AgentEvent) => void,
): Promise<{ state: RunState; sessionId: string; finalText: string }> {
  const api = createWorkbenchDaemonApi(client);
  let terminalState: RunState | null = null;

  const subscription = await api.subscribeRun(runId, (event) => {
    const legacy = agentEventFromEnvelope(event);
    if (legacy) {
      onEvent?.(legacy);
    }
    if (event.type === "run.succeeded") {
      terminalState = "succeeded";
    } else if (event.type === "run.failed") {
      terminalState = "failed";
    } else if (event.type === "run.cancelled") {
      terminalState = "cancelled";
    }
  });

  try {
    while (!terminalState) {
      const snapshot = await client.request("run.get", { runId });
      if (isTerminalRunState(snapshot.state)) {
        terminalState = snapshot.state;
        break;
      }
      await sleep(50);
    }
    const durableResult = await readDurableRunResult(client, runId);
    return {
      state: terminalState ?? "failed",
      sessionId: durableResult.sessionId,
      finalText: durableResult.finalText,
    };
  } finally {
    await subscription.close();
  }
}

async function readDurableRunResult(
  client: DaemonClient,
  runId: string,
): Promise<{ sessionId: string; finalText: string }> {
  const limit = 500;
  let cursor = 0;
  let sessionId = "";
  let finalText = "";

  while (true) {
    const page = await client.request("events.read", {
      cursor,
      limit,
      filter: { runId },
    });
    for (const event of page.events) {
      const legacy = agentEventFromEnvelope(event);
      if (!legacy) continue;
      if ("sessionId" in legacy && typeof legacy.sessionId === "string") {
        sessionId = legacy.sessionId;
      }
      if (legacy.type === "done") {
        sessionId = legacy.sessionId;
        finalText = legacy.finalText ?? "";
      }
    }
    const lastSequence = page.events.at(-1)?.sequence ?? cursor;
    if (page.events.length < limit || lastSequence <= cursor) {
      return { sessionId, finalText };
    }
    cursor = lastSequence;
  }
}

export async function supportsDaemonV2(client: DaemonClient): Promise<boolean> {
  try {
    await createWorkbenchDaemonApi(client).assertCompatible();
    return true;
  } catch {
    return false;
  }
}

function assertExecutionFeature(capabilities: {
  protocolVersion: number;
  features: Record<string, { version: number; enabled: boolean } | undefined>;
}): void {
  if (capabilities.protocolVersion !== RPC_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported protocol version ${capabilities.protocolVersion}`,
    );
  }
  const feature =
    capabilities.features[REQUIRED_EXECUTION_FEATURE] ??
    capabilities.features.execution;
  if (!feature?.enabled) {
    throw new Error(`missing required daemon feature: ${REQUIRED_EXECUTION_FEATURE}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
