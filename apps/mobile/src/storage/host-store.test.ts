import { beforeEach, describe, expect, it, vi } from "vitest";

const values = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { values.delete(key); }),
}));

import {
  listHosts,
  reconcileHostsWithSecrets,
  saveHost,
  type MobileHostSummary,
} from "./host-store.js";

const host = (hostId: string): MobileHostSummary => ({
  hostId,
  deviceId: `device_${hostId}`,
  relayOrigin: "https://relay.example.test",
  displayName: hostId,
  hostE2eePublicKey: "A".repeat(43),
  pairedAt: "2026-07-16T00:00:00.000Z",
});

describe("Mobile host SecureStore reconciliation", () => {
  beforeEach(() => values.clear());

  it("keeps host summaries whose device credentials are still present", async () => {
    await saveHost(host("host_valid"), {
      version: 1,
      deviceToken: "device_token_valid_1234567890",
      resumeToken: "resume_token_valid_1234567890",
    });

    await expect(reconcileHostsWithSecrets()).resolves.toEqual({
      hosts: [host("host_valid")],
      invalidatedHostIds: [],
    });
  });

  it("removes stale summaries when the corresponding credential is missing", async () => {
    await saveHost(host("host_stale"), {
      version: 1,
      deviceToken: "device_token_stale_1234567890",
      resumeToken: "resume_token_stale_1234567890",
    });
    values.delete("forge.mobile.host-secret.v1.host_stale");

    await expect(reconcileHostsWithSecrets()).resolves.toEqual({
      hosts: [],
      invalidatedHostIds: ["host_stale"],
    });
    await expect(listHosts()).resolves.toEqual([]);
  });
});
