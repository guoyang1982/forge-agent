import type { ChannelStore } from "@forge/channel";
import { loadConfig } from "@forge/config";
import { DEFAULT_PERMISSIONS } from "@forge/protocol";
import type {
  MobileCreatePairingRequest,
  MobileCreatePairingResult,
  MobileListDevicesRequest,
  MobileListDevicesResult,
  MobileRevokeDeviceRequest,
  MobileRevokeDeviceResult,
  MobileUpdateDeviceProjectsRequest,
  MobileUpdateDeviceProjectsResult,
  PermissionLevel,
} from "@forge/protocol";
import type { ChannelGatewayHost } from "./channel-gateway-host.js";

export interface MobileServiceDeps {
  getStore: () => ChannelStore;
  getGatewayHost: () => ChannelGatewayHost;
}

export async function handleMobileCreatePairing(
  params: unknown,
  deps: MobileServiceDeps,
): Promise<MobileCreatePairingResult> {
  const req = params as MobileCreatePairingRequest;
  const channel = mobileChannel(req?.adapterId, deps);
  const permissions =
    loadConfig({ cwd: channel.cwd }).permissions?.mobile ?? DEFAULT_PERMISSIONS.mobile;
  assertMobileEnabled(permissions.enabled);
  assertLevel(permissions.pair, "mobile pair", req.skipConfirm);
  await ensureGateway(deps);
  return deps.getGatewayHost().requestMobile("pairing", {
    adapterId: channel.id,
    ...(req.deviceName ? { deviceName: req.deviceName.slice(0, 100) } : {}),
  });
}

export async function handleMobileListDevices(
  params: unknown,
  deps: MobileServiceDeps,
): Promise<MobileListDevicesResult> {
  const req = params as MobileListDevicesRequest;
  const channel = mobileChannel(req?.adapterId, deps);
  assertMobileEnabled(
    (loadConfig({ cwd: channel.cwd }).permissions?.mobile ?? DEFAULT_PERMISSIONS.mobile)
      .enabled,
  );
  await ensureGateway(deps);
  return deps.getGatewayHost().requestMobile("devices", { adapterId: channel.id });
}

export async function handleMobileRevokeDevice(
  params: unknown,
  deps: MobileServiceDeps,
): Promise<MobileRevokeDeviceResult> {
  const req = params as MobileRevokeDeviceRequest;
  const channel = mobileChannel(req?.adapterId, deps);
  assertMobileEnabled(
    (loadConfig({ cwd: channel.cwd }).permissions?.mobile ?? DEFAULT_PERMISSIONS.mobile)
      .enabled,
  );
  if (!req.deviceId?.trim()) throw new Error("deviceId is required");
  await ensureGateway(deps);
  return deps.getGatewayHost().requestMobile("revoke", {
    adapterId: channel.id,
    deviceId: req.deviceId.trim(),
  });
}

export async function handleMobileUpdateDeviceProjects(
  params: unknown,
  deps: MobileServiceDeps,
): Promise<MobileUpdateDeviceProjectsResult> {
  const req = params as MobileUpdateDeviceProjectsRequest;
  const channel = mobileChannel(req?.adapterId, deps);
  assertMobileEnabled(
    (loadConfig({ cwd: channel.cwd }).permissions?.mobile ?? DEFAULT_PERMISSIONS.mobile)
      .enabled,
  );
  if (!req.deviceId?.trim()) throw new Error("deviceId is required");
  if (!Array.isArray(req.allowedProjects) || req.allowedProjects.length > 100) {
    throw new Error("allowedProjects must be an array with at most 100 entries");
  }
  await ensureGateway(deps);
  return deps.getGatewayHost().requestMobile("projects", {
    adapterId: channel.id,
    deviceId: req.deviceId.trim(),
    allowedProjects: req.allowedProjects,
  });
}

function mobileChannel(adapterId: string | undefined, deps: MobileServiceDeps) {
  if (!adapterId?.trim()) throw new Error("adapterId is required");
  const channel = deps.getStore().get(adapterId.trim());
  if (!channel || channel.kind !== "mobile") throw new Error("Forge Mobile channel not found");
  return channel;
}

function assertMobileEnabled(enabled: boolean): void {
  if (!enabled) throw new Error("mobile disabled in permissions");
}

function assertLevel(level: PermissionLevel, operation: string, confirmed = false): void {
  if (level === "deny") throw new Error(`${operation} denied`);
  if (level === "confirm" && !confirmed) throw new Error(`${operation} requires confirmation`);
}

async function ensureGateway(deps: MobileServiceDeps): Promise<void> {
  if (!deps.getGatewayHost().isRunning()) await deps.getGatewayHost().start();
}
