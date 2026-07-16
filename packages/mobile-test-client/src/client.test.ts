import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  SecretboxFrameOpener,
  SecretboxFrameSealer,
  deriveMobileSessionKeys,
  deriveX25519SharedSecret,
  generateX25519KeyPair,
  hashHandshakeTranscript,
  type MobileHandshakeTranscript,
} from "@forge/mobile-crypto";
import { e2eeAuthV1Schema, e2eeHelloV1Schema, mobileRpcFrameV1Schema } from "@forge/mobile-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { MobileRelayTestClient, type MobileTestClientState } from "./client.js";

const servers: WebSocketServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("MobileRelayTestClient", () => {
  it("resumes through Relay-shaped WebSocket auth, E2EE, and Mobile RPC", async () => {
    const hostKey = generateX25519KeyPair();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(wss);
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as AddressInfo).port;
    const state: MobileTestClientState = {
      version: 1,
      relayOrigin: `http://127.0.0.1:${port}`,
      hostId: "host_00000001",
      hostE2eePublicKey: encode(hostKey.publicKey),
      deviceId: "device_000001",
      deviceToken: "device_test_token_00000000000000000001",
      resumeToken: "resume_test_token_00000000000000000001",
    };
    const serverDone = new Promise<void>((resolve, reject) => {
      wss.once("connection", (socket, request) => {
        void serveHost(socket, request.headers, state, hostKey.secretKey)
          .then(resolve)
          .catch(reject);
      });
    });

    const client = await MobileRelayTestClient.resume(state);
    try {
      await expect(client.call("session.list", { limit: 20 })).resolves.toEqual({
        sessions: [{ id: "session_0001", cwd: "/workspace/project" }],
      });
      await serverDone;
    } finally {
      client.close();
    }
  });
});

async function serveHost(
  socket: WebSocket,
  headers: Record<string, string | string[] | undefined>,
  state: MobileTestClientState,
  hostSecretKey: Uint8Array,
): Promise<void> {
  expect(headers.authorization).toBe(`Bearer ${state.resumeToken}`);
  expect(headers["x-forge-credential-kind"]).toBe("resume");
  expect(headers["x-forge-device-id"]).toBe(state.deviceId);
  const inbox = new Inbox(socket);
  const hello = e2eeHelloV1Schema.parse(
    JSON.parse(new TextDecoder().decode(await inbox.next())),
  );
  const serverNonce = randomBytes(32);
  const transcript: MobileHandshakeTranscript = {
    protocolVersion: 1,
    phoneEphemeralPublicKey: hello.phoneEphemeralPublicKey,
    hostE2eePublicKey: state.hostE2eePublicKey,
    clientNonce: hello.clientNonce,
    serverNonce: encode(serverNonce),
    hostId: state.hostId,
    deviceId: state.deviceId,
    relayOrigin: state.relayOrigin,
    transport: "relay",
    selectedFraming: "secretbox-v1",
    capabilities: hello.capabilities,
  };
  const transcriptHash = hashHandshakeTranscript(transcript);
  socket.send(
    new TextEncoder().encode(
      JSON.stringify({
        type: "e2ee.ready",
        version: 1,
        hostE2eePublicKey: state.hostE2eePublicKey,
        serverNonce: encode(serverNonce),
        selectedFraming: "secretbox-v1",
        transcriptHash: encode(transcriptHash),
      }),
    ),
    { binary: true },
  );
  const sharedSecret = deriveX25519SharedSecret(
    hostSecretKey,
    decode(hello.phoneEphemeralPublicKey),
  );
  const keys = deriveMobileSessionKeys({
    sharedSecret,
    clientNonce: decode(hello.clientNonce),
    serverNonce,
    transcriptHash,
  });
  const opener = new SecretboxFrameOpener(keys.phoneToHostKey, keys.sessionId, "phone_to_host");
  const sealer = new SecretboxFrameSealer(keys.hostToPhoneKey, keys.sessionId, "host_to_phone");
  const auth = e2eeAuthV1Schema.parse(
    JSON.parse(
      new TextDecoder().decode(opener.open(await inbox.next(), "text").payload),
    ),
  );
  expect(auth).toMatchObject({ deviceId: state.deviceId, deviceToken: state.deviceToken });
  sendEncrypted(socket, sealer, {
    type: "e2ee.authenticated",
    deviceId: state.deviceId,
    transcriptHash: encode(transcriptHash),
    permissionsDigest: encode(randomBytes(32)),
  });
  const request = mobileRpcFrameV1Schema.parse(
    JSON.parse(
      new TextDecoder().decode(opener.open(await inbox.next(), "text").payload),
    ),
  );
  expect(request).toMatchObject({ type: "rpc.request", method: "session.list" });
  if (request.type !== "rpc.request") throw new Error("expected RPC request");
  sendEncrypted(socket, sealer, {
    type: "rpc.response",
    id: request.id,
    ok: true,
    result: { sessions: [{ id: "session_0001", cwd: "/workspace/project" }] },
  });
}

class Inbox {
  private queue: Uint8Array[] = [];
  private waiters: Array<(value: Uint8Array) => void> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (raw, isBinary) => {
      if (!isBinary) return;
      const value = bytes(raw);
      const waiter = this.waiters.shift();
      if (waiter) waiter(value);
      else this.queue.push(value);
    });
  }

  next(): Promise<Uint8Array> {
    const value = this.queue.shift();
    return value ? Promise.resolve(value) : new Promise((resolve) => this.waiters.push(resolve));
  }
}

function sendEncrypted(
  socket: WebSocket,
  sealer: SecretboxFrameSealer,
  value: unknown,
): void {
  socket.send(
    sealer.seal("text", new TextEncoder().encode(JSON.stringify(value))),
    { binary: true },
  );
}

function bytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return Uint8Array.from(raw);
  if (Array.isArray(raw)) return Uint8Array.from(Buffer.concat(raw));
  return Uint8Array.from(new Uint8Array(raw));
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}
