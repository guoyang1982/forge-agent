import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FrameOpenError,
  SecretboxFrameOpener,
  SecretboxFrameSealer,
  canonicalizeTranscript,
  deriveMobileSessionKeys,
  derivePairingCredentials,
  deriveX25519SharedSecret,
  generateX25519KeyPair,
  hashHandshakeTranscript,
  openSecretboxFrame,
  sealSecretboxFrame,
  type MobileHandshakeTranscript,
} from "./index.js";

const transcript: MobileHandshakeTranscript = {
  protocolVersion: 1,
  phoneEphemeralPublicKey: "phone-key",
  hostE2eePublicKey: "host-key",
  clientNonce: "client-nonce",
  serverNonce: "server-nonce",
  hostId: "host_00000001",
  deviceId: "device_000001",
  relayOrigin: "https://relay.example.com",
  transport: "relay",
  selectedFraming: "secretbox-v1",
  capabilities: ["binary", "rpc", "rpc"],
};

describe("mobile crypto v1", () => {
  it("derives stable, domain-separated device and Relay resume credentials", () => {
    const credentials = derivePairingCredentials(
      Buffer.from(sequence(32, 1)).toString("base64url"),
    );
    expect(credentials.deviceToken).toMatch(/^device_[A-Za-z0-9_-]{43}$/);
    expect(credentials.resumeToken).toMatch(/^resume_[A-Za-z0-9_-]{43}$/);
    expect(credentials.deviceToken.slice(7)).not.toBe(credentials.resumeToken.slice(7));
    expect(derivePairingCredentials(Buffer.from(sequence(32, 1)).toString("base64url"))).toEqual(
      credentials,
    );
  });
  it("derives the same X25519 shared secret on both peers", () => {
    const phone = generateX25519KeyPair((length) => sequence(length, 1));
    const host = generateX25519KeyPair((length) => sequence(length, 101));
    expect(
      Buffer.from(
        deriveX25519SharedSecret(phone.secretKey, host.publicKey),
      ).toString("hex"),
    ).toBe(
      Buffer.from(
        deriveX25519SharedSecret(host.secretKey, phone.publicKey),
      ).toString("hex"),
    );
  });

  it("canonicalizes capability ordering and binds relay origin", () => {
    expect(canonicalizeTranscript(transcript)).toContain(
      '"capabilities":["binary","rpc"]',
    );
    expect(hex(hashHandshakeTranscript(transcript))).not.toBe(
      hex(
        hashHandshakeTranscript({
          ...transcript,
          relayOrigin: "https://other.example.com",
        }),
      ),
    );
    expect(hex(hashHandshakeTranscript(transcript))).not.toBe(
      hex(hashHandshakeTranscript({ ...transcript, hostId: "host_99999999" })),
    );
    expect(hex(hashHandshakeTranscript(transcript))).not.toBe(
      hex(
        hashHandshakeTranscript({
          ...transcript,
          transport: "direct" as "relay",
        }),
      ),
    );
  });

  it("rejects low-order X25519 peer keys", () => {
    expect(() =>
      deriveX25519SharedSecret(sequence(32, 1), new Uint8Array(32)),
    ).toThrow(/low-order/);
  });

  it("derives three domain-separated 32-byte session values", () => {
    const keys = deriveMobileSessionKeys({
      sharedSecret: sequence(32, 1),
      clientNonce: sequence(32, 33),
      serverNonce: sequence(32, 65),
      transcriptHash: hashHandshakeTranscript(transcript),
    });
    expect(keys.phoneToHostKey).toHaveLength(32);
    expect(keys.hostToPhoneKey).toHaveLength(32);
    expect(keys.sessionId).toHaveLength(32);
    expect(hex(keys.phoneToHostKey)).not.toBe(hex(keys.hostToPhoneKey));
    expect(hex(keys.hostToPhoneKey)).not.toBe(hex(keys.sessionId));
  });

  it("matches the frozen cross-runtime v1 test vector", () => {
    const vector = JSON.parse(
      readFileSync(
        new URL("../../../protocol/mobile-crypto/v1/test-vector.json", import.meta.url),
        "utf8",
      ),
    ) as {
      phoneSecretKey: string;
      phonePublicKey: string;
      hostSecretKey: string;
      hostPublicKey: string;
      sharedSecret: string;
      clientNonce: string;
      serverNonce: string;
      transcript: MobileHandshakeTranscript;
      canonicalTranscript: string;
      transcriptHash: string;
      phoneToHostKey: string;
      hostToPhoneKey: string;
      sessionId: string;
      payloadUtf8: string;
      sealedTextFrame: string;
    };
    const phoneSecret = fromHex(vector.phoneSecretKey);
    const hostSecret = fromHex(vector.hostSecretKey);
    const phonePublic = generateX25519KeyPair(() => phoneSecret).publicKey;
    const hostPublic = generateX25519KeyPair(() => hostSecret).publicKey;
    expect(hex(phonePublic)).toBe(vector.phonePublicKey);
    expect(hex(hostPublic)).toBe(vector.hostPublicKey);
    const shared = deriveX25519SharedSecret(phoneSecret, hostPublic);
    expect(hex(shared)).toBe(vector.sharedSecret);
    expect(canonicalizeTranscript(vector.transcript)).toBe(
      vector.canonicalTranscript,
    );
    const transcriptHash = hashHandshakeTranscript(vector.transcript);
    expect(hex(transcriptHash)).toBe(vector.transcriptHash);
    const keys = deriveMobileSessionKeys({
      sharedSecret: shared,
      clientNonce: fromHex(vector.clientNonce),
      serverNonce: fromHex(vector.serverNonce),
      transcriptHash,
    });
    expect(hex(keys.phoneToHostKey)).toBe(vector.phoneToHostKey);
    expect(hex(keys.hostToPhoneKey)).toBe(vector.hostToPhoneKey);
    expect(hex(keys.sessionId)).toBe(vector.sessionId);
    expect(
      hex(
        sealSecretboxFrame({
          key: keys.phoneToHostKey,
          sessionId: keys.sessionId,
          direction: "phone_to_host",
          payloadKind: "text",
          counter: 0n,
          payload: new TextEncoder().encode(vector.payloadUtf8),
        }),
      ),
    ).toBe(vector.sealedTextFrame);
  });

  it("round-trips frames and rejects replay, wrong kind, and tampering", () => {
    const key = sequence(32, 1);
    const sessionId = sequence(32, 90);
    const sealer = new SecretboxFrameSealer(key, sessionId, "phone_to_host");
    const opener = new SecretboxFrameOpener(key, sessionId, "phone_to_host");
    const frame = sealer.seal("text", new TextEncoder().encode("hello"));
    const opened = opener.open(frame, "text");
    expect(new TextDecoder().decode(opened.payload)).toBe("hello");

    expect(() => opener.open(frame, "text")).toThrowError(
      expect.objectContaining({ code: "counter_mismatch", fatal: true }),
    );

    const binaryFrame = sealer.seal("binary", Uint8Array.of(1, 2, 3));
    expect(() => opener.open(binaryFrame, "text")).toThrowError(
      expect.objectContaining({ code: "payload_kind_mismatch", fatal: true }),
    );
  });

  it("rejects skipped and out-of-order counters", () => {
    const key = sequence(32, 1);
    const sessionId = sequence(32, 90);
    const skipped = sealSecretboxFrame({
      key,
      sessionId,
      direction: "phone_to_host",
      payloadKind: "text",
      counter: 2n,
      payload: new TextEncoder().encode("skipped"),
    });
    expect(() =>
      openSecretboxFrame({
        key,
        sessionId,
        direction: "phone_to_host",
        expectedPayloadKind: "text",
        expectedCounter: 0n,
        frame: skipped,
      }),
    ).toThrowError(expect.objectContaining({ code: "counter_mismatch", fatal: true }));
  });

  it("marks the fifth consecutive authentication failure as fatal", () => {
    const key = sequence(32, 1);
    const sessionId = sequence(32, 90);
    const sealer = new SecretboxFrameSealer(key, sessionId, "phone_to_host");
    const opener = new SecretboxFrameOpener(key, sessionId, "phone_to_host");
    const tampered = sealer.seal("text", new TextEncoder().encode("secret"));
    tampered[tampered.length - 1] ^= 1;

    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(() => opener.open(tampered)).toThrowError(
        expect.objectContaining({ code: "authentication_failed", fatal: false }),
      );
    }
    try {
      opener.open(tampered);
      throw new Error("expected frame authentication to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(FrameOpenError);
      expect(error).toMatchObject({ code: "too_many_failures", fatal: true });
    }
  });
});

function sequence(length: number, start: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}
