export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }

  static fromHttp(status: number, body: string): LlmError {
    const trimmed = body.trim();
    let jsonText = trimmed;
    if (trimmed.startsWith("data:")) {
      jsonText = trimmed.slice(5).trim();
    }
    try {
      const json = JSON.parse(jsonText) as {
        error?: { message?: string; code?: string; type?: string };
      };
      const err = json.error;
      const msg = err?.message ?? body.slice(0, 300);
      const code = err?.code ?? err?.type;
      return new LlmError(formatFriendly(status, msg, code), status, code);
    } catch {
      return new LlmError(
        formatFriendly(status, body.slice(0, 300)),
        status,
      );
    }
  }
}

function formatFriendly(
  status: number,
  message: string,
  code?: string,
): string {
  if (
    status === 429 &&
    (code === "insufficient_quota" || message.includes("quota"))
  ) {
    return [
      "模型 API 配额不足（429 insufficient_quota）。",
      "OpenAI 账户余额/额度用尽，请充值或更换其它 API。",
      "可在 ~/.forge-agent/config.json 修改 baseUrl + apiKey + name（如 DeepSeek）。",
      `详情: ${message}`,
    ].join(" ");
  }
  if (status === 401) {
    return `API Key 无效或未授权（401）。请检查 config 中 model.apiKey。详情: ${message}`;
  }
  if (status === 404 && message.includes("model")) {
    return `模型不存在（404）。请检查 model.name 是否与 baseUrl 匹配。详情: ${message}`;
  }
  if (status === 400 && /image_url|expected text/i.test(message)) {
    return [
      "当前 API 不接受图片（image_url）。",
      "请换用支持视觉的模型（如 gpt-4o / gpt-5.5），或在 config 中设置 model.vision: true。",
      `详情: ${message}`,
    ].join(" ");
  }
  if (
    /access denied|overdue-payment|account is in good standing|欠费|账户/i.test(
      message,
    )
  ) {
    return [
      "阿里云百炼 / DashScope 拒绝访问（账户状态异常，常见为欠费或未开通模型）。",
      "请登录阿里云控制台检查余额与「模型服务灵积」账单，或暂时切换其它 profile：forge model use deepseek-pro",
      `详情: ${message}`,
    ].join(" ");
  }
  return `LLM 请求失败 (${status}): ${message}`;
}
