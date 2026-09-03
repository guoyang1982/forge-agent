import { connectDaemon } from "../../packages/bus/dist/index.js";
import {
  agentEventFromEnvelope,
  isTerminalRunState,
  simpleRunSpec,
} from "../../packages/daemon-client/dist/index.js";
import { loadConfig } from "../../packages/config/dist/index.js";

const cfg = loadConfig();
const client = await connectDaemon(cfg.daemon.socketPath);

try {
  const capabilities = await client.request("system.capabilities", {});
  if (capabilities?.protocolVersion !== 2) {
    console.error(
      `[smoke] expected protocolVersion 2, got ${capabilities?.protocolVersion ?? "unknown"}`,
    );
    process.exit(1);
  }
  const executionFeature = capabilities.features?.["core.execution.v2"];
  if (!executionFeature?.enabled) {
    console.error("[smoke] missing core.execution.v2 feature");
    process.exit(1);
  }

  const created = await client.request(
    "run.create",
    simpleRunSpec({
      cwd: process.cwd(),
      message: "smoke pong",
    }),
  );
  const runId = created.runId;
  if (!runId) {
    console.error("[smoke] run.create did not return runId");
    process.exit(1);
  }

  let cursor = 0;
  let sawPersistedEvent = false;
  let terminalState = null;
  let sessionId = "";
  let finalText = "";

const SMOKE_TIMEOUT_MS = Number(process.env.FORGE_SMOKE_TIMEOUT_MS ?? 120_000);
const smokeStarted = Date.now();

  while (!terminalState) {
    if (Date.now() - smokeStarted > SMOKE_TIMEOUT_MS) {
      console.error(`[smoke] timed out after ${SMOKE_TIMEOUT_MS}ms waiting for terminal state`);
      process.exit(1);
    }
    const page = await client.request("events.read", {
      cursor,
      limit: 100,
      filter: { runId },
    });
    for (const event of page.events ?? []) {
      if (typeof event.sequence === "number") {
        cursor = Math.max(cursor, event.sequence);
        sawPersistedEvent = true;
      }
      const legacy = agentEventFromEnvelope(event);
      if (legacy?.type === "done") {
        sessionId = String(legacy.sessionId ?? "");
        finalText = String(legacy.finalText ?? "");
      }
      if (event.type === "run.succeeded") terminalState = "succeeded";
      if (event.type === "run.failed") terminalState = "failed";
      if (event.type === "run.cancelled") terminalState = "cancelled";
    }

    const snapshot = await client.request("run.get", { runId });
    if (isTerminalRunState(snapshot.state)) {
      terminalState = snapshot.state;
    } else {
      await sleep(50);
    }
  }

  if (!sawPersistedEvent) {
    console.error("[smoke] no persisted v2 events observed for run");
    process.exit(1);
  }
  if (!isTerminalRunState(terminalState)) {
    console.error(`[smoke] run did not reach terminal state: ${terminalState}`);
    process.exit(1);
  }
  if (terminalState !== "succeeded") {
    console.error(`[smoke] expected succeeded terminal state, got ${terminalState}`);
    process.exit(1);
  }
  if (!sessionId.trim() || !finalText.trim()) {
    console.error("[smoke] missing non-empty sessionId/finalText from durable result");
    process.exit(1);
  }

  console.log(
    `[smoke] v2 run ok runId=${runId} sessionId=${sessionId} finalText=${JSON.stringify(finalText)} events>=${cursor}`,
  );
} finally {
  client.close();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
