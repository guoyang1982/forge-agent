import type { AutomationStore } from "@forge/automation";
import type { ChannelStore } from "@forge/channel";
import type { ReloadRuntimeResult } from "@forge/protocol";
import type { SessionStore } from "@forge/session";
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
  getRuntime: () => Promise<ForgeRuntime>;
  reloadRuntime: () => Promise<ReloadRuntimeResult>;
  shutdownRuntime: () => Promise<void>;
}
