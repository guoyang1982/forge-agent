import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type {
  AdapterContext,
  ChannelAdapterHealth,
  InteractiveChannelAdapter,
} from "@forge/channel-core";
import {
  SecretboxFrameOpener,
  SecretboxFrameSealer,
  deriveMobileSessionKeys,
  derivePairingCredentials,
  deriveX25519SharedSecret,
  hashHandshakeTranscript,
  type MobileHandshakeTranscript,
} from "@forge/mobile-crypto";
import {
  MOBILE_PROTOCOL_VERSION,
  e2eeAuthV1Schema,
  e2eeHelloV1Schema,
  forgeMobilePairingOfferV1Schema,
  mobileRpcFrameV1Schema,
  type ForgeMobilePairingOfferV1,
} from "@forge/mobile-protocol";
import { z } from "zod";
import { MobileDeviceRegistry } from "./device-registry.js";
import type { MobileDeviceRecord } from "./device-registry.js";
import { MobileRpcRouter } from "./mobile-rpc-router.js";
import {
  RelayTransport,
  type RelayDataConnection,
} from "./relay-transport.js";

const configSchema = z
  .object({
    mobileEnabled: z.boolean().default(false),
    relayOrigin: z.string().url(),
    enrollmentToken: z.string().min(16).optional(),
    allowedProjects: z.array(z.string().min(1)).max(100).default([]),
    maxDevices: z.number().int().min(1).max(20).default(3),
    maxConcurrentRunsPerDevice: z.number().int().min(1).max(10).default(1),
    runPermission: z.enum(["allow", "confirm", "deny"]).default("deny"),
    approvePermission: z.enum(["allow", "confirm", "deny"]).default("deny"),
  })
  .passthrough();

export class MobileChannelAdapter implements InteractiveChannelAdapter {
  readonly kind = "mobile" as const;
  readonly capability = "interactive" as const;
  private ctx: AdapterContext | null = null;
  private registry: MobileDeviceRegistry | null = null;
  private router: MobileRpcRouter | null = null;
  private transport: RelayTransport | null = null;
  private status: ChannelAdapterHealth["status"] = "disconnected";
  private lastError: string | undefined;
  private readonly sessions = new Map<string, Set<RelayDataConnection>>();

  async start(ctx: AdapterContext): Promise<void> {
    if (this.ctx) return;
    const config = configSchema.parse(ctx.config);
    if (!config.mobileEnabled) throw new Error("Forge Mobile is disabled in permissions");
    this.ctx = ctx;
    this.registry = new MobileDeviceRegistry(join(ctx.dataDir, "data.db"), ctx.adapterId);
    this.router = new MobileRpcRouter({
      daemon: ctx.daemon,
      registry: this.registry,
      allowedProjects: config.allowedProjects,
      maxConcurrentRunsPerDevice: config.maxConcurrentRunsPerDevice,
      runPermission: config.runPermission,
      approvePermission: config.approvePermission,
    });
    this.transport = new RelayTransport({
      relayOrigin: config.relayOrigin,
      enrollmentToken: config.enrollmentToken,
      identityPath: join(ctx.dataDir, "mobile", ctx.adapterId, "host-identity.json"),
      log: ctx.log,
      onState: (state, error) => {
        this.status =
          state === "connected"
            ? "connected"
            : state === "connecting"
              ? "connecting"
              : state === "error"
                ? "error"
                : "disconnected";
        this.lastError = error;
        if (state === "connected") void this.flushRevocationOutbox();
      },
      onDataConnection: (connection) => this.acceptDataConnection(connection, config),
    });
    try {
      await this.transport.start();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const connections of this.sessions.values()) {
      for (const connection of connections) connection.close(1001, "adapter stopped");
    }
    this.sessions.clear();
    await this.transport?.stop();
    this.transport = null;
    this.registry?.close();
    this.registry = null;
    this.router = null;
    this.ctx = null;
    this.status = "disconnected";
  }

  async health(): Promise<ChannelAdapterHealth> {
    return {
      adapterId: this.ctx?.adapterId ?? "",
      kind: this.kind,
      status: this.status,
      lastError: this.lastError,
    };
  }

