export type ChannelKind = "ilink" | "feishu" | "dingtalk" | "http" | "mobile";

export type ChannelAdapterRuntimeStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "error"
  | "disabled"
  | "login_required";

export interface ChannelAdapterRecord {
  id: string;
  kind: ChannelKind;
  name: string;
  description?: string;
  enabled: boolean;
  cwd: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  lastMessageAt?: string;
}

export interface ChannelAdapterDraft {
  kind: ChannelKind;
  name: string;
  description?: string;
  cwd?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface ChannelBindingRecord {
  channelId?: string;
  channel: ChannelKind;
  threadKey: string;
  sessionId: string;
  cwd: string;
  peerUserId?: string;
  peerChatId?: string;
  lastContextToken?: string;
  updatedAt: string;
}

export interface ChannelActivityEntry {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface ChannelAdapterStatus {
  adapterId: string;
  kind: ChannelKind;
  name: string;
  status: ChannelAdapterRuntimeStatus;
  lastError?: string;
  lastMessageAt?: string;
  pollState?: "polling" | "idle" | "waiting_login";
  lastPollAt?: string;
  processing?: boolean;
  currentSessionId?: string;
  lastInboundPreview?: string;
  lastRunStatus?: "ok" | "error";
  recentEvents?: ChannelActivityEntry[];
}

export interface ChannelGatewayStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
  listenUrl?: string;
  daemonConnected?: boolean;
  adapters: ChannelAdapterStatus[];
}

export type ChannelLoginStatus = "wait" | "scaned" | "confirmed" | "expired";

export interface ChannelLoginState {
  adapterId: string;
  status: ChannelLoginStatus;
  qrcode?: string;
  qrcodeImgUrl?: string;
  error?: string;
}

export interface ListChannelsRequest {
  cwd?: string;
}
export interface ListChannelsResult {
  channels: ChannelAdapterRecord[];
}

export interface GetChannelRequest {
  id: string;
}
export interface GetChannelResult {
  channel: ChannelAdapterRecord;
}

export interface CreateChannelRequest {
  draft: ChannelAdapterDraft;
  skipConfirm?: boolean;
}
export interface CreateChannelResult {
  channel: ChannelAdapterRecord;
}

export interface UpdateChannelRequest {
  id: string;
  patch: Partial<ChannelAdapterDraft> & { enabled?: boolean; config?: Record<string, unknown> };
}
export interface UpdateChannelResult {
  channel: ChannelAdapterRecord;
}

export interface DeleteChannelRequest {
  id: string;
  skipConfirm?: boolean;
}
export interface DeleteChannelResult {
  ok: true;
}

export interface ListChannelKindsResult {
  kinds: Array<{
    kind: ChannelKind;
    label: string;
    description: string;
    fields?: Array<{
      key: string;
      label: string;
      type: string;
      default?: string | number | boolean;
      placeholder?: string;
      required?: boolean;
    }>;
    actions: string[];
  }>;
}

export interface ChannelStartLoginRequest {
  adapterId: string;
}
export interface ChannelStartLoginResult {
  login: ChannelLoginState;
}

export interface ChannelPollLoginRequest {
  adapterId: string;
}
export interface ChannelPollLoginResult {
  login: ChannelLoginState;
}

export interface ChannelGatewayControlResult {
  ok: true;
  status: ChannelGatewayStatus;
}
