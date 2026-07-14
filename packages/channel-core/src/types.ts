/** Channel-agnostic message types for gateway ↔ adapter boundary. */

export type ChannelKind = "ilink" | "feishu" | "dingtalk" | "http";

export type ChannelChatType = "direct" | "group" | "channel";

export interface ChannelPeer {
  channel: ChannelKind;
  userId: string;
  chatId: string;
  chatType: ChannelChatType;
  displayName?: string;
}

export interface ChannelThread {
  channel: ChannelKind;
  threadKey: string;
}

export interface ChannelAttachment {
  kind: "image" | "file" | "audio" | "video";
  name?: string;
  mimeType?: string;
  text?: string;
  buffer?: Buffer;
  dataUrl?: string;
}

export interface InboundMessage {
  id: string;
  adapterId: string;
  thread: ChannelThread;
  peer: ChannelPeer;
  text: string;
  attachments?: ChannelAttachment[];
  receivedAt: string;
  /** Opaque per-channel reply context (e.g. iLink context_token). */
  replyContext: unknown;
}

export type OutboundPart =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; buffer?: Buffer; mimeType: string }
  | { type: "file"; name: string; buffer: Buffer; mimeType: string };

export interface OutboundReply {
  adapterId: string;
  thread: ChannelThread;
  replyContext: unknown;
  parts: OutboundPart[];
  meta?: { typing?: boolean; final?: boolean };
}

export interface ChannelCapabilities {
  supportsTyping: boolean;
  supportsImages: boolean;
  supportsFiles: boolean;
  supportsStreamReply: boolean;
  maxTextLength: number;
}

export type ChannelAdapterRuntimeStatus =
  | "connected"
  | "disconnected"
  | "error"
  | "disabled"
  | "login_required";

export interface ChannelAdapterHealth {
  adapterId: string;
  kind: ChannelKind;
  status: ChannelAdapterRuntimeStatus;
  lastError?: string;
  lastMessageAt?: string;
  pollState?: "polling" | "idle" | "waiting_login";
  lastPollAt?: string;
}
