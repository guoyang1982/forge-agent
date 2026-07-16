import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import nacl from "tweetnacl";
import WebSocket, { type RawData } from "ws";

const CONTROL_VERSION = 1;

interface PersistedHostIdentity {
  version: 1;
  identityPublicKey: string;
  identitySecretKey: string;
  e2eePublicKey: string;
  e2eeSecretKey: string;
  hostId?: string;
  hostCredential?: string;
  credentialVersion?: number;
}

export interface RelayConnectionOpen {
  connId: string;
  connTicket: string;
  deviceId: string;
  credentialKind: "invite" | "resume";
  attachDeadline: number;
}

export interface RelayDataConnection {
  readonly connection: RelayConnectionOpen;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: Uint8Array) => void): void;
  onClose(handler: () => void): void;
}

export interface RelayTransportOptions {
  relayOrigin: string;
  enrollmentToken?: string;
  identityPath: string;
  log: (level: "info" | "warn" | "error", message: string) => void;
  onDataConnection: (connection: RelayDataConnection) => void | Promise<void>;
  onState?: (state: "connecting" | "connected" | "disconnected" | "error", error?: string) => void;
}

interface PendingControl {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RelayTransport {
  private identity: PersistedHostIdentity;
  private control: WebSocket | null = null;
  private stopped = true;
  private runner: Promise<void> | null = null;
  private pending = new Map<string, PendingControl>();
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dataConnections = new Set<WebSocket>();
  private reconnectAbort: AbortController | null = null;

  constructor(private readonly options: RelayTransportOptions) {
    this.identity = loadOrCreateIdentity(options.identityPath);
  }

  get hostId(): string | undefined {
    return this.identity.hostId;
  }

  get e2eePublicKey(): Uint8Array {
    return decodeBase64Url(this.identity.e2eePublicKey, 32);
  }

  get e2eeSecretKey(): Uint8Array {
    return decodeBase64Url(this.identity.e2eeSecretKey, 32);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAbort = new AbortController();
    await this.ensureEnrolled();
    this.runner = this.reconnectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.reconnectAbort?.abort();
    this.reconnectAbort = null;
    this.clearTimers();
    this.control?.close(1000, "adapter stopped");
    this.control = null;
    for (const socket of this.dataConnections) socket.close(1000, "adapter stopped");
    this.dataConnections.clear();
    this.rejectPending(new Error("relay transport stopped"));
    await this.runner?.catch(() => undefined);
    this.runner = null;
  }

  async createInvite(deviceId: string, expiresInSeconds = 600): Promise<{
    inviteId: string;
    inviteToken: string;
    expiresAt: number;
  }> {
    const message = await this.request({
      type: "invite.create",
      deviceId,
      expiresInSeconds,
    });
    return {
      inviteId: requiredString(message, "inviteId"),
      inviteToken: requiredString(message, "inviteToken"),
      expiresAt: requiredNumber(message, "expiresAt"),
    };
  }

  async revokeInvite(inviteId: string): Promise<void> {
    await this.request({ type: "invite.revoke", inviteId });
  }

  async installDevice(
    deviceId: string,
    resumeTokenHash: string,
    credentialVersion: number,
  ): Promise<void> {
    await this.request({
      type: "device.install",
      deviceId,
      resumeTokenHash,
      credentialVersion,
    });
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.request({ type: "device.revoke", deviceId });
  }

  private async ensureEnrolled(): Promise<void> {
    if (this.identity.hostId && this.identity.hostCredential) return;
    if (!this.options.enrollmentToken) {
      throw new Error("Forge Mobile enrollment token is required for first enrollment");
    }
    const response = await this.post("/v1/hosts/enroll", {
      identityPublicKey: this.identity.identityPublicKey,
      e2eePublicKey: this.identity.e2eePublicKey,
    }, this.options.enrollmentToken);
    this.identity = {
      ...this.identity,
      hostId: requiredString(response, "hostId"),
      hostCredential: requiredString(response, "hostCredential"),
      credentialVersion: requiredNumber(response, "credentialVersion"),
    };
    saveIdentity(this.options.identityPath, this.identity);
  }

