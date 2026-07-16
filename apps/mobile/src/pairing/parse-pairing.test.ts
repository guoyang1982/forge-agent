import { describe, expect, it } from "vitest";
import { parsePairingUri } from "./parse-pairing.js";

const offer = {
  v: 1,
  relayOrigin: "https://relay.example.com",
  hostId: "host_12345678",
  hostE2eePublicKey: "A".repeat(43),
  deviceId: "device_12345678",
  pairingSecret: "B".repeat(43),
  inviteToken: `invite_${"x".repeat(32)}`,
  expiresAt: 2_000_000_000_000,
  protocolVersion: 1,
};

function uri(value: unknown): string {
  return `forge://pair?code=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

describe("parsePairingUri", () => {
  it("accepts a canonical unexpired pairing offer", () => {
    expect(parsePairingUri(uri(offer), offer.expiresAt - 5 * 60 * 1000)).toEqual(offer);
  });

  it("rejects wrong schemes and expired screenshots", () => {
    expect(() => parsePairingUri(uri(offer).replace("forge://", "https://"))).toThrow(
      "仅支持 forge://pair",
    );
    expect(() => parsePairingUri(uri(offer), offer.expiresAt)).toThrow("配对码已过期");
    expect(() => parsePairingUri(uri(offer), offer.expiresAt - 10 * 60 * 1000 - 1)).toThrow(
      "配对码有效期异常",
    );
  });
});