  async createPairingOffer(deviceName?: string): Promise<ForgeMobilePairingOfferV1> {
    const transport = required(this.transport, "Mobile Relay is not started");
    const registry = required(this.registry, "Mobile registry is not started");
    const config = configSchema.parse(required(this.ctx, "Mobile adapter is not started").config);
    const activeDevices = registry.list().filter((device) => !device.revokedAt);
    if (activeDevices.length >= config.maxDevices) throw new Error("Mobile device limit reached");
    for (const pending of registry.pendingPairings()) {
      await transport.revokeInvite(pending.inviteId);
      registry.revokePairing(pending.deviceId);
    }
    const deviceId = `device_${randomBytes(12).toString("base64url")}`;
    const pairingSecret = randomBytes(32).toString("base64url");
    registry.recordPairing({
      deviceId,
      inviteId: `pending_${randomBytes(10).toString("base64url")}`,
      pairingSecret,
      expiresAt: Date.now() + 10 * 60 * 1000,
      displayName: deviceName,
    });
    const invite = await transport.createInvite(deviceId, 600);
    registry.recordPairing({
      deviceId,
      inviteId: invite.inviteId,
      pairingSecret,
      expiresAt: invite.expiresAt,
      displayName: deviceName,
    });
    void deviceName;
    return forgeMobilePairingOfferV1Schema.parse({
      v: MOBILE_PROTOCOL_VERSION,
      relayOrigin: config.relayOrigin,
      hostId: transport.hostId,
      hostE2eePublicKey: Buffer.from(transport.e2eePublicKey).toString("base64url"),
      deviceId,
      pairingSecret,
      inviteToken: invite.inviteToken,
      expiresAt: invite.expiresAt,
      protocolVersion: MOBILE_PROTOCOL_VERSION,
    });
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const registry = required(this.registry, "Mobile registry is not started");
    const revoked = registry.revoke(deviceId);
    if (!revoked) return false;
    for (const connection of this.sessions.get(deviceId) ?? []) {
      connection.close(1008, "device revoked");
    }
    this.sessions.delete(deviceId);
    this.router?.disconnectDevice(deviceId);
    await this.flushRevocationOutbox();
    return true;
  }

  listDevices(): MobileDeviceRecord[] {
    return required(this.registry, "Mobile registry is not started").list();
  }

  updateDeviceProjects(deviceId: string, allowedProjects: string[]): MobileDeviceRecord {
    const ctx = required(this.ctx, "Mobile adapter is not started");
    const registry = required(this.registry, "Mobile registry is not started");
    const config = configSchema.parse(ctx.config);
    const grants = validateDeviceProjectGrants(config.allowedProjects, allowedProjects);
    const device = registry.updateAllowedProjects(deviceId, grants);
    if (!device) throw new Error("Active Mobile device not found");
    return device;
  }

