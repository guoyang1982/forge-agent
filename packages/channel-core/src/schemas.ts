import type { ChannelKind } from "./types.js";

export type ChannelConfigFieldType = "string" | "secret" | "path" | "number" | "boolean";

export interface ChannelConfigField {
  key: string;
  label: string;
  type: ChannelConfigFieldType;
  default?: string | number | boolean;
  placeholder?: string;
  required?: boolean;
}

export interface ChannelKindSchema {
  kind: ChannelKind;
  label: string;
  description: string;
  fields: ChannelConfigField[];
  actions: Array<"login" | "test" | "copyWebhookUrl">;
}

export const CHANNEL_KIND_SCHEMAS: ChannelKindSchema[] = [
  {
    kind: "mobile",
    label: "Forge Mobile",
    description: "Forge 自有移动端，通过公网 Relay 建立端到端加密交互连接",
    fields: [
      {
        key: "relayOrigin",
        label: "Relay Origin",
        type: "string",
        required: true,
        placeholder: "https://relay.example.com",
      },
      {
        key: "enrollmentToken",
        label: "Enrollment Token",
        type: "secret",
        required: true,
      },
    ],
    actions: ["login", "test"],
  },
  {
    kind: "ilink",
    label: "微信 iLink",
    description: "通过腾讯 iLink Bot API 收发微信消息（出站长轮询，无需公网穿透）",
    fields: [
      {
        key: "baseUrl",
        label: "API 基座",
        type: "string",
        default: "https://ilinkai.weixin.qq.com",
      },
    ],
    actions: ["login", "test"],
  },
  {
    kind: "feishu",
    label: "飞书",
    description: "飞书自定义机器人 Webhook，用于自动化完成后主动推送结果",
    fields: [
      {
        key: "webhookUrl",
        label: "Webhook URL",
        type: "secret",
        required: true,
        placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/...",
      },
    ],
    actions: ["test"],
  },
  {
    kind: "dingtalk",
    label: "钉钉",
    description: "钉钉自定义机器人 Webhook，用于自动化完成后主动推送结果",
    fields: [
      {
        key: "webhookUrl",
        label: "Webhook URL",
        type: "secret",
        required: true,
        placeholder: "https://oapi.dingtalk.com/robot/send?access_token=...",
      },
    ],
    actions: ["test"],
  },
  {
    kind: "http",
    label: "自研 App (HTTP)",
    description: "通用 HTTP Webhook，适合自研 App 或内部服务接收自动化结果",
    fields: [
      {
        key: "webhookUrl",
        label: "Webhook URL",
        type: "secret",
        required: true,
        placeholder: "https://your-app.example.com/forge/webhook",
      },
      {
        key: "authHeader",
        label: "Authorization Header",
        type: "secret",
        placeholder: "Bearer ...",
      },
    ],
    actions: ["copyWebhookUrl", "test"],
  },
];

export function getChannelKindSchema(kind: ChannelKind): ChannelKindSchema | undefined {
  return CHANNEL_KIND_SCHEMAS.find((s) => s.kind === kind);
}