  private async reconnectLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.options.onState?.("connecting");
        await this.connectOnce();
        attempt = 0;
      } catch (error) {
        if (this.stopped) return;
        const message = publicTransportError(error);
        this.options.log("warn", `Relay control disconnected: ${message}`);
        this.options.onState?.("error", message);
      }
      if (this.stopped) return;
      this.options.onState?.("disconnected");
      const base = Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6));
      await delay(
        base + Math.floor(Math.random() * Math.max(100, base / 3)),
        this.reconnectAbort?.signal,
      );
    }
  }

  private async connectOnce(): Promise<void> {
    const token = await this.fetchHostToken();
    const socket = await openWebSocket(
      this.wsUrl("/v1/host/control"),
      `Bearer ${token.jwt}`,
    );
    this.control = socket;
    const helloRequestId = requestId();
    socket.send(
      JSON.stringify({
        v: CONTROL_VERSION,
        type: "host.hello",
        requestId: helloRequestId,
        hostId: this.identity.hostId,
        credentialVersion: this.identity.credentialVersion ?? 1,
      }),
    );
    const challenge = await nextControlMessage(socket, 10_000);
    if (challenge.type !== "host.challenge" || challenge.requestId !== helloRequestId) {
      throw new Error("Relay rejected host hello");
    }
    const challengeText = requiredString(challenge, "challenge");
    const signature = nacl.sign.detached(
      new TextEncoder().encode(challengeText),
      decodeBase64Url(this.identity.identitySecretKey, 64),
    );
    socket.send(
      JSON.stringify({
        v: CONTROL_VERSION,
        type: "host.proof",
        requestId: helloRequestId,
        signature: Buffer.from(signature).toString("base64url"),
      }),
    );
    const ready = await nextControlMessage(socket, 10_000);
    if (ready.type !== "host.ready" || ready.requestId !== helloRequestId) {
      throw new Error("Relay rejected host proof");
    }
    const leaseId = requiredString(ready, "leaseId");
    this.options.onState?.("connected");
    this.scheduleLeaseRenewal(leaseId, requiredNumber(ready, "leaseExpiresAt"));
    this.scheduleTokenRefresh(token.expiresAt);
    await new Promise<void>((resolve, reject) => {
      const onMessage = (raw: RawData, isBinary: boolean) => {
        if (isBinary) return;
        try {
          this.handleControl(JSON.parse(raw.toString()) as Record<string, unknown>);
        } catch (error) {
          this.options.log("warn", `Ignored invalid Relay control message: ${publicTransportError(error)}`);
        }
      };
      socket.on("message", onMessage);
      socket.once("close", () => resolve());
      socket.once("error", reject);
    });
    this.clearTimers();
    this.rejectPending(new Error("Relay control connection closed"));
    if (this.control === socket) this.control = null;
  }

  private handleControl(message: Record<string, unknown>): void {
    const type = requiredString(message, "type");
    if (type === "connection.open") {
      const opened: RelayConnectionOpen = {
        connId: requiredString(message, "connId"),
        connTicket: requiredString(message, "connTicket"),
        deviceId: requiredString(message, "deviceId"),
        credentialKind: requiredString(message, "credentialKind") as "invite" | "resume",
        attachDeadline: requiredNumber(message, "attachDeadline"),
      };
      void this.attachData(opened);
      return;
    }
    if (type === "ping") {
      this.send({ type: "pong", timestamp: requiredNumber(message, "timestamp") });
      return;
    }
    const id = typeof message.requestId === "string" ? message.requestId : "";
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (type === "error") {
      pending.reject(new Error(typeof message.message === "string" ? message.message : "Relay request failed"));
    } else {
      pending.resolve(message);
    }
  }

  private async attachData(opened: RelayConnectionOpen): Promise<void> {
    if (opened.attachDeadline <= Date.now()) return;
    try {
      const socket = await openWebSocket(
        this.wsUrl(`/v1/host/data/${encodeURIComponent(opened.connId)}`),
        `Bearer ${opened.connTicket}`,
      );
      this.dataConnections.add(socket);
      socket.once("close", () => this.dataConnections.delete(socket));
      await this.options.onDataConnection(wrapDataConnection(socket, opened));
    } catch (error) {
      this.options.log("warn", `Relay data attach failed: ${publicTransportError(error)}`);
    }
  }

  private request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = requestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Relay control request timed out"));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...body, requestId: id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Relay request failed"));
      }
    });
  }

  private send(body: Record<string, unknown>): void {
    if (!this.control || this.control.readyState !== WebSocket.OPEN) {
      throw new Error("Relay control is not connected");
    }
    this.control.send(JSON.stringify({ v: CONTROL_VERSION, ...body }));
  }

  private scheduleLeaseRenewal(leaseId: string, expiresAt: number): void {
    const delayMs = Math.max(1_000, (expiresAt - Date.now()) / 2);
    this.leaseTimer = setTimeout(() => {
      void this.request({ type: "lease.renew", leaseId })
        .then((message) =>
          this.scheduleLeaseRenewal(leaseId, requiredNumber(message, "leaseExpiresAt")),
        )
        .catch(() => this.control?.close(1011, "lease renewal failed"));
    }, delayMs);
  }

  private scheduleTokenRefresh(expiresAt: number): void {
    const delayMs = Math.max(1_000, expiresAt - Date.now() - 60_000);
    this.refreshTimer = setTimeout(() => {
      void this.fetchHostToken()
        .then((token) => {
          this.send({ type: "auth.refresh", requestId: requestId(), jwt: token.jwt });
          this.scheduleTokenRefresh(token.expiresAt);
        })
        .catch(() => this.control?.close(1011, "token refresh failed"));
    }, delayMs);
  }

  private async fetchHostToken(): Promise<{ jwt: string; expiresAt: number }> {
    const response = await this.post("/v1/hosts/token", {
      hostId: this.identity.hostId,
      credential: this.identity.hostCredential,
    });
    return {
      jwt: requiredString(response, "jwt"),
      expiresAt: requiredNumber(response, "expiresAt"),
    };
  }

  private async post(
    path: string,
    body: unknown,
    bearer?: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, `${this.options.relayOrigin}/`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Relay request returned HTTP ${response.status}`);
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Relay returned an invalid response");
    }
    return value as Record<string, unknown>;
  }

  private wsUrl(path: string): string {
    const url = new URL(path, `${this.options.relayOrigin}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private clearTimers(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.leaseTimer = null;
    this.refreshTimer = null;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function loadOrCreateIdentity(path: string): PersistedHostIdentity {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedHostIdentity;
    validateIdentity(parsed);
    chmodSync(path, 0o600);
    return parsed;
  }
  const identity = nacl.sign.keyPair();
  const e2eeSecretKey = randomBytes(32);
  const state: PersistedHostIdentity = {
    version: 1,
    identityPublicKey: Buffer.from(identity.publicKey).toString("base64url"),
    identitySecretKey: Buffer.from(identity.secretKey).toString("base64url"),
    e2eePublicKey: Buffer.from(nacl.scalarMult.base(e2eeSecretKey)).toString("base64url"),
    e2eeSecretKey: e2eeSecretKey.toString("base64url"),
  };
  saveIdentity(path, state);
  return state;
}

function saveIdentity(path: string, identity: PersistedHostIdentity): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function validateIdentity(identity: PersistedHostIdentity): void {
  if (identity.version !== 1) throw new Error("unsupported Mobile host identity version");
  decodeBase64Url(identity.identityPublicKey, 32);
  decodeBase64Url(identity.identitySecretKey, 64);
  decodeBase64Url(identity.e2eePublicKey, 32);
  decodeBase64Url(identity.e2eeSecretKey, 32);
}

function decodeBase64Url(value: string, length: number): Uint8Array {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== length || decoded.toString("base64url") !== value) {
    throw new Error("invalid Mobile host key material");
  }
  return Uint8Array.from(decoded);
}

