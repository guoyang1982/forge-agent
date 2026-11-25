(function registerConnectorCatalog(root) {
  const KNOWN_MCP = {
    "computer-use": {
      description: "在这台电脑上查看屏幕并操作界面。由已启用插件以本地 MCP 提供。",
      examples: [
        "看一下当前屏幕，告诉我现在打开了什么",
        "帮我在当前窗口里完成这一步操作",
      ],
    },
    xcodebuildmcp: {
      description: "构建和检查 iOS 工程。由已启用插件以本地 MCP 提供。",
      examples: ["用 Xcode 编译当前 iOS 工程", "跑一下这个 scheme 的测试"],
    },
    filesystem: {
      description: "按目录读写文件的 MCP 配置示例。示例不会自动加载。",
      examples: [],
    },
    kling: {
      description: "可灵 AI 的远程 MCP。用可灵账号授权后，可以在对话里生成视频和图片。",
      examples: ["用可灵生成一段海边日落的短视频"],
    },
    github: {
      description: "GitHub 仓库、Issue 和拉取请求。",
      examples: ["看一下这个仓库未关闭的 Issue"],
    },
    slack: {
      description: "Slack 频道和消息。",
      examples: ["在 Slack 里找最近关于发布的消息"],
    },
    gmail: {
      description: "Gmail 邮件。授权范围限于读取、撰写和发送。",
      examples: ["找最近一封关于合同的邮件"],
    },
    feishu: {
      description: "飞书文档和消息。",
      examples: ["在飞书文档里找这份需求说明"],
    },
    notion: {
      description: "Notion 页面和资料库。",
      examples: ["在 Notion 里找项目周报"],
    },
  };

  function connectorIdForMcp(source, name) {
    const safe = `${source}:${name}`.replace(/[^a-zA-Z0-9:_-]+/g, "-");
    return `mcp:${safe}`;
  }

  function sourceKind(source) {
    if (String(source).startsWith("plugin:")) return "plugin";
    if (source === "mcp.json.example") return "example";
    return "manual";
  }

  function mcpRowToConnector(row) {
    const name = String(row?.name || "mcp").trim() || "mcp";
    const sourceRaw = String(row?.source || "manual");
    const source = sourceKind(sourceRaw);
    const enabled = source === "example" ? false : Boolean(row?.enabled);
    const known = KNOWN_MCP[name];
    const url = String(row?.url || "");
    const statusNote =
      source === "plugin"
        ? "由已启用插件自动加载，无需写入 mcp.servers"
        : source === "example"
          ? "配置示例，仅供参考，不会自动加载"
          : url
            ? "已写入自定义配置，等待账号授权"
          : enabled
            ? "已在当前配置启用"
            : "已发现，但尚未启用";
    return {
      id: connectorIdForMcp(sourceRaw, name),
      name,
      description: known?.description || (url ? `远程 MCP ${name}。` : `本地 MCP 服务器 ${name}。`),
      kind: url ? "mcp-remote" : "mcp-local",
      source,
      health: source === "example" || !enabled ? "disconnected" : url ? "needs_auth" : "connected",
      enabled,
      examples: known?.examples || [],
      command: row?.command || "",
      args: row?.args || [],
      url,
      statusNote,
    };
  }

  function buildConnectorCatalog(input) {
    const seen = new Set();
    const out = [];
    const push = (row) => {
      const entry = mcpRowToConnector(row);
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      out.push(entry);
    };
    for (const row of input?.installed || []) {
      if (String(row?.source || "").startsWith("plugin:")) push(row);
    }
    for (const row of input?.configured || []) push(row);
    for (const row of input?.installed || []) {
      if (!String(row?.source || "").startsWith("plugin:")) push(row);
    }
    return out;
  }

  function connectionChoices(query, catalog) {
    const q = String(query || "").trim().toLowerCase();
    const exact =
      (catalog || []).find(
        (entry) =>
          entry.name.toLowerCase() === q ||
          entry.id.toLowerCase() === q ||
          (q && entry.name.toLowerCase().includes(q)),
      ) || null;
    return {
      exact,
      choices: [
        {
          id: "existing",
          label: exact ? `装 ${exact.name} 连接器` : "从已有连接器里选",
          connectorId: exact?.id,
        },
        { id: "api-key", label: "用 API 密钥" },
        { id: "browser", label: "用浏览器登录官网" },
      ],
    };
  }

  function toutiaoPublishConnector(health) {
    const status = health === "connected" || health === "needs_auth" ? health : "disconnected";
    return {
      id: "publish:toutiao",
      name: "今日头条",
      description: "用头条号登录后发布文章。登录在 Forge 浏览器里由你完成，不会保存网页令牌。",
      kind: "browser",
      source: "catalog",
      health: status,
      enabled: true,
      examples: [
        '@publisher 用今日头条账号发布，幂等键 demo-toutiao-2，payload 原样是 {"title":"两字标题","content":"正文"}',
      ],
      statusNote:
        status === "needs_auth"
          ? "登录已失效，请在 Forge 浏览器里重新登录"
          : "在 Forge 浏览器中登录头条号。封面上传还没有接上，缺封面时不会记成已发布。",
      loginUrl: "https://mp.toutiao.com/profile_v4/index",
      action: "connect-toutiao",
      confirmAction: "confirm-toutiao",
    };
  }

  function xiaohongshuPublishConnector(health) {
    const status = health === "connected" || health === "needs_auth" ? health : "disconnected";
    return {
      id: "publish:xiaohongshu",
      name: "小红书",
      description: "用创作者中心登录后发布。登录在 Forge 浏览器里由你完成，不会保存网页令牌。",
      kind: "browser",
      source: "catalog",
      health: status,
      enabled: true,
      examples: [
        '@publisher 用小红书账号发布，幂等键 demo-xhs-1，payload 原样是 {"note":"你好"}',
      ],
      statusNote:
        status === "needs_auth"
          ? "登录已失效，请在 Forge 浏览器里重新登录"
          : "在 Forge 浏览器中登录创作者中心。图片上传还没有接上。",
      loginUrl: "https://creator.xiaohongshu.com/",
      action: "connect-xiaohongshu",
      confirmAction: "confirm-xiaohongshu",
    };
  }

  root.ForgeConnectorCatalog = {
    connectorIdForMcp,
    mcpRowToConnector,
    buildConnectorCatalog,
    connectionChoices,
    toutiaoPublishConnector,
    xiaohongshuPublishConnector,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
