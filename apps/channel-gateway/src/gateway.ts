import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  isMessageChannelAdapter,
  type AdapterContext,
  type ChannelAdapter,
} from "@forge/channel-core";
import type { InboundMessage } from "@forge/channel-core";
import { ChannelStore } from "@forge/channel";
import { IlinkChannelAdapter } from "@forge/channel-ilink";
import { MobileChannelAdapter } from "@forge/channel-mobile";
import { loadConfig } from "@forge/config";
import type {
  ChannelActivityEntry,
  ChannelAdapterRecord,
  ChannelAdapterStatus,
  ChannelGatewayStatus,
  ChannelKind,
} from "@forge/protocol";
import { DEFAULT_PERMISSIONS } from "@forge/protocol";
import { SessionStore } from "@forge/session";
import { openNonMigratingDatabase } from "@forge/store";
import { ForgeBridge } from "./forge-bridge.js";

export interface ChannelGatewayOptions {
  dataDir: string;
  listenHost?: string;
  listenPort?: number;
  defaultReplyPrefix?: string;
  adapterFactory?: (kind: ChannelKind) => ChannelAdapter | null;
}

export class ChannelGateway {
  private readonly store: ChannelStore;
  private readonly sessions: SessionStore;
  private readonly forge: ForgeBridge;
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly adapterFingerprints = new Map<string, string>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly activity = new Map<
    string,
    {
      processing: boolean;
      currentSessionId?: string;
      lastInboundPreview?: string;
      lastRunStatus?: "ok" | "error";
      recentEvents: ChannelActivityEntry[];
    }
  >();
  private httpServer: Server | null = null;
  private startedAt: string | null = null;

  constructor(private readonly opts: ChannelGatewayOptions) {
    const cfg = loadConfig();
    const dbPath = join(opts.dataDir, "data.db");
    this.sessions = new SessionStore(openNonMigratingDatabase(dbPath));
    this.store = new ChannelStore(this.sessions.getDb());
    this.forge = new ForgeBridge(cfg.daemon.socketPath);
  }

