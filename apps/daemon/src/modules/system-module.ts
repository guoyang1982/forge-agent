import type {
  CapabilityManifest,
  SystemStatusResult,
} from "@forge/protocol";
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
      router.register("system.ping", async () => ({
        ok: true,
        version: context.serverVersion,
        build: context.build,
      }));
      router.register("system.capabilities", async () =>
        dependencies.capabilities(),
      );
      router.register("system.status", async () => dependencies.status());
    },
  };
}
