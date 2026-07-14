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
  onInbound: (msg: InboundMessage) => void;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ChannelAdapterHealth>;
  send?(reply: OutboundReply): Promise<void>;
  sendTyping?(replyContext: unknown, on: boolean): Promise<void>;
}
