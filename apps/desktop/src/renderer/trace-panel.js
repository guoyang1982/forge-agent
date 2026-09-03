// Trace tab: one reusable inspector for the durable span tree.
(function initTracePanel() {
  const tools = () => window.forgeToolsPanel;
  const bridge = () => window.forgeDesktop;
  let tab = null;
  let creating = false;
  /** @type {{ runId?: string, sessionId?: string } | null} */
  let currentQuery = null;
  let loadGen = 0;

  function liveTab() {
    if (tab?.body?.isConnected) return tab;
    const existing = tools()?.getByKind?.("trace");
    if (existing) tab = existing;
    return existing || null;
  }

  function ensureTab() {
    const existing = liveTab();
    if (existing) {
      tools()?.closeOthersOfKind?.("trace", existing.id);
      return existing;
    }
    if (creating) return tab;
    creating = true;
    try {
      tab = tools()?.addTab?.({
        kind: "trace",
        label: "Trace",
        onActivate: () => {
          if (creating) return;
          void fillTrace(currentQuery || {});
        },
        onClose: () => {
          tab = null;
        },
      });
      if (!tab) return null;
      tab.body.className = "tools-body trace-panel";
      tab.body.innerHTML = `
        <header class="trace-panel-head">
          <div class="trace-panel-title">调用树</div>
          <div class="trace-panel-meta" data-trace-meta></div>
          <button type="button" class="icon-btn subtle" data-trace-refresh title="刷新">↻</button>
        </header>
        <div class="trace-panel-body" data-trace-tree></div>
      `;
      tab.body.querySelector("[data-trace-refresh]")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void fillTrace(currentQuery || {});
      });
      tools()?.closeOthersOfKind?.("trace", tab.id);
      return tab;
    } finally {
      creating = false;
    }
  }

  async function fillTrace(query) {
    const host = liveTab();
    if (!host) return;
    currentQuery = query;
    const gen = ++loadGen;
    const treeEl = host.body.querySelector("[data-trace-tree]");
    const metaEl = host.body.querySelector("[data-trace-meta]");
    if (!query?.runId && !query?.sessionId) {
      if (metaEl) metaEl.textContent = "";
      if (treeEl) {
        treeEl.innerHTML =
          '<p class="trace-empty">还没有可打开的运行。先发一条消息，再打开 Trace。</p>';
      }
      return;
    }
    if (treeEl) treeEl.innerHTML = '<p class="trace-empty">加载中…</p>';
    try {
      const result = await bridge()?.getTrace?.(query);
      if (gen !== loadGen) return;
      if (result?.runId) currentQuery = { ...query, runId: result.runId };
      if (metaEl) {
        const parts = [
          result?.state,
          result?.summaries?.tools?.length
            ? `${result.summaries.tools.length} 个工具`
            : "",
          formatDuration(result?.tree),
        ].filter(Boolean);
        metaEl.textContent = parts.join(" · ");
      }
      host.setLabel?.("Trace");
      if (treeEl) treeEl.replaceChildren(renderNode(result.tree, true));
    } catch (error) {
      if (gen !== loadGen) return;
      if (treeEl) {
        treeEl.innerHTML = `<p class="trace-empty">${escapeHtml(String(error?.message || error))}</p>`;
      }
    }
  }

  function renderNode(node, open) {
    if (!node) {
      const empty = document.createElement("p");
      empty.className = "trace-empty";
      empty.textContent = "没有 span";
      return empty;
    }
    const details = document.createElement("details");
    details.className = "trace-node";
    details.open = Boolean(open || node.status === "failed" || node.kind === "run");
    const summary = document.createElement("summary");
    summary.className = "trace-node-summary";
    const kind = document.createElement("span");
    kind.className = `trace-kind trace-kind-${cssToken(node.kind)}`;
    kind.textContent = node.kind || "span";
    const name = document.createElement("span");
    name.className = "trace-name";
    name.textContent = node.name || node.spanId;
    const meta = document.createElement("span");
    meta.className = "trace-meta";
    meta.textContent = [node.status, formatMs(node.durationMs)].filter(Boolean).join(" · ");
    summary.append(kind, name, meta);
    details.append(summary);
    if (node.summary) {
      const pre = document.createElement("pre");
      pre.className = "trace-summary";
      pre.textContent = node.summary;
      details.append(pre);
    }
    for (const child of node.children || []) {
      details.append(renderNode(child, node.kind === "run" || node.kind === "step"));
    }
    return details;
  }

  function formatMs(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatDuration(node) {
    return node ? formatMs(node.durationMs) : "";
  }

  function cssToken(value) {
    return String(value || "span").replace(/[^a-z0-9_-]+/gi, "");
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function open(query) {
    const host = ensureTab();
    if (!host) return;
    window.openRight?.(true, "tools");
    host.activate?.();
    void fillTrace(query || currentQuery || {});
  }

  function ensureStarted() {
    if (tools()?.activateKind?.("trace")) {
      window.openRight?.(true, "tools");
      void fillTrace(currentQuery || {});
      return;
    }
    open(currentQuery || {});
  }

  function wire() {
    tools()?.registerCreator?.("trace", () => ensureStarted());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  window.forgeTracePanel = { open, ensureStarted };
})();
