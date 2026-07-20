import * as Crypto from "expo-crypto";
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
  mobileRpcFrameV1Schema,
  type ForgeMobilePairingOfferV1,
  type MobileRpcFrameV1,
  type MobileRpcMethod,
} from "@forge/mobile-protocol";
import { rpcTimeoutMs } from "./rpc-timeout-policy";

type RpcResponse = Extract<MobileRpcFrameV1, { type: "rpc.response" }>;
type RpcEvent = Extract<MobileRpcFrameV1, { type: "rpc.event" }>;

export interface MobileRelayState {
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
  timer?: ReturnType<typeof setTimeout>;
  subscriptionId?: string;
}

export type MobileConnectionState = "connecting" | "authenticated" | "closed" | "error";

export type MobileRunRuntime = {
  provider: string;
  model?: string;
  permissionMode?: string;
  sandboxMode?: string;
  effort?: string;
};

export type MobileRunStartParams = {
  cwd: string;
  message: string;
  sessionId?: string | null;
  runtime?: MobileRunRuntime;
};

export class MobileRelayClient {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly subscriptions = new Map<string, (event: RpcEvent) => void>();
  private sealer: SecretboxFrameSealer | null = null;
  private opener: SecretboxFrameOpener | null = null;
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly state: MobileRelayState,
    private readonly onState?: (state: MobileConnectionState, error?: string) => void,
  ) {}

  static async pair(
    offer: ForgeMobilePairingOfferV1,
    onState?: (state: MobileConnectionState, error?: string) => void,
  ): Promise<MobileRelayClient> {
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
      onState,
    );
  }

  static async resume(
    state: MobileRelayState,
    onState?: (state: MobileConnectionState, error?: string) => void,
  ): Promise<MobileRelayClient> {
    validateState(state);
    return this.connect(
      state,
      { kind: "resume", credential: state.resumeToken, deviceToken: state.deviceToken },
      onState,
    );
  }

  private static async connect(
    state: MobileRelayState,
    auth:
      | { kind: "invite"; credential: string; pairingSecret: string }
      | { kind: "resume"; credential: string; deviceToken: string },
    onState?: (state: MobileConnectionState, error?: string) => void,
  ): Promise<MobileRelayClient> {
    onState?.("connecting");
    let socket: WebSocket | null = null;
    try {
      socket = await openPhoneSocket(state, auth.kind, auth.credential);
      const client = new MobileRelayClient(socket, state, onState);
      const inbox = new BinaryInbox(socket);
      await client.handshake(inbox, auth);
      client.startRpcLoop(inbox);
      onState?.("authenticated");
      return client;
    } catch (error) {
      socket?.close(1000, "handshake failed");
      onState?.("error", publicConnectionError(error));
      throw error;
    }
  }

  async call(
    method: MobileRpcMethod,
    params: unknown = {},
    options?: { subscriptionId?: string; onEvent?: (event: RpcEvent) => void },
  ): Promise<unknown> {
    if (this.closed) throw new Error("Mobile connection is closed");
    const id = opaqueId("request");
    if (options?.subscriptionId && options.onEvent) {
      this.subscriptions.set(options.subscriptionId, options.onEvent);
    }
    const response = new Promise<unknown>((resolve, reject) => {
      const timeoutMs = rpcTimeoutMs(method);
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
          this.pending.delete(id);
          if (options?.subscriptionId) this.subscriptions.delete(options.subscriptionId);
          reject(new Error("Mobile RPC request timed out"));
        }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        ...(timer ? { timer } : {}),
        subscriptionId: options?.subscriptionId,
      });
    });
    try {
      this.sendEncrypted({ type: "rpc.request", id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending?.timer) clearTimeout(pending.timer);
      this.pending.delete(id);
      if (options?.subscriptionId) this.subscriptions.delete(options.subscriptionId);
      throw error;
    }
    return response;
  }

  startRun(
    params: MobileRunStartParams,
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
    if (!this.closed && this.sealer) {
      this.sendEncrypted({ type: "rpc.unsubscribe", subscriptionId });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, "client closed");
    this.rejectAll(new Error("Mobile connection closed"));
    this.onState?.("closed");
  }

  private async handshake(
    inbox: BinaryInbox,
    auth:
      | { kind: "invite"; credential: string; pairingSecret: string }
      | { kind: "resume"; credential: string; deviceToken: string },
  ): Promise<void> {
    const ephemeral = generateX25519KeyPair((length) => Crypto.getRandomBytes(length));
    const clientNonce = Crypto.getRandomBytes(32);
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
    );
    const ready = e2eeReadyV1Schema.parse(
      JSON.parse(new TextDecoder().decode(await inbox.next(10_000))),
    );
    if (ready.hostE2eePublicKey !== this.state.hostE2eePublicKey) {
      throw new Error("Host E2EE identity changed");
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
      throw new Error("Host handshake transcript mismatch");
    }
    const sharedSecret = deriveX25519SharedSecret(
      ephemeral.secretKey,
      decodeKey(this.state.hostE2eePublicKey),
    );
    const keys = deriveMobileSessionKeys({
      sharedSecret,
      clientNonce,
      serverNonce: decodeKey(ready.serverNonce),
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
      throw new Error("Host authentication response mismatch");
    }
  }

  private startRpcLoop(inbox: BinaryInbox): void {
    void (async () => {
      try {
        while (!this.closed) {
          const frame = mobileRpcFrameV1Schema.parse(
            JSON.parse(new TextDecoder().decode(this.openEncrypted(await inbox.next()))),
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
          const safe = new Error(publicConnectionError(error));
          this.rejectAll(safe);
          this.onState?.("error", safe.message);
          this.socket.close(1008, "protocol error");
        }
      }
    })();
  }

  private handleResponse(frame: RpcResponse): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
  }

  private sendEncrypted(value: unknown): void {
    if (!this.sealer) throw new Error("Mobile E2EE session is not ready");
    this.socket.send(this.sealer.seal("text", new TextEncoder().encode(JSON.stringify(value))));
  }

  private openEncrypted(frame: Uint8Array): Uint8Array {
    if (!this.opener) throw new Error("Mobile E2EE session is not ready");
    return this.opener.open(frame, "text").payload;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.subscriptionId) this.subscriptions.delete(pending.subscriptionId);
      pending.reject(error);
    }
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
  private messageChain = Promise.resolve();

  constructor(socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      this.messageChain = this.messageChain
        .then(async () => this.push(await eventBytes(event.data)))
        .catch(() => this.fail(new Error("Relay returned an invalid binary frame")));
    };
    socket.onclose = () => this.fail(new Error("Relay data connection closed"));
    socket.onerror = () => this.fail(new Error("Relay data connection failed"));
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

  private push(value: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (!waiter) this.queue.push(value);
    else {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
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
  state: MobileRelayState,
  kind: "invite" | "resume",
  credential: string,
): Promise<WebSocket> {
  const url = new URL(`/v1/connect/${encodeURIComponent(state.hostId)}`, `${state.relayOrigin}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  type RNWebSocketConstructor = new (
    url: string,
    protocols?: string[] | string | null,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  return new Promise((resolve, reject) => {
    const socket = new (WebSocket as unknown as RNWebSocketConstructor)(url.toString(), [], {
      headers: {
        Authorization: `Bearer ${credential}`,
        "X-Forge-Credential-Kind": kind,
        ...(kind === "resume" ? { "X-Forge-Device-ID": state.deviceId } : {}),
      },
    });
    const timer = setTimeout(() => {
      socket.close(1000, "connect timeout");
      reject(new Error("Relay connection timed out"));
    }, 10_000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Relay connection failed"));
    };
  });
}

async function eventBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new Error("Relay frame is not binary");
}

function encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeKey(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=");
  const binary = globalThis.atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length !== 32 || encode(bytes) !== value) throw new Error("Invalid E2EE key");
  return bytes;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${encode(Crypto.getRandomBytes(12))}`;
}

function validateState(state: MobileRelayState): void {
  if (state.version !== 1) throw new Error("Unsupported Mobile state version");
  new URL(state.relayOrigin);
  decodeKey(state.hostE2eePublicKey);
  if (!state.hostId || !state.deviceId || !state.deviceToken || !state.resumeToken) {
    throw new Error("Mobile state is incomplete");
  }
}

function publicConnectionError(error: unknown): string {
  const text = error instanceof Error ? error.message : "Mobile connection failed";
  if (/401|403|credential|token|unauthor|forbidden/i.test(text)) return "连接凭证已失效，请在 Desktop 重新配对";
  if (/identity|transcript|E2EE|decrypt|frame|protocol/i.test(text)) return "端到端安全校验失败，连接已关闭";
  if (/timeout/i.test(text)) return "连接 Relay 超时，请检查网络后重试";
  return text.slice(0, 180);
}
