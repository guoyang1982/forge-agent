import {
  ApprovalAlreadyDecidedError,
  ApprovalHashMismatchError,
} from "@forge/policy";
import { rpcFault } from "@forge/protocol";
import type { DaemonModule } from "../host/types.js";
import { RpcFaultError, TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";

export function createGovernanceModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "governance",
    feature: { version: 1, enabled: true },
    register(router, context) {
      router.register("approvals.list", async (params) => {
        const subject =
          params.subjectKind && params.subjectId
            ? { kind: params.subjectKind, id: params.subjectId }
            : undefined;
        const approvals = context.approvals
          .listPending(subject)
          .filter((approval) =>
            params.runId ? approval.runId === params.runId : true,
          )
          .map((approval) => ({
            id: approval.id,
            subject: approval.subject,
            action: approval.action,
            resource: approval.resource,
            parametersHash: approval.parametersHash,
            parametersSummary: approval.parametersSummary,
            risk: approval.risk,
            policyVersionId: approval.policyVersionId,
            state: approval.state,
            runId: approval.runId,
            stepId: approval.stepId,
            attemptId: approval.attemptId,
            expiresAt: approval.expiresAt,
            createdAt: approval.createdAt,
          }));
        return { approvals };
      });

      router.register("approvals.decide", async (params, rpc) => {
        if (!params.approvalId || !params.actor) {
          throw invalidRequest(
            "approvalId and actor are required",
            rpc.correlationId,
          );
        }
        try {
          const approval = context.approvals.decide(params.approvalId, {
            decision: params.decision,
            actor: params.actor,
            reason: params.reason,
            parametersHash: params.parametersHash,
          });
          if (approval.state === "approved" && approval.runId) {
            context.wakeExecutor();
          }
          return {
            id: approval.id,
            state: approval.state,
            decision: approval.decision,
          };
        } catch (error) {
          if (error instanceof ApprovalHashMismatchError) {
            throw new RpcFaultError(
              rpcFault("VALIDATION_FAILED", error.message, {
                correlationId: rpc.correlationId,
              }),
            );
          }
          if (error instanceof ApprovalAlreadyDecidedError) {
            throw invalidRequest(error.message, rpc.correlationId);
          }
          throw error;
        }
      });

      router.register("budgets.get", async (params, rpc) => {
        if (!params.accountId) {
          throw invalidRequest("accountId is required", rpc.correlationId);
        }
        const balance = context.budgetLedger.balance(params.accountId);
        return {
          accountId: balance.accountId,
          currency: balance.currency,
          hardLimitMinor: balance.hardLimitMinor?.toString(),
          committedMinor: balance.committedMinor.toString(),
          reservedMinor: balance.reservedMinor.toString(),
          availableMinor: balance.availableMinor?.toString(),
        };
      });

      router.register("agentProfiles.publish", async (params) => {
        const version = context.agentProfiles.publishVersion({
          profileId: params.profileId,
          name: params.name,
          model: params.model,
          policyVersionId: params.policyVersionId,
        });
        return {
          profileId: version.profileId,
          versionId: version.id,
          version: version.version,
        };
      });

      router.register("agentProfiles.resolve", async (params, rpc) => {
        if (!params.profileId || !params.profileVersionId) {
          throw invalidRequest(
            "profileId and profileVersionId are required",
            rpc.correlationId,
          );
        }
        const snapshot = context.agentProfiles.resolveSnapshot({
          profileId: params.profileId,
          profileVersionId: params.profileVersionId,
          runId: params.runId,
        });
        return {
          snapshotId: snapshot.id,
          profileId: snapshot.profileId,
          profileVersionId: snapshot.profileVersionId,
          policyVersionId: snapshot.policyVersionId,
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

export function registerGovernanceHandlers(
  router: TypedRouter,
  context: ForgeDaemonContext,
): void {
  createGovernanceModule().register(router, context);
}
