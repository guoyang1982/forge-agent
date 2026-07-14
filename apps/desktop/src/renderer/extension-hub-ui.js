/**
 * Extension Hub UI helpers: merge hub + discovery into rows, render agent chips
 * on manage cards (installed + distribute combined).
 */
(function initForgeExtensionHub(global) {
  const AGENTS = [
    { id: "forge", label: "Forge" },
    { id: "cursor", label: "Cursor" },
    { id: "claude-code", label: "Claude" },
    { id: "codex", label: "Codex" },
  ];
  /** What the user must do after file deploy/undeploy for the agent to pick it up. */
  const RELOAD_HINT = {
    forge: "",
    cursor: "请在 Cursor 执行 Reload Window（⌘⇧P → Reload Window）后生效",
    "claude-code": "请重启 Claude Code 后生效",
    codex: "请重启 Codex 后生效",
  };
  const STATUS_TEXT = {
    synced: "已同步",
    drift: "有变更",
    missing: "已丢失",
    error: "错误",
  };

  function reloadHint(agentId) {
    return RELOAD_HINT[agentId] || "";
  }

  function notifyWithReload(deps, baseMsg, agentId) {
    const hint = reloadHint(agentId);
    deps.notify(hint ? `${baseMsg}。${hint}` : baseMsg, hint ? "warn" : "done");
  }

  /**
   * Merge hub-tracked extensions with per-agent discovery into one row model.
   * Row: { id, kind, inHub, name, deployments, discovered }
   * @param {string} [kindFilter] - when set ("skill"|"plugin"), only include that kind
   */
  function buildRows(items, discovery, kindFilter) {
    const rows = new Map();
    for (const it of items || []) {
      if (kindFilter && (it.kind || "") !== kindFilter) continue;
      rows.set(it.id, {
        id: it.id,
        kind: it.kind || "",
        name: it.name || it.id,
        inHub: true,
        deployments: it.deployments || {},
        compatibility: it.compatibility || {},
        discovered: {},
      });
    }
    for (const ag of discovery || []) {
      if (!ag || !ag.available) continue;
      for (const f of ag.found || []) {
        if (kindFilter && (f.kind || "") !== kindFilter) continue;
        let row = rows.get(f.id);
        if (!row) {
          row = {
            id: f.id,
            kind: f.kind || "",
            name: f.id,
            inHub: Boolean(f.inHub),
            deployments: {},
            compatibility: {},
            discovered: {},
          };
          rows.set(f.id, row);
        }
        if (!row.deployments[ag.agent]) {
          row.discovered[ag.agent] = { path: f.path || "", matches: Boolean(f.hubMatches) };
        }
      }
    }
    return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  function rowsById(items, discovery, kindFilter) {
    const map = new Map();
    for (const row of buildRows(items, discovery, kindFilter)) {
      map.set(row.id, row);
    }
    return map;
  }

  /** Agent chip for one deployment target on a manage card. */
  function chipHtml(row, agent, escapeHtml) {
    const dep = row.deployments ? row.deployments[agent.id] : undefined;
    const compatibility = row.compatibility ? row.compatibility[agent.id] : undefined;
    const reload = reloadHint(agent.id);
    if (compatibility && compatibility.status === "incompatible") {
      const title = `${agent.label}: 不兼容 · ${compatibility.reason}${dep ? "（点击卸载）" : ""}`;
      if (!dep) {
        return `<span class="agent-chip agent-chip-incompatible" title="${escapeHtml(title)}"><span class="agent-chip-dot"></span>${escapeHtml(agent.label)}</span>`;
      }
      return `<button type="button" class="agent-chip agent-chip-incompatible" data-hub-chip data-ext="${escapeHtml(
        row.id,
      )}" data-agent="${agent.id}" data-action="undeploy" title="${escapeHtml(
        title,
      )}"><span class="agent-chip-dot"></span>${escapeHtml(agent.label)}</button>`;
    }
    if (dep) {
      const status = dep.status || "synced";
      const label = STATUS_TEXT[status] || status;
      const note = dep.note ? ` · ${dep.note}` : "";
      const reloadNote = reload ? ` · ${reload}` : "";
      return `<button type="button" class="agent-chip agent-chip-${escapeHtml(status)}" data-hub-chip data-ext="${escapeHtml(
        row.id,
      )}" data-agent="${agent.id}" data-action="undeploy" title="${escapeHtml(
        `${agent.label}: ${label}${dep.path ? ` · ${dep.path}` : ""}${note}（点击卸载）${reloadNote}`,
      )}"><span class="agent-chip-dot"></span>${escapeHtml(agent.label)}</button>`;
    }
    const disc = row.discovered ? row.discovered[agent.id] : undefined;
    if (disc) {
      const canManage = row.inHub;
      const reloadNote = canManage && reload ? ` · ${reload}` : "";
      return `<button type="button" class="agent-chip agent-chip-found" data-hub-chip data-ext="${escapeHtml(
        row.id,
      )}" data-agent="${agent.id}" data-action="${canManage ? "deploy" : "none"}" title="${escapeHtml(
        `已装（未纳管）${disc.path ? ` · ${disc.path}` : ""}${canManage ? " · 点击部署为 Hub 版" : " · 先导入 Hub"}${reloadNote}`,
      )}"><span class="agent-chip-dot"></span>${escapeHtml(agent.label)}</button>`;
    }
    if (row.inHub) {
      const reloadNote = reload ? ` · ${reload}` : "";
      const compatibilityNote = compatibility && compatibility.status !== "compatible"
        ? ` · ${compatibility.reason}`
        : "";
      return `<button type="button" class="agent-chip agent-chip-empty" data-hub-chip data-ext="${escapeHtml(
        row.id,
      )}" data-agent="${agent.id}" data-action="deploy" title="${escapeHtml(
        `部署到 ${agent.label}${compatibilityNote}${reloadNote}`,
      )}"><span class="agent-chip-dot"></span>${escapeHtml(
        agent.label,
      )}</button>`;
    }
    return `<span class="agent-chip agent-chip-na" title="未安装"><span class="agent-chip-dot"></span>${escapeHtml(
      agent.label,
    )}</span>`;
  }

  function agentChipsHtml(row, escapeHtml) {
    if (!row) return "";
    return `<div class="manage-agent-chips" data-hub-ext="${escapeHtml(row.id)}">${AGENTS.map((a) =>
      chipHtml(row, a, escapeHtml),
    ).join("")}</div>`;
  }

  function manageActionsHtml(row, escapeHtml, options) {
    const opts = options || {};
    const parts = [];
    if (row?.inHub) {
      parts.push(
        `<button type="button" class="manage-icon-btn" data-hub-sync-one data-ext="${escapeHtml(
          row.id,
        )}" title="同步到已部署的 Agent">↻</button>`,
      );
    }
    if (opts.toggleHtml) parts.push(opts.toggleHtml);
    if (row?.inHub) {
      parts.push(
        `<button type="button" class="manage-icon-btn manage-icon-danger" data-hub-remove data-ext="${escapeHtml(
          row.id,
        )}" title="从 Hub 及所有 Agent 移除">⌫</button>`,
      );
    } else if (row && Object.keys(row.discovered || {}).length) {
      parts.push(
        `<button type="button" class="btn primary btn-sm" data-hub-import data-ext="${escapeHtml(
          row.id,
        )}" title="纳管进 Hub 后可分发到其他 Agent">导入 Hub</button>`,
      );
    }
    return `<div class="manage-card-actions">${parts.join("")}</div>`;
  }

  function bindManageCards(root, deps) {
    const run = async (el, fn) => {
      const prevDisabled = el.disabled;
      el.disabled = true;
      el.classList.add("busy");
      try {
        await fn();
      } catch (err) {
        deps.notify(`操作失败: ${String(err)}`, "err");
      } finally {
        el.disabled = prevDisabled;
        el.classList.remove("busy");
      }
      if (deps.refresh) await deps.refresh();
    };

    root.querySelectorAll("[data-hub-chip]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const extId = btn.getAttribute("data-ext");
        const agent = btn.getAttribute("data-agent");
        const action = btn.getAttribute("data-action");
        if (!extId || !agent || !action || action === "none") return;
        void run(btn, async () => {
          if (action === "undeploy") {
            await deps.undeploy(extId, agent);
            notifyWithReload(deps, `已从 ${agent} 卸载 ${extId}`, agent);
          } else {
            await deps.deploy(extId, agent);
            notifyWithReload(deps, `已部署 ${extId} 到 ${agent}`, agent);
          }
        });
      });
    });

    root.querySelectorAll("[data-hub-sync-one]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const extId = btn.getAttribute("data-ext");
        if (!extId) return;
        void run(btn, async () => {
          await deps.sync(extId);
          deps.notify(
            `已同步 ${extId}。外部 Agent（Cursor / Claude / Codex）需 Reload 或重启后生效`,
            "warn",
          );
        });
      });
    });

    root.querySelectorAll("[data-hub-remove]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const extId = btn.getAttribute("data-ext");
        if (!extId) return;
        if (!deps.confirm(`从 Hub 及所有 Agent 移除 “${extId}”？`)) return;
        void run(btn, async () => {
          await deps.remove(extId);
          deps.notify(
            `已移除 ${extId}。外部 Agent 需 Reload / 重启后才会卸干净`,
            "warn",
          );
        });
      });
    });

    root.querySelectorAll("[data-hub-import]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const extId = btn.getAttribute("data-ext");
        if (!extId) return;
        void run(btn, async () => {
          await deps.importToHub(extId);
          deps.notify(`已把 ${extId} 导入 Hub`, "done");
        });
      });
    });
  }

  /** Discovered-only rows not already shown via local installed ids. */
  function orphanRows(hubRows, localIds) {
    const ids = new Set(localIds || []);
    return (hubRows || []).filter((r) => !ids.has(r.id));
  }

  function orphanCardsHtml(rows, escapeHtml) {
    return rows
      .map((row) => {
        const actions = manageActionsHtml(row, escapeHtml);
        return `<article class="skill-card skill-card-compact manage-card" data-hub-orphan="${escapeHtml(row.id)}">
          <div class="skill-card-layout">
            <span class="skill-card-glyph" aria-hidden="true">↗</span>
            <div class="skill-card-content">
              <div class="skill-card-topline">
                <span class="skill-card-name">${escapeHtml(row.id)}</span>
                <span class="skill-card-source hub-ext-kind-ext">${escapeHtml(row.kind || "")} · 未纳管</span>
              </div>
              <div class="skill-card-subline">
                <span class="skill-card-desc">在其他 Agent 已装，导入 Hub 后可跨端分发</span>
              </div>
            </div>
            ${actions}
          </div>
          ${agentChipsHtml(row, escapeHtml)}
        </article>`;
      })
      .join("");
  }

  function orphanSectionHtml(rows, escapeHtml, kindLabel) {
    if (!rows.length) return "";
    const cards = orphanCardsHtml(rows, escapeHtml);
    return `<section class="skill-group">
      <div class="skill-group-title">
        <span class="skill-group-label">其他 Agent 已装（未纳管）</span>
        <span class="skill-count">${rows.length}</span>
      </div>
      <div class="skill-card-grid manage-card-grid">${cards}</div>
    </section>`;
  }

  global.ForgeExtensionHub = {
    AGENTS,
    buildRows,
    rowsById,
    agentChipsHtml,
    manageActionsHtml,
    bindManageCards,
    orphanRows,
    orphanCardsHtml,
    orphanSectionHtml,
  };
})(typeof window !== "undefined" ? window : globalThis);
