import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ChannelGatewayControlResult,
  ChannelGatewayStatus,
  ChannelLoginState,
  ChannelPollLoginResult,
  ChannelStartLoginResult,
  CreateChannelResult,
  DeleteChannelResult,
  ForgeConfig,
  GetChannelResult,
  ListChannelKindsResult,
  ListChannelsResult,
  UpdateChannelResult,
} from "@forge/protocol";
import { CHANNEL_KIND_SCHEMAS } from "@forge/channel-core";
import { ChannelStore } from "@forge/channel";
import { IlinkClient, resolveIlinkQrcodeImage } from "@forge/channel-ilink";
import { loadConfig } from "@forge/config";
import type { ChannelGatewayHost } from "./channel-gateway-host.js";

export interface ChannelServiceDeps {
  getStore: () => ChannelStore;
  getGatewayHost: () => ChannelGatewayHost;
}

const loginSessions = new Map<string, ChannelLoginState & { qrcode: string }>();

function resolveCwd(cwd: string | undefined, fallback?: string): string {
  return resolve(cwd ?? fallback ?? process.cwd());
}

function assertCwdExists(cwd: string): void {
  if (!existsSync(cwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
}

export function assertChannelPermission(
  cfg: ForgeConfig,
  op: "create" | "start" | "delete",
  opts?: { skipConfirm?: boolean },
): void {
  const p = cfg.permissions?.channels;
  if (!p?.enabled) {
    throw new Error("channels disabled in permissions");
  }
  const level = p[op];
  if (level === "deny") {
    throw new Error(`channel ${op} denied`);
  }
  if (level === "confirm" && !opts?.skipConfirm) {
    throw new Error(`channel ${op} requires confirmation`);
  }
}

export async function handleListChannels(
  params: unknown,
  deps: ChannelServiceDeps,
): Promise<ListChannelsResult> {
  const req = params as { cwd?: string } | undefined;
  const cwd = req?.cwd ? resolveCwd(req.cwd) : undefined;
  return { channels: deps.getStore().list(cwd ? { cwd } : undefined) };
}

export async function handleGetChannel(
  params: unknown,
  deps: ChannelServiceDeps,
): Promise<GetChannelResult> {
  const req = params as { id: string };
  const channel = deps.getStore().get(req.id);
  if (!channel) throw new Error("channel not found");
  return { channel };
}

export async function handleCreateChannel(
  params: unknown,
  deps: ChannelServiceDeps,
): Promise<CreateChannelResult> {
  const req = params as {
    draft: {
      kind: import("@forge/protocol").ChannelKind;
      name: string;
      description?: string;
      cwd?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    };
    skipConfirm?: boolean;
  };
  const absCwd = resolveCwd(req.draft.cwd);
  assertCwdExists(absCwd);
  const cfg = loadConfig({ cwd: absCwd });
  assertChannelPermission(cfg, "create", { skipConfirm: req.skipConfirm });

  const schema = CHANNEL_KIND_SCHEMAS.find((s) => s.kind === req.draft.kind);
  if (!schema) throw new Error(`unknown channel kind: ${req.draft.kind}`);

  const defaults: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field.default !== undefined) defaults[field.key] = field.default;
  }

  const channel = deps.getStore().createFromDraft(
    {
      ...req.draft,
      config: { ...defaults, ...(req.draft.config ?? {}) },
    },
    absCwd,
  );
  return { channel };
}

export async function handleUpdateChannel(
  params: unknown,
  deps: ChannelServiceDeps,
): Promise<UpdateChannelResult> {
  const req = params as {
    id: string;
    patch: {
      name?: string;
      description?: string;
      cwd?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    };
  };
  const store = deps.getStore();
  const existing = store.get(req.id);
  if (!existing) throw new Error("channel not found");

  if (req.patch.cwd !== undefined) {
    const absCwd = resolveCwd(req.patch.cwd);
    assertCwdExists(absCwd);
    req.patch.cwd = absCwd;
  }

  const channel = store.update(req.id, req.patch);
  if (!channel) throw new Error("channel not found");

  if (deps.getGatewayHost().isRunning()) {
    await deps.getGatewayHost().reload();
  }
  return { channel };
}