  async start(): Promise<void> {
    this.startedAt = new Date().toISOString();
    await this.forge.connect();
    await this.reloadAdapters();
    await this.startHttp();
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch (error) {
        console.error(`[channel-gateway] adapter stop failed: ${String(error)}`);
      }
    }
    this.adapters.clear();
    this.adapterFingerprints.clear();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    this.forge.close();
    this.sessions.close();
    this.startedAt = null;
  }

  async reloadAdapters(): Promise<void> {
    const enabled = this.store.list({ enabledOnly: true });
    const desired = new Map(enabled.map((record) => [record.id, record]));

    for (const [adapterId, adapter] of this.adapters) {
      const record = desired.get(adapterId);
      const fingerprint = record ? this.adapterFingerprint(record) : null;
      if (record && this.adapterFingerprints.get(adapterId) === fingerprint) {
        continue;
      }
      try {
        await adapter.stop();
      } catch (error) {
        this.store.update(adapterId, { lastError: `stop failed: ${String(error)}` });
      }
      this.adapters.delete(adapterId);
      this.adapterFingerprints.delete(adapterId);
    }

    for (const record of enabled) {
      if (this.adapters.has(record.id)) continue;
      const adapter = this.createAdapter(record.kind);
      if (!adapter) continue;
      const ctx: AdapterContext = this.adapterContext(record);
      try {
        await adapter.start(ctx);
        this.adapters.set(record.id, adapter);
        this.adapterFingerprints.set(record.id, this.adapterFingerprint(record));
        this.store.update(record.id, { lastError: null });
      } catch (error) {
        const message = `start failed: ${String(error)}`;
        this.store.update(record.id, { lastError: message });
        this.pushActivity(record.id, "error", message);
        try {
          await adapter.stop();
        } catch {
          /* best-effort cleanup of partially started adapter */
        }
      }
    }
  }

  private adapterContext(record: ChannelAdapterRecord): AdapterContext {
    const config =
      record.kind === "mobile"
        ? this.mobileAdapterConfig(record)
        : record.config;
    return {
      adapterId: record.id,
      kind: record.kind,
      cwd: record.cwd,
      config,
      dataDir: this.opts.dataDir,
      daemon: {
        request: (method, params, onEvent) =>
          this.forge.request(method, params, onEvent),
      },
      onInbound: (msg: InboundMessage) => {
        void this.handleInbound(record, msg);
      },
      log: (level: "info" | "warn" | "error", message: string) => {
        const line = `[channel:${record.kind}:${record.id}] ${message}`;
        if (level === "error") console.error(line);
        else console.log(line);
      },
    };
  }

  private mobileAdapterConfig(record: ChannelAdapterRecord): Record<string, unknown> {
    // Forge Mobile is a computer-level channel: its permissions always come
    // from the global config, never from the project the record was created in.
    const permissions = loadConfig().permissions?.mobile ?? DEFAULT_PERMISSIONS.mobile;
    return {
      ...record.config,
      mobileEnabled: permissions.enabled,
      allowedProjects: permissions.allowedProjects,
      maxDevices: permissions.maxDevices,
      maxConcurrentRunsPerDevice: permissions.maxConcurrentRunsPerDevice,
      runPermission: permissions.run,
      approvePermission: permissions.approve,
    };
  }

  private adapterFingerprint(record: ChannelAdapterRecord): string {
    return stableStringify({
      kind: record.kind,
      name: record.name,
      cwd: record.cwd,
      config: record.kind === "mobile" ? this.mobileAdapterConfig(record) : record.config,
    });
  }

  getStatus(): ChannelGatewayStatus {
    const listenPort = this.opts.listenPort ?? 8787;
    const records = this.store.list();
    const adapters: ChannelAdapterStatus[] = records.map((r) => {
      const runtime = this.adapters.get(r.id);
      let status: ChannelAdapterStatus["status"] = r.enabled
        ? "disconnected"
        : "disabled";
      if (runtime) {
        // health is async; status endpoint uses cached fields below in HTTP handler
        status = r.lastError ? "error" : "connected";
      } else if (!r.enabled) {
        status = "disabled";
      } else if (!this.hasCredentials(r)) {
        status = "login_required";
      }
      const act = this.activity.get(r.id);
      return {
        adapterId: r.id,
        kind: r.kind,
        name: r.name,
        status,
        lastError: r.lastError,
        lastMessageAt: r.lastMessageAt,
        processing: act?.processing,
        currentSessionId: act?.currentSessionId,
        lastInboundPreview: act?.lastInboundPreview,
        lastRunStatus: act?.lastRunStatus,
        recentEvents: act?.recentEvents?.slice(0, 12),
      };
    });

    return {
      running: Boolean(this.startedAt),
      pid: process.pid,
      startedAt: this.startedAt ?? undefined,
      listenUrl: `http://${this.opts.listenHost ?? "127.0.0.1"}:${listenPort}`,
      daemonConnected: this.forge.isConnected(),
      adapters,
    };
  }

  async createMobilePairing(
    adapterId: string,
    deviceName?: string,
  ): Promise<unknown> {
    const offer = await this.mobileAdapter(adapterId).createPairingOffer(deviceName);
    this.pushActivity(adapterId, "info", "已生成新的 Mobile 一次性配对邀请");
    return offer;
  }

  listMobileDevices(adapterId: string): unknown[] {
    return this.mobileAdapter(adapterId).listDevices();
  }

  async revokeMobileDevice(adapterId: string, deviceId: string): Promise<boolean> {
    const revoked = await this.mobileAdapter(adapterId).revokeDevice(deviceId);
    if (revoked) {
      this.pushActivity(adapterId, "warn", `已撤销设备 ${deviceId.slice(0, 8)}…`);
    }
    return revoked;
  }

  updateMobileDeviceProjects(
    adapterId: string,
    deviceId: string,
    allowedProjects: string[],
  ): unknown {
    const device = this.mobileAdapter(adapterId).updateDeviceProjects(deviceId, allowedProjects);
    this.pushActivity(adapterId, "warn", `已更新设备 ${deviceId.slice(0, 8)}… 的项目授权`);
    return device;
  }

  private mobileAdapter(adapterId: string): MobileChannelAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!(adapter instanceof MobileChannelAdapter)) {
      throw new Error("Forge Mobile adapter is not running");
    }
    return adapter;
  }

  private pushActivity(
    adapterId: string,
    level: ChannelActivityEntry["level"],
    message: string,
  ): void {
    let state = this.activity.get(adapterId);
    if (!state) {
      state = { processing: false, recentEvents: [] };
      this.activity.set(adapterId, state);
    }
    state.recentEvents.unshift({
      at: new Date().toISOString(),
      level,
      message,
    });
    if (state.recentEvents.length > 20) {
      state.recentEvents.length = 20;
    }
  }

  private setProcessing(
    adapterId: string,
    processing: boolean,
    sessionId?: string,
    preview?: string,
  ): void {
    let state = this.activity.get(adapterId);
    if (!state) {
      state = { processing: false, recentEvents: [] };
      this.activity.set(adapterId, state);
    }
    state.processing = processing;
    state.currentSessionId = sessionId;
    if (preview) state.lastInboundPreview = preview;
  }

  private hasCredentials(record: ChannelAdapterRecord): boolean {
    if (record.kind === "ilink") {
      return typeof record.config.botToken === "string" && !!record.config.botToken;
    }
    return true;
  }

  private createAdapter(kind: ChannelKind): ChannelAdapter | null {
    if (this.opts.adapterFactory) return this.opts.adapterFactory(kind);
    if (kind === "ilink") return new IlinkChannelAdapter();
    if (kind === "mobile") return new MobileChannelAdapter();
    return null;
  }

  private async handleInbound(
    record: ChannelAdapterRecord,
    msg: InboundMessage,
  ): Promise<void> {
    const lockKey = `${record.id}:${msg.thread.threadKey}`;
    const prev = this.threadLocks.get(lockKey) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.processInbound(record, msg));
    this.threadLocks.set(lockKey, next);
    await next;
  }

  private async processInbound(
    record: ChannelAdapterRecord,
    msg: InboundMessage,
  ): Promise<void> {
    const preview = msg.text.trim().slice(0, 80);
    this.pushActivity(record.id, "info", `收到消息：${preview || "(空)"}`);
    const replyCtx = msg.replyContext as {
      toUserId?: string;
      contextToken?: string;
    } | null;
    if (!replyCtx?.toUserId || !String(replyCtx.contextToken ?? "").trim()) {
      this.pushActivity(
        record.id,
        "error",
        "消息缺少 toUserId 或 context_token，无法回复微信",
      );
      this.store.update(record.id, {
        lastError: "ilink reply context missing",
      });
      return;
    }
    let runSessionId: string | undefined;
    try {
      let binding = this.store.getBinding(record.id, msg.thread.threadKey);
      let sessionId = binding?.sessionId;
      if (!sessionId) {
        sessionId = this.sessions.createSession(record.cwd);
        this.store.upsertBinding({
          channelId: record.id,
          channel: record.kind,
          threadKey: msg.thread.threadKey,
          sessionId,
          cwd: record.cwd,
          peerUserId: msg.peer.userId,
          peerChatId: msg.peer.chatId,
          lastContextToken: replyCtx.contextToken,
        });
        this.pushActivity(
          record.id,
          "info",
          `新建会话 ${sessionId.slice(0, 8)}…（项目 ${record.cwd}）`,
        );
      }

      const prefix = this.opts.defaultReplyPrefix ?? "[微信渠道] ";
      const userMessage =
        msg.text.trim() === "/new" || msg.text.trim() === "/reset"
          ? "用户请求开始新会话。请简短确认。"
          : `${prefix}${msg.text}`;

      if (msg.text.trim() === "/new" || msg.text.trim() === "/reset") {
        sessionId = this.sessions.createSession(record.cwd);
        this.store.upsertBinding({
          channelId: record.id,
          channel: record.kind,
          threadKey: msg.thread.threadKey,
          sessionId,
          cwd: record.cwd,
          peerUserId: msg.peer.userId,
          peerChatId: msg.peer.chatId,
          lastContextToken: replyCtx.contextToken,
        });
        this.pushActivity(record.id, "info", `重置会话 ${sessionId.slice(0, 8)}…`);
      }

      runSessionId = sessionId;
      this.setProcessing(record.id, true, sessionId, preview);
      this.pushActivity(record.id, "info", `Agent 运行中…（会话 ${sessionId.slice(0, 8)}…）`);

      const result = await this.forge.run({
        cwd: record.cwd,
        message: userMessage,
        sessionId,
        autoApply: false,
        hookSource: "resume",
        channelRun: {
          kind: record.kind,
          label: record.name,
          preview: msg.text.trim().slice(0, 120),
        },
      });

      const adapter = this.adapters.get(record.id);
      if (adapter && isMessageChannelAdapter(adapter)) {
        const max = 4000;
        const text =
          result.finalText.length > max
            ? `${result.finalText.slice(0, max)}\n\n…(已截断)`
            : result.finalText;
        const outbound = text || "(无回复)";
        await adapter.send({
          adapterId: record.id,
          thread: msg.thread,
          replyContext: msg.replyContext,
          parts: [{ type: "text", text: outbound }],
          meta: { final: true },
        });
        this.pushActivity(
          record.id,
          "info",
          `已回复微信（${outbound.length} 字）`,
        );
      } else {
        this.pushActivity(record.id, "warn", "未配置发送适配器，微信未收到回复");
      }

      this.store.update(record.id, {
        lastMessageAt: new Date().toISOString(),
        lastError: null,
      });
      const act = this.activity.get(record.id);
      if (act) act.lastRunStatus = "ok";
    } catch (e) {
      const err = String(e);
      const act = this.activity.get(record.id);
      if (act) act.lastRunStatus = "error";
      this.pushActivity(record.id, "error", `处理失败：${err}`);
      this.store.update(record.id, { lastError: err });
      const adapter = this.adapters.get(record.id);
      if (adapter && isMessageChannelAdapter(adapter)) {
        try {
          await adapter.send({
            adapterId: record.id,
            thread: msg.thread,
            replyContext: msg.replyContext,
            parts: [{ type: "text", text: `处理失败: ${err}` }],
            meta: { final: true },
          });
        } catch {
          /* ignore secondary failure */
        }
      }
    } finally {
      this.setProcessing(record.id, false, runSessionId);
    }
  }

  private async startHttp(): Promise<void> {
    const host = this.opts.listenHost ?? "127.0.0.1";
    const port = this.opts.listenPort ?? 8787;
    this.httpServer = createServer(async (req, res) => {
      const url = req.url ?? "/";
      if (req.method === "GET" && (url === "/health" || url === "/health/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && (url === "/status" || url === "/status/")) {
        const statuses = await Promise.all(
          [...this.adapters.entries()].map(async ([id, adapter]) => {
            const h = await adapter.health();
            return [id, h] as const;
          }),
        );
        const statusMap = Object.fromEntries(statuses);
        const base = this.getStatus();
        base.daemonConnected = this.forge.isConnected();
        base.adapters = base.adapters.map((a) => ({
          ...a,
          status: statusMap[a.adapterId]?.status ?? a.status,
          lastError: statusMap[a.adapterId]?.lastError ?? a.lastError,
          lastMessageAt:
            statusMap[a.adapterId]?.lastMessageAt ?? a.lastMessageAt,
          pollState: statusMap[a.adapterId]?.pollState ?? a.pollState,
          lastPollAt: statusMap[a.adapterId]?.lastPollAt ?? a.lastPollAt,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(base));
        return;
      }
      if (req.method === "POST" && url === "/mobile/pairing") {
        try {
          const body = await readJsonBody(req);
          const offer = await this.createMobilePairing(
            requiredBodyString(body, "adapterId"),
            typeof body.deviceName === "string" ? body.deviceName : undefined,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ offer }));
        } catch (error) {
          writeGatewayError(res, error);
        }
        return;
      }
      if (req.method === "POST" && url === "/mobile/devices") {
        try {
          const body = await readJsonBody(req);
          const devices = this.listMobileDevices(requiredBodyString(body, "adapterId"));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ devices }));
        } catch (error) {
          writeGatewayError(res, error);
        }
        return;
      }
      if (req.method === "POST" && url === "/mobile/revoke") {
        try {
          const body = await readJsonBody(req);
          const ok = await this.revokeMobileDevice(
            requiredBodyString(body, "adapterId"),
            requiredBodyString(body, "deviceId"),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok }));
        } catch (error) {
          writeGatewayError(res, error);
        }
        return;
      }
      if (req.method === "POST" && url === "/mobile/projects") {
        try {
          const body = await readJsonBody(req);
          if (!Array.isArray(body.allowedProjects)) throw new Error("allowedProjects is required");
          const device = this.updateMobileDeviceProjects(
            requiredBodyString(body, "adapterId"),
            requiredBodyString(body, "deviceId"),
            body.allowedProjects.filter((item): item is string => typeof item === "string"),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ device }));
        } catch (error) {
          writeGatewayError(res, error);
        }
        return;
      }
      if (req.method === "POST" && url === "/reload") {
        await this.reloadAdapters();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(port, host, () => resolve());
      this.httpServer!.on("error", reject);
    });
    console.log(`[channel-gateway] listening on http://${host}:${port}`);
  }
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid request body");
  }
  return value as Record<string, unknown>;
}

function requiredBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function writeGatewayError(res: import("node:http").ServerResponse, error: unknown): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: error instanceof Error ? error.message.slice(0, 300) : "request failed",
    }),
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
