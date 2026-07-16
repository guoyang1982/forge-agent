import type {
  ChannelAdapterHealth,
  ChannelKind,
  InboundMessage,
  OutboundReply,
} from "./types.js";

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
  request(
    method: string,
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
