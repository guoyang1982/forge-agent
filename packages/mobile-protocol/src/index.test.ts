import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  MOBILE_PAIRING_MAX_TTL_MS,
  mobileRpcFrameV1Schema,
  parseMobileRpcFrameV1,
  parsePairingOfferV1,
} from "./index.js";

interface ContractValidator {
  (value: unknown): boolean;
  errors?: unknown;
}

type AjvConstructor = new (options?: { strict?: boolean }) => {
  compile(schema: unknown): ContractValidator;
};

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as AjvConstructor;

const key32 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("mobile protocol v1", () => {
  it("keeps Relay golden fixtures aligned with the language-neutral schema", () => {
    const contractRoot = new URL("../../../protocol/relay/v1/", import.meta.url);
    const schema = JSON.parse(
      readFileSync(new URL("schemas/host-control.schema.json", contractRoot), "utf8"),
    );
    const validate = new Ajv2020({ strict: true }).compile(schema);
    const valid = readJsonLines(
      new URL("testdata/host-control.valid.jsonl", contractRoot),
    );
    const invalid = readJsonLines(
      new URL("testdata/host-control.invalid.jsonl", contractRoot),
    );
    for (const fixture of valid) {
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const fixture of invalid) {
      expect(validate(fixture)).toBe(false);
    }
  });

  it("accepts a canonical, short-lived pairing offer", () => {
    const now = 1_800_000_000_000;
    const offer = parsePairingOfferV1(
      {
        v: 1,
        relayOrigin: "https://relay.example.com",
        hostId: "host_12345678",
        hostE2eePublicKey: key32,
        deviceId: "device_12345678",
        pairingSecret: key32,
        inviteToken: "i".repeat(32),
        expiresAt: now + 60_000,
        protocolVersion: 1,
      },
      now,
    );
    expect(offer.hostId).toBe("host_12345678");
  });

  it("allows HTTP only for loopback end-to-end testing", () => {
    const now = 1_800_000_000_000;
    const base = {
      v: 1,
      hostId: "host_12345678",
      hostE2eePublicKey: key32,
      deviceId: "device_12345678",
      pairingSecret: key32,
      inviteToken: "i".repeat(32),
      expiresAt: now + 60_000,
      protocolVersion: 1,
    };
    expect(
      parsePairingOfferV1({ ...base, relayOrigin: "http://127.0.0.1:58080" }, now)
        .relayOrigin,
    ).toBe("http://127.0.0.1:58080");
    expect(() =>
      parsePairingOfferV1({ ...base, relayOrigin: "http://relay.example.com" }, now),
    ).toThrow();
  });

  it("rejects non-canonical origins and excessive TTLs", () => {
    const now = 1_800_000_000_000;
    const base = {
      v: 1,
      hostId: "host_12345678",
      hostE2eePublicKey: key32,
      deviceId: "device_12345678",
      pairingSecret: key32,
      inviteToken: "i".repeat(32),
      expiresAt: now + 60_000,
      protocolVersion: 1,
    };
    expect(() =>
      parsePairingOfferV1(
        { ...base, relayOrigin: "https://relay.example.com/path" },
        now,
      ),
    ).toThrow();
    expect(() =>
      parsePairingOfferV1(
        {
          ...base,
          relayOrigin: "https://relay.example.com",
          expiresAt: now + MOBILE_PAIRING_MAX_TTL_MS + 1,
        },
        now,
      ),
    ).toThrow(/TTL/);
  });

  it("rejects unknown mobile methods and fields", () => {
    expect(
      mobileRpcFrameV1Schema.safeParse({
        type: "rpc.request",
        id: "request_12345678",
        method: "get_config",
      }).success,
    ).toBe(false);
    expect(
      mobileRpcFrameV1Schema.safeParse({
        type: "rpc.request",
        id: "request_12345678",
        method: "status.get",
        skipConfirm: true,
      }).success,
    ).toBe(false);
  });

  it("enforces the control frame size limit before parsing", () => {
    expect(() => parseMobileRpcFrameV1("x".repeat(65 * 1024))).toThrow(
      /64 KiB/,
    );
  });
});

function readJsonLines(url: URL): unknown[] {
  return readFileSync(url, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
