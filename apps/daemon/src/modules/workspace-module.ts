import { rpcFault } from "@forge/protocol";
import type { DaemonModule } from "../host/types.js";
import { RpcFaultError, TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";

export function createWorkspaceModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "workspace",
    feature: { version: 1, enabled: true },
    register(router, context) {
      router.register("workspace.groups.create", async (params, rpc) => {
        if (!params.name) {
          throw invalidRequest("name is required", rpc.correlationId);
        }
        const group = context.workspaceGroups.createGroup({
          id: params.id,
          name: params.name,
          description: params.description,
        });
        return group;
      });

      router.register("workspace.groups.bind", async (params, rpc) => {
        if (!params.groupId || !params.workspaceId || !params.rootPath) {
          throw invalidRequest(
            "groupId, workspaceId and rootPath are required",
            rpc.correlationId,
          );
        }
        context.workspaceGroups.registerWorkspace({
          id: params.workspaceId,
          rootPath: params.rootPath,
        });
        return context.workspaceGroups.bindWorkspace({
          id: params.id,
          groupId: params.groupId,
          workspaceId: params.workspaceId,
          rootPath: params.rootPath,
          mode: params.mode,
          pathScopes: params.pathScopes,
        });
      });

      router.register("workspace.groups.listBindings", async (params, rpc) => {
        if (!params.groupId) {
          throw invalidRequest("groupId is required", rpc.correlationId);
        }
        return {
          bindings: context.workspaceGroups.listBindings(params.groupId),
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

export function registerWorkspaceHandlers(
  router: TypedRouter,
  context: ForgeDaemonContext,
): void {
  createWorkspaceModule().register(router, context);
}
