/**
 * 插件发现页：精选 + GitHub 搜索 + 安装
 */
(function initForgePluginsMarketplace(global) {
  function formatStars(n) {
    if (n == null || n <= 0) return "";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  function renderRepoLink(repo, subdir, escapeHtml) {
    if (!repo) return `<div class="store-card-repo"></div>`;
    return `<button type="button" class="store-card-repo store-card-repo-link" data-github-repo="${escapeHtml(repo)}" data-github-subdir="${escapeHtml(subdir || "")}" title="在 GitHub 打开">↗ ${escapeHtml(repo)}</button>`;
  }

  function renderPluginCard(item, escapeHtml) {
    const installed = Boolean(item.installed);
    const stars = formatStars(item.stars);
    const action = installed
      ? `<span class="store-card-badge installed">已安装</span>`
      : `<button type="button" class="store-card-install" data-plugin-install="${escapeHtml(item.id)}">安装</button>`;
    return `<article class="store-card" data-plugin-store-id="${escapeHtml(item.id)}">
      <h3 class="store-card-name">${escapeHtml(item.name)}</h3>
      ${renderRepoLink(item.repo, item.subdir, escapeHtml)}
      <p class="store-card-desc">${escapeHtml(item.description || "")}</p>
      <div class="store-card-footer">
        <div class="store-card-meta">
          ${stars ? `<span class="store-card-stars">★ ${stars}</span>` : ""}
          <span class="store-card-source">${escapeHtml(item.source || "")}</span>
        </div>
        ${action}
      </div>
    </article>`;
  }

  function renderDiscoverHtml(state, escapeHtml) {
    const hint = state.pluginsMarketHint
      ? `<p class="store-hint">${escapeHtml(state.pluginsMarketHint)}</p>`
      : "";
    if (state.pluginsMarketLoading) {
      return `${hint}<div class="store-status">正在搜索…</div>`;
    }
    const items = state.pluginsMarketItems ?? [];
    if (!items.length) {
      return `${hint}<div class="store-status">没有匹配的插件，试试其他关键词或「+ 手动添加」GitHub 仓库。</div>`;
    }
    return `${hint}<div class="store-grid">${items.map((i) => renderPluginCard(i, escapeHtml)).join("")}</div>`;
  }

  function bindGithubRepoLinks(root, onOpen) {
    root.querySelectorAll(".store-card-repo-link").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const repo = btn.getAttribute("data-github-repo");
        const subdir = btn.getAttribute("data-github-subdir") || "";
        if (repo && onOpen) onOpen(repo, subdir);
      });
    });
  }

  function bindDiscover(root, state, deps) {
    bindGithubRepoLinks(root, deps.openGithub);
    root.querySelectorAll("[data-plugin-install]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-plugin-install");
        const item = (state.pluginsMarketItems ?? []).find((x) => x.id === id);
        if (!item) return;
        btn.disabled = true;
        btn.textContent = "…";
        try {
          const payload = item.catalogId
            ? { catalogId: item.catalogId }
            : { source: item.repo, subdir: item.subdir || undefined };
          await deps.importPlugin(payload);
          deps.notify(`已安装插件: ${item.name}`, "done");
          item.installed = true;
          await deps.refreshDiscover();
          if (deps.onInstalled) await deps.onInstalled();
        } catch (err) {
          const raw = String(err);
          const friendly = /不是 Forge 插件包|不是插件包|plugin\.json/i.test(raw)
            ? raw.replace(/^Error:\s*(Error invoking remote method[^:]*:\s*)?/i, "").trim()
            : raw;
          deps.notify(`安装失败: ${friendly}`, "err");
          btn.disabled = false;
          btn.textContent = "安装";
        }
      });
    });
  }

  global.ForgePluginsMarketplace = {
    renderDiscoverHtml,
    bindDiscover,
    bindGithubRepoLinks,
  };
})(typeof window !== "undefined" ? window : globalThis);
