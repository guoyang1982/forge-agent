import type { DaemonClient } from "@forge/daemon-client";
import {
  createWorkbenchDaemonApi,
  simpleRunSpec,
  waitForWorkbenchRun,
  type SimpleRunInput,
} from "@forge/daemon-client";
import type { AgentEvent, RunState } from "@forge/protocol";

export type { SimpleRunInput };

export interface SimpleRunResult {
  runId: string;
  state: RunState;
  sessionId: string;
  finalText: string;
}

export interface CliDaemonApi {
  assertCompatible(): Promise<void>;
  startSimpleRun(
    input: SimpleRunInput,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<SimpleRunResult>;
}

export function createCliDaemonApi(client: DaemonClient): CliDaemonApi {
  const workbench = createWorkbenchDaemonApi(client);
  return {
    assertCompatible: () => workbench.assertCompatible(),
    async startSimpleRun(input, onEvent) {
      const created = await workbench.createRun(simpleRunSpec(input));
      const terminal = await waitForWorkbenchRun(client, created.runId, onEvent);
      return {
        runId: created.runId,
        state: terminal.state,
        sessionId: terminal.sessionId,
        finalText: terminal.finalText,
      };
    },
  };
}