  private async acceptDataConnection(
    connection: RelayDataConnection,
    config: z.infer<typeof configSchema>,
  ): Promise<void> {
    const ctx = required(this.ctx, "Mobile adapter is stopped");
    const transport = required(this.transport, "Mobile Relay is stopped");
    const registry = required(this.registry, "Mobile registry is stopped");
    const router = required(this.router, "Mobile RPC router is stopped");
    let phase: "hello" | "auth" | "rpc" = "hello";
    let opener: SecretboxFrameOpener | null = null;
    let sealer: SecretboxFrameSealer | null = null;
    let transcriptHashText = "";
    let authenticatedDeviceId = "";
    let processing = Promise.resolve();

    const sendEncrypted = (value: unknown) => {
      const activeSealer = required(sealer, "Mobile E2EE is not ready");
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      connection.send(activeSealer.seal("text", bytes));
    };

    connection.onMessage((data) => {
      processing = processing
        .then(async () => {
          if (phase === "hello") {
            const hello = e2eeHelloV1Schema.parse(JSON.parse(new TextDecoder().decode(data)));
            if (
              hello.hostId !== transport.hostId ||
              hello.deviceId !== connection.connection.deviceId
            ) {
              throw new Error("Mobile handshake identity mismatch");
            }
            const serverNonce = randomBytes(32);
            const transcript: MobileHandshakeTranscript = {
              protocolVersion: MOBILE_PROTOCOL_VERSION,
              phoneEphemeralPublicKey: hello.phoneEphemeralPublicKey,
              hostE2eePublicKey: Buffer.from(transport.e2eePublicKey).toString("base64url"),
              clientNonce: hello.clientNonce,
              serverNonce: serverNonce.toString("base64url"),
              hostId: hello.hostId,
              deviceId: hello.deviceId,
              relayOrigin: config.relayOrigin,
              transport: "relay",
              selectedFraming: "secretbox-v1",
              capabilities: hello.capabilities,
            };
            const transcriptHash = hashHandshakeTranscript(transcript);
            transcriptHashText = Buffer.from(transcriptHash).toString("base64url");
            const sharedSecret = deriveX25519SharedSecret(
              transport.e2eeSecretKey,
              decodeCanonicalKey(hello.phoneEphemeralPublicKey),
            );
            const keys = deriveMobileSessionKeys({
              sharedSecret,
              clientNonce: decodeCanonicalKey(hello.clientNonce),
              serverNonce,
              transcriptHash,
            });
            opener = new SecretboxFrameOpener(keys.phoneToHostKey, keys.sessionId, "phone_to_host");
            sealer = new SecretboxFrameSealer(keys.hostToPhoneKey, keys.sessionId, "host_to_phone");
            connection.send(
              new TextEncoder().encode(
                JSON.stringify({
                  type: "e2ee.ready",
                  version: MOBILE_PROTOCOL_VERSION,
                  hostE2eePublicKey: transcript.hostE2eePublicKey,
                  serverNonce: transcript.serverNonce,
                  selectedFraming: "secretbox-v1",
                  transcriptHash: transcriptHashText,
                }),
              ),
            );
            phase = "auth";
            return;
          }

          const opened = required(opener, "Mobile E2EE opener is missing").open(data, "text");
          const plaintext = new TextDecoder().decode(opened.payload);
          if (phase === "auth") {
            const auth = e2eeAuthV1Schema.parse(JSON.parse(plaintext));
            if (
              auth.deviceId !== connection.connection.deviceId ||
              !constantTextEqual(auth.transcriptHash, transcriptHashText)
            ) {
              throw new Error("Mobile authentication transcript mismatch");
            }
            if ("pairingSecret" in auth) {
              if (
                connection.connection.credentialKind !== "invite" ||
                !registry.consumePairing(auth.deviceId, auth.pairingSecret)
              ) {
                throw new Error("Mobile pairing credential rejected");
              }
              const { deviceToken, resumeToken } = derivePairingCredentials(
                auth.pairingSecret,
              );
              registry.installDevice({
                deviceId: auth.deviceId,
                displayName: registry.pairingDisplayName(auth.deviceId),
                allowedProjects: config.allowedProjects,
                token: deviceToken,
              });
              await transport.installDevice(
                auth.deviceId,
                createHash("sha256").update(resumeToken).digest("base64url"),
                1,
              );
            } else if (
              connection.connection.credentialKind !== "resume" ||
              !registry.authenticate(auth.deviceId, auth.deviceToken)
            ) {
              throw new Error("Mobile device credential rejected");
            }
            authenticatedDeviceId = auth.deviceId;
            let connections = this.sessions.get(auth.deviceId);
            if (!connections) {
              connections = new Set();
              this.sessions.set(auth.deviceId, connections);
            }
            connections.add(connection);
            sendEncrypted({
              type: "e2ee.authenticated",
              deviceId: auth.deviceId,
              transcriptHash: transcriptHashText,
              permissionsDigest: createHash("sha256")
                .update(JSON.stringify([...config.allowedProjects].sort()))
                .digest("base64url"),
            });
            phase = "rpc";
            return;
          }

          const frame = mobileRpcFrameV1Schema.parse(JSON.parse(plaintext));
          if (frame.type === "rpc.ping") {
            sendEncrypted({ type: "rpc.pong", timestamp: frame.timestamp });
          } else if (frame.type === "rpc.unsubscribe") {
            router.unsubscribe(authenticatedDeviceId, frame.subscriptionId);
          } else if (frame.type === "rpc.request") {
            void router
              .handle(authenticatedDeviceId, frame, sendEncrypted)
              .then(sendEncrypted)
              .catch((error) => {
                ctx.log("warn", `Mobile RPC dispatch failed: ${safeError(error)}`);
                connection.close(1011, "mobile RPC dispatch failed");
              });
          } else {
            throw new Error("Mobile client sent an invalid RPC frame direction");
          }
        })
        .catch((error) => {
          ctx.log("warn", `Mobile data session closed: ${safeError(error)}`);
          connection.close(1008, "mobile protocol violation");
        });
    });
    connection.onClose(() => {
      if (!authenticatedDeviceId) return;
      const connections = this.sessions.get(authenticatedDeviceId);
      connections?.delete(connection);
      if (!connections?.size) this.sessions.delete(authenticatedDeviceId);
      router.disconnectDevice(authenticatedDeviceId);
    });
  }

  private async flushRevocationOutbox(): Promise<void> {
    const registry = this.registry;
    const transport = this.transport;
    if (!registry || !transport) return;
    for (const item of registry.pendingRevocations()) {
      try {
        await transport.revokeDevice(item.deviceId);
        registry.completeOutbox(item.id);
      } catch {
        return;
      }
    }
  }
}

export function validateDeviceProjectGrants(
  channelProjects: string[],
  requestedProjects: string[],
): string[] {
  const grants = [...new Set(requestedProjects)];
  const allowed = new Set(channelProjects);
  if (grants.some((project) => !allowed.has(project))) {
    throw new Error("Device project grant exceeds channel allowed projects");
  }
  return grants;
}

function decodeCanonicalKey(value: string): Uint8Array {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("Mobile handshake key is invalid");
  }
  return Uint8Array.from(decoded);
}

function constantTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "protocol error").slice(0, 300);
}
