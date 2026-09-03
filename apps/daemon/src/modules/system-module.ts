import { DAEMON_METHODS, type CapabilityManifest, type SystemStatusResult } from "@forge/protocol";
import type { DaemonContext, DaemonModule } from "../host/types.js";

export interface SystemModuleDependencies {
  capabilities: () => CapabilityManifest;
  status: () => Promise<SystemStatusResult>;
}

export function createSystemModule(
  dependencies: SystemModuleDependencies,
): DaemonModule<DaemonContext> {
  return {
    id: "system",
    feature: { version: 1, enabled: true },
    register(router, context) {
      const ping = async () => ({
        ok: true,
        version: context.serverVersion,
        build: context.build,
      });
      router.register("system.ping", ping);
      router.registerProduct(DAEMON_METHODS.PING, ping);
      router.register("system.capabilities", async () =>
        dependencies.capabilities(),
      );
      router.register("system.status", async () => dependencies.status());
    },
  };
}