export async function handleDeleteChannel(
  params: unknown,
  deps: ChannelServiceDeps,
): Promise<DeleteChannelResult> {
  const req = params as { id: string; skipConfirm?: boolean };
  const store = deps.getStore();
  const existing = store.get(req.id);
  if (!existing) throw new Error("channel not found");

  const cfg = loadConfig({ cwd: existing.cwd });
  assertChannelPermission(cfg, "delete", { skipConfirm: req.skipConfirm });

  store.delete(req.id);
  loginSessions.delete(req.id);
  if (deps.getGatewayHost().isRunning()) {
    await deps.getGatewayHost().reload();
  }
  return { ok: true };
}

export function handleListChannelKinds(): ListChannelKindsResult {
  return {
    kinds: CHANNEL_KIND_SCHEMAS.map((s) => ({
      kind: s.kind,
      label: s.label,
      description: s.description,
      fields: s.fields,
      actions: s.actions,
    })),
  };
}

export async function handleGetChannelGatewayStatus(
  deps: ChannelServiceDeps,
): Promise<ChannelGatewayStatus> {
  return deps.getGatewayHost().getStatus();
}

export async function handleStartChannelGateway(
  params: unknown,
  deps: ChannelServiceDeps,
): Promise<ChannelGatewayControlResult> {
  const req = params as { skipConfirm?: boolean } | undefined;
  const cfg = loadConfig();
  assertChannelPermission(cfg, "start", { skipConfirm: req?.skipConfirm });
  const status = await deps.getGatewayHost().start();
  return { ok: true, status };
}

export async function handleStopChannelGateway(
  deps: ChannelServiceDeps,
): Promise<ChannelGatewayControlResult> {
  const status = await deps.getGatewayHost().stop();
  return { ok: true, status };
}

export async function handleChannelStartLogin(
  params: unknown,
  deps: ChannelServiceDeps,
): Promise<ChannelStartLoginResult> {
  const req = params as { adapterId: string };
  const channel = deps.getStore().get(req.adapterId);
  if (!channel) throw new Error("channel not found");
  if (channel.kind !== "ilink") {
    throw new Error(`login not supported for kind: ${channel.kind}`);
  }

  const baseUrl =
    typeof channel.config.baseUrl === "string" && channel.config.baseUrl
      ? String(channel.config.baseUrl).replace(/\/+$/, "")
      : "https://ilinkai.weixin.qq.com";
  const client = new IlinkClient(baseUrl);
  const qr = await client.getBotQrcode();
  const qrcodeImgUrl =
    (await resolveIlinkQrcodeImage(qr.qrcode_img_content)) ??
    qr.qrcode_img_content;
  const login: ChannelLoginState & { qrcode: string } = {
    adapterId: req.adapterId,
    status: "wait",
    qrcode: qr.qrcode,
    qrcodeImgUrl,
  };
  loginSessions.set(req.adapterId, login);
  return { login };
}

export async function handleChannelPollLogin(
  params: unknown,
  deps: ChannelServiceDeps,
): Promise<ChannelPollLoginResult> {
  const req = params as { adapterId: string };
  const channel = deps.getStore().get(req.adapterId);
  if (!channel) throw new Error("channel not found");
  if (channel.kind !== "ilink") {
    throw new Error(`login not supported for kind: ${channel.kind}`);
  }

  const pending = loginSessions.get(req.adapterId);
  if (!pending?.qrcode) {
    return {
      login: { adapterId: req.adapterId, status: "expired", error: "no pending login" },
    };
  }

  const baseUrl =
    typeof channel.config.baseUrl === "string" && channel.config.baseUrl
      ? String(channel.config.baseUrl).replace(/\/+$/, "")
      : "https://ilinkai.weixin.qq.com";
  const client = new IlinkClient(baseUrl);
  const status = await client.getQrcodeStatus(pending.qrcode);

  if (status.status === "confirmed" && status.bot_token) {
    deps.getStore().update(req.adapterId, {
      config: {
        botToken: status.bot_token,
        baseUrl: status.baseurl ?? baseUrl,
        botId: status.ilink_bot_id,
        userId: status.ilink_user_id,
      },
      enabled: true,
    });
    loginSessions.delete(req.adapterId);
    if (deps.getGatewayHost().isRunning()) {
      await deps.getGatewayHost().reload();
    }
  }

  if (status.status === "expired") {
    loginSessions.delete(req.adapterId);
  }

  const login: ChannelLoginState = {
    adapterId: req.adapterId,
    status: status.status,
    qrcode: pending.qrcode,
    qrcodeImgUrl: pending.qrcodeImgUrl,
  };
  return { login };
}
