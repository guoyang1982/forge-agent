import type { DaemonModule } from "../host/types.js";
import { createAssetsModule } from "./assets-module.js";
import { createAutomationModule } from "./automation-module.js";
import { createChannelModule } from "./channel-module.js";
import type { ForgeDaemonContext } from "./context.js";
import { createEventModule } from "./event-module.js";
import { createEvidenceModule } from "./evidence-module.js";
import { createExecutionModule } from "./execution-module.js";
import { createGovernanceModule } from "./governance-module.js";
import { createRuntimeModule } from "./runtime-module.js";
import { createSessionModule } from "./session-module.js";
import { createWorkspaceModule } from "./workspace-module.js";

export function createDaemonModules(
  _context: ForgeDaemonContext,
): Array<DaemonModule<ForgeDaemonContext>> {
  return [
    createExecutionModule(),
    createEventModule<ForgeDaemonContext>(),
    createWorkspaceModule(),
    createGovernanceModule(),
    createEvidenceModule(),
    createSessionModule(),
    createRuntimeModule(),
    createAssetsModule(),
    createAutomationModule(),
    createChannelModule(),
  ];
}
