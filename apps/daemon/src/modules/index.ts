import type { DaemonModule } from "../host/types.js";
import { createAssetsModule } from "./assets-module.js";
import { createAutomationModule } from "./automation-module.js";
import { createChannelModule } from "./channel-module.js";
import type { ForgeDaemonContext } from "./context.js";
import { createEventModule } from "./event-module.js";
import { createExecutionModule } from "./execution-module.js";
import { createRuntimeModule } from "./runtime-module.js";
import { createSessionModule } from "./session-module.js";

export function createDaemonModules(
  _context: ForgeDaemonContext,
): Array<DaemonModule<ForgeDaemonContext>> {
  return [
    createExecutionModule(),
    createEventModule(),
    createSessionModule(),
    createRuntimeModule(),
    createAssetsModule(),
    createAutomationModule(),
    createChannelModule(),
  ];
}
