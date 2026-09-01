import type { AdapterDaemonBridge } from "@forge/channel-core";
import type { EventEnvelope } from "@forge/protocol";
import {
  mobileRunResumeParamsV2Schema,
  type MobileRpcFrameV2,
} from "@forge/mobile-protocol/v2";
import { z } from "zod";
import type { MobileRpcRouterError } from "./mobile-rpc-router.js";

type RpcRequest = Extract<MobileRpcFrameV2, { type: "rpc.request" }>;
type RpcResponse = Extract<MobileRpcFrameV2, { type: "rpc.response" }>;
type RpcEvent = Extract<MobileRpcFrameV2, { type: "rpc.event" }>;
type EventSink = (frame: RpcEvent) => void;

export interface MobileRpcV2RouterOptions {
  daemon: AdapterDaemonBridge;
}

export class MobileRpcV2Router {
  constructor(private readonly options: MobileRpcV2RouterOptions) {}

  async handle(
    _deviceId: string,
    input: unknown,
    emit: EventSink,
  ): Promise<RpcResponse> {
    const frame = z
      .object({
        type: z.literal("rpc.request"),
        id: z.string().min(8).max(128),
        method: z.literal("run.resume"),
        params: z.unknown().optional(),
      })
      .parse(input);
    try {
      const result = await this.resumeRun(frame.params, emit);
      return { type: "rpc.response", id: frame.id, ok: true, result };
    } catch (error) {
      const publicError = toPublicError(error);
      return {
        type: "rpc.response",
        id: frame.id,
        ok: false,
        error: publicError,
      };
    }
  }

  async resumeRun(
    rawParams: unknown,
    emit?: EventSink,
  ): Promise<{ sequences: number[] }> {
    const params = mobileRunResumeParamsV2Schema.parse(rawParams);
    const page = await this.options.daemon.request("events.read", {
      cursor: params.cursor,
      limit: 500,
      filter: { runId: params.runId },
    });
    const events = objectArray(page, "events") as EventEnvelope[];
    const sequences: number[] = [];
    let seq = 0;
    for (const event of events) {
      if (typeof event.sequence !== "number") continue;
      sequences.push(event.sequence);
      emit?.({
        type: "rpc.event",
        subscriptionId: params.subscriptionId,
        seq: seq++,
        cursor: event.sequence,
        event,
      });
    }
    return { sequences };
  }
}

function objectArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : [];
}

function toPublicError(error: unknown): {
  code: MobileRpcRouterError["code"];
  message: string;
  retryable?: boolean;
} {
  if (error instanceof z.ZodError) {
    return { code: "bad_request", message: "request parameters are invalid" };
  }
  if (error instanceof Error) {
    return { code: "internal", message: error.message.slice(0, 280), retryable: true };
  }
  return { code: "internal", message: "request failed", retryable: true };
}
