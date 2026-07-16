import { randomBytes } from "node:crypto";
import {
  SecretboxFrameOpener,
  SecretboxFrameSealer,
  deriveMobileSessionKeys,
  derivePairingCredentials,
  deriveX25519SharedSecret,
  generateX25519KeyPair,
  hashHandshakeTranscript,
  type MobileHandshakeTranscript,
} from "@forge/mobile-crypto";
import {
  e2eeAuthenticatedV1Schema,
  e2eeReadyV1Schema,
  forgeMobilePairingOfferV1Schema,
  mobileRpcFrameV1Schema,
  type ForgeMobilePairingOfferV1,
  type MobileRpcFrameV1,
  type MobileRpcMethod,
} from "@forge/mobile-protocol";
import WebSocket, { type RawData } from "ws";

type RpcResponse = Extract<MobileRpcFrameV1, { type: "rpc.response" }>;
type RpcEvent = Extract<MobileRpcFrameV1, { type: "rpc.event" }>;

export interface MobileTestClientState {
  version: 1;
  relayOrigin: string;
  hostId: string;
  hostE2eePublicKey: string;
  deviceId: string;
  deviceToken: string;
  resumeToken: string;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class MobileRelayTestClient {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly subscriptions = new Map<string, (event: RpcEvent) => void>();
  private sealer: SecretboxFrameSealer | null = null;
  private opener: SecretboxFrameOpener | null = null;
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly state: MobileTestClientState,
  ) {}

  static async pair(offerInput: unknown): Promise<MobileRelayTestClient> {
    const offer = forgeMobilePairingOfferV1Schema.parse(offerInput);
    const credentials = derivePairingCredentials(offer.pairingSecret);
    return this.connect(
      {
        version: 1,
        relayOrigin: offer.relayOrigin,
        hostId: offer.hostId,
        hostE2eePublicKey: offer.hostE2eePublicKey,
        deviceId: offer.deviceId,
        ...credentials,
      },
      { kind: "invite", credential: offer.inviteToken, pairingSecret: offer.pairingSecret },
    );
  }

  static async resume(state: MobileTestClientState): Promise<MobileRelayTestClient> {
    validateState(state);
    return this.connect(state, {
      kind: "resume",
      credential: state.resumeToken,
      deviceToken: state.deviceToken,
    });
  }

  private static async connect(
    state: MobileTestClientState,
    auth:
      | { kind: "invite"; credential: string; pairingSecret: string }
      | { kind: "resume"; credential: string; deviceToken: string },
  ): Promise<MobileRelayTestClient> {
    const socket = await openPhoneSocket(state, auth.kind, auth.credential);
    const client = new MobileRelayTestClient(socket, state);
    const inbox = new BinaryInbox(socket);
    await client.handshake(inbox, auth);
    client.startRpcLoop(inbox);
    return client;
  }

