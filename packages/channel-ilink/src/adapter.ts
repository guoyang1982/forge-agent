import type { AdapterContext, ChannelAdapter } from "@forge/channel-core";
import type { ChannelAdapterHealth } from "@forge/channel-core";
import type { InboundMessage, OutboundReply } from "@forge/channel-core";
import {
  credentialsFromConfig,
  extractInboundText,
  IlinkClient,
  threadKeyFromMessage,
} from "./client.js";

const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";

export class IlinkChannelAdapter implements ChannelAdapter {
  readonly kind = "ilink" as const;
  readonly capability = "message" as const;

  private ctx: AdapterContext | null = null;
  private client = new IlinkClient(DEFAULT_BASE);
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private updatesBuf = "";
  private lastError: string | undefined;
  private lastMessageAt: string | undefined;
  private lastPollAt: string | undefined;
  private polling = false;

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    const baseUrl =
      typeof ctx.config.baseUrl === "string" && ctx.config.baseUrl
        ? String(ctx.config.baseUrl).replace(/\/+$/, "")
        : DEFAULT_BASE;
    this.client = new IlinkClient(baseUrl);
    this.schedulePoll(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.ctx = null;
  }

  async health(): Promise<ChannelAdapterHealth> {
    const creds = this.ctx
      ? credentialsFromConfig(this.ctx.config, DEFAULT_BASE)
      : null;
    return {
      adapterId: this.ctx?.adapterId ?? "",
      kind: "ilink",
      status: !this.ctx
        ? "disabled"
        : !creds
          ? "login_required"
          : this.lastError
            ? "error"
            : this.stopped
              ? "disconnected"
              : "connected",
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      pollState: !creds
        ? "waiting_login"
        : this.polling
          ? "polling"
          : "idle",
      lastPollAt: this.lastPollAt,
    };
  }

  async send(reply: OutboundReply): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("ilink adapter not started");
    const creds = credentialsFromConfig(ctx.config, DEFAULT_BASE);
    if (!creds) throw new Error("ilink not logged in");

    const text = reply.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (!text) return;

    const replyCtx = reply.replyContext as {
      toUserId?: string;
      contextToken?: string;
    } | null;
    const toUserId = replyCtx?.toUserId;
    const contextToken = replyCtx?.contextToken;
    if (!toUserId || !contextToken) {
      throw new Error("ilink reply missing toUserId or contextToken");
    }

    const res = await this.client.sendTextMessage(
      creds,
      toUserId,
      text,
      contextToken,
    );
    const code = res.ret ?? res.errcode ?? res.code;
    if (code !== undefined && code !== 0) {
      throw new Error(
        res.errmsg?.trim() || res.message?.trim() || `sendmessage code=${code}`,
      );
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.pollOnce(), delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || this.polling) {
      this.schedulePoll(1000);
      return;
    }
    const ctx = this.ctx;
    if (!ctx) return;

    const creds = credentialsFromConfig(ctx.config, DEFAULT_BASE);
    if (!creds) {
      this.schedulePoll(5000);
      return;
    }

    this.polling = true;
    this.lastPollAt = new Date().toISOString();
    try {
      const res = await this.client.getUpdates(creds, this.updatesBuf);
      if (res.ret !== undefined && res.ret !== 0) {
        throw new Error(res.errmsg?.trim() || `getupdates ret=${res.ret}`);
      }
      if (res.get_updates_buf) this.updatesBuf = res.get_updates_buf;
      const msgs = res.msgs ?? [];
      for (const msg of msgs) {
        if (msg.message_type !== 1) {
          ctx.log("info", `skip message_type=${msg.message_type ?? "?"}`);
          continue;
        }
        const text = extractInboundText(msg);
        if (!text) {
          ctx.log("info", "skip empty text message");
          continue;
        }
        const fromUserId = msg.from_user_id ?? "";
        const inbound: InboundMessage = {
          id: `${fromUserId}:${msg.context_token ?? Date.now()}`,
          adapterId: ctx.adapterId,
          thread: {
            channel: "ilink",
            threadKey: threadKeyFromMessage(msg),
          },
          peer: {
            channel: "ilink",
            userId: fromUserId,
            chatId: msg.group_id ?? fromUserId,
            chatType: msg.group_id ? "group" : "direct",
          },
          text,
          receivedAt: new Date().toISOString(),
          replyContext: {
            toUserId: fromUserId,
            contextToken: msg.context_token ?? "",
          },
        };
        this.lastMessageAt = inbound.receivedAt;
        ctx.onInbound(inbound);
      }
      this.lastError = undefined;
      this.schedulePoll(100);
    } catch (e) {
      this.lastError = String(e);
      ctx.log("error", `ilink poll failed: ${this.lastError}`);
      this.schedulePoll(3000);
    } finally {
      this.polling = false;
    }
  }
}
