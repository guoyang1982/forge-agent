/** Agent Runtime panel (loaded before app.js). */
(function () {
  const LS_RUNTIME_PREFS_KEY = "forgeRuntimePrefsV1";

  const DEFAULT_PREFS = {
    defaultProvider: "forge",
    cursor: { model: "", mode: "default" },
    codex: { model: "" },
    claude: { model: "sonnet" },
  };

  const CLAUDE_MODELS = [
    { id: "sonnet", model: "sonnet", displayName: "Sonnet", isDefault: true },
    { id: "opus", model: "opus", displayName: "Opus" },
    { id: "haiku", model: "haiku", displayName: "Haiku" },
  ];

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statusLabel(status) {
    switch (status) {
      case "ready":
        return "ready";
      case "needs_setup":
        return "needs setup";
      case "binary_missing":
        return "binary missing";
      case "auth_required":
        return "needs setup";
      default:
        return status || "unknown";
    }
  }

  function statusClass(status) {
    return status === "ready" ? "runtime-status-ready" : "runtime-status-warn";
  }

  function loadPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_RUNTIME_PREFS_KEY) || "{}");
      return {
        ...DEFAULT_PREFS,
        ...raw,
        cursor: { ...DEFAULT_PREFS.cursor, ...(raw.cursor || {}) },
        codex: { ...DEFAULT_PREFS.codex, ...(raw.codex || {}) },
        claude: { ...DEFAULT_PREFS.claude, ...(raw.claude || {}) },
      };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs(prefs) {
    localStorage.setItem(LS_RUNTIME_PREFS_KEY, JSON.stringify(prefs));
  }

  function providerCard(provider, prefs, selectedId) {
    const active = provider.id === selectedId ? " runtime-provider-card--active" : "";
    return `<button type="button" class="runtime-provider-card${active}" data-runtime-provider="${escapeHtml(provider.id)}">
      <div class="runtime-provider-card-head">
        <strong>${escapeHtml(provider.label)}</strong>
        <span class="runtime-status-pill ${statusClass(provider.status)}">${escapeHtml(statusLabel(provider.status))}</span>
      </div>
      <p class="runtime-provider-card-msg">${escapeHtml(provider.message || provider.kind || "")}</p>
    </button>`;
  }

  function detailPanel(provider, prefs, context = {}) {
    if (!provider) {
      return `<div class="runtime-detail-empty">选择一个 Agent Runtime 查看配置。</div>`;
    }

    const codexModels = context.codexModels || [];
    const claudeModels = context.claudeModels || CLAUDE_MODELS;

    if (provider.id === "cursor") {
      const models = provider.models || [];
      const modes = provider.modes || [];
      const modelOptions = [
        `<option value="">Auto</option>`,
        ...models.map((m) => {
          const value = m.model || m.id;
          const selected = prefs.cursor?.model === value ? " selected" : "";
          return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(m.displayName || value)}</option>`;
        }),
      ].join("");
      const modeOptions = modes
        .map((m) => {
          const selected = (prefs.cursor?.mode || "default") === m.id ? " selected" : "";
          return `<option value="${escapeHtml(m.id)}"${selected}>${escapeHtml(m.label || m.id)}</option>`;
        })
        .join("");
      return `<section class="runtime-detail-card">
        <h3>Cursor</h3>
        <div class="runtime-detail-grid">
          <label class="runtime-detail-field">
            <span>Model</span>
            <select id="runtimeDetailCursorModel" class="modal-input">${modelOptions}</select>
          </label>
          <label class="runtime-detail-field">
            <span>Mode</span>
            <select id="runtimeDetailCursorMode" class="modal-input">${modeOptions}</select>
          </label>
          <div class="runtime-detail-field">
            <span>Status</span>
            <div class="runtime-detail-status">
              <span class="runtime-status-pill ${statusClass(provider.status)}">${escapeHtml(statusLabel(provider.status))}</span>
              <span class="tiny">${escapeHtml(provider.message || "")}</span>
            </div>
          </div>
          ${
            provider.binaryPath
              ? `<div class="runtime-detail-field"><span>Binary</span><code class="runtime-binary-path">${escapeHtml(provider.binaryPath)}</code></div>`
              : ""
          }
        </div>
        <div class="runtime-detail-actions">
          <button type="button" class="btn secondary btn-sm" id="runtimeUseCursorBtn">设为默认 Runtime</button>
          <button type="button" class="btn secondary btn-sm" id="runtimeRefreshCursorBtn">重新检测</button>
        </div>
      </section>`;
    }

    if (provider.id === "codex") {
      const modelOptions = [
        `<option value="">Auto</option>`,
        ...codexModels.map((m) => {
          const value = m.model || m.id;
          const selected = prefs.codex?.model === value ? " selected" : "";
          return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(m.displayName || value)}</option>`;
        }),
      ].join("");
      return `<section class="runtime-detail-card">
        <h3>Codex</h3>
        <p class="tiny">通过 Codex app-server 驱动。</p>
        <div class="runtime-detail-grid">
          <label class="runtime-detail-field">
            <span>Model</span>
            <select id="runtimeDetailCodexModel" class="modal-input">${modelOptions}</select>
          </label>
          <div class="runtime-detail-field">
            <span>Status</span>
            <div class="runtime-detail-status">
              <span class="runtime-status-pill ${statusClass(provider.status)}">${escapeHtml(statusLabel(provider.status))}</span>
              <span class="tiny">${escapeHtml(provider.message || "")}</span>
            </div>
          </div>
          ${
            provider.binaryPath
              ? `<div class="runtime-detail-field"><span>Binary</span><code class="runtime-binary-path">${escapeHtml(provider.binaryPath)}</code></div>`
              : ""
          }
        </div>
        <div class="runtime-detail-actions">
          <button type="button" class="btn secondary btn-sm" data-runtime-use="codex">设为默认 Runtime</button>
          <button type="button" class="btn secondary btn-sm" id="runtimeRefreshCodexBtn">刷新模型列表</button>
        </div>
      </section>`;
    }

    if (provider.id === "claude-code") {
      const modelOptions = claudeModels
        .map((m) => {
          const value = m.model || m.id;
          const selected = (prefs.claude?.model || "sonnet") === value ? " selected" : "";
          return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(m.displayName || value)}</option>`;
        })
        .join("");
      return `<section class="runtime-detail-card">
        <h3>Claude Code</h3>
        <p class="tiny">通过 Claude Code CLI stream-json 驱动。</p>
        <div class="runtime-detail-grid">
          <label class="runtime-detail-field">
            <span>Model</span>
            <select id="runtimeDetailClaudeModel" class="modal-input">${modelOptions}</select>
          </label>
          <div class="runtime-detail-field">
            <span>Status</span>
            <div class="runtime-detail-status">
              <span class="runtime-status-pill ${statusClass(provider.status)}">${escapeHtml(statusLabel(provider.status))}</span>
              <span class="tiny">${escapeHtml(provider.message || "")}</span>
            </div>
          </div>
          ${
            provider.binaryPath
              ? `<div class="runtime-detail-field"><span>Binary</span><code class="runtime-binary-path">${escapeHtml(provider.binaryPath)}</code></div>`
              : ""
          }
        </div>
        <div class="runtime-detail-actions">
          <button type="button" class="btn secondary btn-sm" data-runtime-use="claude-code">设为默认 Runtime</button>
        </div>
      </section>`;
    }

    return `<section class="runtime-detail-card">
      <h3>${escapeHtml(provider.label)}</h3>
      <div class="runtime-detail-status">
        <span class="runtime-status-pill ${statusClass(provider.status)}">${escapeHtml(statusLabel(provider.status))}</span>
        <span class="tiny">${escapeHtml(provider.message || "")}</span>
      </div>
      ${
        provider.id === "forge"
          ? `<div class="runtime-detail-actions"><button type="button" class="btn secondary btn-sm" data-runtime-use="forge">设为默认 Runtime</button></div>`
          : ""
      }
    </section>`;
  }

  function warmSessionsHtml(sessions) {
    if (!sessions.length) {
      return `<div class="runtime-warm-empty tiny">当前没有 warm ACP session。</div>`;
    }
    return `<div class="runtime-warm-list">${sessions
      .map(
        (s) => `<div class="runtime-warm-item">
          <div class="runtime-warm-item-head">
            <div><strong>${escapeHtml(s.providerKey)}</strong> · ${escapeHtml(s.forgeSessionId.slice(0, 8))}…</div>
            <button type="button" class="btn secondary btn-sm runtime-warm-close-btn" data-warm-provider="${escapeHtml(s.providerKey)}" data-warm-session="${escapeHtml(s.forgeSessionId)}">关闭</button>
          </div>
          <div class="tiny">${escapeHtml(s.cwd)}${s.model ? ` · ${escapeHtml(s.model)}` : ""}${s.mode ? ` · ${escapeHtml(s.mode)}` : ""}</div>
        </div>`,
      )
      .join("")}</div>`;
  }

  function renderPage(root, providers, prefs, selectedId, warmSessions, context = {}) {
    const selected = providers.find((p) => p.id === selectedId) || providers[0] || null;
    root.innerHTML = `<div class="runtime-page">
      <p class="runtime-page-lead">选择外部 Agent Runtime。ACP provider（如 Cursor）会复用 warm session，减少每轮启动开销。</p>
      <div class="runtime-provider-grid">${providers.map((p) => providerCard(p, prefs, selected?.id || "")).join("")}</div>
      ${detailPanel(selected, prefs, context)}
      <section class="runtime-detail-card runtime-warm-card">
        <h3>Warm ACP Sessions</h3>
        ${warmSessionsHtml(warmSessions)}
      </section>
    </div>`;
  }

  function bindPage(root, handlers) {
    root.querySelectorAll("[data-runtime-provider]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-runtime-provider");
        if (id) handlers.onSelectProvider(id);
      });
    });
    root.querySelectorAll("[data-runtime-use]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-runtime-use");
        if (id) handlers.onUseProvider(id);
      });
    });
    root.querySelector("#runtimeUseCursorBtn")?.addEventListener("click", () =>
      handlers.onUseProvider("cursor"),
    );
    root.querySelector("#runtimeRefreshCursorBtn")?.addEventListener("click", () =>
      handlers.onRefresh(),
    );
    root.querySelector("#runtimeDetailCursorModel")?.addEventListener("change", (e) => {
      handlers.onCursorPrefChange({ model: e.target.value });
    });
    root.querySelector("#runtimeDetailCursorMode")?.addEventListener("change", (e) => {
      handlers.onCursorPrefChange({ mode: e.target.value });
    });
    root.querySelector("#runtimeDetailCodexModel")?.addEventListener("change", (e) => {
      handlers.onCodexPrefChange?.({ model: e.target.value });
    });
    root.querySelector("#runtimeDetailClaudeModel")?.addEventListener("change", (e) => {
      handlers.onClaudePrefChange?.({ model: e.target.value });
    });
    root.querySelector("#runtimeRefreshCodexBtn")?.addEventListener("click", () =>
      handlers.onRefreshCodex?.(),
    );
    root.querySelectorAll(".runtime-warm-close-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const provider = btn.getAttribute("data-warm-provider");
        const sessionId = btn.getAttribute("data-warm-session");
        if (provider && sessionId) handlers.onCloseWarmSession(provider, sessionId);
      });
    });
  }

  window.ForgeRuntimeUI = {
    LS_RUNTIME_PREFS_KEY,
    DEFAULT_PREFS,
    loadPrefs,
    savePrefs,
    renderPage,
    bindPage,
    statusLabel,
  };
})();
