import type {
  ChannelAdapterHealth,
  ChannelKind,
  InboundMessage,
  OutboundReply,
} from "./types.js";
import type { RpcMethod, RpcParams, RpcResult } from "@forge/protocol";
import { DAEMON_METHODS } from "@forge/protocol";

type LegacyDaemonMethod = (typeof DAEMON_METHODS)[keyof typeof DAEMON_METHODS];
export type AdapterDaemonMethod = RpcMethod | LegacyDaemonMethod;

export interface AdapterContext {
  adapterId: string;
  kind: ChannelKind;
  cwd: string;
  config: Record<string, unknown>;
  dataDir: string;
  daemon: AdapterDaemonBridge;
  onInbound: (msg: InboundMessage) => void;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

export interface AdapterDaemonBridge {
  request<M extends RpcMethod>(
    method: M,
    params?: RpcParams<M>,
    onEvent?: (event: unknown) => void,
  ): Promise<RpcResult<M>>;
  request(
    method: LegacyDaemonMethod,
    params?: unknown,
    onEvent?: (event: unknown) => void,
  ): Promise<unknown>;
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly capability: "message" | "interactive";
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ChannelAdapterHealth>;
}

export interface MessageChannelAdapter extends ChannelAdapter {
  readonly capability: "message";
  send(reply: OutboundReply): Promise<void>;
  sendTyping?(replyContext: unknown, on: boolean): Promise<void>;
}

export interface InteractiveChannelAdapter extends ChannelAdapter {
  readonly capability: "interactive";
}

export function isMessageChannelAdapter(
  adapter: ChannelAdapter,
): adapter is MessageChannelAdapter {
  return adapter.capability === "message";
}

export function isInteractiveChannelAdapter(
  adapter: ChannelAdapter,
): adapter is InteractiveChannelAdapter {
  return adapter.capability === "interactive";
}