async function openWebSocket(url: string, authorization: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization } });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Relay WebSocket connection timed out"));
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

function nextControlMessage(
  socket: WebSocket,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Relay control handshake timed out")), timeoutMs);
    const onMessage = (raw: RawData, isBinary: boolean) => {
      cleanup();
      if (isBinary) return reject(new Error("Relay control handshake must be text"));
      try {
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        reject(new Error("Relay control handshake returned invalid JSON"));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Relay closed during control handshake"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

function wrapDataConnection(
  socket: WebSocket,
  connection: RelayConnectionOpen,
): RelayDataConnection {
  return {
    connection,
    send(data) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("Relay data connection is closed");
      socket.send(data, { binary: true });
    },
    close(code = 1000, reason = "closed") {
      socket.close(code, reason);
    },
    onMessage(handler) {
      socket.on("message", (data, isBinary) => {
        if (isBinary) handler(Uint8Array.from(data as Buffer));
      });
    },
    onClose(handler) {
      socket.once("close", handler);
    },
  };
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error(`Relay response missing ${key}`);
  return field;
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Relay response missing ${key}`);
  }
  return field;
}

function requestId(): string {
  return `request_${randomBytes(12).toString("base64url")}`;
}

function publicTransportError(error: unknown): string {
  if (!(error instanceof Error)) return "transport error";
  return error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
