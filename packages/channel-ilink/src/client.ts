import type { ChannelLoginStatus } from "@forge/protocol";
import { randomUUID } from "node:crypto";

export interface IlinkCredentials {
  botToken: string;
  baseUrl: string;
  botId?: string;
  userId?: string;
}

export interface IlinkQrcodeResponse {
  qrcode: string;
  qrcode_img_content?: string;
}

export interface IlinkQrcodeStatusResponse {
  status: ChannelLoginStatus;
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}

export interface IlinkTextItem {
  type: number;
  text_item?: { text?: string };
}

export interface IlinkMessage {
  from_user_id?: string;
  to_user_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: IlinkTextItem[];
}

export interface IlinkGetUpdatesResponse {
  ret?: number;
  errmsg?: string;
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface IlinkSendMessageResponse {
  ret?: number;
  errcode?: number;
  code?: number;
  errmsg?: string;
  message?: string;
}

function randomWechatUin(): string {
  const n = Math.floor(Math.random() * 0xffffffff) >>> 0;
  return Buffer.from(String(n), "utf8").toString("base64");
}

export class IlinkClient {
  constructor(private readonly baseUrl: string) {}

  async getBotQrcode(): Promise<IlinkQrcodeResponse> {
    const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`get_bot_qrcode failed: ${res.status}`);
    return (await res.json()) as IlinkQrcodeResponse;
  }

  async getQrcodeStatus(qrcode: string): Promise<IlinkQrcodeStatusResponse> {
    const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
    });
    if (!res.ok) throw new Error(`get_qrcode_status failed: ${res.status}`);
    return (await res.json()) as IlinkQrcodeStatusResponse;
  }

  async post<T>(
    path: string,
    body: Record<string, unknown>,
    creds: IlinkCredentials,
  ): Promise<T> {
    const payload = JSON.stringify(body);
    const res = await fetch(`${creds.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${creds.botToken}`,
        "X-WECHAT-UIN": randomWechatUin(),
        "Content-Length": String(Buffer.byteLength(payload, "utf8")),
      },
      body: payload,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${path} failed: ${res.status} ${text}`.trim());
    }
    return (await res.json()) as T;
  }

  getUpdates(
    creds: IlinkCredentials,
    getUpdatesBuf: string,
    channelVersion = "1.0.2",
  ): Promise<IlinkGetUpdatesResponse> {
    return this.post<IlinkGetUpdatesResponse>(
      "ilink/bot/getupdates",
      {
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: channelVersion },
      },
      creds,
    );
  }

  sendTextMessage(
    creds: IlinkCredentials,
    toUserId: string,
    text: string,
    contextToken: string,
    channelVersion = "1.0.3",
  ): Promise<IlinkSendMessageResponse> {
    return this.post(
      "ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: { channel_version: channelVersion },
      },
      creds,
    );
  }
}

export function credentialsFromConfig(
  config: Record<string, unknown>,
  defaultBaseUrl: string,
): IlinkCredentials | null {
  const botToken =
    typeof config.botToken === "string" ? config.botToken.trim() : "";
  if (!botToken) return null;
  const baseUrl =
    typeof config.baseUrl === "string" && config.baseUrl.trim()
      ? config.baseUrl.trim().replace(/\/+$/, "")
      : defaultBaseUrl;
  return {
    botToken,
    baseUrl,
    botId: typeof config.botId === "string" ? config.botId : undefined,
    userId: typeof config.userId === "string" ? config.userId : undefined,
  };
}

export function extractInboundText(msg: IlinkMessage): string {
  const items = msg.item_list ?? [];
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text) {
      parts.push(item.text_item.text);
    }
  }
  return parts.join("\n").trim();
}

export function threadKeyFromMessage(msg: IlinkMessage): string {
  if (msg.group_id) return `group:${msg.group_id}`;
  if (msg.from_user_id) return `direct:${msg.from_user_id}`;
  return `unknown:${msg.context_token ?? "anon"}`;
}
