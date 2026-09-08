import { rpcFault } from "@forge/protocol";
import type { DaemonModule } from "../host/types.js";
import { RpcFaultError, TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";

export function createEvidenceModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "evidence",
    feature: { version: 1, enabled: true },
    register(router, context) {
      router.register("artifacts.get", async (params, rpc) => {
        if (!params.artifactId) {
          throw invalidRequest("artifactId is required", rpc.correlationId);
        }
        try {
          const artifact = context.artifacts.get(params.artifactId);
          return {
            id: artifact.id,
            producerRunId: artifact.producerRunId,
            producerStepId: artifact.producerStepId,
            mediaType: artifact.mediaType,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
            accessScope: artifact.accessScope,
            metadata: artifact.metadata,
            createdAt: artifact.createdAt,
          };
        } catch {
          throw invalidRequest("artifact not found", rpc.correlationId);
        }
      });

      router.register("validations.list", async (params, rpc) => {
        if (!params.runId) {
          throw invalidRequest("runId is required", rpc.correlationId);
        }
        return {
          validations: context.validations.listByRun(params.runId),
        };
      });
    },
  };
}

function invalidRequest(message: string, correlationId: string): RpcFaultError {
  return new RpcFaultError(
    rpcFault("INVALID_REQUEST", message, { correlationId }),
  );
}

export function registerEvidenceHandlers(
  router: TypedRouter,
  context: ForgeDaemonContext,
): void {
  createEvidenceModule().register(router, context);
}
