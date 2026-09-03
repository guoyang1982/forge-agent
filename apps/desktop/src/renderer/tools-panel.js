// Unified right-region tool tabs. One tab bar hosts any mix of terminal and
// browser tabs; the "＋" button offers both kinds. terminal-panel.js and
// browser-panel.js register creators and fill tab bodies; app.js owns the
// panel's open/close state and width (shared with the code panel).
(function initToolsPanel() {
  /** @type {Map<string, { kind: string, tabEl: HTMLElement, bodyEl: HTMLElement, labelEl: HTMLElement, onActivate?: Function, onClose?: Function }>} */
  const tabs = new Map();
  /** @type {Map<string, Function>} */
  const creators = new Map();
  let activeId = null;
  let seq = 0;

  const   TAB_ICONS = {
    terminal: "&gt;_",
    browser:
      '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.4" /><ellipse cx="8" cy="8" rx="2.9" ry="6.4" /><path d="M1.6 8h12.8" /></svg>',
    trace:
      '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M3 3.5h6.5v3H8" /><path d="M8 8.5h5v4H8z" /><path d="M3 11.5h3v2H3z" /><path d="M6.5 6.5v2H8" /></svg>',
  };

  function els() {
    return {
      tabBar: document.getElementById("toolsTabs"),
      bodies: document.getElementById("toolsBodies"),
      addBtn: document.getElementById("toolsAddBtn"),
      addMenu: document.getElementById("toolsAddMenu"),
    };
  }

  /** Let app.js react to tab/active changes (button states, auto-close). */
  function notifyChanged() {
    document.dispatchEvent(new CustomEvent("forge-tools-changed"));
  }

  function activate(id) {
    if (!tabs.has(id)) return;
    activeId = id;
    for (const [tid, t] of tabs) {
      const on = tid === id;
      t.bodyEl.classList.toggle("hidden", !on);
      t.tabEl.classList.toggle("active", on);
      if (on) {
        try {
          t.onActivate?.();
        } catch {
          /* owner callback failed */
        }
      }
    }
    notifyChanged();
  }

  function close(id) {
    const t = tabs.get(id);
    if (!t) return;
    try {
      t.onClose?.();
    } catch {
      /* owner callback failed */
    }
    t.tabEl.remove();
    t.bodyEl.remove();
    tabs.delete(id);
    if (activeId === id) {
      activeId = null;
      let lastId = null;
      for (const tid of tabs.keys()) lastId = tid;
      if (lastId) activate(lastId);
    }
    notifyChanged();
  }

  /**
   * Create a tab (button + empty body container) and make it active.
   * The caller renders its own UI into `body`.
   */
  function addTab({ kind, label, onActivate, onClose }) {
    const { tabBar, bodies } = els();
    if (!tabBar || !bodies) return null;
    const id = `tools-${++seq}`;

    const bodyEl = document.createElement("div");
    bodyEl.className = "tools-body hidden";
    bodies.appendChild(bodyEl);

    const tabEl = document.createElement("button");
    tabEl.type = "button";
    tabEl.className = "terminal-tab tools-tab";
    const icon = document.createElement("span");
    icon.className = "tools-tab-icon";
    icon.innerHTML = TAB_ICONS[kind] || "";
    const labelEl = document.createElement("span");
    labelEl.className = "terminal-tab-label";
    labelEl.textContent = label || "";
    const x = document.createElement("span");
    x.className = "terminal-tab-close";
    x.textContent = "✕";
    x.title = "关闭标签页";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      close(id);
    });
    tabEl.append(icon, labelEl, x);
    tabEl.addEventListener("click", () => activate(id));
    tabBar.appendChild(tabEl);

    tabs.set(id, { kind, tabEl, bodyEl, labelEl, onActivate, onClose });
    activate(id);

    return {
      id,
      body: bodyEl,
      setLabel(text) {
        labelEl.textContent = text || "";
        tabEl.title = text || "";
      },
      activate: () => activate(id),
      close: () => close(id),
      isActive: () => activeId === id,
    };
  }

  /** Focus the most recently created tab of `kind`; false when none exists. */
  function activateKind(kind) {
    if (activeId && tabs.get(activeId)?.kind === kind) {
      activate(activeId);
      return true;
    }
    let lastId = null;
    for (const [tid, t] of tabs) {
      if (t.kind === kind) lastId = tid;
    }
    if (!lastId) return false;
    activate(lastId);
    return true;
  }

  function newTab(kind) {
    creators.get(kind)?.();
  }

  function registerCreator(kind, fn) {
    creators.set(kind, fn);
  }

  function activeKind() {
    return activeId ? (tabs.get(activeId)?.kind ?? null) : null;
  }

  function hasTabs() {
    return tabs.size > 0;
  }

  /** Last tab of `kind`, or null. */
  function getByKind(kind) {
    let found = null;
    for (const [id, t] of tabs) {
      if (t.kind === kind) found = { id, t };
    }
    if (!found) return null;
    const { id, t } = found;
    return {
      id,
      body: t.bodyEl,
      setLabel(text) {
        t.labelEl.textContent = text || "";
        t.tabEl.title = text || "";
      },
      activate: () => activate(id),
      close: () => close(id),
      isActive: () => activeId === id,
    };
  }

  function closeOthersOfKind(kind, keepId) {
    for (const [id, t] of [...tabs]) {
      if (t.kind === kind && id !== keepId) close(id);
    }
  }

  function setAddMenuOpen(open) {
    const { addBtn, addMenu } = els();
    addMenu?.classList.toggle("hidden", !open);
    addBtn?.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function wire() {
    const { addBtn, addMenu } = els();
    addBtn?.addEventListener("click", () => {
      setAddMenuOpen(addMenu?.classList.contains("hidden") ?? false);
    });
    addMenu?.addEventListener("click", (e) => {
      const item =
        e.target instanceof Element && e.target.closest("[data-tools-add]");
      if (!item) return;
      setAddMenuOpen(false);
      newTab(item.getAttribute("data-tools-add"));
    });
    document.addEventListener(
      "pointerdown",
      (e) => {
        const menu = els().addMenu;
        if (!menu || menu.classList.contains("hidden")) return;
        if (e.target instanceof Element && e.target.closest(".tools-add-wrap")) return;
        setAddMenuOpen(false);
      },
      true,
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  window.forgeToolsPanel = {
    addTab,
    activate,
    activateKind,
    newTab,
    registerCreator,
    activeKind,
    hasTabs,
    getByKind,
    closeOthersOfKind,
  };
})();
