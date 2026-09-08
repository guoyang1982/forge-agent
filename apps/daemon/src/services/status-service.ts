import type {
  DaemonStatusResult,
  ModuleHealthSummary,
  SystemStatusResult,
} from "@forge/protocol";
import type { SessionStore } from "@forge/session";
import type { ForgeStore } from "@forge/store";
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
    activeSessionIds: deps.cancelService.activeSessionIds(),
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

export function handleSystemStatus(deps: {
  store: ForgeStore;
  modules: ModuleHealthSummary[];
}): SystemStatusResult {
  const row = deps.store.db
    .prepare(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    )
    .get() as { version: string } | undefined;
  return {
    ok: deps.modules.every((module) => module.status === "healthy"),
    migrationVersion: row?.version ?? null,
    modules: deps.modules,
  };
}
