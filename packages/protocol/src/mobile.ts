export interface MobileCreatePairingRequest {
  adapterId: string;
  deviceName?: string;
  skipConfirm?: boolean;
}

export interface MobilePairingOffer {
  v: 1;
  relayOrigin: string;
  hostId: string;
  hostE2eePublicKey: string;
  deviceId: string;
  pairingSecret: string;
  inviteToken: string;
  expiresAt: number;
  protocolVersion: 1;
}

export interface MobileCreatePairingResult {
  offer: MobilePairingOffer;
}

export interface MobileDeviceSummary {
  adapterId: string;
  deviceId: string;
  displayName?: string;
  credentialVersion: number;
  allowedProjects: string[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export interface MobileListDevicesRequest {
  adapterId: string;
}

export interface MobileListDevicesResult {
  devices: MobileDeviceSummary[];
}

export interface MobileRevokeDeviceRequest {
  adapterId: string;
  deviceId: string;
}

export interface MobileRevokeDeviceResult {
  ok: boolean;
}

export interface MobileUpdateDeviceProjectsRequest {
  adapterId: string;
  deviceId: string;
  allowedProjects: string[];
}

export interface MobileUpdateDeviceProjectsResult {
  device: MobileDeviceSummary;
}
