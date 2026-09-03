import { DAEMON_METHODS } from "@forge/protocol";
import type { DaemonModule } from "../host/types.js";
import { listCodexModels } from "../services/codex-runtime.js";
import { listCursorModels, probeCursorRuntime } from "../services/cursor-runtime.js";
import { handlePermissionResponse } from "../services/network-confirm.js";
import {
  closeAcpSession,
  listRuntimes,
  listWarmAcpSessions,
  prewarmAcpSession,
  releaseAcpForgeSession,
} from "../services/runtime-service.js";
import { handleStatus } from "../services/status-service.js";
import type { ForgeDaemonContext } from "./context.js";

export function createRuntimeModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "runtime",
    feature: { version: 1, enabled: true },
    register(router, context) {
      router.registerProduct(DAEMON_METHODS.STATUS, async () => handleStatus({
        version: context.serverVersion,
        sessions: context.sessions,
        getRuntime: context.getRuntime,
        cancelService: context.cancelService,
      }));
      router.registerProduct(DAEMON_METHODS.CANCEL_RUN, async (params) => {
        const request = params as { sessionId?: string } | undefined;
        return context.firstPartyRuns.cancel(request?.sessionId);
      });
      router.registerProduct(DAEMON_METHODS.PERMISSION_RESPONSE, async (params) =>
        handlePermissionResponse(params));
      router.registerProduct(DAEMON_METHODS.RUN, async (params, rpc) =>
        context.firstPartyRuns.start(params, rpc.emitAgentEvent));
      router.registerProduct(DAEMON_METHODS.LIST_CODEX_MODELS, async (params) =>
        listCodexModels(cwdFromParams(params)));
      router.registerProduct(DAEMON_METHODS.LIST_CURSOR_MODELS, async (params) =>
        listCursorModels(cwdFromParams(params)));
      router.registerProduct(DAEMON_METHODS.PROBE_CURSOR_RUNTIME, async (params) =>
        probeCursorRuntime(cwdFromParams(params)));
      router.registerProduct(DAEMON_METHODS.LIST_RUNTIMES, async (params) =>
        listRuntimes(cwdFromParams(params)));
      router.registerProduct(DAEMON_METHODS.CLOSE_ACP_SESSION, async (params) => {
        const payload = isObject(params)
          ? params as { provider?: unknown; sessionId?: unknown }
          : {};
        const sessionId = String(payload.sessionId ?? "");
        if (!sessionId) throw new Error("sessionId required");
        const provider = payload.provider === undefined || payload.provider === null
          ? undefined
          : String(payload.provider);
        return closeAcpSession({ provider, sessionId });
      });
      router.registerProduct(DAEMON_METHODS.RELEASE_ACP_FORGE_SESSION, async (params) => {
        const payload = isObject(params) ? params as { sessionId?: unknown } : {};
        const sessionId = String(payload.sessionId ?? "");
        if (!sessionId) throw new Error("sessionId required");
        return releaseAcpForgeSession(sessionId);
      });
      router.registerProduct(DAEMON_METHODS.LIST_WARM_ACP_SESSIONS, async () => ({
        sessions: listWarmAcpSessions(),
      }));
      router.registerProduct(DAEMON_METHODS.PREWARM_ACP_SESSION, async (params) => {
        const payload = isObject(params)
          ? params as {
              provider?: unknown;
              cwd?: unknown;
              model?: unknown;
              mode?: unknown;
              sandboxMode?: unknown;
            }
          : {};
        return prewarmAcpSession({
          provider: String(payload.provider ?? "cursor"),
          cwd: String(payload.cwd ?? process.cwd()),
          model: payload.model ? String(payload.model) : undefined,
          mode: payload.mode ? String(payload.mode) : undefined,
          sandboxMode: payload.sandboxMode ? String(payload.sandboxMode) : undefined,
        });
      });
    },
    start: (context) => context.getRuntime().then(() => undefined),
    stop: (context) => context.shutdownRuntime(),
  };
}

function cwdFromParams(params: unknown): string {
  return isObject(params) && "cwd" in params
    ? String((params as { cwd?: unknown }).cwd ?? process.cwd())
    : process.cwd();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
