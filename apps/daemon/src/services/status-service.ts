import type { DaemonStatusResult } from "@forge/protocol";
import type { SessionStore } from "@forge/session";
import type { ForgeRuntime } from "../runtime.js";
import type { CancelService } from "./cancel-service.js";

export async function handleStatus(deps: {
  version: string;
  sessions: SessionStore;
  getRuntime: () => Promise<ForgeRuntime>;
  cancelService: CancelService;
}): Promise<DaemonStatusResult> {
  const runtime = await deps.getRuntime();
  return {
    version: deps.version,
    activeRun: deps.cancelService.hasActiveRun(),
    runtime: {
      loaded: true,
      skills: runtime.skills.length,
      plugins: runtime.plugins.length,
    },
    sessions: {
      count: deps.sessions.countSessions(),
    },
    browser: {
      backends: runtime.browser.listBackends(),
    },
  };
}