  async call(
    method: MobileRpcMethod,
    params: unknown = {},
    options?: { subscriptionId?: string; onEvent?: (event: RpcEvent) => void },
  ): Promise<unknown> {
    if (this.closed) throw new Error("Mobile test client is closed");
    const id = opaqueId("request");
    if (options?.subscriptionId && options.onEvent) {
      this.subscriptions.set(options.subscriptionId, options.onEvent);
    }
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      this.sendEncrypted({ type: "rpc.request", id, method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  startRun(
    params: {
      cwd: string;
      message: string;
      sessionId?: string | null;
      runtime?: Record<string, unknown>;
    },
    onEvent: (event: RpcEvent) => void,
  ): { subscriptionId: string; result: Promise<unknown> } {
    const subscriptionId = opaqueId("subscription");
    return {
      subscriptionId,
      result: this.call(
        "run.start",
        { ...params, subscriptionId },
        { subscriptionId, onEvent },
      ),
    };
  }

  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
    this.sendEncrypted({ type: "rpc.unsubscribe", subscriptionId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, "test complete");
    this.rejectAll(new Error("Mobile test client closed"));
  }

  private async handshake(
    inbox: BinaryInbox,
    auth:
      | { kind: "invite"; credential: string; pairingSecret: string }
      | { kind: "resume"; credential: string; deviceToken: string },
  ): Promise<void> {
    const ephemeral = generateX25519KeyPair((length) => randomBytes(length));
    const clientNonce = randomBytes(32);
    const capabilities = ["rpc", "events", "permission.pending"];
    this.socket.send(
      new TextEncoder().encode(
        JSON.stringify({
          type: "e2ee.hello",
          version: 1,
          phoneEphemeralPublicKey: encode(ephemeral.publicKey),
          clientNonce: encode(clientNonce),
          hostId: this.state.hostId,
          deviceId: this.state.deviceId,
          transport: "relay",
          capabilities,
        }),
      ),
      { binary: true },
    );
    const ready = e2eeReadyV1Schema.parse(
      JSON.parse(new TextDecoder().decode(await inbox.next(10_000))),
    );
    if (ready.hostE2eePublicKey !== this.state.hostE2eePublicKey) {
      throw new Error("host E2EE key mismatch");
    }
    const transcript: MobileHandshakeTranscript = {
      protocolVersion: 1,
      phoneEphemeralPublicKey: encode(ephemeral.publicKey),
      hostE2eePublicKey: this.state.hostE2eePublicKey,
      clientNonce: encode(clientNonce),
      serverNonce: ready.serverNonce,
      hostId: this.state.hostId,
      deviceId: this.state.deviceId,
      relayOrigin: this.state.relayOrigin,
      transport: "relay",
      selectedFraming: "secretbox-v1",
      capabilities,
    };
    const transcriptHash = hashHandshakeTranscript(transcript);
    if (encode(transcriptHash) !== ready.transcriptHash) {
      throw new Error("host transcript hash mismatch");
    }
    const sharedSecret = deriveX25519SharedSecret(
      ephemeral.secretKey,
      decode(this.state.hostE2eePublicKey),
    );
    const keys = deriveMobileSessionKeys({
      sharedSecret,
      clientNonce,
      serverNonce: decode(ready.serverNonce),
      transcriptHash,
    });
    this.sealer = new SecretboxFrameSealer(keys.phoneToHostKey, keys.sessionId, "phone_to_host");
    this.opener = new SecretboxFrameOpener(keys.hostToPhoneKey, keys.sessionId, "host_to_phone");
    this.sendEncrypted({
      type: "e2ee.auth",
      deviceId: this.state.deviceId,
      ...(auth.kind === "invite"
        ? { pairingSecret: auth.pairingSecret }
        : { deviceToken: auth.deviceToken }),
      transcriptHash: encode(transcriptHash),
    });
    const authenticated = e2eeAuthenticatedV1Schema.parse(
      JSON.parse(new TextDecoder().decode(this.openEncrypted(await inbox.next(10_000)))),
    );
    if (
      authenticated.deviceId !== this.state.deviceId ||
      authenticated.transcriptHash !== encode(transcriptHash)
    ) {
      throw new Error("host authentication response mismatch");
    }
  }

  private startRpcLoop(inbox: BinaryInbox): void {
    void (async () => {
      try {
        while (!this.closed) {
          const plaintext = this.openEncrypted(await inbox.next());
          const frame = mobileRpcFrameV1Schema.parse(
            JSON.parse(new TextDecoder().decode(plaintext)),
          );
          if (frame.type === "rpc.response") this.handleResponse(frame);
          else if (frame.type === "rpc.event") this.subscriptions.get(frame.subscriptionId)?.(frame);
          else if (frame.type === "rpc.ping") {
            this.sendEncrypted({ type: "rpc.pong", timestamp: frame.timestamp });
          }
        }
      } catch (error) {
        if (!this.closed) {
          this.closed = true;
          this.rejectAll(error instanceof Error ? error : new Error("Mobile RPC connection failed"));
          this.socket.close(1008, "client protocol error");
        }
      }
    })();
  }

  private handleResponse(frame: RpcResponse): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
  }

  private sendEncrypted(value: unknown): void {
    if (!this.sealer) throw new Error("Mobile E2EE session is not ready");
    const payload = new TextEncoder().encode(JSON.stringify(value));
    this.socket.send(this.sealer.seal("text", payload), { binary: true });
  }

  private openEncrypted(frame: Uint8Array): Uint8Array {
    if (!this.opener) throw new Error("Mobile E2EE session is not ready");
    return this.opener.open(frame, "text").payload;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

class BinaryInbox {
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: Array<{
    resolve: (value: Uint8Array) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];
  private terminalError: Error | null = null;

  constructor(socket: WebSocket) {
    socket.on("message", (raw, isBinary) => {
      if (!isBinary) return this.fail(new Error("Relay data frame must be binary"));
      const value = rawBytes(raw);
      const waiter = this.waiters.shift();
      if (waiter) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else {
        this.queue.push(value);
      }
    });
    socket.once("close", () => this.fail(new Error("Relay data connection closed")));
    socket.once("error", (error) => this.fail(error));
  }

  next(timeoutMs?: number): Promise<Uint8Array> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject };
      if (timeoutMs) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Mobile handshake timed out"));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

async function openPhoneSocket(
  state: MobileTestClientState,
  kind: "invite" | "resume",
  credential: string,
): Promise<WebSocket> {
  const url = new URL(`/v1/connect/${encodeURIComponent(state.hostId)}`, `${state.relayOrigin}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${credential}`,
        "x-forge-credential-kind": kind,
        ...(kind === "resume" ? { "x-forge-device-id": state.deviceId } : {}),
      },
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Relay phone connection timed out"));
    }, 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function rawBytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return Uint8Array.from(raw);
  if (Array.isArray(raw)) return Uint8Array.from(Buffer.concat(raw));
  return Uint8Array.from(new Uint8Array(raw));
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("invalid canonical 32-byte base64url value");
  }
  return Uint8Array.from(bytes);
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function validateState(state: MobileTestClientState): void {
  if (state.version !== 1) throw new Error("unsupported Mobile test state version");
  new URL(state.relayOrigin);
  decode(state.hostE2eePublicKey);
  if (!state.hostId || !state.deviceId || !state.deviceToken || !state.resumeToken) {
    throw new Error("Mobile test state is incomplete");
  }
}
