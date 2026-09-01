import { z } from "zod";
import {
  MOBILE_CONTROL_FRAME_MAX_BYTES,
  mobileRpcErrorCodeSchema,
  mobileRpcMethodSchema,
} from "./index.js";

export const MOBILE_PROTOCOL_VERSION_V2 = 2 as const;

const opaqueId = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const mobileRpcMethodV2Schema = mobileRpcMethodSchema.or(
  z.enum(["run.resume"]),
);

export const mobileRunResumeParamsV2Schema = z
  .object({
    runId: opaqueId,
    cursor: z.number().int().nonnegative(),
    subscriptionId: opaqueId,
  })
  .strict();

const rpcRequestV2Schema = z
  .object({
    type: z.literal("rpc.request"),
    id: opaqueId,
    protocolVersion: z.literal(MOBILE_PROTOCOL_VERSION_V2).optional(),
    method: mobileRpcMethodV2Schema,
    params: z.unknown().optional(),
  })
  .strict();

const rpcSuccessV2Schema = z
  .object({
    type: z.literal("rpc.response"),
    id: opaqueId,
    protocolVersion: z.literal(MOBILE_PROTOCOL_VERSION_V2).optional(),
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

const rpcFailureV2Schema = z
  .object({
    type: z.literal("rpc.response"),
    id: opaqueId,
    protocolVersion: z.literal(MOBILE_PROTOCOL_VERSION_V2).optional(),
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

const rpcEventV2Schema = z
  .object({
    type: z.literal("rpc.event"),
    protocolVersion: z.literal(MOBILE_PROTOCOL_VERSION_V2).optional(),
    subscriptionId: opaqueId,
    seq: z.number().int().nonnegative(),
    cursor: z.number().int().nonnegative().optional(),
    event: z.unknown(),
  })
  .strict();

export const mobileRpcFrameV2Schema = z.union([
  rpcRequestV2Schema,
  rpcSuccessV2Schema,
  rpcFailureV2Schema,
  rpcEventV2Schema,
]);

export type MobileRpcMethodV2 = z.infer<typeof mobileRpcMethodV2Schema>;
export type MobileRpcFrameV2 = z.infer<typeof mobileRpcFrameV2Schema>;
export type MobileRunResumeParamsV2 = z.infer<typeof mobileRunResumeParamsV2Schema>;

export function isMobileV2Method(method: string): method is MobileRpcMethodV2 {
  return mobileRpcMethodV2Schema.safeParse(method).success;
}

export function isMobileV2OnlyMethod(method: string): boolean {
  return method === "run.resume";
}

export function parseMobileRpcFrameV2(input: string): MobileRpcFrameV2 {
  if (new TextEncoder().encode(input).byteLength > MOBILE_CONTROL_FRAME_MAX_BYTES) {
    throw new Error("mobile RPC control frame exceeds 64 KiB");
  }
  return mobileRpcFrameV2Schema.parse(JSON.parse(input));
}
