import { DAEMON_METHODS } from "@forge/protocol";
import type { DaemonModule } from "../host/types.js";
import {
  handleChannelPollLogin,
  handleChannelStartLogin,
  handleCreateChannel,
  handleDeleteChannel,
  handleGetChannel,
  handleGetChannelGatewayStatus,
  handleListChannelKinds,
  handleListChannels,
  handleStartChannelGateway,
  handleStopChannelGateway,
  handleUpdateChannel,
  type ChannelServiceDeps,
} from "../services/channel-service.js";
import {
  handleMobileCreatePairing,
  handleMobileListDevices,
  handleMobileRevokeDevice,
  handleMobileUpdateDeviceProjects,
} from "../services/mobile-service.js";
import {
  handleMobileDiffGet,
  handleMobileDiffList,
  handleMobileFileRead,
  handleMobileFilesList,
  handleMobileGitBranches,
  handleMobileGitSwitch,
} from "../services/mobile-workspace-service.js";
import type { ForgeDaemonContext } from "./context.js";

export function createChannelModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "channel",
    feature: { version: 1, enabled: true },
    register(router, context) {
      const deps: ChannelServiceDeps = {
        getStore: () => context.channelStore,
        getGatewayHost: () => context.channelGatewayHost,
      };
      router.registerProduct(DAEMON_METHODS.LIST_CHANNELS, async (params) =>
        handleListChannels(params, deps));
      router.registerProduct(DAEMON_METHODS.GET_CHANNEL, async (params) =>
        handleGetChannel(params, deps));
      router.registerProduct(DAEMON_METHODS.CREATE_CHANNEL, async (params) =>
        handleCreateChannel(params, deps));
      router.registerProduct(DAEMON_METHODS.UPDATE_CHANNEL, async (params) =>
        handleUpdateChannel(params, deps));
      router.registerProduct(DAEMON_METHODS.DELETE_CHANNEL, async (params) =>
        handleDeleteChannel(params, deps));
      router.registerProduct(DAEMON_METHODS.LIST_CHANNEL_KINDS, async () =>
        handleListChannelKinds());
      router.registerProduct(DAEMON_METHODS.GET_CHANNEL_GATEWAY_STATUS, async () =>
        handleGetChannelGatewayStatus(deps));
      router.registerProduct(DAEMON_METHODS.START_CHANNEL_GATEWAY, async (params) =>
        handleStartChannelGateway(params, deps));
      router.registerProduct(DAEMON_METHODS.STOP_CHANNEL_GATEWAY, async () =>
        handleStopChannelGateway(deps));
      router.registerProduct(DAEMON_METHODS.CHANNEL_START_LOGIN, async (params) =>
        handleChannelStartLogin(params, deps));
      router.registerProduct(DAEMON_METHODS.CHANNEL_POLL_LOGIN, async (params) =>
        handleChannelPollLogin(params, deps));
      router.registerProduct(DAEMON_METHODS.MOBILE_CREATE_PAIRING, async (params) =>
        handleMobileCreatePairing(params, deps));
      router.registerProduct(DAEMON_METHODS.MOBILE_LIST_DEVICES, async (params) =>
        handleMobileListDevices(params, deps));
      router.registerProduct(DAEMON_METHODS.MOBILE_REVOKE_DEVICE, async (params) =>
        handleMobileRevokeDevice(params, deps));
      router.registerProduct(DAEMON_METHODS.MOBILE_UPDATE_DEVICE_PROJECTS, async (params) =>
        handleMobileUpdateDeviceProjects(params, deps));
      registerMobileWorkspaceMethods(router, context);
    },
    async stop(context) {
      await context.channelGatewayHost.stop();
    },
  };
}

function registerMobileWorkspaceMethods(
  router: Parameters<DaemonModule<ForgeDaemonContext>["register"]>[0],
  context: ForgeDaemonContext,
): void {
  router.registerProduct(DAEMON_METHODS.MOBILE_GIT_BRANCHES, async (params) => {
    const payload = mobileWorkspaceParams(params);
    return handleMobileGitBranches({ cwd: payload.cwd });
  });
  router.registerProduct(DAEMON_METHODS.MOBILE_GIT_SWITCH, async (params) => {
    const payload = mobileWorkspaceParams(params);
    return handleMobileGitSwitch({
      cwd: payload.cwd,
      branch: payload.branch ?? "",
      confirmDirty: payload.confirmDirty,
      running: context.cancelService.hasActiveRun(),
    });
  });
  router.registerProduct(DAEMON_METHODS.MOBILE_WORKSPACE_FILES_LIST, async (params) => {
    const payload = mobileWorkspaceParams(params);
    return handleMobileFilesList({ cwd: payload.cwd, path: payload.path });
  });
  router.registerProduct(DAEMON_METHODS.MOBILE_WORKSPACE_FILE_READ, async (params) => {
    const payload = mobileWorkspaceParams(params);
    return handleMobileFileRead({ cwd: payload.cwd, path: payload.path ?? "" });
  });
  router.registerProduct(DAEMON_METHODS.MOBILE_WORKSPACE_DIFF_LIST, async (params) => {
    const payload = mobileWorkspaceParams(params);
    return handleMobileDiffList({ cwd: payload.cwd });
  });
  router.registerProduct(DAEMON_METHODS.MOBILE_WORKSPACE_DIFF_GET, async (params) => {
    const payload = mobileWorkspaceParams(params);
    return handleMobileDiffGet({ cwd: payload.cwd, path: payload.path ?? "" });
  });
}

function mobileWorkspaceParams(params: unknown): {
  cwd: string;
  path?: string;
  branch?: string;
  confirmDirty?: boolean;
} {
  const raw = params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  return {
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    path: typeof raw.path === "string" ? raw.path : undefined,
    branch: typeof raw.branch === "string" ? raw.branch : undefined,
    confirmDirty: raw.confirmDirty === true,
  };
}
