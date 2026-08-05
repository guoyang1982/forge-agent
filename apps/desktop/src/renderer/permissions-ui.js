/** Permissions settings editor (loaded before app.js). */
(function () {
  const DEFAULT_ROOTS = [
    "~/Documents",
    "~/Downloads",
    "~/Desktop",
    "~/Pictures",
    "~/Movies",
    "~/Music",
  ];

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function levelSelect(path, value, label) {
    const v = value ?? "confirm";
    const opts = ["allow", "confirm", "deny"]
      .map(
        (o) =>
          `<option value="${o}"${o === v ? " selected" : ""}>${
            o === "allow" ? "允许" : o === "confirm" ? "需确认" : "禁止"
          }</option>`,
      )
      .join("");
    return `<div class="field">
      <label for="perm-${path.replace(/\./g, "-")}">${escapeHtml(label)}</label>
      <select id="perm-${path.replace(/\./g, "-")}" data-perm="${escapeHtml(path)}" class="perm-level-select">${opts}</select>
    </div>`;
  }

  function enabledToggle(path, checked, label) {
    return `<div class="field">
      <label class="toggle">
        <input type="checkbox" data-perm-bool="${escapeHtml(path)}" ${checked ? "checked" : ""} />
        <span>${escapeHtml(label)}</span>
      </label>
    </div>`;
  }

  function section(title, description, body) {
    return `<div class="permissions-section">
      <h4 class="permissions-section-title">${escapeHtml(title)}</h4>
      ${description ? `<p class="tiny permissions-section-desc">${escapeHtml(description)}</p>` : ""}
      ${body}
    </div>`;
  }

  function levelGrid(fields) {
    return `<div class="field-grid permissions-level-grid">${fields.join("")}</div>`;
  }

  function renderPermissionsEditor(cfg) {
    const p = cfg?.permissions ?? {};
    const fs = p.fileSystem ?? {};
    const net = p.network ?? {};
    const mem = p.memory ?? {};
    const sw = p.software ?? {};
    const auto = p.automation ?? {};
    const channels = p.channels ?? {};
    const notif = p.notifications ?? {};
    const browser = p.browser ?? {};
    const apps = p.apps ?? {};
    const secrets = p.secrets ?? {};
    const audit = p.audit ?? {};

    const roots = (fs.allowedRoots?.length ? fs.allowedRoots : DEFAULT_ROOTS).join("\n");

    return [
      section(
        "文件系统",
        "除当前项目 workspace 外，Agent 可访问的个人目录白名单。",
        `<div class="field">
          <label for="perm-fileSystem-allowedRoots">允许访问的目录（每行一个，支持 ~/…）</label>
          <textarea id="perm-fileSystem-allowedRoots" class="permissions-roots-input" data-perm-roots="fileSystem.allowedRoots" rows="6">${escapeHtml(roots)}</textarea>
        </div>
        ${levelGrid([
          levelSelect("fileSystem.read", fs.read, "读取"),
          levelSelect("fileSystem.write", fs.write, "写入"),
          levelSelect("fileSystem.delete", fs.delete, "删除"),
        ])}`,
      ),
      section(
        "网络",
        "搜索、访问网页、调用 API、下载文件。",
        `${enabledToggle("network.enabled", net.enabled !== false, "启用网络能力")}
        ${levelGrid([
          levelSelect("network.search", net.search, "搜索"),
          levelSelect("network.web", net.web, "读取网页"),
          levelSelect("network.api", net.api, "API 请求"),
          levelSelect("network.download", net.download, "下载文件"),
        ])}`,
      ),
      section(
        "记忆",
        "长期偏好与上下文记忆读写。",
        `${enabledToggle("memory.enabled", mem.enabled !== false, "启用记忆")}
        ${levelGrid([
          levelSelect("memory.read", mem.read, "读取"),
          levelSelect("memory.write", mem.write, "写入"),
          levelSelect("memory.delete", mem.delete, "删除"),
        ])}`,
      ),
      section(
        "软件管理",
        "通过包管理器（如 brew / winget / choco）安装/卸载软件。",
        `${enabledToggle("software.enabled", Boolean(sw.enabled), "启用软件管理")}
        ${levelGrid([
          levelSelect("software.install", sw.install, "安装"),
          levelSelect("software.uninstall", sw.uninstall, "卸载"),
        ])}`,
      ),
      section(
        "自动化（定时任务）",
        "已启用且用户确认过的定时任务，到点由 Daemon 静默执行。",
        `${enabledToggle("automation.enabled", Boolean(auto.enabled), "启用自动化")}
        ${levelGrid([
          levelSelect("automation.create", auto.create, "创建"),
          levelSelect("automation.run", auto.run, "手动运行"),
          levelSelect("automation.delete", auto.delete, "删除"),
        ])}`,
      ),
      section(
        "渠道（外部消息）",
        "连接微信 iLink、飞书、钉钉等，由 Channel Gateway 长轮询入站并调用 Agent。",
        `${enabledToggle("channels.enabled", Boolean(channels.enabled), "启用渠道")}
        ${levelGrid([
          levelSelect("channels.create", channels.create, "创建"),
          levelSelect("channels.start", channels.start, "启动 Gateway"),
          levelSelect("channels.delete", channels.delete, "删除"),
        ])}`,
      ),
      section(
        "通知",
        "系统通知与任务完成提醒。",
        `${enabledToggle("notifications.enabled", Boolean(notif.enabled), "启用通知")}
        ${levelGrid([levelSelect("notifications.send", notif.send, "发送")])}`,
      ),
      section(
        "Forge Browser",
        "Forge 内置的独立浏览器：打开网页、读取 DOM、交互和截图；不依赖 Codex 或用户 Chrome。",
        `${enabledToggle("browser.enabled", Boolean(browser.enabled), "启用 Forge Browser")}
        ${levelGrid([
          levelSelect("browser.open", browser.open, "打开网页"),
          levelSelect("browser.interact", browser.interact, "页面交互"),
          levelSelect("browser.submit", browser.submit, "提交表单"),
        ])}`,
      ),
      section(
        "本机 App",
        "打开或控制本机应用程序。",
        `${enabledToggle("apps.enabled", Boolean(apps.enabled), "启用 App 控制")}
        ${levelGrid([
          levelSelect("apps.open", apps.open, "打开 App"),
          levelSelect("apps.control", apps.control, "控制 UI"),
        ])}`,
      ),
      section(
        "密钥与凭据",
        "密码、Token、钥匙串等敏感数据。",
        levelGrid([levelSelect("secrets.read", secrets.read, "读取")]),
      ),
      section(
        "审计",
        "记录高影响操作以便回看。",
        enabledToggle("audit.enabled", audit.enabled !== false, "启用审计日志"),
      ),
    ].join("");
  }

  function setNested(obj, path, value) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!cur[key] || typeof cur[key] !== "object") cur[key] = {};
      cur = cur[key];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function collectPermissionsFromEditor(host) {
    const permissions = {};
    if (!host) return permissions;

    host.querySelectorAll("[data-perm]").forEach((el) => {
      setNested(permissions, el.getAttribute("data-perm"), el.value);
    });

    host.querySelectorAll("[data-perm-bool]").forEach((el) => {
      setNested(permissions, el.getAttribute("data-perm-bool"), el.checked);
    });

    host.querySelectorAll("[data-perm-roots]").forEach((el) => {
      const paths = el.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      setNested(permissions, el.getAttribute("data-perm-roots"), paths);
    });

    return permissions;
  }

  window.ForgePermissionsUI = {
    renderPermissionsEditor,
    collectPermissionsFromEditor,
  };
})();
