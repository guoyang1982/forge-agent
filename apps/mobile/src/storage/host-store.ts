import * as SecureStore from "expo-secure-store";

const HOST_INDEX_KEY = "forge.mobile.host-index.v1";
const HOST_SECRET_PREFIX = "forge.mobile.host-secret.v1.";
const SECURE_STORE_PROBE_KEY = "forge.mobile.secure-store-probe";

export interface MobileHostSummary {
  hostId: string;
  deviceId: string;
  relayOrigin: string;
  displayName: string;
  hostE2eePublicKey: string;
  pairedAt: string;
}

export interface MobileHostSecret {
  version: 1;
  deviceToken: string;
  resumeToken: string;
}

export async function listHosts(): Promise<MobileHostSummary[]> {
  const raw = await SecureStore.getItemAsync(HOST_INDEX_KEY);
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter(isHostSummary) : [];
  } catch {
    return [];
  }
}

export async function reconcileHostsWithSecrets(): Promise<{
  hosts: MobileHostSummary[];
  invalidatedHostIds: string[];
}> {
  const hosts = await listHosts();
  const secrets = await Promise.all(hosts.map((host) => loadHostSecret(host.hostId)));
  const validHosts = hosts.filter((_, index) => secrets[index] !== null);
  const invalidatedHostIds = hosts
    .filter((_, index) => secrets[index] === null)
    .map((host) => host.hostId);
  if (invalidatedHostIds.length > 0) {
    await Promise.all(invalidatedHostIds.map((hostId) => SecureStore.deleteItemAsync(secretKey(hostId))));
    await writeHostIndex(validHosts);
  }
  return { hosts: validHosts, invalidatedHostIds };
}

export async function saveHost(
  summary: MobileHostSummary,
  secret: MobileHostSecret,
): Promise<void> {
  const hosts = (await listHosts()).filter((host) => host.hostId !== summary.hostId);
  await SecureStore.setItemAsync(secretKey(summary.hostId), JSON.stringify(secret), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await writeHostIndex([summary, ...hosts]);
}

export async function assertSecureStoreAvailable(): Promise<void> {
  await SecureStore.setItemAsync(SECURE_STORE_PROBE_KEY, "ok", {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.deleteItemAsync(SECURE_STORE_PROBE_KEY);
}

export async function loadHostSecret(hostId: string): Promise<MobileHostSecret | null> {
  const raw = await SecureStore.getItemAsync(secretKey(hostId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as MobileHostSecret;
    return value.version === 1 && value.deviceToken && value.resumeToken ? value : null;
  } catch {
    return null;
  }
}

export async function removeHost(hostId: string): Promise<void> {
  const hosts = (await listHosts()).filter((host) => host.hostId !== hostId);
  await SecureStore.deleteItemAsync(secretKey(hostId));
  await writeHostIndex(hosts);
}

async function writeHostIndex(hosts: MobileHostSummary[]): Promise<void> {
  await SecureStore.setItemAsync(HOST_INDEX_KEY, JSON.stringify(hosts), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

function secretKey(hostId: string): string {
  return `${HOST_SECRET_PREFIX}${hostId.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

function isHostSummary(value: unknown): value is MobileHostSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["hostId", "deviceId", "relayOrigin", "displayName", "hostE2eePublicKey", "pairedAt"].every(
    (key) => typeof item[key] === "string",
  );
}
