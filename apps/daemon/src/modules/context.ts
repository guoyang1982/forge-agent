import type { AgentProfileStore } from "@forge/agent-profile";
import type { AutomationStore } from "@forge/automation";
import type { ChannelStore } from "@forge/channel";
import type { ArtifactService, ValidationService } from "@forge/evidence";
import type {
  DurableExecutor,
  ExecutionClock,
  ExecutionRecovery,
  ExecutionStore,
} from "@forge/execution";
import type { EventStore } from "@forge/event-store";
import type { ApprovalService } from "@forge/policy";
import type { ReloadRuntimeResult } from "@forge/protocol";
import type { SessionStore } from "@forge/session";
import type { BudgetLedgerService } from "@forge/usage-ledger";
import type { WorkspaceGroupService } from "@forge/workspace";
import type { ForgeRuntime } from "../runtime.js";
import type { AutomationSchedulerHost } from "../services/automation-scheduler-host.js";
import type { CancelService } from "../services/cancel-service.js";
import type { ChannelGatewayHost } from "../services/channel-gateway-host.js";
import type { DaemonContext } from "../host/types.js";

export interface ForgeDaemonContext extends DaemonContext {
  dataDir: string;
  monorepoRoot: string;
  sessions: SessionStore;
  automationStore: AutomationStore;
  channelStore: ChannelStore;
  cancelService: CancelService;
  schedulerHost: AutomationSchedulerHost;
  channelGatewayHost: ChannelGatewayHost;
  executionStore: ExecutionStore;
  eventStore: EventStore;
  executor: DurableExecutor;
  executionRecovery: ExecutionRecovery;
  executionClock: ExecutionClock;
  workspaceGroups: WorkspaceGroupService;
  approvals: ApprovalService;
  budgetLedger: BudgetLedgerService;
  agentProfiles: AgentProfileStore;
  artifacts: ArtifactService;
  validations: ValidationService;
  wakeExecutor: () => void;
  getRuntime: () => Promise<ForgeRuntime>;
  reloadRuntime: () => Promise<ReloadRuntimeResult>;
  shutdownRuntime: () => Promise<void>;
}
