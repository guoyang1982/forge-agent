import { z } from "zod";

export const MOBILE_PROTOCOL_VERSION = 1 as const;
export const MOBILE_CONTROL_FRAME_MAX_BYTES = 64 * 1024;
export const MOBILE_DATA_FRAME_MAX_BYTES = 1024 * 1024;
export const MOBILE_PAIRING_MAX_TTL_MS = 10 * 60 * 1000;

const base64Url32 = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/);
const opaqueId = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.number().int().positive();
const canonicalRelayOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopbackHost(url.hostname))) &&
      url.origin === value &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}, "expected a canonical https origin (or HTTP loopback for local tests) without path, query, or hash");

export const forgeMobilePairingOfferV1Schema = z
  .object({
    v: z.literal(MOBILE_PROTOCOL_VERSION),
    relayOrigin: canonicalRelayOrigin,
    hostId: opaqueId,
    hostE2eePublicKey: base64Url32,
    deviceId: opaqueId,
    pairingSecret: base64Url32,
    inviteToken: z.string().min(32).max(2048),
    expiresAt: timestamp,
    protocolVersion: z.literal(MOBILE_PROTOCOL_VERSION),
  })
  .strict();

export type ForgeMobilePairingOfferV1 = z.infer<
  typeof forgeMobilePairingOfferV1Schema
>;

export const e2eeHelloV1Schema = z
  .object({
    type: z.literal("e2ee.hello"),
    version: z.literal(MOBILE_PROTOCOL_VERSION),
    phoneEphemeralPublicKey: base64Url32,
    clientNonce: base64Url32,
    hostId: opaqueId,
    deviceId: opaqueId,
    transport: z.literal("relay"),
    capabilities: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();

export const e2eeReadyV1Schema = z
  .object({
    type: z.literal("e2ee.ready"),
    version: z.literal(MOBILE_PROTOCOL_VERSION),
    hostE2eePublicKey: base64Url32,
    serverNonce: base64Url32,
    selectedFraming: z.literal("secretbox-v1"),
    transcriptHash: base64Url32,
  })
  .strict();

const pairingAuthSchema = z
  .object({
    type: z.literal("e2ee.auth"),
    deviceId: opaqueId,
    pairingSecret: base64Url32,
    transcriptHash: base64Url32,
  })
  .strict();

const deviceAuthSchema = z
  .object({
    type: z.literal("e2ee.auth"),
    deviceId: opaqueId,
    deviceToken: z.string().min(32).max(2048),
    transcriptHash: base64Url32,
  })
  .strict();

export const e2eeAuthV1Schema = z.union([pairingAuthSchema, deviceAuthSchema]);

export const e2eeAuthenticatedV1Schema = z
  .object({
    type: z.literal("e2ee.authenticated"),
    deviceId: opaqueId,
    transcriptHash: base64Url32,
    permissionsDigest: base64Url32,
  })
  .strict();

export const mobileHandshakeFrameV1Schema = z.union([
  e2eeHelloV1Schema,
  e2eeReadyV1Schema,
  e2eeAuthV1Schema,
  e2eeAuthenticatedV1Schema,
]);

export const mobileRpcMethodSchema = z.enum([
  "status.get",
  "runtime.list",
  "project.list",
  "project.create",
  "session.list",
  "session.search",
  "session.messages",
  "session.history.page",
  "run.start",
  "run.cancel",
  "run.subscribe",
  "permission.pending",
  "permission.respond",
  "git.branches",
  "git.switch",
  "workspace.files.list",
  "workspace.file.read",
  "workspace.diff.list",
  "workspace.diff.get",
]);

export const mobileRpcErrorCodeSchema = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "timeout",
  "internal",
  "unsupported_version",
]);

const rpcRequestSchema = z
  .object({
    type: z.literal("rpc.request"),
    id: opaqueId,
    method: mobileRpcMethodSchema,
    params: z.unknown().optional(),
  })
  .strict();

const rpcSuccessSchema = z
  .object({
    type: z.literal("rpc.response"),
    id: opaqueId,
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

const rpcFailureSchema = z
  .object({
    type: z.literal("rpc.response"),
    id: opaqueId,
    ok: z.literal(false),
    error: z
      .object({
        code: mobileRpcErrorCodeSchema,
        message: z.string().min(1).max(512),
        retryable: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const rpcEventSchema = z
  .object({
    type: z.literal("rpc.event"),
    subscriptionId: opaqueId,
    seq: z.number().int().nonnegative(),
    event: z.unknown(),
  })
  .strict();

const rpcUnsubscribeSchema = z
  .object({
    type: z.literal("rpc.unsubscribe"),
    subscriptionId: opaqueId,
  })
  .strict();

const rpcPingSchema = z
  .object({ type: z.literal("rpc.ping"), timestamp })
  .strict();
const rpcPongSchema = z
  .object({ type: z.literal("rpc.pong"), timestamp })
  .strict();

export const mobileRpcFrameV1Schema = z.union([
  rpcRequestSchema,
  rpcSuccessSchema,
  rpcFailureSchema,
  rpcEventSchema,
  rpcUnsubscribeSchema,
  rpcPingSchema,
  rpcPongSchema,
]);

export type MobileRpcMethod = z.infer<typeof mobileRpcMethodSchema>;
export type MobileRpcFrameV1 = z.infer<typeof mobileRpcFrameV1Schema>;
export type E2eeHelloV1 = z.infer<typeof e2eeHelloV1Schema>;
export type E2eeReadyV1 = z.infer<typeof e2eeReadyV1Schema>;
export type E2eeAuthV1 = z.infer<typeof e2eeAuthV1Schema>;
export type E2eeAuthenticatedV1 = z.infer<
  typeof e2eeAuthenticatedV1Schema
>;

export function parsePairingOfferV1(
  input: unknown,
  now = Date.now(),
): ForgeMobilePairingOfferV1 {
  const offer = forgeMobilePairingOfferV1Schema.parse(input);
  if (offer.expiresAt <= now) throw new Error("pairing offer expired");
  if (offer.expiresAt - now > MOBILE_PAIRING_MAX_TTL_MS) {
    throw new Error("pairing offer TTL exceeds 10 minutes");
  }
  return offer;
}

export function parseMobileRpcFrameV1(input: string): MobileRpcFrameV1 {
  if (new TextEncoder().encode(input).byteLength > MOBILE_CONTROL_FRAME_MAX_BYTES) {
    throw new Error("mobile RPC control frame exceeds 64 KiB");
  }
  return mobileRpcFrameV1Schema.parse(JSON.parse(input));
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
